import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  type TransactionIdentity,
  WagerTransactionProcessed,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { DRAIN_INCOMPLETE_EXIT } from '../../src/infrastructure/runtime/shutdown';
import { EventsQueue } from '../helpers/events-queue';
import { SERVICE_MAIN, SpawnedProcess, freePort, helperScript } from '../helpers/spawned-process';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
/** The trio this run addresses: the suites namespace theirs away from the stack. */
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const migrationEnv = loadMigrationEnv(process.env);

/**
 * The grace period the cases run the processes with. It is long enough for a drain that is expected
 * to finish — a committed operation, a batch of three publications, one attempt — and short enough
 * that a case which asserts the deadline does not wait fifteen seconds for it.
 */
const GRACE_PERIOD_MS = 5000;

/** What every process in this suite runs with, over the addresses of the stack. */
const PROCESS_ENV: Record<string, string> = {
  SQS_WAIT_TIME_SECONDS: '1',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_SWEEP_INTERVAL_MS: '100',
  SHUTDOWN_GRACE_PERIOD_MS: GRACE_PERIOD_MS.toString(),
};

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const ENQUEUED_AT = new Date('2026-10-28T12:00:00.000Z');

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** How long a case waits for work it expects to happen, with room for a slow container. */
const WORK_TIMEOUT_MS = 30_000;

/**
 * The batch one publication case works on, and the delay each publication takes. Three rows at a
 * quarter of a second each is a batch that is comfortably in flight when the signal arrives and
 * comfortably finished inside the grace period.
 */
const PUBLICATION_BATCH = 3;
const PUBLICATION_DELAY_MS = 250;

/** The first attempt of a parked transaction is due a second after the park (`ref.backoff`). */
const FIRST_ATTEMPT_DUE_MS = 1200;

/** An attempt that finishes well inside the grace period, and one that cannot finish at all. */
const SHORT_ATTEMPT_MS = 500;
const LONGER_THAN_GRACE_MS = GRACE_PERIOD_MS * 6;

/** The messages the consumer case holds, as one receive: one applied, the rest handed back. */
const MESSAGES_IN_FLIGHT = 5;

/** Long enough that the signal lands while the first message is still being applied. */
const APPLY_DELAY_MS = 2000;

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
let events: EventsQueue;
let api: SpawnedProcess;
let apiUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queues.input }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queues.input}`);
  }
  queueUrl = QueueUrl;
  events = await EventsQueue.open(env);

  // One `api` instance for the suite, which no case signals: it is how the cases about the workers
  // put the work in front of them, over the surface a provider would use.
  api = SpawnedProcess.spawn({
    script: SERVICE_MAIN,
    env: { ...PROCESS_ENV, APP_ROLE: 'api', HTTP_PORT: freePort().toString() },
  });
  apiUrl = await api.listening();
}, 60_000);

afterAll(async () => {
  await api.dispose();
  await drainInput();
  await events.drain();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  await drainInput();
  await events.drain();
}, 30_000);

// `recon.final-invariant` (RECON-004): these cases move money while a process is being stopped, so
// every wallet they touched is rebuilt from its ledger before the next truncation.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

const sql = <Row>(query: string, parameters: unknown[] = []): Promise<Row[]> =>
  runtime.em.getConnection().execute<Row[]>(query, parameters);

/** Whatever is in the input queue, received and deleted, so one case never sees another's message. */
async function drainInput(): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );

    if (Messages === undefined || Messages.length === 0) {
      return;
    }

    for (const message of Messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
}

/** The `bet` message example of [docs/asyncapi.yaml], under the identity this case sends it with. */
function betMessage(walletId: string, messageId: string): Record<string, unknown> {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-28T12:05:00.000Z',
    correlationId: 'acme-req-5f2c',
    data: {
      providerId: 'provider-acme',
      externalTransactionId: messageId,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl('10.00'),
      idempotencyKey: `provider-acme:${messageId}`,
    },
  };
}

async function send(walletId: string, messageId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(betMessage(walletId, messageId)),
      MessageGroupId: walletId,
      MessageDeduplicationId: `${messageId}-${Bun.randomUUIDv7()}`,
    }),
  );
}

interface BetRow {
  readonly external_transaction_id: string;
  readonly status: string;
}

const betsOf = (walletId: string): Promise<BetRow[]> =>
  sql<BetRow>(
    `select "external_transaction_id", "status" from "wager_transactions"
      where "wallet_id" = ? and "kind" = 'BET' order by "created_at"`,
    [walletId],
  );

const parkedStatusOf = async (transactionId: string): Promise<string | undefined> =>
  (
    await sql<{ status: string }>('select "status" from "wager_transactions" where "id" = ?', [
      transactionId,
    ])
  )[0]?.status;

const walletRow = async (walletId: string) =>
  (
    await sql<{ balance: string; version: number }>(
      'select "balance"::text as "balance", "version" from "wallets" where "id" = ?',
      [walletId],
    )
  )[0];

/** What a connection that was not accepted at all answers with, as a status a case can assert. */
const REFUSED = 'connection refused';

/** A request's status, or `REFUSED` when the port did not accept the connection. */
const attempt = async (url: string): Promise<number | typeof REFUSED> =>
  fetch(url).then(
    (response) => response.status,
    () => REFUSED,
  );

/** Waits for the condition the case is about, so nothing is asserted on a fixed sleep. */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  timeoutMs = WORK_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();

  while (!holds(last)) {
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${timeoutMs.toString()} ms`);
    }

    await Bun.sleep(100);
    last = await read();
  }

  return last;
}

