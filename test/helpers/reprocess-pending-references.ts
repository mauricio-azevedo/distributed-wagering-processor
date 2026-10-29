/**
 * Sweeps the pending-reference claim list in a process of its own and exits: the other workers
 * REF-002 needs. Nothing is shared but PostgreSQL — no heap, no entity manager, no connection pool
 * — so the exclusivity of a claim is decided by the database or not at all.
 *
 * Usage: `bun run test/helpers/reprocess-pending-references.ts '<options as JSON>'`.
 *
 * - With no options it drains: it sweeps until a sweep finds nothing due, then prints every attempt
 *   it made as JSON.
 * - With `holdMs` it claims one transaction, prints its id on a line of its own and holds the claim
 *   open for that long inside the transaction, so the process that spawned it can watch another
 *   sweep skip the claimed row and then kill this one mid-attempt.
 * - With `loop` it runs the scheduler the `worker` role runs, under the service's own signal
 *   handling, and lives until it is signalled: it prints `ready`, then drains on `SIGTERM` within
 *   `SHUTDOWN_GRACE_PERIOD_MS` and exits by the code that drain earned (`ops.graceful-shutdown`).
 *   With `holdMs` beside it, the attempt in flight is the claim a case signals it in the middle of.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ReprocessPendingReference } from '../../src/application/use-cases/reprocess-pending-reference';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { uncountedMetrics } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import {
  PENDING_REFERENCE_SCHEDULER,
  PendingReferenceScheduler,
} from '../../src/infrastructure/runtime/pending-reference-scheduler';
import { onShutdownSignal } from '../../src/infrastructure/runtime/shutdown';

/** A sweep that keeps finding work cannot loop forever: a drain is bounded by this many sweeps. */
const MAX_SWEEPS = 200;

const optionsSchema = z.object({
  holdMs: z.number().int().positive().optional(),
  loop: z.literal(true).optional(),
});

const [argument] = process.argv.slice(2);
const options = optionsSchema.parse(JSON.parse(argument ?? '{}') as unknown);
const env = loadEnv(process.env);
const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));

/** The claim, held open inside its transaction, with the id it claimed announced at once. */
function holdingClaims(unitOfWork: UnitOfWork, holdMs: number): UnitOfWork {
  return {
    snapshot: (work) => unitOfWork.snapshot(work),
    transactional: (work) =>
      unitOfWork.transactional((repositories) => {
        const held: Repositories = {
          ...repositories,
          pendingReferences: {
            insert: (schedule) => repositories.pendingReferences.insert(schedule),
            update: (schedule) => repositories.pendingReferences.update(schedule),
            claimNextDue: async (at) => {
              const claimed = await repositories.pendingReferences.claimNextDue(at);

              if (claimed !== null) {
                process.stdout.write(`${claimed.transactionId}\n`);
                await Bun.sleep(holdMs);
              }

              return claimed;
            },
          },
        };

        return work(held);
      }),
  };
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const unitOfWork = new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS);
// On stderr, so the lines a case parses off stdout are the helper's own.
const logger = jsonLinesLogger('reprocess-pending-references', process.stderr);
const reprocessPendingReference = new ReprocessPendingReference({
  unitOfWork: options.holdMs === undefined ? unitOfWork : holdingClaims(unitOfWork, options.holdMs),
  clock: systemClock,
  ids: uuidV7IdGenerator,
  logger,
  metrics: uncountedMetrics,
  ...(options.holdMs === undefined ? {} : { sweepSize: 1 }),
});

if (options.loop) {
  const scheduler = new PendingReferenceScheduler(reprocessPendingReference, {
    sweepIntervalMs: env.PENDING_REFERENCE_SWEEP_INTERVAL_MS,
    logger,
  });

  onShutdownSignal({
    drain: async () => {
      await scheduler.stop();
      await orm.close(true);
      say(`drained ${PENDING_REFERENCE_SCHEDULER}`);
    },
    gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
    logger,
  });

  scheduler.start();
  say('ready');

  // The process now belongs to the signal: `onShutdownSignal` is what ends it.
  await new Promise(() => {
    /* until SIGTERM */
  });
}

try {
  const attempts = [];

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    const swept = await reprocessPendingReference.execute();

    attempts.push(...swept);

    if (swept.length === 0) {
      break;
    }
  }

  process.stdout.write(JSON.stringify(attempts));
} finally {
  await orm.close(true);
}
