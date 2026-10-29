import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import { InboxPayloadConflictError, ServiceUnavailableError } from '../../src/application/errors';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import {
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../../src/infrastructure/messaging/sqs';
import { MessageContractError } from '../../src/infrastructure/messaging/wager-transaction-message.dto';
import {
  type DeliveryReport,
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
} from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { CounterRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

/**
 * The consumer settings this suite runs the service with. The suite drives `poll` itself, so a
 * receive answers at once instead of long polling, and a message a dead worker left behind comes
 * back after two seconds instead of the thirty a deployment would wait (`msg.ack-after-commit`).
 */
const CONSUMER_ENV = {
  LOCK_TIMEOUT_MS: 250,
  SQS_WAIT_TIME_SECONDS: 1,
  SQS_VISIBILITY_TIMEOUT_SECONDS: 1,
};

/** The same seconds the helper process runs with, so this suite knows when a redelivery is due. */
const VISIBILITY_TIMEOUT_MS = CONSUMER_ENV.SQS_VISIBILITY_TIMEOUT_SECONDS * 1000;

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

const touched = new TouchedWallets();

/** Whether the test that just ran left a message in the input queue, invisible for its window. */
let messagesLeftInFlight = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let schema: MikroORM;
let runtime: MikroORM;
let app: INestApplication;
let baseUrl: string;
let consumer: WagerTransactionsConsumer;
let metrics: CounterRegistry;
let sqs: SQSClient;
let queueUrl: string;
let deadLetterQueueUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  app = await NestFactory.create(AppModule.create({ ...env, ...CONSUMER_ENV }), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
  consumer = app.get(WagerTransactionsConsumer);
  metrics = app.get(CounterRegistry);
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  queueUrl = await urlOf(WAGER_TRANSACTIONS_QUEUE);
  deadLetterQueueUrl = await urlOf(WAGER_TRANSACTIONS_DLQ);
});

afterAll(async () => {
  await drainQueue({ inFlight: messagesLeftInFlight });
  await drainDeadLetterQueue();
  await app.close();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);

  // A message this slice did not acknowledge is still in the queue, invisible until its visibility
  // expires, so the next test waits that out before draining: it is the cost of the behaviour under
  // test, and the alternative — leaving it — would hand another test a message of its own.
  await drainQueue({ inFlight: messagesLeftInFlight });
  // A permanent failure is forwarded before it is deleted (`msg.permanent-to-dlq`), so a test that
  // drove one left a body in the dead-letter queue for the next one to find.
  await drainDeadLetterQueue();
  messagesLeftInFlight = false;
}, 20_000);

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

