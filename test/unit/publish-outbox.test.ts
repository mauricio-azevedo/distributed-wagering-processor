import { describe, expect, test } from 'bun:test';

import type { Clock } from '../../src/application/ports/clock';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { LogFields, Logger } from '../../src/application/ports/logger';
import type { OutboxClaim } from '../../src/application/ports/repositories';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import {
  DEFAULT_OUTBOX_BATCH_SIZE,
  PublishOutbox,
} from '../../src/application/use-cases/publish-outbox';
import {
  type TransactionIdentity,
  WagerTransactionProcessed,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage, type OutboxMessageState } from '../../src/domain/outbox-message';

const WALLET_ID = '0193f0c0-0000-7000-8000-00000000000a';
const OTHER_WALLET_ID = '0193f0c0-0000-7000-8000-00000000000b';
const PLAYER_ID = '0193f0c0-0000-7000-8000-00000000000c';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000d';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const ENQUEUED_AT = new Date('2026-10-28T12:00:00.000Z');
const PUBLISHED_AT = new Date('2026-10-28T12:00:10.000Z');

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

/** One pending row, due since `ENQUEUED_AT`, optionally carrying earlier failed attempts. */
function pending(
  eventId: string,
  walletId: string,
  options: { readonly attempts?: number } = {},
): OutboxMessage {
  const row = OutboxMessage.enqueue(
    WagerTransactionProcessed.record({
      eventId,
      correlationId: CORRELATION_ID,
      occurredAt: ENQUEUED_AT,
      identity: identity(walletId),
      balanceAfter: brl('460.00'),
      walletVersion: 2,
      processedAt: ENQUEUED_AT,
      reference: null,
    }),
  );

  return OutboxMessage.rehydrate({
    eventId: row.eventId,
    eventType: row.eventType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: options.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: null,
  });
}

const stateOf = (message: OutboxMessage): OutboxMessageState => ({
  eventId: message.eventId,
  eventType: message.eventType,
  aggregateId: message.aggregateId,
  payload: message.payload,
  occurredAt: message.occurredAt,
  attempts: message.attempts,
  nextAttemptAt: message.nextAttemptAt,
  publishedAt: message.publishedAt,
});

/**
 * The outbox as rows rather than as objects, which is what the database is: a claim rehydrates
 * copies, so whatever the use case changes reaches the store only through `recordAttempt`, and a
 * write lands only when the transaction commits — a cycle whose commit is lost leaves rows exactly
 * as it found them, which is the duplicate window of ADR 0005.
 */