/**
 * A wallet row locked by another session, which is what makes an operation wait on the lock of
 * ADR 0002 and so outlive the signal. The migrator owns the tables, so it is the session a case may
 * lock from, and the caller releases the lock — by rolling back — when its case is ready for the
 * operation to proceed.
 */
async function lockWallet(walletId: string): Promise<{ release: () => Promise<void> }> {
  const holder = schema.em.fork();
  await holder.begin();
  await holder.execute('select "id" from "wallets" where "id" = ? for no key update', [walletId]);

  return { release: () => holder.rollback() };
}

async function openWallet(baseUrl: string, initialBalance: string): Promise<string> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, initialBalance: brl(initialBalance) }),
  });
  const body = (await response.json()) as { id?: string };

  if (response.status !== 201 || typeof body.id !== 'string') {
    throw new Error(`opening a wallet answered ${response.status.toString()}`);
  }

  return touched.add(body.id);
}

interface ScheduleRow {
  readonly attempts: number;
  readonly next_attempt_at: string;
}

const scheduleRow = async (transactionId: string): Promise<ScheduleRow | undefined> =>
  (
    await sql<ScheduleRow>(
      `select "attempts", "next_attempt_at"::text as "next_attempt_at"
         from "pending_reference_schedule" where "transaction_id" = ?`,
      [transactionId],
    )
  )[0];

/**
 * A `ROLLBACK` whose bet never arrived, which `rule.reference.missing-is-pending` parks: the work
 * the scheduler is there to finish, and the row it claims. Nothing is moved by a park, so the
 * wallet of this transaction is as it was opened.
 */
