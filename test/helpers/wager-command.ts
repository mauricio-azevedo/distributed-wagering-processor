/**
 * What a helper process is told to submit, and what it reports back. It is shared by the two
 * process helpers — `submit-transaction.ts`, which applies one submission and dies, and
 * `wager-worker.ts`, which stays alive and applies the batches a concurrency case feeds it — so a
 * scenario means the same thing whichever of them a suite spawns.
 *
 * The schema is the business half of `WagerOperationFields` in
 * [docs/openapi.yaml](../../docs/openapi.yaml) plus the key and the correlation id, which is what
 * `SubmitWagerTransactionCommand` takes. It is validated rather than cast because the command
 * crosses a process boundary as text: a scenario that misspells a field has to fail in the helper
 * that received it, not three asserts later in the suite that sent it.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import { ApplicationError } from '../../src/application/errors';
import { sha256Hex } from '../../src/application/sha256';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import { systemClock } from '../../src/infrastructure/clock';
import { type Env, loadEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { uncountedMetrics } from '../../src/infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

export const wagerCommandSchema = z.object({
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

export type WagerCommand = z.input<typeof wagerCommandSchema>;

/** The command as the schema validated it, which is what the use case takes. */
export type ParsedWagerCommand = z.output<typeof wagerCommandSchema>;

/**
 * What one submission amounted to, as a process reports it: the recorded outcome off the row, or
 * the `ErrorCode` of a refusal of the request itself. A caller tells the two apart by the member,
 * which is why a refusal is reported rather than raised — a scenario racing submissions needs to
 * know which of them were refused and with what, not to lose the batch to the first exception.
 */
export type SubmissionReport =
  | {
      readonly transactionId: string;
      readonly status: string;
      readonly failureCode: string | null;
      readonly idempotentReplay: boolean;
    }
  | { readonly error: string };

/** The service, wired from the environment exactly as the composition root wires it. */
export function submitterOf(orm: MikroORM, env: Env): SubmitWagerTransaction {
  return new SubmitWagerTransaction({
    unitOfWork: new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
    // A helper process writes its lines to stderr, so a suite reading its stdout reads the outcome
    // alone, and counts nothing: the registry a metric is asserted on is the service's own.
    logger: jsonLinesLogger('wager-command', process.stderr),
    metrics: uncountedMetrics,
  });
}

/** The ORM and the environment a helper process runs on, opened once per process. */
export async function openHelper(): Promise<{ orm: MikroORM; env: Env }> {
  const env = loadEnv(process.env);

  return { orm: await MikroORM.init(ormConfig(env.DATABASE_URL)), env };
}

/**
 * One submission, applied and reported. Only an `ApplicationError` is reported as a refusal: a
 * defect has no `ErrorCode` and must not be flattened into one, so it reaches the caller as the
 * message it carries and fails the scenario that sent it.
 */
export async function submitReporting(
  submit: SubmitWagerTransaction,
  command: ParsedWagerCommand,
): Promise<SubmissionReport> {
  try {
    const outcome = await submit.execute(command);

    return {
      transactionId: outcome.transaction.id,
      status: outcome.transaction.status,
      failureCode: outcome.transaction.failureCode,
      idempotentReplay: outcome.idempotentReplay,
    };
  } catch (error) {
    return { error: error instanceof ApplicationError ? error.code : String(error) };
  }
}
