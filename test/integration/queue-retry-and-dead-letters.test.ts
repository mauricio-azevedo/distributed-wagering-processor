import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { ServiceUnavailableError } from '../../src/application/errors';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import {
  type DeliveryOutcome,
  type MessageDelivery,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/use-cases/submit-wager-transaction';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import {
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../../src/infrastructure/messaging/sqs';
import {
  type DeliveryReport,
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
  type WagerTransactionsConsumerDependencies,
} from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { CounterRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * What the consumer does about a delivery that did not end in a business outcome: the classification
 * before the action, the visibility backoff of a transient failure and its exhaustion into the
 * dead-letter queue, the direct forward of a permanent one, and the ordering that keeps a refused
 * forward from deleting anything (MSG-007, MSG-008, MSG-009, MSG-011).
 *
 * The transient failure is injected at the use case rather than by stopping PostgreSQL, for the
 * reason `bet-atomicity.test.ts` injects its own: what is under test is the consumer's reaction to a
 * class of failure, one message at a time and with the other messages of the batch unaffected, and a
 * container that is down fails every suite that shares it. Which driver errors are that class is
 * proven against PostgreSQL's own vocabulary in `transient-failure.test.ts`.
 *
 * Everything else is real: LocalStack's queues with the redrive policy the stack creates them with,
 * a committed database, and a forward whose failure is a queue that genuinely does not exist.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

/**
 * The consumer settings this suite runs with. The backoff is a second doubling to a four-second
 * ceiling, so the schedule is visible in the reports and the five receives the redrive policy allows
 * are exhausted in seconds rather than in the twelve minutes the deployed default would take; a
 * receive makes a message invisible for a second, so the one a test left behind is back on the next
 * poll.
 */
const RETRY_BACKOFF = { baseSeconds: 1, maxSeconds: 4 };
const VISIBILITY_TIMEOUT_SECONDS = 1;
const WAIT_TIME_SECONDS = 1;

/** `maxReceiveCount` of the redrive policy docker/localstack/queues.sh creates the queue with. */
const MAX_RECEIVES = 5;

/** The waits the five receives of one message earn: a second doubling, then the ceiling. */
const BACKOFF_SCHEDULE = [1, 2, 4, 4, 4];

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';

/** How a report about a body that never parsed is keyed, there being no message id to key it by. */
const UNPARSABLE = 'unparsable';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/**
 * The transient failure an injection stands for: what the unit of work raises when it cannot reach
 * PostgreSQL (`api.transient-failure`).
 */
const DROPPED = () =>
  new ServiceUnavailableError(
    'The service could not reach the database to complete the operation.',
    5,
  );

/**
 * The use case with PostgreSQL unreachable for the message ids a test nominates, and reachable for
 * every other one. A single instance therefore carries a batch in which one message fails
 * transiently and the others are applied, which is what `msg.classification` is about: the class is
 * decided per delivery, and the action follows the class.
 */
class UnreachableFor extends SubmitWagerTransaction {
  private readonly unreachable = new Set<string>();

  outageFor(messageId: string): string {
    this.unreachable.add(messageId);

    return messageId;
  }

  recovers(messageId: string): void {
    this.unreachable.delete(messageId);
  }

  override deliver(
    command: SubmitWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<DeliveryOutcome> {
    return this.unreachable.has(delivery.messageId)
      ? Promise.reject(DROPPED())
      : super.deliver(command, delivery);
  }
}

/** A defect: the one error class `msg.classification` names nothing for (`ref.permanent-failure`). */
class Defective extends SubmitWagerTransaction {
  override deliver(): Promise<DeliveryOutcome> {
    return Promise.reject(new TypeError('reading a property of undefined'));
  }
}

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let openWallet: OpenWallet;
let submit: UnreachableFor;
let consumer: WagerTransactionsConsumer;
let metrics: CounterRegistry;
let sqs: SQSClient;
let queueUrl: string;
let deadLetterQueueUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));

  const unitOfWork = new MikroOrmUnitOfWork(runtime.em, env.LOCK_TIMEOUT_MS);
  const dependencies = { unitOfWork, clock: systemClock, ids: uuidV7IdGenerator, sha256Hex };

  openWallet = new OpenWallet(dependencies);
  submit = new UnreachableFor(dependencies);
  metrics = new CounterRegistry();
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  queueUrl = await urlOf(WAGER_TRANSACTIONS_QUEUE);
  deadLetterQueueUrl = await urlOf(WAGER_TRANSACTIONS_DLQ);
  consumer = consumerWith();
});