async function urlOf(queueName: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queueName}`);
  }

  return QueueUrl;
}

/** The dead-letter queue holds nothing invisible, so one empty receive is the whole drain. */
async function drainDeadLetterQueue(): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: CONSUMER_ENV.SQS_VISIBILITY_TIMEOUT_SECONDS,
      }),
    );

    if (Messages === undefined || Messages.length === 0) {
      return;
    }

    for (const message of Messages) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
}

/**
 * Receives and deletes whatever is in the queue, so one test never sees another's message. A
 * message another test left invisible is not reachable here, which is why every test sends ids of
 * its own and asserts on the wallet it opened.
 */
async function drainQueue(options: { inFlight: boolean }): Promise<void> {
  const deadline = Date.now() + 20_000;
  // A message the consumer did not acknowledge is invisible until its visibility expires, so a
  // drain after such a test keeps receiving until the queue has stayed empty for one window; one
  // after a test that acknowledged everything only has to see an empty receive.
  const quietFor = options.inFlight ? VISIBILITY_TIMEOUT_MS + 300 : 0;
  let quietUntil = Date.now() + quietFor;

  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: options.inFlight ? 1 : 0,
        // Not zero: a receipt handle expires with the visibility it was handed out under, and the
        // delete below needs a handle that is still valid.
        VisibilityTimeout: CONSUMER_ENV.SQS_VISIBILITY_TIMEOUT_SECONDS,
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
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }

    quietUntil = Date.now() + quietFor;

    if (Date.now() > deadline) {
      throw new Error('the input queue did not drain, so the next test would see another message');
    }
  }
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: brl(initialBalance) }),
  });
  const body = (await response.json()) as { id?: string };

  if (response.status !== 201 || typeof body.id !== 'string') {
    throw new Error(`opening a wallet answered ${response.status.toString()}`);
  }

  return touched.add(body.id);
}

/** A bet over HTTP, for the comparisons that hold the two entry points to one outcome. */
async function submitOverHttp(
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<number> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });

  return response.status;
}

/** The business fields of the `bet` example of both transport contracts. */
function bet(walletId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl('40.00'),
    ...overrides,
  };
}

/** The `bet` message example of [docs/asyncapi.yaml], with `data` carrying the key. */
function betMessage(
  walletId: string,
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  const operation = bet(walletId, data);

  return {
    messageId: 'acme-msg-000123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-28T12:05:00.000Z',
    correlationId: 'acme-req-5f2c',
    data: {
      ...operation,
      idempotencyKey: `${String(operation['providerId'])}:${String(operation['externalTransactionId'])}`,
    },
    ...overrides,
  };
}

/**
 * One message, with a deduplication id of its own. The producer contract asks for the wallet as
 * `MessageGroupId` and `messageId` as `MessageDeduplicationId` (`msg.producer-contract`), and both
 * are advisory: a suite that sends the same body twice has to defeat the broker's five-minute
 * window to prove the database is what deduplicates (`msg.broker-features-optional`).
 */
async function send(
  message: Record<string, unknown> | string,
  groupId: string,
): Promise<string | undefined> {
  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof message === 'string' ? message : JSON.stringify(message),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );

  return sent.MessageId;
}

/** One poll, which this suite drives instead of the loop, with the single report it expects. */
async function pollOne(): Promise<DeliveryReport> {
  return reportOf(await consumer.poll());
}

/**
 * The next report, polled until one arrives or the deadline passes. A redelivery is due when the
 * visibility of the message expires, and when exactly is the broker's to decide, so a test that
 * waits for one waits for the report rather than for a number of milliseconds.
 */
async function pollUntilOne(timeoutMs: number): Promise<DeliveryReport> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const reports = await consumer.poll();

    if (reports.length > 0) {
      return reportOf(reports);
    }

    if (Date.now() > deadline) {
      throw new Error(`no message was delivered within ${timeoutMs.toString()} ms`);
    }
  }
}

function reportOf(reports: readonly DeliveryReport[]): DeliveryReport {
  const [report] = reports;

  if (reports.length !== 1 || report === undefined) {
    throw new Error(`expected one message to be processed, got ${reports.length.toString()}`);
  }

  // Both an acknowledgement and a forward end with the delete, so only the other two dispositions
  // leave the input queue holding something the next test has to wait out.
  messagesLeftInFlight ||= report.disposition === 'returned' || report.disposition === 'retained';

  return report;
}

const rows = async <Row>(sql: string, parameters: unknown[] = []): Promise<Row[]> =>
  runtime.em.getConnection().execute<Row[]>(sql, parameters);

interface TransactionRow {
  readonly id: string;
  readonly status: string;
  readonly kind: string;
  readonly amount: string;
  readonly failure_code: string | null;
  readonly observed_balance: string | null;
  readonly idempotency_key: string;
  readonly payload_hash: string;
}

/** What a provider submitted on a wallet; the internal `OPENING` credit is not one of those. */
const transactionsOf = (walletId: string) =>
  rows<TransactionRow>(
    `select id, status, kind, amount::text, failure_code, observed_balance::text, idempotency_key, payload_hash
       from wager_transactions where wallet_id = ? and provider_id <> 'system' order by created_at`,
    [walletId],
  );

/** The entries provider operations wrote, so the opening credit's entry is left out. */
const entriesOf = (walletId: string) =>
  rows<{ direction: string; amount: string; balance_after: string }>(
    `select direction, amount::text, balance_after::text
       from wallet_ledger_entries where wallet_id = ? and kind <> 'OPENING'`,
    [walletId],
  );

const balanceOf = async (walletId: string) =>
  (
    await rows<{ balance: string; version: number }>(
      `select balance::text, version from wallets where id = ?`,
      [walletId],
    )
  )[0];

const inboxRows = () =>
  rows<{
    consumer_name: string;
    message_id: string;
    payload_hash: string;
    processed_at: Date | null;
  }>(
    `select consumer_name, message_id, payload_hash, processed_at from inbox_messages order by received_at`,
  );

/** The events one transaction's processing produced (`event.correlation-causation`). */
const eventsOf = (transactionId: string) =>
  rows<{ event_type: string; payload: { correlationId: string } }>(
    `select event_type, payload from outbox_messages
      where payload->>'causationId' = ? order by occurred_at, event_id`,
    [transactionId],
  );

/**
 * The body message id of everything the queue still holds, which is what an acknowledgement is
 * asserted against. It long polls, so an empty answer is not a short poll that looked away, and it
 * returns the visibility it took, so asking does not hide a message from the next question.
 */
const queueContents = () => contentsOf(queueUrl);

/**
 * The same of the dead-letter queue, which is where a permanently failed message is asserted
 * against: the forward is the consumer's own and precedes the delete (`msg.permanent-to-dlq`), so a
 * test reads both queues to see the message moved rather than lost.
 */
const deadLetterContents = () => contentsOf(deadLetterQueueUrl);

const contentsOf = async (url: string): Promise<string[]> => {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
    }),
  );

  return (Messages ?? []).map(({ Body }) => messageIdOf(Body));
};

/**
 * How a queued body is named in an assertion: by its message id, and by the body itself when there
 * is none to read. A dead letter is forwarded unchanged, so the queue holds bodies that never
 * parsed — validation failure being one of the permanent classes.
 */
function messageIdOf(body: string | undefined): string {
  if (body === undefined) {
    return 'unparsable';
  }

  try {
    return (JSON.parse(body) as { messageId?: string }).messageId ?? body;
  } catch {
    return body;
  }
}

describe('consumer-uses-same-use-case', () => {
  test('a submitted message produces the effects the HTTP path produces for the same payload', async () => {
    const overQueue = await openWallet('500.00');
    const overHttp = await openWallet('500.00', OTHER_PLAYER_ID);

    await send(betMessage(overQueue), overQueue);
    const report = await pollOne();
    const submittedOverHttp = bet(overHttp, {
      playerId: OTHER_PLAYER_ID,
      externalTransactionId: 'acme-tx-000124',
    });

    expect(await submitOverHttp(submittedOverHttp, 'provider-acme:acme-tx-000124')).toBe(200);

    expect(report).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(report.classification === 'business' && report.outcome.absorbed).toBe(false);

    const [queued] = await transactionsOf(overQueue);
    const [submitted] = await transactionsOf(overHttp);
    const outcome = (row: TransactionRow | undefined) => ({
      status: row?.status,
      kind: row?.kind,
      amount: row?.amount,
      failureCode: row?.failure_code,
      observedBalance: row?.observed_balance,
    });

    expect(outcome(queued)).toEqual(outcome(submitted));
    expect(outcome(queued)).toEqual({
      status: 'PROCESSED',
      kind: 'BET',
      amount: '40.00',
      failureCode: null,
      observedBalance: '460.00',
    });
    expect(await entriesOf(overQueue)).toEqual(await entriesOf(overHttp));
    expect(await balanceOf(overQueue)).toEqual({ balance: '460.00', version: 2 });
    expect((await eventsOf(queued?.id ?? '')).map((event) => event.event_type)).toEqual(
      (await eventsOf(submitted?.id ?? '')).map((event) => event.event_type),
    );
    expect((await eventsOf(queued?.id ?? '')).map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('a message the wallet refuses is a recorded rejection and is acknowledged', async () => {
    const walletId = await openWallet('30.00');

    await send(betMessage(walletId), walletId);
    const report = await pollOne();

    expect(report).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(await transactionsOf(walletId)).toMatchObject([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE', observed_balance: '30.00' },
    ]);
    expect(await entriesOf(walletId)).toEqual([]);
    expect(await queueContents()).toEqual([]);
  });

  /** `msg.unknown-wallet-permanent`: the row cannot be written, so nothing is. */
  test('a message for a wallet that does not exist is permanent and persists nothing', async () => {
    await send(betMessage(UNKNOWN_WALLET_ID), UNKNOWN_WALLET_ID);

    const report = await pollOne();

    expect(report).toMatchObject({ classification: 'permanent', disposition: 'dead-lettered' });
    expect(await transactionsOf(UNKNOWN_WALLET_ID)).toEqual([]);
    expect(await inboxRows()).toEqual([]);
    expect(await deadLetterContents()).toEqual(['acme-msg-000123']);
    expect(await queueContents()).toEqual([]);
  });
});

describe('message-contract-validated', () => {
  const refusals: [string, Record<string, unknown> | string][] = [
    ['a body that is not JSON', '{ not json'],
    ['an unknown type', { type: 'WalletOpeningRequested' }],
    ['an unsupported version', { version: 2 }],
    ['an unknown envelope member', { receiptHandle: 'AQEB' }],
  ];

  for (const [name, overrides] of refusals) {
    test(`${name} is a permanent error that persists nothing`, async () => {
      const walletId = await openWallet('500.00');

      await send(
        typeof overrides === 'string' ? overrides : betMessage(walletId, overrides),
        walletId,
      );
      const report = await pollOne();

      expect(report.classification).toBe('permanent');
      expect(report.disposition).toBe('dead-lettered');
      expect(report.classification === 'business' ? null : report.error).toBeInstanceOf(
        MessageContractError,
      );
      expect(report.messageId).toBeNull();
      expect(await transactionsOf(walletId)).toEqual([]);
      expect(await inboxRows()).toEqual([]);
      // The body an operator has to read is in the dead-letter queue, unchanged and therefore as
      // invalid as it arrived: validation failure is one of the permanent classes.
      expect(await deadLetterContents()).toHaveLength(1);
      expect(await queueContents()).toEqual([]);
    });
  }

  test('a missing amount and a malformed one are permanent errors naming the member', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId, {}, { money: { amount: '40', currency: 'BRL' } }), walletId);
    const report = await pollOne();
    const violations =
      report.classification === 'business' || !(report.error instanceof MessageContractError)
        ? ''
        : report.error.violations;

    expect(report.classification).toBe('permanent');
    expect(violations).toContain('amount');
    expect(await transactionsOf(walletId)).toEqual([]);
  });

  test('a message missing its idempotency key is a validation failure', async () => {
    const walletId = await openWallet('500.00');
    const message = betMessage(walletId);
    const data = { ...(message['data'] as Record<string, unknown>) };
    delete data['idempotencyKey'];

    await send({ ...message, data }, walletId);
    const report = await pollOne();

    expect(report.classification).toBe('permanent');
    expect(await transactionsOf(walletId)).toEqual([]);
  });
});

describe('inbox-keyed-by-body-message-id', () => {
  test('a producer resend keeps the body id, gets a new receipt id and is absorbed', async () => {
    const walletId = await openWallet('500.00');
    const message = betMessage(walletId);

    const firstReceipt = await send(message, walletId);
    const first = await pollOne();
    const secondReceipt = await send(message, walletId);
    const second = await pollOne();

    expect(firstReceipt).not.toBe(secondReceipt);
    expect(first.classification === 'business' && first.outcome.absorbed).toBe(false);
    expect(second).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(second.classification === 'business' && second.outcome.absorbed).toBe(true);
    expect(second.messageId).toBe('acme-msg-000123');

    expect(await transactionsOf(walletId)).toHaveLength(1);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await inboxRows()).toHaveLength(1);
    expect(await queueContents()).toEqual([]);
  });

  test('the inbox row carries the consumer, the body message id and a completion', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId), walletId);
    await pollOne();

    const [row] = await inboxRows();

    expect(row?.consumer_name).toBe(WAGER_TRANSACTIONS_CONSUMER);
    expect(row?.message_id).toBe('acme-msg-000123');
    expect(row?.payload_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row?.processed_at).not.toBeNull();
  });

  test('two message ids for one operation are one debit, and both deliveries are recorded', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId), walletId);
    await pollOne();
    await send(betMessage(walletId, { messageId: 'acme-msg-000123-resent' }), walletId);
    const second = await pollOne();

    expect(second.classification === 'business' && second.outcome.absorbed).toBe(false);
    expect(
      second.classification === 'business' && !second.outcome.absorbed
        ? second.outcome.idempotentReplay
        : null,
    ).toBe(true);
    expect(await transactionsOf(walletId)).toHaveLength(1);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect((await inboxRows()).map((row) => row.message_id)).toEqual([
      'acme-msg-000123',
      'acme-msg-000123-resent',
    ]);
  });
});

describe('inbox-payload-conflict', () => {
  test('a reused message id with another amount is permanent and changes nothing', async () => {
    const walletId = await openWallet('500.00');
    const conflicts = metrics.total('wager_duplicates_detected_total', {
      source: 'inbox-conflict',
    });

    await send(betMessage(walletId), walletId);
    await pollOne();

    await send(
      betMessage(walletId, {}, { externalTransactionId: 'acme-tx-000124', money: brl('41.00') }),
      walletId,
    );
    const report = await pollOne();

    expect(report).toMatchObject({ classification: 'permanent', disposition: 'dead-lettered' });
    expect(report.classification === 'business' ? null : report.error).toBeInstanceOf(
      InboxPayloadConflictError,
    );
    expect(metrics.total('wager_duplicates_detected_total', { source: 'inbox-conflict' })).toBe(
      conflicts + 1,
    );

    expect(await transactionsOf(walletId)).toMatchObject([
      { status: 'PROCESSED', amount: '40.00', observed_balance: '460.00' },
    ]);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect((await inboxRows()).map((row) => row.message_id)).toEqual(['acme-msg-000123']);

    // The conflicting delivery is the one in the dead-letter queue; the first is acknowledged.
    expect(await deadLetterContents()).toEqual(['acme-msg-000123']);
    expect(await queueContents()).toEqual([]);
  });
});

describe('message-correlation', () => {
  test('the correlation id of the message reaches the events it produced', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId), walletId);
    await pollOne();

    expect(await correlationIdsOf(walletId)).toEqual(['acme-req-5f2c', 'acme-req-5f2c']);
  });

  /** `msg.correlation`: absent, the message id is the correlation id. */
  test('a message without a correlation id is correlated by its message id', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId, { correlationId: undefined }), walletId);
    await pollOne();

    expect(await correlationIdsOf(walletId)).toEqual(['acme-msg-000123', 'acme-msg-000123']);
  });

  /** The correlation id of every event the wallet's one provider transaction produced. */
  async function correlationIdsOf(walletId: string): Promise<string[]> {
    const [transaction] = await transactionsOf(walletId);
    const events = await eventsOf(transaction?.id ?? '');

    return events.map((event) => event.payload.correlationId);
  }
});

describe('idempotency-across-entry-points', () => {
  test('the same operation over HTTP and through the queue is one debit and a replay', async () => {
    const walletId = await openWallet('500.00');
    const duplicates = metrics.total('wager_duplicates_detected_total', { source: 'inbox' });

    expect(await submitOverHttp(bet(walletId), 'provider-acme:acme-tx-000123')).toBe(200);

    await send(betMessage(walletId), walletId);
    const report = await pollOne();

    expect(report).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(
      report.classification === 'business' && !report.outcome.absorbed
        ? report.outcome.idempotentReplay
        : null,
    ).toBe(true);

    expect(await transactionsOf(walletId)).toHaveLength(1);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await queueContents()).toEqual([]);
    expect(metrics.total('wager_duplicates_detected_total', { source: 'inbox' })).toBe(duplicates);
  });

  test('a replayed delivery redelivered again is absorbed by the inbox', async () => {
    const walletId = await openWallet('500.00');
    const duplicates = metrics.total('wager_duplicates_detected_total', { source: 'inbox' });

    expect(await submitOverHttp(bet(walletId), 'provider-acme:acme-tx-000123')).toBe(200);
    await send(betMessage(walletId), walletId);
    await pollOne();
    await send(betMessage(walletId), walletId);
    const second = await pollOne();

    expect(second.classification === 'business' && second.outcome.absorbed).toBe(true);
    expect(metrics.total('wager_duplicates_detected_total', { source: 'inbox' })).toBe(
      duplicates + 1,
    );
    expect(await entriesOf(walletId)).toHaveLength(1);
  });
});

/**
 * MSG-006, with a real death: a worker process commits the effect and dies before the delete, which
 * is the window `msg.ack-after-commit` exists for. The redelivery that follows has to be absorbed
 * by the inbox and acknowledged, and the wallet has to end where one bet leaves it.
 */
describe('killed-after-commit-before-ack', () => {
  test('a worker killed after the commit leaves one effect and a redelivery with none', async () => {
    const walletId = await openWallet('500.00');
    const duplicates = metrics.total('wager_duplicates_detected_total', { source: 'inbox' });

    await send(betMessage(walletId), walletId);

    const killed = Bun.spawnSync({
      cmd: [process.execPath, 'run', 'test/helpers/consume-message.ts'],
      env: {
        ...process.env,
        SQS_VISIBILITY_TIMEOUT_SECONDS: String(CONSUMER_ENV.SQS_VISIBILITY_TIMEOUT_SECONDS),
      },
    });

    expect({ code: killed.exitCode, out: killed.stdout.toString().trim() }).toMatchObject({
      code: 9,
    });

    const committed = await transactionsOf(walletId);

    expect(committed).toMatchObject([{ status: 'PROCESSED', observed_balance: '460.00' }]);
    expect(await inboxRows()).toMatchObject([{ message_id: 'acme-msg-000123' }]);
    expect((await inboxRows())[0]?.processed_at).not.toBeNull();

    // The dead process never deleted the message, so it comes back when its visibility expires.
    const redelivery = await pollUntilOne(10_000);

    expect(redelivery).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(redelivery.classification === 'business' && redelivery.outcome.absorbed).toBe(true);
    expect(metrics.total('wager_duplicates_detected_total', { source: 'inbox' })).toBe(
      duplicates + 1,
    );

    expect(await transactionsOf(walletId)).toEqual(committed);
    expect(await entriesOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await queueContents()).toEqual([]);
  }, 20_000);
});

describe('consumer-loop-drains-the-queue', () => {
  test('run polls until stop, acknowledging what it applied', async () => {
    const walletId = await openWallet('500.00');

    await send(betMessage(walletId), walletId);

    const loop = consumer.run();

    for (let waited = 0; waited < 100; waited += 1) {
      if ((await transactionsOf(walletId)).length === 1) {
        break;
      }

      await sleep(100);
    }

    consumer.stop();
    await loop;

    expect(await transactionsOf(walletId)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await queueContents()).toEqual([]);
  }, 20_000);
});

/**
 * `conc.row-lock` on the queue (CONC-002): a lock wait longer than the ceiling is a transient
 * failure here too, so the message comes back and a later receive of it succeeds. The same wait over
 * HTTP is a `503` with `Retry-After`, in `bet-submission.test.ts`; what makes the two one rule is
 * that neither entry point classifies anything — the unit of work does, once, for whichever of them
 * opened the transaction.
 *
 * It belongs in this suite rather than beside the other two failure classes in
 * `queue-retry-and-dead-letters.test.ts` because the consumer here is the one the composition root
 * built: a counter raised through that wiring is evidence that the deployment raises it, which an
 * instance assembled by a test could not give. The backoff a returned message comes back on, and the
 * dispositions of the other classes, are that suite's (MSG-007 to MSG-009).
 */
describe('lock-timeout-is-transient', () => {
  test('a message that cannot take the wallet lock is retried, and succeeds once it is released', async () => {
    const walletId = await openWallet('500.00');
    const conflicts = metrics.total('wager_lock_conflicts_total');

    await send(betMessage(walletId), walletId);

    // The wallet row, held by the migrator for as long as the first delivery takes: the lock the
    // consumer then asks for is the one it cannot have. The reservation that precedes it is not
    // blocked, because the `FOR KEY SHARE` its foreign key takes is compatible with this mode
    // (ADR 0002) — so what gives up is the wallet lock and nothing earlier.
    const holder = schema.em.fork();
    await holder.begin();
    let refused: DeliveryReport;

    try {
      await holder.execute('select "id" from "wallets" where "id" = ? for no key update', [
        walletId,
      ]);
      refused = await pollUntilOne(20_000);
    } finally {
      await holder.rollback();
    }

    // Transient, not a business outcome: nothing about this delivery is terminal, so the message is
    // returned to the queue rather than acknowledged or dead-lettered (`msg.classification`).
    expect(refused).toMatchObject({ classification: 'transient', disposition: 'returned' });
    expect(refused.classification === 'business' ? null : refused.error).toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(metrics.total('wager_lock_conflicts_total')).toBe(conflicts + 1);

    // Nothing was written, so the redelivery is a new operation and not a replay
    // (`api.transient-failure`): the inbox row of a rolled-back delivery never committed either.
    expect(await transactionsOf(walletId)).toEqual([]);
    expect(await inboxRows()).toEqual([]);

    const applied = await pollUntilOne(20_000);

    expect(applied).toMatchObject({ classification: 'business', disposition: 'acknowledged' });
    expect(applied.classification === 'business' && applied.outcome.absorbed).toBe(false);
    expect(await transactionsOf(walletId)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await balanceOf(walletId)).toEqual({ balance: '460.00', version: 2 });
  }, 40_000);
});
