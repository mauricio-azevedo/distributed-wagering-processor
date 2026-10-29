import { describe, expect, test } from 'bun:test';

import { InvalidMessageStateError } from '../../src/domain/errors';
import {
  type TransactionIdentity,
  WagerTransactionProcessed,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';

const WALLET_ID = '0193f0c0-0000-7000-8000-00000000000a';
const PLAYER_ID = '0193f0c0-0000-7000-8000-00000000000b';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000c';
const EVENT_ID = '0193f0c0-0000-7000-8000-00000000000e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const OCCURRED_AT = new Date('2026-10-28T12:00:00.000Z');
const FAILED_AT = new Date('2026-10-28T12:00:05.000Z');
const PUBLISHED_AT = new Date('2026-10-28T12:00:01.000Z');

const brl = (amount: string): Money => Money.from(amount, 'BRL');

const IDENTITY: TransactionIdentity = {
  transactionId: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
};

const processedEvent = (eventId = EVENT_ID): WagerTransactionProcessed =>
  WagerTransactionProcessed.record({
    eventId,
    correlationId: CORRELATION_ID,
    occurredAt: OCCURRED_AT,
    identity: IDENTITY,
    balanceAfter: brl('60.00'),
    walletVersion: 4,
    processedAt: OCCURRED_AT,
    reference: null,
  });

const enqueued = (): OutboxMessage => OutboxMessage.enqueue(processedEvent());

const pendingAfter = (attempts: number): OutboxMessage =>
  OutboxMessage.rehydrate({
    eventId: EVENT_ID,
    eventType: 'WagerTransactionProcessed',
    aggregateId: WALLET_ID,
    payload: processedEvent().toJSON(),
    occurredAt: OCCURRED_AT,
    attempts,
    nextAttemptAt: FAILED_AT,
    publishedAt: null,
  });

describe('domain-factories-are-the-only-entry', () => {
  test('the OutboxMessage constructor is not reachable', () => {
    const construct = (): void => {
      // @ts-expect-error - the constructor is private (`model.private-constructors`).
      new OutboxMessage();
    };

    expect(construct).toThrow(TypeError);
  });

  test('enqueue stores the event envelope as the row, pending and due at once', () => {
    const row = enqueued();

    expect(row).toBeInstanceOf(OutboxMessage);
    expect(row.eventType).toBe('WagerTransactionProcessed');
    expect(row.aggregateId).toBe(WALLET_ID);
    expect(row.occurredAt).toEqual(OCCURRED_AT);
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).toEqual(OCCURRED_AT);
    expect(row.publishedAt).toBeNull();
    expect(row.isPublished()).toBe(false);
    expect(row.payload).toEqual(processedEvent().toJSON());
  });

  test('the event id is fixed when the row is enqueued and carries into the payload', () => {
    const row = enqueued();

    expect(row.eventId).toBe(EVENT_ID);
    expect(row.payload.eventId).toBe(EVENT_ID);
    expect(
      OutboxMessage.enqueue(processedEvent('0193f0c0-0000-7000-8000-0000000000ee')).eventId,
    ).toBe('0193f0c0-0000-7000-8000-0000000000ee');
  });

  test('a failed publication and a successful one leave the event id untouched', () => {
    const row = enqueued();

    row.scheduleRetry(FAILED_AT);
    row.markPublished(PUBLISHED_AT);

    expect(row.eventId).toBe(EVENT_ID);
    expect(row.payload).toEqual(processedEvent().toJSON());
  });
});

describe('rehydrate-trusts-stored-state', () => {
  test('a row that failed nine times is rebuilt as the database holds it', () => {
    const stored = pendingAfter(9);

    expect(stored.attempts).toBe(9);
    expect(stored.nextAttemptAt).toEqual(FAILED_AT);
    expect(stored.isPublished()).toBe(false);
  });

  test('a published row is rebuilt published, whatever its attempts', () => {
    const stored = OutboxMessage.rehydrate({
      eventId: EVENT_ID,
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      payload: processedEvent().toJSON(),
      occurredAt: OCCURRED_AT,
      attempts: 3,
      nextAttemptAt: FAILED_AT,
      publishedAt: PUBLISHED_AT,
    });

    expect(stored.isPublished()).toBe(true);
    expect(stored.publishedAt).toEqual(PUBLISHED_AT);
  });
});