function outboxStore(rows: readonly OutboxMessage[]) {
  const stored = new Map<string, OutboxMessageState>(
    rows.map((row) => [row.eventId, stateOf(row)]),
  );
  const staged = new Map<string, OutboxMessageState>();
  const claims: OutboxClaim[] = [];

  return {
    claims,
    commit: () => {
      for (const [eventId, state] of staged) {
        stored.set(eventId, state);
      }
      staged.clear();
    },
    rollback: () => {
      staged.clear();
    },
    row: (eventId: string): OutboxMessage => {
      const state = stored.get(eventId);
      if (state === undefined) {
        throw new Error(`the store holds no row ${eventId}`);
      }

      return OutboxMessage.rehydrate(state);
    },
    repository: {
      insert: () => {
        throw new Error('publishing never enqueues');
      },
      findByEventId: () => {
        throw new Error('publishing claims rows, it never looks one up');
      },
      claimPending: (claim: OutboxClaim) => {
        claims.push(claim);

        return Promise.resolve(
          [...stored.values()]
            .filter((state) => state.publishedAt === null && state.nextAttemptAt <= claim.dueAt)
            .toSorted((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
            .slice(0, claim.limit)
            .map((state) => OutboxMessage.rehydrate(state)),
        );
      },
      recordAttempt: (message: OutboxMessage) => {
        staged.set(message.eventId, stateOf(message));

        return Promise.resolve();
      },
    },
  };
}

/** A publisher that records what it was asked to send and fails for the event ids it is given. */
function recordingPublisher(failing: readonly string[] = []) {
  const sent: { readonly eventId: string; readonly body: string }[] = [];

  return {
    sent,
    publisher: {
      publish: (message: OutboxMessage) => {
        if (failing.includes(message.eventId)) {
          return Promise.reject(new Error(`the broker refused ${message.eventId}`));
        }
        sent.push({ eventId: message.eventId, body: JSON.stringify(message.payload) });

        return Promise.resolve();
      },
    } satisfies EventPublisher,
  };
}

function recordingLogger() {
  const records: { readonly event: string; readonly fields: LogFields }[] = [];

  return {
    records,
    logger: {
      error: (event: string, fields: LogFields) => {
        records.push({ event, fields });
      },
    } satisfies Logger,
  };
}

interface CycleOptions {
  readonly rows?: readonly OutboxMessage[];
  readonly failing?: readonly string[];
  readonly batchSize?: number;
  /** The commit that never lands: the window in which a published row stays pending. */
  readonly failCommit?: boolean;
}

function publisherOver(options: CycleOptions = {}) {
  const store = outboxStore(options.rows ?? []);
  const broker = recordingPublisher(options.failing);
  const log = recordingLogger();
  const unitOfWork: UnitOfWork = {
    snapshot() {
      throw new Error('publishing writes, so it must not run in a read-only snapshot');
    },
    async transactional(work) {
      try {
        const result = await work({ outbox: store.repository } as unknown as Repositories);
        if (options.failCommit === true) {
          throw new Error('the commit that records the publication never landed');
        }
        store.commit();

        return result;
      } catch (error) {
        store.rollback();

        throw error;
      }
    },
  };

  return {
    store,
    broker,
    log,
    useCase: new PublishOutbox({
      unitOfWork,
      publisher: broker.publisher,
      clock: { now: () => PUBLISHED_AT } satisfies Clock,
      logger: log.logger,
      ...(options.batchSize !== undefined && { batchSize: options.batchSize }),
    }),
  };
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

const FIRST = '0193f0c0-0000-7000-8000-000000000101';
const SECOND = '0193f0c0-0000-7000-8000-000000000102';
const THIRD = '0193f0c0-0000-7000-8000-000000000103';

describe('publisher-publishes-claimed-rows', () => {
  test('every claimed row is sent and marked published at the moment it was sent', async () => {
    const { useCase, store, broker } = publisherOver({
      rows: [pending(FIRST, WALLET_ID), pending(SECOND, OTHER_WALLET_ID)],
    });

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(broker.sent.map((message) => message.eventId)).toEqual([FIRST, SECOND]);
    for (const eventId of [FIRST, SECOND]) {
      expect(store.row(eventId).isPublished()).toBe(true);
      expect(store.row(eventId).publishedAt).toEqual(PUBLISHED_AT);
      expect(store.row(eventId).attempts).toBe(0);
    }
  });

  test('a cycle claims the due rows of one batch, at the moment it runs', async () => {
    const { useCase, store } = publisherOver({ rows: [pending(FIRST, WALLET_ID)] });

    await useCase.execute();

    expect(store.claims).toEqual([{ dueAt: PUBLISHED_AT, limit: DEFAULT_OUTBOX_BATCH_SIZE }]);
    expect(DEFAULT_OUTBOX_BATCH_SIZE).toBe(50);
  });

  test('the batch size is configuration: a smaller one leaves the rest for the next cycle', async () => {
    const { useCase, store, broker } = publisherOver({
      rows: [pending(FIRST, WALLET_ID), pending(SECOND, WALLET_ID), pending(THIRD, WALLET_ID)],
      batchSize: 2,
    });

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(store.claims).toEqual([{ dueAt: PUBLISHED_AT, limit: 2 }]);
    expect(broker.sent).toHaveLength(2);
    expect(store.row(THIRD).isPublished()).toBe(false);
  });

  test('an outbox with nothing due sends nothing and reports an idle cycle', async () => {
    const { useCase, broker } = publisherOver();

    expect(await useCase.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(broker.sent).toEqual([]);
  });

  test('a published row is never claimed again', async () => {
    const { useCase, broker } = publisherOver({ rows: [pending(FIRST, WALLET_ID)] });

    await useCase.execute();
    expect(await useCase.execute()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(broker.sent).toHaveLength(1);
  });
});

describe('publisher-sends-the-stored-envelope', () => {
  test('the message is the envelope the row was enqueued with, byte for byte', async () => {
    const row = pending(FIRST, WALLET_ID);
    const { useCase, broker } = publisherOver({ rows: [row] });

    await useCase.execute();

    expect(broker.sent[0]?.body).toBe(JSON.stringify(row.payload));
  });

  test('a republication after a lost commit carries the same event id and the same bytes', async () => {
    const row = pending(FIRST, WALLET_ID);
    const lost = publisherOver({ rows: [row], failCommit: true });

    expect(await rejection(lost.useCase.execute())).toMatch(/never landed/);

    // The send happened and the commit did not, so the row is pending: the duplicate window of
    // ADR 0005. Another publisher then claims it and sends the same message again.
    expect(lost.store.row(FIRST).isPublished()).toBe(false);
    const again = publisherOver({ rows: [lost.store.row(FIRST)] });
    await again.useCase.execute();

    expect(again.broker.sent).toEqual(lost.broker.sent);
    expect(again.broker.sent[0]?.eventId).toBe(FIRST);
  });
});

describe('publisher-retries-without-dropping', () => {
  test('a failed publication counts an attempt, schedules the backoff and stays pending', async () => {
    const { useCase, store } = publisherOver({
      rows: [pending(FIRST, WALLET_ID)],
      failing: [FIRST],
    });

    expect(await useCase.execute()).toEqual({ claimed: 1, published: 0, failed: 1 });

    const row = store.row(FIRST);
    expect(row.attempts).toBe(1);
    expect(row.isPublished()).toBe(false);
    expect(row.nextAttemptAt).toEqual(new Date(PUBLISHED_AT.getTime() + 2000));
    expect(row.payload).toEqual(pending(FIRST, WALLET_ID).payload);
  });

  test('one row the broker refuses does not hold back the rest of the batch', async () => {
    const { useCase, store, broker } = publisherOver({
      rows: [pending(FIRST, WALLET_ID), pending(SECOND, WALLET_ID), pending(THIRD, WALLET_ID)],
      failing: [SECOND],
    });

    expect(await useCase.execute()).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(broker.sent.map((message) => message.eventId)).toEqual([FIRST, THIRD]);
    expect(store.row(SECOND).attempts).toBe(1);
    expect(store.row(FIRST).isPublished()).toBe(true);
    expect(store.row(THIRD).isPublished()).toBe(true);
  });

  test('a row that crossed ten attempts is reported, and is retried all the same', async () => {
    const { useCase, store, log } = publisherOver({
      rows: [pending(FIRST, WALLET_ID, { attempts: 9 })],
      failing: [FIRST],
    });

    expect(await useCase.execute()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(log.records).toEqual([
      {
        event: 'outbox.publication-stalled',
        fields: {
          eventId: FIRST,
          eventType: 'WagerTransactionProcessed',
          aggregateId: WALLET_ID,
          attempts: 10,
          nextAttemptAt: new Date(PUBLISHED_AT.getTime() + 300_000).toISOString(),
          reason: `the broker refused ${FIRST}`,
        },
      },
    ]);

    const row = store.row(FIRST);
    expect(row.attempts).toBe(10);
    expect(row.hasStalled()).toBe(true);
    expect(row.isPublished()).toBe(false);
  });

  test('an ordinary transient failure is not an alert', async () => {
    const { useCase, log } = publisherOver({
      rows: [pending(FIRST, WALLET_ID, { attempts: 3 })],
      failing: [FIRST],
    });

    await useCase.execute();

    expect(log.records).toEqual([]);
  });

  test('no record of a publication survives a cycle whose commit was lost', async () => {
    const { useCase, store } = publisherOver({
      rows: [pending(FIRST, WALLET_ID), pending(SECOND, WALLET_ID)],
      failing: [SECOND],
      failCommit: true,
    });

    expect(await rejection(useCase.execute())).toMatch(/never landed/);

    expect(store.row(FIRST).isPublished()).toBe(false);
    expect(store.row(SECOND).attempts).toBe(0);
  });
});