afterAll(async () => {
  await drainInput();
  await drain(deadLetterQueueUrl);
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
}, 60_000);

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  // Both queues: this suite leaves messages in the input queue on purpose and fills the dead-letter
  // queue, so one test would otherwise read another's.
  await drainInput();
  await drain(deadLetterQueueUrl);
}, 60_000);

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
}, 20_000);

async function urlOf(queueName: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queueName}`);
  }

  return QueueUrl;
}

/**
 * The consumer under test. The defaults are the suite's; a test overrides the use case behind it, or
 * the queue it forwards to when what is under test is a forward the broker refuses.
 */
function consumerWith(
  overrides: Partial<WagerTransactionsConsumerDependencies> = {},
): WagerTransactionsConsumer {
  return new WagerTransactionsConsumer({
    sqs,
    queueUrl: () => Promise.resolve(queueUrl),
    deadLetterQueueUrl: () => Promise.resolve(deadLetterQueueUrl),
    submit,
    metrics,
    logger: { error: () => undefined },
    consumerName: WAGER_TRANSACTIONS_CONSUMER,
    waitTimeSeconds: WAIT_TIME_SECONDS,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    retryBackoff: RETRY_BACKOFF,
    ...overrides,
  });
}

/**
 * Receives and deletes everything a queue holds. A message a test left behind is invisible for as
 * long as the backoff it was returned with, so the input queue is drained until it has stayed empty
 * for one such window; the dead-letter queue holds nothing invisible, so an empty receive ends it.
 */
const drainInput = () =>
  drain(queueUrl, (VISIBILITY_TIMEOUT_SECONDS + RETRY_BACKOFF.maxSeconds) * 1000);

async function drain(url: string, quietForMs = 0): Promise<void> {
  const deadline = Date.now() + 45_000;
  let quietUntil = Date.now() + quietForMs;

  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        // Not zero: a receipt handle expires with the visibility it was handed out under, and the
        // delete below needs a handle that is still valid.
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      }),
    );

    if (Messages === undefined || Messages.length === 0) {
      if (Date.now() >= quietUntil) {
        return;
      }

      continue;
    }

    for (const message of Messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
      );
    }

    quietUntil = Date.now() + quietForMs;

    if (Date.now() > deadline) {
      throw new Error(`${url} did not drain, so the next test would see another message`);
    }
  }
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** One wallet per player and currency (`wallet.one-per-player-currency`), so a test opening two names two players. */
async function wallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const opened = await openWallet.execute({
    playerId,
    initialBalance: brl(initialBalance),
    correlationId: CORRELATION_ID,
  });

  return touched.add(opened.id);
}

/** The `bet` message example of [docs/asyncapi.yaml], with `data` carrying the key. */
function message(
  walletId: string,
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  const operation = {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl('40.00'),
    ...data,
  };

  return {
    messageId: 'acme-msg-000123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-28T12:05:00.000Z',
    correlationId: 'acme-req-5f2c',
    data: {
      ...operation,
      idempotencyKey: `${operation.providerId}:${operation.externalTransactionId}`,
    },
    ...overrides,
  };
}

/**
 * One message, with a deduplication id of its own. The producer contract asks for the wallet as
 * `MessageGroupId` and `messageId` as `MessageDeduplicationId` (`msg.producer-contract`), and both
 * are advisory: a suite that sends the same body twice has to defeat the broker's five-minute window
 * to prove the database is what deduplicates (`msg.broker-features-optional`).
 */
async function send(body: Record<string, unknown> | string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/**
 * The report about each of `count` messages, the first one per message. Polls until it has them all,
 * because a broker is free to hand over fewer messages than are waiting, and a message this consumer
 * returned to the queue is free to come back while the rest are still being collected. A redelivery
 * is due when a visibility expires, and when exactly is the broker's to decide, so a test that waits
 * for one waits for the report rather than for a number of milliseconds.
 */
async function pollUntilReported(
  count: number,
  timeoutMs: number,
  using = consumer,
): Promise<Map<string, DeliveryReport>> {
  const reported = new Map<string, DeliveryReport>();
  const deadline = Date.now() + timeoutMs;

  while (reported.size < count) {
    for (const report of await using.poll()) {
      const key = report.messageId ?? UNPARSABLE;

      if (!reported.has(key)) {
        reported.set(key, report);
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        `${reported.size.toString()} of ${count.toString()} messages were delivered within ${timeoutMs.toString()} ms`,
      );
    }
  }

  return reported;
}

async function pollOne(timeoutMs = 10_000, using = consumer): Promise<DeliveryReport> {
  const [report] = (await pollUntilReported(1, timeoutMs, using)).values();

  if (report === undefined) {
    throw new Error('no report was produced');
  }

  return report;
}

/** The body message id of everything a queue holds, taken without hiding it from the next read. */
async function contentsOf(url: string): Promise<string[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
    }),
  );

  return (Messages ?? []).map(({ Body }) => messageIdOf(Body));
}

/**
 * How a queued body is named in an assertion: by its message id, and by the body itself when there
 * is none to read. A dead letter is forwarded unchanged, so the queue holds bodies that never
 * parsed — validation failure being one of the permanent classes.
 */
function messageIdOf(body: string | undefined): string {
  if (body === undefined) {
    return UNPARSABLE;
  }

  try {
    return (JSON.parse(body) as { messageId?: string }).messageId ?? body;
  } catch {
    return body;
  }
}

/**
 * A queue read until it holds everything a test is waiting for, the send being the broker's to time.
 * With nothing expected it is one read, which is how a test asserts a queue is empty.
 */
async function awaitContents(
  url: string,
  expected: readonly string[],
  timeoutMs = 15_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let contents = await contentsOf(url);

  while (!expected.every((entry) => contents.includes(entry)) && Date.now() < deadline) {
    contents = await contentsOf(url);
  }

  return contents;
}

/**
 * The dead-letter queue read until the broker has moved a message there, polling the input queue
 * while it waits: a redrive is decided on a receive and not by the passage of time, so a message
 * whose receives are exhausted is moved the next time someone asks for it.
 */
async function awaitRedriven(messageId: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const contents = await contentsOf(deadLetterQueueUrl);

    if (contents.includes(messageId) || Date.now() > deadline) {
      return contents;
    }

    await consumer.poll();
  }
}

const rows = async <Row>(sql: string, parameters: unknown[] = []): Promise<Row[]> =>
  runtime.em.getConnection().execute<Row[]>(sql, parameters);

interface TransactionRow {
  readonly status: string;
  readonly kind: string;
  readonly amount: string;
  readonly failure_code: string | null;
  readonly observed_balance: string | null;
}

/** What a provider submitted on a wallet; the internal `OPENING` credit is not one of those. */
const transactionsOf = (walletId: string) =>
  rows<TransactionRow>(
    `select status, kind, amount::text, failure_code, observed_balance::text
       from wager_transactions where wallet_id = ? and provider_id <> 'system' order by created_at`,
    [walletId],
  );

/** The entries provider operations wrote, so the opening credit's entry is left out. */
const entriesOf = (walletId: string) =>
  rows<{ amount: string }>(
    `select amount::text from wallet_ledger_entries where wallet_id = ? and kind <> 'OPENING'`,
    [walletId],
  );

const balanceOf = async (walletId: string) =>
  (
    await rows<{ balance: string; version: number }>(
      `select balance::text, version from wallets where id = ?`,
      [walletId],
    )
  )[0];

const inboxMessageIds = async () =>
  (
    await rows<{ message_id: string }>(`select message_id from inbox_messages order by received_at`)
  ).map((row) => row.message_id);

/** What a report amounted to, as the pair every assertion about a class is made on. */
const actedOn = (reported: Map<string, DeliveryReport>): Record<string, string[]> =>
  Object.fromEntries(
    [...reported].map(([key, report]) => [key, [report.classification, report.disposition]]),
  );

/**
 * MSG-007: the three classes of one delivery, decided before anything is done to the message, and
 * the three actions they decide. They are driven as one batch because the classification is per
 * delivery: a message that cannot be applied must not change what happens to the others.
 */
describe('consumer-outcome-classification', () => {
  test('a rejection is acknowledged, an outage is returned and a malformed body is dead-lettered', async () => {
    const rejected = await wallet('30.00');
    const unavailable = await wallet('500.00', OTHER_PLAYER_ID);

    submit.outageFor('acme-msg-outage');

    await send(message(rejected, { messageId: 'acme-msg-rejected' }), rejected);
    await send(message(unavailable, { messageId: 'acme-msg-outage' }), unavailable);
    await send('{ not json', 'acme-group-malformed');

    expect(actedOn(await pollUntilReported(3, 20_000))).toEqual({
      'acme-msg-rejected': ['business', 'acknowledged'],
      'acme-msg-outage': ['transient', 'returned'],
      [UNPARSABLE]: ['permanent', 'dead-lettered'],
    });

    // The rejection is a persisted outcome and no movement; the outage left nothing at all.
    expect(await transactionsOf(rejected)).toMatchObject([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE', observed_balance: '30.00' },
    ]);
    expect(await transactionsOf(unavailable)).toEqual([]);
    expect(await inboxMessageIds()).toEqual(['acme-msg-rejected']);

    // The malformed body is in the dead-letter queue unchanged, and the returned message is the only
    // one the input queue still holds.
    expect(await awaitContents(deadLetterQueueUrl, ['{ not json'])).toEqual(['{ not json']);
    expect(await awaitContents(queueUrl, ['acme-msg-outage'])).toEqual(['acme-msg-outage']);
  }, 60_000);

  /**
   * `ref.permanent-failure`: an error no rule classified is transient, so a defect surfaces as a
   * retry and, its receives exhausted, as a dead letter the broker made — never as a message
   * acknowledged as if it had been applied.
   */
  test('an error that cannot be classified is treated as transient', async () => {
    const walletId = await wallet('500.00');
    const defective = consumerWith({ submit: new Defective(dependenciesOf()) });

    await send(message(walletId), walletId);

    const report = await pollOne(10_000, defective);

    expect(report).toMatchObject({ classification: 'transient', disposition: 'returned' });
    expect(await transactionsOf(walletId)).toEqual([]);
    expect(await awaitContents(deadLetterQueueUrl, [])).toEqual([]);
  }, 30_000);

  function dependenciesOf() {
    return {
      unitOfWork: new MikroOrmUnitOfWork(runtime.em, env.LOCK_TIMEOUT_MS),
      clock: systemClock,
      ids: uuidV7IdGenerator,
      sha256Hex,
    };
  }
});

/**
 * MSG-008: the retry sequence of one message, from the first transient failure to the dead-letter
 * queue the broker puts it in. The consumer counts nothing and gives up on nothing — it asks for a
 * visibility per delivery, and the redrive policy is what ends the sequence.
 */
describe('transient-backoff-then-dlq', () => {
  test('a message that keeps failing comes back on a growing backoff and the broker dead-letters it', async () => {
    const walletId = await wallet('500.00');
    const failing = submit.outageFor('acme-msg-outage');

    await send(message(walletId, { messageId: failing }), walletId);

    const backoffs: number[] = [];

    for (let receive = 0; receive < MAX_RECEIVES; receive += 1) {
      const report = await pollOne(20_000);

      expect(report).toMatchObject({
        classification: 'transient',
        disposition: 'returned',
        messageId: failing,
      });
      backoffs.push(report.classification === 'transient' ? report.visibilitySeconds : -1);
    }

    // The wait grows with the receive count and stops at the ceiling (`msg.transient-backoff`).
    expect(backoffs).toEqual(BACKOFF_SCHEDULE);

    // Past the receives the redrive policy allows, the broker moves the message instead of
    // delivering it again: the consumer never sees it a sixth time and never deleted it.
    expect(await awaitRedriven(failing, 30_000)).toEqual([failing]);
    expect(await transactionsOf(walletId)).toEqual([]);
    expect(await inboxMessageIds()).toEqual([]);
  }, 120_000);

  test('a transient failure that clears is applied on a later receive, with nothing lost', async () => {
    const walletId = await wallet('500.00');
    const failing = submit.outageFor('acme-msg-000123');

    await send(message(walletId), walletId);

    expect(await pollOne()).toMatchObject({
      classification: 'transient',
      disposition: 'returned',
    });
    expect(await transactionsOf(walletId)).toEqual([]);

    submit.recovers(failing);

    expect(await pollOne(20_000)).toMatchObject({
      classification: 'business',
      disposition: 'acknowledged',
    });
    expect(await transactionsOf(walletId)).toMatchObject([
      { status: 'PROCESSED', amount: '40.00', observed_balance: '460.00' },
    ]);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await awaitContents(queueUrl, [])).toEqual([]);
    expect(await awaitContents(deadLetterQueueUrl, [])).toEqual([]);
  }, 60_000);
});

/**
 * MSG-009: a permanent failure forwarded by the consumer, without waiting out five receives of a
 * failure nobody can fix, and the ordering that makes the forward safe.
 */
describe('permanent-failure-to-dlq', () => {
  /** `msg.unknown-wallet-permanent`: the row cannot be written, so nothing is. */
  test('a message for a wallet that does not exist is dead-lettered on the first receive', async () => {
    await send(message(UNKNOWN_WALLET_ID), UNKNOWN_WALLET_ID);

    expect(await pollOne()).toMatchObject({
      classification: 'permanent',
      disposition: 'dead-lettered',
    });
    expect(await transactionsOf(UNKNOWN_WALLET_ID)).toEqual([]);
    expect(await inboxMessageIds()).toEqual([]);
    expect(await awaitContents(deadLetterQueueUrl, ['acme-msg-000123'])).toEqual([
      'acme-msg-000123',
    ]);
    expect(await awaitContents(queueUrl, [])).toEqual([]);
  }, 30_000);

  /**
   * The ordering rule: the forward precedes the delete, so a send the broker refuses leaves the
   * message in the input queue. It is then retried and, its receives exhausted, dead-lettered by the
   * redrive policy — the one path that does not depend on this consumer reaching the queue it was
   * told to forward to.
   */
  test('a forward the broker refuses never deletes the source message', async () => {
    const refusing = consumerWith({
      deadLetterQueueUrl: () => Promise.resolve(`${deadLetterQueueUrl}-does-not-exist`),
    });

    await send(message(UNKNOWN_WALLET_ID), UNKNOWN_WALLET_ID);

    expect(await pollOne(10_000, refusing)).toMatchObject({
      classification: 'permanent',
      disposition: 'retained',
    });
    expect(await awaitContents(queueUrl, ['acme-msg-000123'])).toEqual(['acme-msg-000123']);
    expect(await awaitContents(deadLetterQueueUrl, [])).toEqual([]);
  }, 30_000);
});

/**
 * MSG-011: the invariants hold with the two broker features the contract calls optimizations taken
 * away — the order deliveries arrive in, and the deduplication window. The duplicate here carries a
 * deduplication id of its own, so the broker does not filter it and the inbox row is what does.
 */
describe('correct-without-fifo', () => {
  test('a reversal before its target, and a duplicate the broker did not filter, leave one effect each', async () => {
    const walletId = await wallet('500.00');
    const refund = message(
      walletId,
      { messageId: 'acme-msg-refund' },
      {
        externalTransactionId: 'acme-tx-000124',
        kind: 'REFUND',
        referenceExternalTransactionId: 'acme-tx-000123',
      },
    );

    // The reversal arrives before the operation it reverses, which is an order a queue that does not
    // order anything may well deliver them in: it is parked rather than refused (`tx.reference-matrix`).
    await send(refund, 'acme-group-refund');

    expect(await pollOne()).toMatchObject({
      classification: 'business',
      disposition: 'acknowledged',
      messageId: 'acme-msg-refund',
    });

    await send(message(walletId), walletId);

    expect(await pollOne()).toMatchObject({
      classification: 'business',
      disposition: 'acknowledged',
      messageId: 'acme-msg-000123',
    });

    // The same body again, with a deduplication id the broker has not seen: the inbox absorbs it.
    const duplicates = metrics.total('wager_duplicates_detected_total', { source: 'inbox' });

    await send(message(walletId), walletId);

    const redelivered = await pollOne();

    expect(redelivered).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(redelivered.classification === 'business' && redelivered.outcome.absorbed).toBe(true);
    expect(metrics.total('wager_duplicates_detected_total', { source: 'inbox' })).toBe(
      duplicates + 1,
    );

    // One debit for the operation, one entry, and the reversal still waiting for its target.
    expect(await transactionsOf(walletId)).toMatchObject([
      { kind: 'REFUND', status: 'PENDING_REFERENCE' },
      { kind: 'BET', status: 'PROCESSED', observed_balance: '460.00' },
    ]);
    expect(await entriesOf(walletId)).toEqual([{ amount: '40.00' }]);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await inboxMessageIds()).toEqual(['acme-msg-refund', 'acme-msg-000123']);
    expect(await awaitContents(queueUrl, [])).toEqual([]);
    expect(await awaitContents(deadLetterQueueUrl, [])).toEqual([]);
  }, 60_000);
});