describe('outbox-retry-backoff-is-capped', () => {
  test.each([
    [1, 2],
    [2, 4],
    [3, 8],
    [4, 16],
    [5, 32],
    [6, 64],
    [7, 128],
    [8, 256],
    [9, 300],
    [10, 300],
  ])('failure %i schedules the next attempt %i seconds later', (attempts, seconds) => {
    const row = enqueued();

    for (let failure = 0; failure < attempts; failure += 1) {
      row.scheduleRetry(FAILED_AT);
    }

    expect(row.attempts).toBe(attempts);
    expect(row.nextAttemptAt).toEqual(new Date(FAILED_AT.getTime() + seconds * 1000));
  });

  test('the interval never grows past five minutes, however many attempts a row has', () => {
    const row = pendingAfter(40);

    row.scheduleRetry(FAILED_AT);

    expect(row.attempts).toBe(41);
    expect(row.nextAttemptAt).toEqual(new Date(FAILED_AT.getTime() + 300_000));
  });

  test.each([
    [0, false],
    [9, false],
    [10, true],
    [40, true],
  ])('a row that failed %i times reports stalled %p', (attempts, stalled) => {
    expect(pendingAfter(attempts).hasStalled()).toBe(stalled);
  });

  test('the tenth failure is what makes a row stalled, and it stays publishable', () => {
    const row = enqueued();

    for (let failure = 0; failure < 9; failure += 1) {
      row.scheduleRetry(FAILED_AT);
    }

    expect(row.hasStalled()).toBe(false);

    row.scheduleRetry(FAILED_AT);

    expect(row.hasStalled()).toBe(true);
    expect(row.isPublished()).toBe(false);
    expect(row.nextAttemptAt).toEqual(new Date(FAILED_AT.getTime() + 300_000));
  });

  test('a row is never discarded: after ten failures it is still pending and publishable', () => {
    const row = enqueued();

    for (let failure = 0; failure < 12; failure += 1) {
      row.scheduleRetry(new Date(FAILED_AT.getTime() + failure * 1000));
    }

    expect(row.attempts).toBe(12);
    expect(row.isPublished()).toBe(false);
    expect(row.payload).toEqual(processedEvent().toJSON());

    row.markPublished(PUBLISHED_AT);

    expect(row.isPublished()).toBe(true);
  });
});

describe('outbox-transitions-are-explicit', () => {
  test('markPublished records the publication once', () => {
    const row = enqueued();

    row.markPublished(PUBLISHED_AT);

    expect(row.publishedAt).toEqual(PUBLISHED_AT);
    expect(row.attempts).toBe(0);
  });

  test('a published row refuses both transitions and keeps its state', () => {
    const row = enqueued();
    row.markPublished(PUBLISHED_AT);

    const publishAgain = (): void => {
      row.markPublished(new Date('2026-10-28T13:00:00.000Z'));
    };
    const retryAgain = (): void => {
      row.scheduleRetry(FAILED_AT);
    };

    expect(publishAgain).toThrow(InvalidMessageStateError);
    expect(retryAgain).toThrow(InvalidMessageStateError);
    expect(row.publishedAt).toEqual(PUBLISHED_AT);
    expect(row.attempts).toBe(0);
  });

  test('markPublished and scheduleRetry are the only members that change a row', () => {
    const row = enqueued();
    const assignPublishedAt = (): void => {
      // @ts-expect-error - publication happens through markPublished (`model.explicit-transitions`).
      row.publishedAt = PUBLISHED_AT;
    };
    // A private member of TypeScript is still on the prototype at runtime; the surface the
    // publisher can reach is three readings, two questions and the two transitions.
    const surface = Object.getOwnPropertyNames(OutboxMessage.prototype).filter(
      (name) => !['constructor', 'assertPending', 'backoffSeconds'].includes(name),
    );

    expect(assignPublishedAt).toThrow(TypeError);
    expect(row.publishedAt).toBeNull();
    expect(surface.toSorted()).toEqual([
      'attempts',
      'hasStalled',
      'isPublished',
      'markPublished',
      'nextAttemptAt',
      'publishedAt',
      'scheduleRetry',
    ]);
  });
});