async function park(walletId: string, externalTransactionId: string): Promise<string> {
  const response = await fetch(`${apiUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': externalTransactionId },
    body: JSON.stringify({
      providerId: 'provider-acme',
      externalTransactionId,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'ROLLBACK',
      money: brl('40.00'),
      referenceExternalTransactionId: 'acme-bet-never-arrives',
    }),
  });
  const body = (await response.json()) as { transactionId?: string; status?: string };

  if (response.status !== 202 || typeof body.transactionId !== 'string') {
    throw new Error(
      `the rollback answered ${response.status.toString()} instead of being parked: ${JSON.stringify(body)}`,
    );
  }

  return body.transactionId;
}

/** What the broker reports for a message it is delivering for the second time. */
const SECOND_DELIVERY = 2;

interface AvailableMessage {
  readonly messageId: string;
  readonly receiveCount: number;
  readonly receiptHandle: string;
}

/**
 * The messages the input queue is willing to deliver right now, with how often each has been
 * delivered. Nothing is deleted: the case hands them back, because what applies them is the
 * instance that survived and not this suite.
 */
async function receiveAvailable(): Promise<AvailableMessage[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );

  return (Messages ?? []).map((message) => ({
    messageId: (JSON.parse(message.Body ?? '{}') as { messageId?: string }).messageId ?? '',
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '0'),
    receiptHandle: message.ReceiptHandle ?? '',
  }));
}

/** How many deliveries the inbox holds, which is one per message that was applied (ADR 0010). */
const inboxRows = async (): Promise<number> =>
  Number(
    (await sql<{ rows: string }>('select count(*)::text as "rows" from "inbox_messages"'))[0]
      ?.rows ?? '0',
  );

const identity = (walletId: string, index: number): TransactionIdentity => ({
  transactionId: `01a19200-0000-7000-8000-${index.toString().padStart(12, '0')}`,
  providerId: 'provider-acme',
  externalTransactionId: `acme-tx-${index.toString()}`,
  walletId,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: Money.from('40.00', 'BRL'),
});

/**
 * Committed outbox rows for the publisher to claim. The event ids are unique per run because they
 * are the broker's `MessageDeduplicationId`: a repeated run inside the deduplication window would
 * otherwise have its messages filtered as duplicates of the previous one's.
 */
async function enqueueEvents(rows: number): Promise<string[]> {
  const run = Bun.randomUUIDv7().slice(0, 8);
  const unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
  const eventIds = Array.from(
    { length: rows },
    (_unused, index) => `${run}-0000-7000-0001-${index.toString().padStart(12, '0')}`,
  );

  await unitOfWork.transactional(async ({ outbox }) => {
    for (const [index, eventId] of eventIds.entries()) {
      await outbox.insert(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.record({
            eventId,
            correlationId: CORRELATION_ID,
            occurredAt: new Date(ENQUEUED_AT.getTime() + index),
            identity: identity(
              `01a19200-0000-7000-9000-${index.toString().padStart(12, '0')}`,
              index,
            ),
            balanceAfter: Money.from('460.00', 'BRL'),
            walletVersion: 2,
            processedAt: ENQUEUED_AT,
            reference: null,
          }),
        ),
      );
    }
  });

  return eventIds;
}

const pendingEvents = async (): Promise<number> =>
  Number(
    (
      await sql<{ pending: string }>(
        'select count(*)::text as "pending" from "outbox_messages" where "published_at" is null',
      )
    )[0]?.pending ?? '0',
  );

/**
 * `ops.graceful-shutdown` (OPS-007): what each role does with the work in hand when it is told to
 * stop. Every case runs a real process and signals it, because a drain is a property of a process:
 * what it finished, what it handed back, and the code it exited with.
 */
describe('graceful-shutdown-all-roles', () => {
  test('the api role completes the request in flight and accepts nothing new', async () => {
    const port = freePort();
    const api = SpawnedProcess.spawn({
      script: SERVICE_MAIN,
      env: {
        ...PROCESS_ENV,
        APP_ROLE: 'api',
        HTTP_PORT: port.toString(),
        // The lock wait is bounded by this case, which releases it, rather than by the ceiling: a
        // submission that gave up on the lock would be a `503` about contention and not a drain.
        LOCK_TIMEOUT_MS: '10000',
      },
    });

    try {
      const baseUrl = await api.listening();
      const walletId = await openWallet(baseUrl, '500.00');
      const lock = await lockWallet(walletId);

      // The submission is in flight and waiting for the wallet lock this session holds, which is
      // what makes the request outlive the signal instead of finishing before it.
      const submitting = fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'acme-key-drain' },
        body: JSON.stringify({
          providerId: 'provider-acme',
          externalTransactionId: 'acme-tx-drain',
          playerId: PLAYER_ID,
          walletId,
          roundId: 'round-7f3a',
          gameId: 'lucky-sevens',
          kind: 'BET',
          money: brl('40.00'),
        }),
      });

      await Bun.sleep(300);
      api.signal('SIGTERM');
      await api.waitFor(/"event":"service\.draining"/);

      // A request that arrives once the drain has begun is not served: the listener has stopped
      // accepting, so a new connection is refused outright, and one that arrives on a connection
      // the caller already held is answered `503` with `Connection: close`. Which of the two a
      // caller gets is a matter of its own connection pool, so both count as the refusal.
      expect([503, REFUSED]).toContain(await attempt(`${baseUrl}/health/live`));

      // The lock goes, so the operation the drain is waiting for can commit.
      await lock.release();

      const answered = await submitting;

      // The request in flight was answered, not dropped, and its outcome is committed: `200` is
      // what a `PROCESSED` submission answers with (`api.status-classes`).
      expect(answered.status).toBe(200);
      expect(await answered.json()).toMatchObject({
        status: 'PROCESSED',
        balance: brl('460.00'),
        idempotentReplay: false,
      });
      expect(await api.exited()).toBe(0);
      expect(await betsOf(walletId)).toEqual([
        { external_transaction_id: 'acme-tx-drain', status: 'PROCESSED' },
      ]);
      expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
    } finally {
      await api.dispose();
    }
  }, 90_000);

  test('the publisher finishes the batch it had claimed before exiting', async () => {
    const eventIds = await enqueueEvents(PUBLICATION_BATCH);
    const publisher = SpawnedProcess.spawn({
      script: helperScript('publish-outbox.ts'),
      // A publication that takes a quarter of a second is what makes the batch still be in flight
      // when the signal arrives; the batch size is the whole backlog, so one cycle holds it all.
      args: [
        '--batch-size',
        PUBLICATION_BATCH.toString(),
        '--send-delay',
        PUBLICATION_DELAY_MS.toString(),
      ],
      env: PROCESS_ENV,
    });

    try {
      await publisher.waitFor(/^ready$/);
      // The first publication of the batch has been sent, so the cycle in flight is holding the
      // claim on all three rows when the signal arrives.
      await publisher.waitFor(/^sent 1$/);

      publisher.signal('SIGTERM');

      expect(await publisher.exited()).toBe(0);
      // `stop` resolved only after the cycle committed, so every row of the batch is published and
      // the count the instance reports is the whole batch (`ops.graceful-shutdown`).
      expect(publisher.output()).toContain(`published ${PUBLICATION_BATCH.toString()}`);
      expect(await pendingEvents()).toBe(0);

      const delivered = await events.receive(PUBLICATION_BATCH, { timeoutMs: WORK_TIMEOUT_MS });

      expect(delivered.map(({ envelope }) => envelope.eventId).toSorted()).toEqual(
        eventIds.toSorted(),
      );
    } finally {
      await publisher.dispose();
    }
  }, 90_000);

  /**
   * The scheduler's claim exists only inside the transaction attempting it (ADR 0011), so a
   * shutdown has nothing to release: the attempt either commits inside the grace period, recording
   * its outcome and its backoff, or rolls back with the process and leaves the row exactly as it
   * was. These two cases are the two halves of that, and the second is the one OPS-007 asks for —
   * a row the dying instance was holding is due the moment another instance sweeps, with no
   * backoff to wait out.
   */
  test('the scheduler finishes the attempt in flight when it fits in the grace period', async () => {
    const walletId = await openWallet(apiUrl, '500.00');
    const parkedId = await park(walletId, 'acme-rollback-drained');
    const before = await scheduleRow(parkedId);

    // The first attempt is due a second after the park (`ref.backoff`), and the scheduler reads the
    // host clock, so it is started once there is something to claim.
    await Bun.sleep(FIRST_ATTEMPT_DUE_MS);

    const scheduler = SpawnedProcess.spawn({
      script: helperScript('reprocess-pending-references.ts'),
      args: [JSON.stringify({ loop: true, holdMs: SHORT_ATTEMPT_MS })],
      env: PROCESS_ENV,
    });

    try {
      await scheduler.waitFor(/^ready$/);
      // The claim is announced as it is taken, so the signal lands inside the attempt.
      await scheduler.waitFor(new RegExp(parkedId));
      scheduler.signal('SIGTERM');

      expect(await scheduler.exited()).toBe(0);
      expect(scheduler.output()).toContain('drained pending-reference-scheduler');

      // The attempt it was holding ran to its end: it is counted, and the next one is scheduled.
      const after = await scheduleRow(parkedId);

      expect(after?.attempts).toBe(1);
      expect(Date.parse(after?.next_attempt_at ?? '')).toBeGreaterThan(
        Date.parse(before?.next_attempt_at ?? ''),
      );
      expect(await parkedStatusOf(parkedId)).toBe('PENDING_REFERENCE');
    } finally {
      await scheduler.dispose();
    }
  }, 90_000);

  test('a claim the scheduler could not finish is released, with no backoff to wait out', async () => {
    const walletId = await openWallet(apiUrl, '500.00');
    const parkedId = await park(walletId, 'acme-rollback-released');
    const before = await scheduleRow(parkedId);

    await Bun.sleep(FIRST_ATTEMPT_DUE_MS);

    const scheduler = SpawnedProcess.spawn({
      script: helperScript('reprocess-pending-references.ts'),
      // An attempt that cannot finish inside the grace period, which is what makes the claim one
      // the shutdown has to leave behind rather than complete.
      args: [JSON.stringify({ loop: true, holdMs: LONGER_THAN_GRACE_MS })],
      env: PROCESS_ENV,
    });

    try {
      await scheduler.waitFor(/^ready$/);
      await scheduler.waitFor(new RegExp(parkedId));
      scheduler.signal('SIGTERM');

      // The drain gave up on the grace period and said so, which is the exit a deployment reads.
      expect(await scheduler.exited()).toBe(DRAIN_INCOMPLETE_EXIT);
      expect(scheduler.output()).toContain('service.drain-timed-out');
    } finally {
      await scheduler.dispose();
    }

    // Nothing the attempt did survived: PostgreSQL rolled it back with the connection, so the row
    // carries the attempts and the moment it carried before the claim.
    expect(await scheduleRow(parkedId)).toEqual(before);

    // And a surviving instance claims it at once, rather than waiting out a backoff the attempt
    // never got to record (`ref.scheduler`, OPS-007).
    const surviving = SpawnedProcess.spawn({
      script: helperScript('reprocess-pending-references.ts'),
      env: PROCESS_ENV,
    });

    try {
      await surviving.exited();

      // It claimed this row and attempted it, which is what the attempt it reports says, and the
      // count on the row is what says the attempt was recorded by someone at last.
      expect(surviving.output()).toContain(`"transactionId":"${parkedId}"`);
      expect(surviving.output()).toContain('"outcome":"pending"');
      expect((await scheduleRow(parkedId))?.attempts).toBe(1);
    } finally {
      await surviving.dispose();
    }
  }, 90_000);
});

/**
 * `msg.sigterm` (MSG-010): a consumer signalled while it holds a batch. The message it is applying
 * is finished and acknowledged after its commit, and every message of the batch it had not reached
 * is handed straight back with its visibility cleared, so another instance takes them at once
 * rather than after the visibility timeout. Neither half may cost a second effect.
 */
describe('sigterm-drains-or-releases', () => {
  test('the message in flight is applied and the rest come back at once, applied exactly once', async () => {
    const walletId = await openWallet(apiUrl, '500.00');
    const messageIds = Array.from(
      { length: MESSAGES_IN_FLIGHT },
      (_unused, index) => `acme-msg-flight-${index.toString()}`,
    );

    for (const messageId of messageIds) {
      await send(walletId, messageId);
    }

    const dying = SpawnedProcess.spawn({
      script: helperScript('sigterm-consumer.ts'),
      args: ['--delay-ms', APPLY_DELAY_MS.toString()],
      env: PROCESS_ENV,
    });
    let applied: string;

    try {
      await dying.waitFor(/^ready$/);
      // One message is in flight, the rest of the batch is held with it.
      const applying = await dying.waitFor(/^applying /);
      applied = applying.slice('applying '.length);

      dying.signal('SIGTERM');

      // The drain finished: the message in flight was committed and acknowledged, and the rest were
      // handed back, all inside the grace period.
      expect(await dying.exited()).toBe(0);
      expect(dying.output()).toContain(`applied ${applied}`);
      expect(dying.output()).toContain('drained wager-transactions-consumer');
    } finally {
      await dying.dispose();
    }

    expect(await betsOf(walletId)).toEqual([
      { external_transaction_id: applied, status: 'PROCESSED' },
    ]);

    // The rest are receivable now, not in thirty seconds, and each carries a second delivery: they
    // were handed to the instance that died and given back, rather than never taken at all.
    const released = await receiveAvailable();

    expect(released.map(({ messageId }) => messageId).toSorted()).toEqual(
      messageIds.filter((messageId) => messageId !== applied).toSorted(),
    );
    expect(released.map(({ receiveCount }) => receiveCount)).toEqual(
      released.map(() => SECOND_DELIVERY),
    );

    // Handed back again, so the surviving instance is what applies them.
    for (const { receiptHandle } of released) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }

    const surviving = SpawnedProcess.spawn({
      script: helperScript('sigterm-consumer.ts'),
      env: PROCESS_ENV,
    });

    try {
      await surviving.waitFor(/^ready$/);

      const bets = await until(
        'the surviving instance applying the released messages',
        () => betsOf(walletId),
        (rows) => rows.length === MESSAGES_IN_FLIGHT,
      );

      // Every message was applied exactly once, by one instance or the other: the redelivery of the
      // acknowledged one would have been absorbed by the inbox, and nothing was lost.
      expect(bets.map((bet) => bet.external_transaction_id).toSorted()).toEqual(
        messageIds.toSorted(),
      );
      expect(bets.map((bet) => bet.status)).toEqual(messageIds.map(() => 'PROCESSED'));
      expect(await inboxRows()).toBe(MESSAGES_IN_FLIGHT);
      expect(await walletRow(walletId)).toEqual({
        balance: '450.00',
        version: MESSAGES_IN_FLIGHT + 1,
      });

      surviving.signal('SIGTERM');

      expect(await surviving.exited()).toBe(0);
    } finally {
      await surviving.dispose();
    }
  }, 120_000);
});
