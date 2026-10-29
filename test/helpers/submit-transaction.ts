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
import { ApplicationError } from '../../src/application/errors';
import { openHelper, submitterOf, wagerCommandSchema } from './wager-command';

const [argument] = process.argv.slice(2);

if (argument === undefined) {
  throw new Error('submit-transaction expects the command as its one argument');
}

const command = wagerCommandSchema.parse(JSON.parse(argument) as unknown);
const { orm, env } = await openHelper();

try {
  const outcome = await submitterOf(orm, env).execute(command);

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
