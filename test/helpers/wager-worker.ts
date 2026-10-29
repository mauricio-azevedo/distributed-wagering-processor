/**
 * One service instance, as a process a concurrency case can load (`conc.multi-instance`). It boots
 * the use case once and then applies the batches the case feeds it over stdin, so a scenario costs
 * a round trip instead of a process start and a hundred rounds of two racing bets are affordable.
 *
 * Nothing but PostgreSQL connects two of these: no heap, no entity manager, no connection pool and
 * no event loop. That is the whole point — a race between promises in one runtime proves nothing
 * about a deployment, because a single event loop never interleaves two transactions the way two
 * processes do.
 *
 * Usage: `bun run test/helpers/wager-worker.ts`, with one JSON command per line on stdin:
 *
 * - `{"arm":"<batch id>","concurrency":N,"operations":[<command>,...]}` — parse and hold a batch,
 *   answering `armed <batch id>`. Nothing is submitted yet.
 *   `{"fire":"<batch id>","at":<epoch ms>}` — submit the armed batch, starting at `at`.
 * - `{"stop":true}` — close the connection and exit.
 *
 * Arming and firing are separate because the barrier needs both: the case waits for every worker to
 * answer `armed` before it picks the instant, so the start is agreed by processes that are all ready,
 * and `at` is a wall-clock instant they share, so three of them issue their first statement together
 * rather than in the order the case happened to write to their pipes.
 *
 * It answers `done <batch id> <results as JSON>`, one entry per operation in the order they were
 * given: the recorded outcome, or the `ErrorCode` of a refusal (`SubmissionReport`). A refusal is
 * reported and never raised, so a batch is reported whole and the case decides what each outcome
 * means.
 */
import { z } from 'zod';

import type { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import {
  type ParsedWagerCommand,
  type SubmissionReport,
  openHelper,
  submitReporting,
  submitterOf,
  wagerCommandSchema,
} from './wager-command';

const instructionSchema = z.union([
  z.object({
    arm: z.string(),
    /** How many of the batch's operations this instance keeps in flight at once. */
    concurrency: z.number().int().min(1),
    operations: z.array(wagerCommandSchema).min(1),
  }),
  z.object({ fire: z.string(), at: z.number().int().min(0) }),
  z.object({ stop: z.literal(true) }),
]);

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { orm, env } = await openHelper();
const submit = submitterOf(orm, env);

/** The batches armed and not yet fired; a case arms one at a time, but nothing here requires that. */
const armed = new Map<string, { concurrency: number; operations: ParsedWagerCommand[] }>();

/**
 * The batch, applied with at most `concurrency` submissions open at once. The operations are taken
 * from one cursor by that many loops, so a slow submission delays nothing but itself and the
 * instance keeps the pressure on the database steady rather than in waves.
 */
async function apply(
  batch: { concurrency: number; operations: ParsedWagerCommand[] },
  submitter: SubmitWagerTransaction,
): Promise<SubmissionReport[]> {
  const reports = new Array<SubmissionReport>(batch.operations.length);
  let next = 0;

  const lane = async (): Promise<void> => {
    for (let index = next++; index < batch.operations.length; index = next++) {
      const command = batch.operations[index];

      if (command === undefined) {
        return;
      }

      reports[index] = await submitReporting(submitter, command);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(batch.concurrency, batch.operations.length) }, lane),
  );

  return reports;
}

/** Returns `false` when the instruction was to stop, which is what ends the loop. */
async function handle(line: string): Promise<boolean> {
  if (line.trim() === '') {
    return true;
  }

  const instruction = instructionSchema.parse(JSON.parse(line) as unknown);

  if ('stop' in instruction) {
    return false;
  }

  if ('arm' in instruction) {
    armed.set(instruction.arm, {
      concurrency: instruction.concurrency,
      operations: instruction.operations,
    });
    say(`armed ${instruction.arm}`);

    return true;
  }

  const batch = armed.get(instruction.fire);

  if (batch === undefined) {
    throw new Error(`no batch ${instruction.fire} is armed`);
  }
  armed.delete(instruction.fire);

  // The agreed instant. An instance that reached this line late starts at once, which skews the
  // start rather than serializing the batch; one that reached it early waits for the others.
  await Bun.sleep(Math.max(0, instruction.at - Date.now()));

  say(`done ${instruction.fire} ${JSON.stringify(await apply(batch, submit))}`);

  return true;
}

say(`ready ${process.pid.toString()}`);

try {
  const decoder = new TextDecoder();
  let buffered = '';
  let running = true;

  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      running = await handle(line);

      if (!running) {
        break;
      }
    }

    if (!running) {
      break;
    }
  }
} finally {
  await orm.close(true);
}
