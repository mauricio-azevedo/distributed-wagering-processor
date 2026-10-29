import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { Clock } from '../../src/application/ports/clock';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { LogFields, Logger } from '../../src/application/ports/logger';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import {
  type IntegrationEventEnvelope,
  type TransactionIdentity,
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { type LedgerOperation, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { EventsQueue } from '../helpers/events-queue';
import { ReferenceConsumer } from '../helpers/reference-consumer';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const WALLET_ID = '01a19000-0000-7000-8000-000000000001';
const OTHER_WALLET_ID = '01a19000-0000-7000-8000-000000000002';
const PLAYER_ID = '01a19000-0000-7000-8000-000000000003';
const TRANSACTION_ID = '01a19000-0000-7000-8000-000000000004';
const ENTRY_ID = '01a19000-0000-7000-8000-000000000005';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

/**
 * Event ids a case can name, unique to this run of the suite and ordered by their suffix, which is
 * the order the claim puts rows recorded in the same moment in.
 *
 * The run is part of the id because the event id is the `MessageDeduplicationId`
 * (`outbox.destination`): a fixed id would make the broker treat the next run's publication of it
 * as a duplicate of this one for five minutes and swallow the message, and the suite would be
 * asserting the deduplication window rather than the publisher. The prefix is the time half of a
 * UUIDv7, so ids of one run sort together and after those of the run before it.
 */
const RUN = Bun.randomUUIDv7().slice(0, 8);

const eventId = (suffix: number): string =>
  `${RUN}-0000-7000-8000-${suffix.toString().padStart(12, '0')}`;

const ENQUEUED_AT = new Date('2026-10-28T12:00:00.000Z');
const PUBLISHED_AT = new Date('2026-10-28T12:30:00.000Z');

/** `event.envelope`, as `IntegrationEventEnvelope` in docs/asyncapi.yaml lists it. */
const ENVELOPE_MEMBERS = [
  'aggregateId',
  'causationId',
  'correlationId',
  'data',
  'eventId',
  'eventType',
  'occurredAt',
  'version',
];

/** `WalletBalanceChangedData` in docs/asyncapi.yaml. */
const BALANCE_CHANGED_MEMBERS = [
  'balanceAfter',
  'balanceBefore',
  'direction',
  'money',
  'transactionId',
  'walletId',
  'walletVersion',
];

/**
 * The ceiling for a case that waits on the broker. Proving that a message arrived, and proving that
 * none did, both cost several one-second long polls against LocalStack, which is more than bun's
 * default per-test budget allows; the cases that do not touch the queue keep the default.
 */
const BROKER_WAIT_MS = 30_000;

const brl = (amount: string): Money => Money.from(amount, 'BRL');

const identity = (walletId: string): TransactionIdentity => ({
  transactionId: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  walletId,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
});

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: MikroOrmUnitOfWork;
let queue: EventsQueue;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
  queue = await EventsQueue.open(env);
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute('truncate table "outbox_messages"');
  await queue.drain();
});

/** A row the publisher will claim: one processed event of `walletId`, due since it was enqueued. */
function processedRow(
  id: string,
  walletId: string,
  { occurredAt = ENQUEUED_AT }: { readonly occurredAt?: Date } = {},
): OutboxMessage {
  return OutboxMessage.enqueue(
    WagerTransactionProcessed.record({
      eventId: id,
      correlationId: CORRELATION_ID,
      occurredAt,
      identity: identity(walletId),
      balanceAfter: brl('460.00'),
      walletVersion: 2,
      processedAt: occurredAt,
      reference: null,
    }),
  );
}

/** One balance event of a chain: the entry that took `balanceBefore` to `balanceAfter`. */
function balanceChangedRow(
  id: string,
  walletId: string,
  change: {
    readonly operation?: LedgerOperation;
    readonly before: string;
    readonly money: string;
    readonly after: string;
    readonly walletVersion: number;
    readonly occurredAt: Date;
  },
): OutboxMessage {
  return OutboxMessage.enqueue(
    WalletBalanceChanged.record({
      eventId: id,
      correlationId: CORRELATION_ID,
      occurredAt: change.occurredAt,
      entry: WalletLedgerEntry.create({
        id: ENTRY_ID,
        walletId,
        transactionId: TRANSACTION_ID,
        operation: change.operation ?? { kind: 'BET' },
        money: brl(change.money),
        balanceBefore: brl(change.before),
        balanceAfter: brl(change.after),
        walletVersion: change.walletVersion,
        createdAt: change.occurredAt,
      }),
    }),
  );
}

