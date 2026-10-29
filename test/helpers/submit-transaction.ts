/**
 * Applies one submission in a process of its own and exits: the other instance RULE-016 needs. The
 * command arrives as JSON on the command line and the only thing the process leaves behind is what
 * it committed, so two of these racing for one target share nothing but PostgreSQL — no heap, no
 * entity manager, no connection pool.
 *
 * Usage: `bun run test/helpers/submit-transaction.ts '<command as JSON>'`. It prints the recorded
 * outcome as JSON, and on a refusal of the request itself prints the `ErrorCode` the use case raised
 * and exits non-zero, so a caller racing two of these tells a rejection from a crash.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import { ApplicationError } from '../../src/application/errors';
import { sha256Hex } from '../../src/application/sha256';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

const commandSchema = z.object({
  operation: z.object({
    providerId: z.string(),
    externalTransactionId: z.string(),
    playerId: z.string(),
    walletId: z.string(),
    roundId: z.string(),
    gameId: z.string(),
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: z.string().nullable().default(null),
  }),
  idempotencyKey: z.string(),
  correlationId: z.string(),
});

const [argument] = process.argv.slice(2);

if (argument === undefined) {
  throw new Error('submit-transaction expects the command as its one argument');
}

const command = commandSchema.parse(JSON.parse(argument) as unknown);
const env = loadEnv(process.env);
const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));

try {
  const submitWagerTransaction = new SubmitWagerTransaction({
    unitOfWork: new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });
  const outcome = await submitWagerTransaction.execute(command);

  process.stdout.write(
    JSON.stringify({
      status: outcome.transaction.status,
      failureCode: outcome.transaction.failureCode,
      idempotentReplay: outcome.idempotentReplay,
    }),
  );
} catch (error) {
  process.stdout.write(error instanceof ApplicationError ? error.code : String(error));
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
