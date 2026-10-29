/**
 * One outbox publisher in a process of its own: the other instance OUTBOX-003 and OUTBOX-005 need.
 * It runs the loop the service runs, wired by `outboxPublisher` from the same environment, so what
 * a concurrency case drives is the publisher and not a re-implementation of it.
 *
 * Usage: `bun run test/helpers/publish-outbox.ts [options]`
 *
 * - `--batch-size N`, `--poll-interval N`: the publisher's two knobs, as `OUTBOX_BATCH_SIZE` and
 *   `OUTBOX_POLL_INTERVAL_MS` would set them.
 * - `--drain`: stop and exit once the outbox holds no pending row, so a case can wait for the work
 *   to be finished instead of for a timer.
 * - `--hold`: claim a batch and then stop before sending anything, holding the claim until the
 *   process is killed. It is how a case kills a publisher that holds rows nobody has published.
 *
 * It writes one line per event to stdout: `ready` when the loop started, `holding` when it is
 * holding a claim it will not publish, and `published <count>` before it exits, counting the
 * messages this process sent. The count is what proves two publishers claimed disjoint work: the
 * counts of all of them add up to the number of rows exactly once.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { loadEnv } from '../../src/infrastructure/config/env';
import { outboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

const argv = process.argv.slice(2);

const flag = (name: string): boolean => argv.includes(`--${name}`);

const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);

  return at === -1 ? undefined : argv[at + 1];
};

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const env = loadEnv({
  ...process.env,
  ...(option('batch-size') !== undefined && { OUTBOX_BATCH_SIZE: option('batch-size') }),
  ...(option('poll-interval') !== undefined && {
    OUTBOX_POLL_INTERVAL_MS: option('poll-interval'),
  }),
});

const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));

/** How often `--drain` asks whether anything is left; short, because the case waits on it. */
const DRAIN_POLL_MS = 100;

/** Never reached: the case kills the process while it holds its claim. */
const HOLD_MS = 600_000;

const pendingRows = async (): Promise<number> => {
  const [row] = await orm.em
    .getConnection()
    .execute<{ pending: string }[]>(
      'select count(*)::text as "pending" from "outbox_messages" where "published_at" is null',
    );

  return Number(row?.pending ?? '0');
};

let sent = 0;

/**
 * The real adapter, counting what it sent, and — with `--hold` — refusing to send at all: the
 * publisher is then holding a claimed batch of rows that no instance has published, which is the
 * state OUTBOX-005 kills a publisher in.
 */
const instrumented = (over: EventPublisher): EventPublisher => ({
  publish: async (message: OutboxMessage) => {
    if (flag('hold')) {
      say('holding');
      await Bun.sleep(HOLD_MS);
    }

    await over.publish(message);
    sent += 1;
  },
});

const publisher = outboxPublisher({
  em: orm.em,
  env,
  publisher: instrumented(
    new SqsEventPublisher(
      new SQSClient({
        region: env.AWS_REGION,
        ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
      }),
      { timeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS },
    ),
  ),
});

async function shutDown(): Promise<void> {
  await publisher.stop();
  say(`published ${sent.toString()}`);
  await orm.close(true);
}

process.on('SIGTERM', () => {
  void shutDown().then(() => process.exit(0));
});

publisher.start();
say('ready');

if (flag('drain')) {
  // Two empty readings in a row, so a publisher does not stop between another one's claim and the
  // commit that marks those rows published.
  let empty = 0;
  while (empty < 2) {
    await Bun.sleep(DRAIN_POLL_MS);
    empty = (await pendingRows()) === 0 ? empty + 1 : 0;
  }

  await shutDown();
}
