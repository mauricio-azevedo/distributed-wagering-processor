import { describe, expect, test } from 'bun:test';

import { InvalidTransactionStateError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { PendingReferenceSchedule } from '../../src/domain/pending-reference-schedule';
import { WagerTransaction } from '../../src/domain/wager-transaction';

const TRANSACTION_ID = '01a18268-f900-758e-8c3e-13ce27511119';
const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const RECEIVED_AT = new Date('2026-10-28T12:08:00.000Z');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A parked `ROLLBACK`: the only state a schedule row exists for (`ref.parked-state`). */
function parked(): WagerTransaction {
  const transaction = WagerTransaction.create({
    id: TRANSACTION_ID,
    providerId: 'provider-acme',
    externalTransactionId: 'acme-rollback-1',
    idempotencyKey: 'provider-acme:acme-rollback-1',
    payloadHash: 'sha256:' + 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'ROLLBACK',
    money: Money.from('40.00', 'BRL'),
    referenceExternalTransactionId: 'acme-bet-1',
    createdAt: RECEIVED_AT,
  });
  transaction.markPendingReference({ observedBalance: Money.from('460.00', 'BRL') });

  return transaction;
}

const openSchedule = (): PendingReferenceSchedule => PendingReferenceSchedule.open(parked());

describe('pending-reference-backoff', () => {
  test('a parked transaction is first attempted one second after it was received', () => {
    const schedule = openSchedule();

    expect(schedule.transactionId).toBe(TRANSACTION_ID);
    expect(schedule.attempts).toBe(0);
    expect(schedule.nextAttemptAt).toEqual(new Date(RECEIVED_AT.getTime() + SECOND));
  });

  /**
   * `ref.backoff`: `min(1s × 2^attempt, 5m)`, as the gap each of the first thirteen attempts
   * leaves behind it. The first is the gap the park itself scheduled, counted from the receipt;
   * every later one is counted from the attempt that just ran.
   */
  test('the attempts are spaced by one second doubling up to five minutes', () => {
    const schedule = openSchedule();
    const gaps = [(schedule.nextAttemptAt.getTime() - RECEIVED_AT.getTime()) / SECOND];

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const attemptedAt = new Date(RECEIVED_AT.getTime() + attempt * MINUTE);
      schedule.recordAttempt(attemptedAt);
      gaps.push((schedule.nextAttemptAt.getTime() - attemptedAt.getTime()) / SECOND);
    }

    expect(schedule.attempts).toBe(12);
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300]);
  });

  test('the backoff is counted from the attempt, not from the receipt', () => {
    const schedule = openSchedule();
    const attemptedAt = new Date(RECEIVED_AT.getTime() + 11 * MINUTE);

    schedule.recordAttempt(attemptedAt);

    expect(schedule.nextAttemptAt).toEqual(new Date(attemptedAt.getTime() + 2 * SECOND));
  });
});

describe('pending-reference-window', () => {
  /** `ref.ttl`: sixty minutes after the first receipt, and no attempt moves it. */
  test('the window closes sixty minutes after the first receipt', () => {
    const schedule = openSchedule();

    expect(schedule.expiresAt).toEqual(new Date(RECEIVED_AT.getTime() + 60 * MINUTE));
  });

  test('an attempt counts and reschedules without ever extending the window', () => {
    const schedule = openSchedule();

    schedule.recordAttempt(new Date(RECEIVED_AT.getTime() + 30 * MINUTE));

    expect(schedule.expiresAt).toEqual(new Date(RECEIVED_AT.getTime() + 60 * MINUTE));
  });

  test.each([
    ['inside the window', 59 * MINUTE, false],
    ['at the moment it closes', 60 * MINUTE, true],
    ['after it closed', 60 * MINUTE + 1, true],
  ])('a transaction %s has expired: %p', (_case, elapsed, expired) => {
    expect(openSchedule().hasExpired(new Date(RECEIVED_AT.getTime() + elapsed))).toBe(expired);
  });
});

describe('pending-reference-schedule-identity', () => {
  test('a schedule exists only for a parked transaction', () => {
    const transaction = parked();
    transaction.markProcessed({
      observedBalance: Money.from('500.00', 'BRL'),
      processedAt: RECEIVED_AT,
      referenceTransactionId: '01a18266-39e0-758b-a289-fb48c2dd9c8b',
    });

    expect(() => PendingReferenceSchedule.open(transaction)).toThrow(InvalidTransactionStateError);
  });

  test('a stored row is rebuilt as it stands, without replaying the backoff', () => {
    const state = {
      transactionId: TRANSACTION_ID,
      attempts: 4,
      nextAttemptAt: new Date(RECEIVED_AT.getTime() + 2 * MINUTE),
      expiresAt: new Date(RECEIVED_AT.getTime() + 60 * MINUTE),
    };

    const schedule = PendingReferenceSchedule.rehydrate(state);

    expect(schedule.attempts).toBe(4);
    expect(schedule.nextAttemptAt).toEqual(state.nextAttemptAt);
    expect(schedule.expiresAt).toEqual(state.expiresAt);
  });
});