const enqueue = (rows: readonly OutboxMessage[]): Promise<void> =>
  unitOfWork.transactional(async ({ outbox }) => {
    for (const row of rows) {
      await outbox.insert(row);
    }
  });

interface StoredRow {
  readonly event_id: string;
  readonly attempts: number;
  readonly published_at: string | null;
  readonly next_attempt_at: string;
}

/** The two timestamps come back as the ISO strings the domain renders, so they compare exactly. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const storedRows = (): Promise<StoredRow[]> =>
  runtime.em.getConnection().execute<StoredRow[]>(
    `select "event_id", "attempts",
            to_char("published_at" at time zone 'utc', ${ISO}) as "published_at",
            to_char("next_attempt_at" at time zone 'utc', ${ISO}) as "next_attempt_at"
       from "outbox_messages" order by "event_id"`,
  );

async function storedRow(id: string): Promise<StoredRow> {
  const row = (await storedRows()).find((stored) => stored.event_id === id);

  if (row === undefined) {
    throw new Error(`the outbox holds no row ${id}`);
  }

  return row;
}

/** A clock a case moves by hand, so a five-minute backoff costs no five minutes. */
function movableClock(start: Date) {
  let now = start;

  return {
    clock: { now: () => now } satisfies Clock,
    moveTo: (instant: Date) => {
      now = instant;
    },
    forward: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function recordingLogger() {
  const records: { readonly event: string; readonly fields: LogFields }[] = [];

  return {
    records,
    logger: { error: (event, fields) => records.push({ event, fields }) } satisfies Logger,
  };
}

/** The real adapter, against LocalStack. */
const sqsPublisher = (): SqsEventPublisher =>
  new SqsEventPublisher(
    new SQSClient({
      region: env.AWS_REGION,
      ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
    }),
    { timeoutMs: 5000 },
  );

/**
 * The broker that is not there: a real adapter against a closed port, with one attempt and a short
 * timeout, which is what a publisher sees while SQS is unavailable (`outbox.retry-backoff`).
 */
const unreachablePublisher = (): SqsEventPublisher =>
  new SqsEventPublisher(
    new SQSClient({ region: env.AWS_REGION, endpoint: 'http://127.0.0.1:1', maxAttempts: 1 }),
    { timeoutMs: 1000 },
  );

/** Every envelope the publisher handed to the broker, whether or not the cycle committed. */
function recording(publisher: EventPublisher) {
  const sent: { readonly eventId: string; readonly body: string }[] = [];

  return {
    sent,
    publisher: {
      publish: async (message: OutboxMessage) => {
        await publisher.publish(message);
        sent.push({ eventId: message.eventId, body: JSON.stringify(message.payload) });
      },
    } satisfies EventPublisher,
  };
}

/**
 * A unit of work whose commit never lands: the work runs, its statements reach PostgreSQL, and the
 * transaction rolls back. It is the crash of ADR 0005 reproduced without killing anything — the
 * sends happened, the publication was never recorded — and it is the window `outbox.duplicate-safe`
 * is about.
 */
function losingCommit(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional(async (repositories: Repositories) => {
        await work(repositories);

        throw new Error('the commit that would have recorded the publication never landed');
      }),
  };
}

function publisherOver(
  options: {
    readonly publisher?: EventPublisher;
    readonly clock?: Clock;
    readonly logger?: Logger;
    readonly unitOfWork?: UnitOfWork;
    readonly batchSize?: number;
  } = {},
): PublishOutbox {
  return new PublishOutbox({
    unitOfWork: options.unitOfWork ?? unitOfWork,
    publisher: options.publisher ?? sqsPublisher(),
    clock: options.clock ?? { now: () => PUBLISHED_AT },
    logger: options.logger ?? { error: () => undefined },
    ...(options.batchSize !== undefined && { batchSize: options.batchSize }),
  });
}

/** The message of a rejection, as the suites assert refusals without `.rejects`. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected a rejection');
}

describe('events-destination-attributes', () => {
  test(
    'a published row reaches the events queue with the wallet as group and the event id as deduplication id',
    async () => {
      const row = processedRow(eventId(101), WALLET_ID);
      await enqueue([row]);

      expect(await publisherOver().execute()).toEqual({ claimed: 1, published: 1, failed: 0 });

      const [delivered] = await queue.receive(1);
      expect(delivered?.groupId).toBe(WALLET_ID);
      expect(delivered?.deduplicationId).toBe(eventId(101));
      // The message is the stored envelope: `jsonb` normalizes member order, so the comparison is of
      // the envelope and not of the bytes the row was enqueued with.
      expect(delivered?.envelope).toEqual(row.payload);
      expect(delivered?.envelope.eventId).toBe(eventId(101));
      expect(Object.keys(delivered?.envelope ?? {}).toSorted()).toEqual(ENVELOPE_MEMBERS);
      expect(await storedRow(eventId(101))).toMatchObject({
        attempts: 0,
        published_at: PUBLISHED_AT.toISOString(),
      });
    },
    BROKER_WAIT_MS,
  );

  test(
    'the envelope is the one the event subclass defines, with every amount a string',
    async () => {
      await enqueue([
        balanceChangedRow(eventId(102), WALLET_ID, {
          before: '500.00',
          money: '40.00',
          after: '460.00',
          walletVersion: 2,
          occurredAt: ENQUEUED_AT,
        }),
      ]);

      await publisherOver().execute();

      const [delivered] = await queue.receive(1);
      expect(delivered?.envelope).toMatchObject({
        eventType: 'WalletBalanceChanged',
        aggregateId: WALLET_ID,
        correlationId: CORRELATION_ID,
        causationId: TRANSACTION_ID,
        occurredAt: ENQUEUED_AT.toISOString(),
        version: 1,
      });
      expect(Object.keys(delivered?.envelope.data as object).toSorted()).toEqual(
        BALANCE_CHANGED_MEMBERS,
      );
      expect(delivered?.envelope.data).toMatchObject({
        direction: 'DEBIT',
        money: { amount: '40.00', currency: 'BRL' },
        balanceBefore: { amount: '500.00', currency: 'BRL' },
        balanceAfter: { amount: '460.00', currency: 'BRL' },
        walletVersion: 2,
      });
    },
    BROKER_WAIT_MS,
  );
});

describe('publish-after-commit', () => {
  test(
    'an uncommitted row is published by nobody, and is published once it commits',
    async () => {
      const row = processedRow(eventId(103), WALLET_ID);

      // The enqueueing transaction is still open while the publisher runs, on its own connection.
      expect(
        await rejection(
          unitOfWork.transactional(async ({ outbox }) => {
            await outbox.insert(row);

            expect(await publisherOver().execute()).toEqual({
              claimed: 0,
              published: 0,
              failed: 0,
            });

            throw new Error('rolled back on purpose');
          }),
        ),
      ).toMatch(/rolled back on purpose/);

      expect(await storedRows()).toEqual([]);
      expect(await queue.receive(1, { timeoutMs: 2000 })).toEqual([]);

      await enqueue([row]);
      expect(await publisherOver().execute()).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(await queue.receive(1)).toHaveLength(1);
    },
    BROKER_WAIT_MS,
  );
});

describe('outbox-claims-are-exclusive', () => {
  test('two publishers claiming at the same moment receive disjoint rows', async () => {
    await enqueue([
      processedRow(eventId(111), WALLET_ID),
      processedRow(eventId(112), WALLET_ID),
      processedRow(eventId(113), OTHER_WALLET_ID),
      processedRow(eventId(114), OTHER_WALLET_ID),
    ]);

    let claimed: (ids: string[]) => void = () => undefined;
    const firstClaim = new Promise<string[]>((resolve) => {
      claimed = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = unitOfWork.transactional(async ({ outbox }) => {
      const rows = await outbox.claimPending({ dueAt: PUBLISHED_AT, limit: 2 });
      claimed(rows.map((row) => row.eventId));
      await held;
    });

    const first = await firstClaim;
    const second = await new MikroOrmUnitOfWork(runtime.em.fork()).transactional(({ outbox }) =>
      outbox.claimPending({ dueAt: PUBLISHED_AT, limit: 2 }),
    );
    release();
    await holding;

    expect(first).toEqual([eventId(111), eventId(112)]);
    expect(second.map((row) => row.eventId)).toEqual([eventId(113), eventId(114)]);
  });

  test('a row is claimed only once its next attempt is due', async () => {
    await enqueue([processedRow(eventId(115), WALLET_ID)]);
    await runtime.em
      .getConnection()
      .execute('update "outbox_messages" set "next_attempt_at" = ?', [PUBLISHED_AT]);

    const early = await unitOfWork.transactional(({ outbox }) =>
      outbox.claimPending({ dueAt: new Date(PUBLISHED_AT.getTime() - 1), limit: 50 }),
    );
    const due = await unitOfWork.transactional(({ outbox }) =>
      outbox.claimPending({ dueAt: PUBLISHED_AT, limit: 50 }),
    );

    expect(early).toEqual([]);
    expect(due.map((row) => row.eventId)).toEqual([eventId(115)]);
  });

  test('a batch is claimed in the order the events were recorded', async () => {
    await enqueue([
      processedRow(eventId(118), WALLET_ID, { occurredAt: new Date('2026-10-28T12:00:02.000Z') }),
      processedRow(eventId(117), WALLET_ID, { occurredAt: new Date('2026-10-28T12:00:01.000Z') }),
      processedRow(eventId(116), WALLET_ID, { occurredAt: new Date('2026-10-28T12:00:00.000Z') }),
    ]);

    const claimed = await unitOfWork.transactional(({ outbox }) =>
      outbox.claimPending({ dueAt: PUBLISHED_AT, limit: 50 }),
    );

    expect(claimed.map((row) => row.eventId)).toEqual([eventId(116), eventId(117), eventId(118)]);
  });

  test(
    'a published row is never claimed again',
    async () => {
      await enqueue([processedRow(eventId(119), WALLET_ID)]);

      expect(await publisherOver().execute()).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(await publisherOver().execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
      expect(await queue.receive(2, { timeoutMs: 3000 })).toHaveLength(1);
    },
    BROKER_WAIT_MS,
  );
});

/**
 * The crash window of ADR 0005, reproduced without killing a process: the row is sent, the commit
 * that would have recorded the publication is lost, and the next cycle finds the row pending and
 * sends it again. It returns both publications, as the broker was handed them.
 */
async function republishedAfterLostCommit(id: string): Promise<{
  readonly row: OutboxMessage;
  readonly sent: readonly { readonly eventId: string; readonly body: string }[];
}> {
  const row = processedRow(id, WALLET_ID);
  await enqueue([row]);
  const broker = recording(sqsPublisher());

  expect(
    await rejection(
      publisherOver({
        publisher: broker.publisher,
        unitOfWork: losingCommit(unitOfWork),
      }).execute(),
    ),
  ).toMatch(/never landed/);

  // The send happened; the commit did not, so the row is still pending and still due.
  expect(await storedRow(id)).toMatchObject({ attempts: 0, published_at: null });

  expect(await publisherOver({ publisher: broker.publisher }).execute()).toEqual({
    claimed: 1,
    published: 1,
    failed: 0,
  });
  expect(await storedRow(id)).toMatchObject({ published_at: PUBLISHED_AT.toISOString() });

  return { row, sent: broker.sent };
}

describe('stable-event-id', () => {
  test(
    'both publications of a row carry the event id and the envelope it was enqueued with',
    async () => {
      const { row, sent } = await republishedAfterLostCommit(eventId(121));

      // Byte for byte the same message, because both were taken from the stored row and nothing
      // about that row changed between them (`outbox.stable-event-id`).
      expect(sent).toHaveLength(2);
      expect(sent.map((message) => message.eventId)).toEqual([row.eventId, row.eventId]);
      expect(sent[0]).toEqual(sent[1]);
      expect(JSON.parse(sent[0]?.body ?? '')).toEqual(row.payload);
    },
    BROKER_WAIT_MS,
  );
});

describe('duplicate-publication-safe', () => {
  test(
    'a consumer deduplicating by event id applies the event once, whatever the copies',
    async () => {
      const { row, sent } = await republishedAfterLostCommit(eventId(122));

      // The queue holds one copy, because the deduplication id suppressed the second within its
      // window; a consumer may not rely on that (`msg.broker-features-optional`), so the reference
      // consumer is handed the delivered copy and every copy the publisher sent.
      const delivered = await queue.receive(2, { timeoutMs: 3000 });
      expect(delivered).toHaveLength(1);

      const consumer = new ReferenceConsumer();
      const copies = [
        ...sent.map((message) => JSON.parse(message.body) as IntegrationEventEnvelope),
        ...delivered.map((event) => event.envelope),
      ];

      expect(copies.map((copy) => consumer.apply(copy))).toEqual([
        'applied',
        'duplicate',
        'duplicate',
      ]);
      expect(consumer.appliedCount).toBe(1);
      expect(consumer.copiesOf(row.eventId)).toBe(3);
      expect(consumer.appliedEvent(row.eventId)).toEqual(row.payload);
    },
    BROKER_WAIT_MS,
  );
});

describe('publisher-backoff-never-drops', () => {
  test(
    'an outage counts attempts with capped backoff, drops nothing and drains when the broker returns',
    async () => {
      await enqueue([processedRow(eventId(131), WALLET_ID), processedRow(eventId(132), WALLET_ID)]);
      const time = movableClock(PUBLISHED_AT);
      const log = recordingLogger();
      const failing = publisherOver({
        publisher: unreachablePublisher(),
        clock: time.clock,
        logger: log.logger,
      });

      expect(await failing.execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
      expect(await storedRow(eventId(131))).toMatchObject({
        attempts: 1,
        published_at: null,
        next_attempt_at: new Date(PUBLISHED_AT.getTime() + 2000).toISOString(),
      });

      // Nothing is due yet, so a cycle one second later claims nothing and costs no broker call.
      time.forward(1000);
      expect(await failing.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });

      time.forward(1000);
      expect(await failing.execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
      expect(await storedRow(eventId(131))).toMatchObject({
        attempts: 2,
        next_attempt_at: new Date(PUBLISHED_AT.getTime() + 2000 + 4000).toISOString(),
      });
      expect(log.records).toEqual([]);

      // The broker returns; the rows are still there, with the attempts they accumulated.
      time.forward(4000);
      const returned = publisherOver({ clock: time.clock });
      expect(await returned.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });

      const rows = await storedRows();
      expect(rows.map((row) => row.attempts)).toEqual([2, 2]);
      expect(rows.every((row) => row.published_at !== null)).toBe(true);
      expect((await queue.receive(2)).map((event) => event.envelope.eventId).toSorted()).toEqual([
        eventId(131),
        eventId(132),
      ]);
    },
    BROKER_WAIT_MS,
  );

  test(
    'a row that has failed ten times is reported, keeps its backoff capped and is still published',
    async () => {
      await enqueue([processedRow(eventId(133), WALLET_ID)]);
      await runtime.em
        .getConnection()
        .execute('update "outbox_messages" set "attempts" = 9, "next_attempt_at" = ?', [
          ENQUEUED_AT,
        ]);
      const time = movableClock(PUBLISHED_AT);
      const log = recordingLogger();

      expect(
        await publisherOver({
          publisher: unreachablePublisher(),
          clock: time.clock,
          logger: log.logger,
        }).execute(),
      ).toEqual({ claimed: 1, published: 0, failed: 1 });

      expect(await storedRow(eventId(133))).toMatchObject({
        attempts: 10,
        published_at: null,
        next_attempt_at: new Date(PUBLISHED_AT.getTime() + 300_000).toISOString(),
      });
      expect(log.records).toMatchObject([
        {
          event: 'outbox.publication-stalled',
          fields: { eventId: eventId(133), attempts: 10, aggregateId: WALLET_ID },
        },
      ]);

      time.forward(300_000);
      expect(await publisherOver({ clock: time.clock }).execute()).toEqual({
        claimed: 1,
        published: 1,
        failed: 0,
      });
      expect(await queue.receive(1)).toHaveLength(1);
    },
    BROKER_WAIT_MS,
  );
});

describe('consumer-side-ordering', () => {
  test(
    'balance events delivered in any order rebuild the ledger chain by wallet version',
    async () => {
      const chain = [
        balanceChangedRow(eventId(141), WALLET_ID, {
          operation: { kind: 'OPENING' },
          before: '0.00',
          money: '500.00',
          after: '500.00',
          walletVersion: 1,
          occurredAt: new Date('2026-10-28T12:00:00.000Z'),
        }),
        balanceChangedRow(eventId(142), WALLET_ID, {
          before: '500.00',
          money: '40.00',
          after: '460.00',
          walletVersion: 2,
          occurredAt: new Date('2026-10-28T12:00:01.000Z'),
        }),
        balanceChangedRow(eventId(143), WALLET_ID, {
          before: '460.00',
          money: '60.00',
          after: '400.00',
          walletVersion: 3,
          occurredAt: new Date('2026-10-28T12:00:02.000Z'),
        }),
      ];
      await enqueue(chain);

      // One row per cycle, as two publishers holding consecutive events of one wallet would: the
      // order the copies reach a consumer is not the order they were recorded in (`event.ordering`).
      for (const recorded of chain) {
        expect(await publisherOver({ batchSize: 1 }).execute()).toMatchObject({ published: 1 });
        expect(await storedRow(recorded.eventId)).toMatchObject({
          published_at: PUBLISHED_AT.toISOString(),
        });
      }

      const delivered = await queue.receive(3);
      expect(delivered).toHaveLength(3);

      const consumer = new ReferenceConsumer();
      for (const event of delivered.toReversed()) {
        expect(consumer.apply(event.envelope)).toBe('applied');
      }

      expect(consumer.balanceChangesOf(WALLET_ID).map((change) => change.walletVersion)).toEqual([
        1, 2, 3,
      ]);
      expect(consumer.rebuiltBalanceOf(WALLET_ID, brl('0.00'))).toEqual(brl('400.00'));
    },
    BROKER_WAIT_MS,
  );
});
