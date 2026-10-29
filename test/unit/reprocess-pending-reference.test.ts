import { describe, expect, test } from 'bun:test';

import { ServiceUnavailableError, WalletNotFoundError } from '../../src/application/errors';
import type { Clock } from '../../src/application/ports/clock';
import type { IdGenerator } from '../../src/application/ports/id-generator';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ReprocessPendingReference } from '../../src/application/use-cases/reprocess-pending-reference';
import type { IntegrationEventType } from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import {
  PendingReferenceSchedule,
  type PendingReferenceScheduleState,
} from '../../src/domain/pending-reference-schedule';
import { WagerTransaction, type WagerTransactionState } from '../../src/domain/wager-transaction';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { recordingLogger } from '../helpers/recording-logger';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import type { OutboxMessage } from '../../src/domain/outbox-message';

const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const PROVIDER_ID = 'provider-acme';
const ROUND_ID = 'round-7f3a';
const BET_ID = '01a18266-39e0-758b-a289-fb48c2dd9c8b';
const ROLLBACK_ID = '01a18268-f900-758e-8c3e-13ce27511119';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');
/** When the reversal arrived, which is what its waiting window is counted from (`ref.ttl`). */
const RECEIVED_AT = new Date('2026-10-28T12:08:00.000Z');
/** When the attempt runs: after the first attempt is due and well inside the window. */
const ATTEMPTED_AT = new Date('2026-10-28T12:08:10.000Z');
/** An attempt after the window closed (`ref.expiry`). */
const AFTER_THE_WINDOW = new Date('2026-10-28T13:08:01.000Z');

const SECOND = 1000;

const brl = (amount: string) => Money.from(amount, 'BRL');

/** What the fake database holds, as the rows a real one would: state, never live aggregates. */
interface Store {
  readonly wallets: Map<string, WalletState>;
  readonly transactions: Map<string, WagerTransactionState>;
  readonly schedules: Map<string, PendingReferenceScheduleState>;
  readonly entries: WalletLedgerEntry[];
  readonly outbox: OutboxMessage[];
}

const transactionStateOf = (transaction: WagerTransaction): WagerTransactionState => ({
  id: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  payloadHash: transaction.payloadHash,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money,
  status: transaction.status,
  failureCode: transaction.failureCode,
  observedBalance: transaction.observedBalance,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  referenceTransactionId: transaction.referenceTransactionId,
  processedAt: transaction.processedAt,
  createdAt: transaction.createdAt,
});

const scheduleStateOf = (schedule: PendingReferenceSchedule): PendingReferenceScheduleState => ({
  transactionId: schedule.transactionId,
  correlationId: schedule.correlationId,
  attempts: schedule.attempts,
  nextAttemptAt: schedule.nextAttemptAt,
  expiresAt: schedule.expiresAt,
});

/** The wallet after a `BET` of `40.00` against an opening credit of `500.00`. */
const WALLET: WalletState = {
  id: WALLET_ID,
  playerId: PLAYER_ID,
  balance: brl('460.00'),
  version: 2,
  createdAt: OPENED_AT,
  updatedAt: OPENED_AT,
};

/** The `BET` a reversal references, as the row it is once processed. */
function processedBet(): WagerTransactionState {
  const bet = WagerTransaction.create({
    id: BET_ID,
    providerId: PROVIDER_ID,
    externalTransactionId: 'acme-bet-1',
    idempotencyKey: `${PROVIDER_ID}:acme-bet-1`,
    payloadHash: 'sha256:' + 'b'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl('40.00'),
    referenceExternalTransactionId: null,
    createdAt: OPENED_AT,
  });
  bet.markProcessed({ observedBalance: brl('460.00'), processedAt: OPENED_AT });

  return transactionStateOf(bet);
}

/** The `ROLLBACK` that arrived before its `BET` and was parked (`ref.parked-state`). */
function parkedRollback(
  id = ROLLBACK_ID,
  externalTransactionId = 'acme-rollback-1',
): WagerTransaction {
  const rollback = WagerTransaction.create({
    id,
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: 'sha256:' + 'c'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'lucky-sevens',
    kind: 'ROLLBACK',
    money: brl('40.00'),
    referenceExternalTransactionId: 'acme-bet-1',
    createdAt: RECEIVED_AT,
  });
  rollback.markPendingReference({ observedBalance: brl('460.00') });

  return rollback;
}

interface Fixture {
  /** Whether the referenced `BET` has arrived and been processed. */
  readonly referenceArrived?: boolean;
  /** Called with the name of every port call, so a test can inject a failure at one of them. */
  readonly intercept?: (call: string) => void;
  readonly parked?: readonly WagerTransaction[];
  /** The wallet the parked transaction names is gone: the permanent case of `msg.classification`. */
  readonly walletMissing?: boolean;
}

function storeOf(fixture: Fixture): Store {
  const parked = fixture.parked ?? [parkedRollback()];
  const store: Store = {
    wallets: new Map<string, WalletState>(
      fixture.walletMissing === true ? [] : [[WALLET_ID, WALLET]],
    ),
    transactions: new Map(),
    schedules: new Map(),
    entries: [],
    outbox: [],
  };

  if (fixture.referenceArrived === true) {
    store.transactions.set(BET_ID, processedBet());
  }

  for (const transaction of parked) {
    store.transactions.set(transaction.id, transactionStateOf(transaction));
    const schedule = PendingReferenceSchedule.open(transaction, CORRELATION_ID);
    store.schedules.set(schedule.transactionId, scheduleStateOf(schedule));
  }

  return store;
}

const copy = (store: Store): Store => ({
  wallets: new Map(store.wallets),
  transactions: new Map(store.transactions),
  schedules: new Map(store.schedules),
  entries: [...store.entries],
  outbox: [...store.outbox],
});

function overwrite(target: Store, source: Store): void {
  target.wallets.clear();
  target.transactions.clear();
  target.schedules.clear();
  target.entries.length = 0;
  target.outbox.length = 0;

  for (const [id, wallet] of source.wallets) target.wallets.set(id, wallet);
  for (const [id, transaction] of source.transactions) target.transactions.set(id, transaction);
  for (const [id, schedule] of source.schedules) target.schedules.set(id, schedule);
  target.entries.push(...source.entries);
  target.outbox.push(...source.outbox);
}

/**
 * A `UnitOfWork` over the fake store whose writes reach it only when the work resolves, so an
 * attempt that failed mid-way leaves nothing behind (`outbox.single-transaction`), and a log of the
 * port calls in the order they were issued.
 */
function fakeUnitOfWork(
  store: Store,
  calls: string[],
  intercept: (call: string) => void,
): UnitOfWork {
  return {
    snapshot() {
      throw new Error('reprocessing writes, so it must not run in a read-only snapshot');
    },
    async transactional(work) {
      const staged = copy(store);
      const result = await work(repositoriesOver(staged, calls, intercept));

      overwrite(store, staged);

      return result;
    },
  };
}

function repositoriesOver(
  staged: Store,
  calls: string[],
  intercept: (call: string) => void,
): Repositories {
  const record = (call: string) => {
    calls.push(call);
    intercept(call);
  };
  const unreachable = (port: string) => () => {
    throw new Error(`reprocessing a pending reference must not reach the ${port} port`);
  };

  return {
    wallets: {
      insert: unreachable('wallet insert'),
      findById: (walletId) => {
        record(`find wallet ${walletId}`);
        const wallet = staged.wallets.get(walletId);

        return Promise.resolve(wallet === undefined ? null : Wallet.rehydrate(wallet));
      },
      lockById: (walletId) => {
        record(`lock wallet ${walletId}`);
        const wallet = staged.wallets.get(walletId);

        return Promise.resolve(wallet === undefined ? null : Wallet.rehydrate(wallet));
      },
      update: (wallet, expectedVersion) => {
        record(`update wallet from version ${expectedVersion.toString()}`);

        if (staged.wallets.get(wallet.id)?.version !== expectedVersion) {
          return Promise.reject(new Error('the wallet moved under the lock'));
        }
        staged.wallets.set(wallet.id, wallet);

        return Promise.resolve();
      },
    },
    transactions: {
      insert: unreachable('transaction insert'),
      reserve: unreachable('reservation'),
      findById: (transactionId) => {
        record(`find transaction ${transactionId}`);
        const transaction = staged.transactions.get(transactionId);

        return Promise.resolve(
          transaction === undefined ? null : WagerTransaction.rehydrate(transaction),
        );
      },
      findByProviderTransaction: (identity) => {
        record(`resolve ${identity.providerId}:${identity.externalTransactionId}`);
        const found = [...staged.transactions.values()].find(
          (transaction) =>
            transaction.providerId === identity.providerId &&
            transaction.externalTransactionId === identity.externalTransactionId,
        );

        return Promise.resolve(found === undefined ? null : WagerTransaction.rehydrate(found));
      },
      hasProcessedReversal: (transactionId) => {
        record(`reversals of ${transactionId}`);

        return Promise.resolve(
          [...staged.transactions.values()].some(
            (transaction) =>
              transaction.referenceTransactionId === transactionId &&
              transaction.status === 'PROCESSED' &&
              (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK'),
          ),
        );
      },
      recordOutcome: (transaction) => {
        record(`record ${transaction.status}`);
        staged.transactions.set(transaction.id, transactionStateOf(transaction));

        return Promise.resolve();
      },
    },
    ledger: {
      insert: (entry) => {
        record('insert entry');
        staged.entries.push(entry);

        return Promise.resolve();
      },
      findByTransactionId: unreachable('ledger lookup'),
      summarize: unreachable('ledger summary'),
      page: unreachable('ledger page'),
    },
    inbox: {
      claim: unreachable('inbox claim'),
      complete: unreachable('inbox completion'),
      findByIdentity: unreachable('inbox lookup'),
    },
    outbox: {
      insert: (message) => {
        record(`enqueue ${message.eventType}`);
        staged.outbox.push(message);

        return Promise.resolve();
      },
      findByEventId: unreachable('outbox lookup'),
      claimPending: unreachable('outbox claim'),
      recordAttempt: unreachable('publication attempt'),
      backlog: unreachable('outbox backlog'),
    },
    pendingReferences: {
      insert: (schedule) => {
        record(`schedule ${schedule.transactionId}`);
        staged.schedules.set(schedule.transactionId, scheduleStateOf(schedule));

        return Promise.resolve();
      },
      claimNextDue: (at) => {
        record('claim the next due schedule');
        const due = [...staged.schedules.values()]
          .filter(
            (schedule) =>
              schedule.nextAttemptAt.getTime() <= at.getTime() &&
              staged.transactions.get(schedule.transactionId)?.status === 'PENDING_REFERENCE',
          )
          .toSorted((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
        const [claimed] = due;

        return Promise.resolve(
          claimed === undefined ? null : PendingReferenceSchedule.rehydrate(claimed),
        );
      },
      update: (schedule) => {
        record(`reschedule after attempt ${schedule.attempts.toString()}`);
        staged.schedules.set(schedule.transactionId, scheduleStateOf(schedule));

        return Promise.resolve();
      },
    },
  };
}

/** `id-1`, `id-2`, ...: the mint, so a test can name every id the attempt wrote. */
function sequencedIds(): IdGenerator {
  let minted = 0;

  return {
    next: () => {
      minted += 1;

      return `id-${minted.toString()}`;
    },
  };
}

function reprocessPendingReference(fixture: Fixture = {}, startedAt: Date = ATTEMPTED_AT) {
  const store = storeOf(fixture);
  const calls: string[] = [];
  const log = recordingLogger();
  const metrics = new MetricsRegistry();
  let now = startedAt;
  const clock: Clock = { now: () => now };
  const useCase = new ReprocessPendingReference({
    unitOfWork: fakeUnitOfWork(store, calls, fixture.intercept ?? (() => undefined)),
    clock,
    ids: sequencedIds(),
    logger: log.logger,
    metrics,
  });

  const advanceBy = (seconds: number) => {
    now = new Date(now.getTime() + seconds * SECOND);
  };

  return {
    execute: () => useCase.execute(),
    advanceBy,
    store,
    calls,
    metrics,
    log,
  };
}

const eventTypes = (store: Store): IntegrationEventType[] =>
  store.outbox.map((message) => message.eventType);

const parkedTransaction = (store: Store) => store.transactions.get(ROLLBACK_ID);

const schedule = (store: Store) => store.schedules.get(ROLLBACK_ID);

describe('reprocess-claims-only-what-is-due', () => {
  test('a sweep with no due schedule attempts nothing', async () => {
    const { execute, calls } = reprocessPendingReference({}, new Date(RECEIVED_AT.getTime()));

    expect(await execute()).toEqual([]);
    expect(calls).toEqual(['claim the next due schedule']);
  });

  test('the schedule is claimed before the transaction and the wallet are read', async () => {
    const { execute, calls } = reprocessPendingReference({ referenceArrived: true });

    await execute();

    expect(calls.slice(0, 4)).toEqual([
      'claim the next due schedule',
      `find transaction ${ROLLBACK_ID}`,
      `lock wallet ${WALLET_ID}`,
      `resolve ${PROVIDER_ID}:acme-bet-1`,
    ]);
  });

  test('every claimed schedule is attempted in a transaction of its own', async () => {
    const { execute, calls } = reprocessPendingReference({
      parked: [
        parkedRollback(),
        parkedRollback('01a18268-f900-758e-8c3e-13ce27511121', 'acme-rollback-2'),
      ],
    });

    const attempts = await execute();

    expect(attempts).toHaveLength(2);
    expect(calls.filter((call) => call === 'claim the next due schedule')).toHaveLength(3);
  });
});

describe('rollback-before-bet-resolves', () => {
  test('a reference that has arrived is applied under the normal rules on the next attempt', async () => {
    const { execute, store } = reprocessPendingReference({ referenceArrived: true });

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'PROCESSED',
      failureCode: null,
      referenceTransactionId: BET_ID,
      processedAt: ATTEMPTED_AT,
    });
    expect(parkedTransaction(store)?.observedBalance?.toString()).toBe('500.00');
    expect(store.wallets.get(WALLET_ID)?.balance.toString()).toBe('500.00');
    expect(store.wallets.get(WALLET_ID)?.version).toBe(3);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      transactionId: ROLLBACK_ID,
      kind: 'ROLLBACK',
      direction: 'CREDIT',
      walletVersion: 3,
    });
    expect(eventTypes(store)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('the attempt that applied it is counted on the schedule', async () => {
    const { execute, store } = reprocessPendingReference({ referenceArrived: true });

    await execute();

    expect(schedule(store)?.attempts).toBe(1);
  });

  test('a reference rule still refuses what it would refuse on arrival', async () => {
    const reversed = WagerTransaction.rehydrate({
      ...processedBet(),
      id: '01a18268-f900-758e-8c3e-13ce27511120',
      externalTransactionId: 'acme-refund-1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'acme-bet-1',
      referenceTransactionId: BET_ID,
    });
    const { execute, store } = reprocessPendingReference({
      referenceArrived: true,
      parked: [parkedRollback()],
    });
    store.transactions.set(reversed.id, transactionStateOf(reversed));

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(store.entries).toEqual([]);
    expect(eventTypes(store)).toEqual(['WagerTransactionRejected']);
  });
});

describe('pending-reference-stays-parked', () => {
  test('a reference that still has not arrived is recorded as pending again, with no event', async () => {
    const { execute, store } = reprocessPendingReference();

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'pending' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'PENDING_REFERENCE',
      failureCode: null,
      referenceTransactionId: null,
    });
    expect(store.wallets.get(WALLET_ID)).toEqual(WALLET);
    expect(store.entries).toEqual([]);
    expect(eventTypes(store)).toEqual([]);
  });

  test('the attempt is counted and the next one is scheduled with the backoff', async () => {
    const { execute, store } = reprocessPendingReference();

    await execute();

    expect(schedule(store)?.attempts).toBe(1);
    expect(schedule(store)?.nextAttemptAt).toEqual(new Date(ATTEMPTED_AT.getTime() + 2 * SECOND));
    expect(schedule(store)?.expiresAt).toEqual(new Date(RECEIVED_AT.getTime() + 60 * 60 * SECOND));
  });
});

describe('pending-reference-expires', () => {
  test('an attempt after the window closed rejects it with REFERENCE_NOT_FOUND', async () => {
    const { execute, store } = reprocessPendingReference({}, AFTER_THE_WINDOW);

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'expired' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      processedAt: null,
    });
    expect(parkedTransaction(store)?.observedBalance?.toString()).toBe('460.00');
    expect(store.wallets.get(WALLET_ID)).toEqual(WALLET);
    expect(store.entries).toEqual([]);
    expect(eventTypes(store)).toEqual(['WagerTransactionRejected']);
  });

  test('the rejected event names the reference the transaction waited for', async () => {
    const { execute, store } = reprocessPendingReference({}, AFTER_THE_WINDOW);

    await execute();

    expect(store.outbox[0]?.payload.data).toMatchObject({
      transactionId: ROLLBACK_ID,
      kind: 'ROLLBACK',
      failureCode: 'REFERENCE_NOT_FOUND',
      observedBalance: { amount: '460.00', currency: 'BRL' },
      referenceExternalTransactionId: 'acme-bet-1',
    });
  });

  /**
   * `ref.expiry` is a decision about a missing reference, so a reference that did arrive is applied
   * even on an attempt that runs after the window closed: nothing is missing to reject it for.
   */
  test('a reference that arrived before the window closed is still applied afterwards', async () => {
    const { execute, store } = reprocessPendingReference(
      { referenceArrived: true },
      AFTER_THE_WINDOW,
    );

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(parkedTransaction(store)?.status).toBe('PROCESSED');
  });
});

describe('pending-reference-failure-classes', () => {
  /** The transient refusal the unit of work raises when the database cannot be reached. */
  const unavailable = () => new ServiceUnavailableError('the database is unavailable', 5);

  test('a transient failure records no outcome and only reschedules the attempt', async () => {
    const { execute, store, metrics } = reprocessPendingReference({
      referenceArrived: true,
      intercept: (call) => {
        if (call === 'record PROCESSED') {
          throw unavailable();
        }
      },
    });

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'retried' },
    ]);
    // `obs.metrics`: the attempt is counted by what it ended in, and a transient failure is also a
    // retry of this component, which is what separates an outage from a reference that has not
    // arrived (OBS-003).
    expect(await metrics.total('wager_pending_reference_total', { outcome: 'retried' })).toBe(1);
    expect(await metrics.total('wager_retries_total', { component: 'pending-reference' })).toBe(1);
    expect(parkedTransaction(store)?.status).toBe('PENDING_REFERENCE');
    expect(store.wallets.get(WALLET_ID)).toEqual(WALLET);
    expect(store.entries).toEqual([]);
    expect(eventTypes(store)).toEqual([]);
    expect(schedule(store)?.attempts).toBe(1);
    expect(schedule(store)?.expiresAt).toEqual(new Date(RECEIVED_AT.getTime() + 60 * 60 * SECOND));
  });

  test('transient failures are never limited: the attempt after them applies the transaction', async () => {
    let failures = 0;
    const { execute, advanceBy, store } = reprocessPendingReference({
      referenceArrived: true,
      intercept: (call) => {
        if (call === 'record PROCESSED' && failures < 5) {
          failures += 1;

          throw unavailable();
        }
      },
    });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      expect(await execute()).toEqual([
        { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'retried' },
      ]);
      advanceBy(300);
    }

    expect(failures).toBe(5);
    expect(schedule(store)?.attempts).toBe(5);
    expect(parkedTransaction(store)?.status).toBe('PENDING_REFERENCE');

    expect(await execute()).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(parkedTransaction(store)?.status).toBe('PROCESSED');
    expect(store.wallets.get(WALLET_ID)?.balance.toString()).toBe('500.00');
  });

  test('an error no classification recognises is treated as transient, so nothing becomes terminal', async () => {
    const { execute, store } = reprocessPendingReference({
      referenceArrived: true,
      intercept: (call) => {
        if (call === 'insert entry') {
          throw new Error('something nobody classified');
        }
      },
    });

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'retried' },
    ]);
    expect(parkedTransaction(store)?.status).toBe('PENDING_REFERENCE');
  });

  test('a permanent failure marks the transaction FAILED with PROCESSING_FAILED and emits nothing', async () => {
    const { execute, store, log } = reprocessPendingReference({
      referenceArrived: true,
      intercept: (call) => {
        if (call === 'insert entry') {
          throw new WalletNotFoundError(WALLET_ID);
        }
      },
    });

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'failed' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      processedAt: null,
    });
    expect(parkedTransaction(store)?.observedBalance?.toString()).toBe('460.00');
    expect(store.wallets.get(WALLET_ID)).toEqual(WALLET);
    expect(store.entries).toEqual([]);
    expect(eventTypes(store)).toEqual([]);
    expect(log.at('error')).toHaveLength(1);
    expect(log.at('error')[0]?.fields).toMatchObject({
      correlationId: CORRELATION_ID,
      transactionId: ROLLBACK_ID,
    });
  });

  test('a FAILED transaction leaves the claim list, so no later sweep attempts it again', async () => {
    const { execute, calls } = reprocessPendingReference({
      referenceArrived: true,
      intercept: (call) => {
        if (call === 'insert entry') {
          throw new WalletNotFoundError(WALLET_ID);
        }
      },
    });

    await execute();
    const after = calls.length;
    await execute();

    expect(calls.slice(after)).toEqual(['claim the next due schedule']);
  });
});

describe('pending-reference-wallet-vanished', () => {
  test('a parked transaction whose wallet cannot be locked is FAILED, not retried forever', async () => {
    const { execute, store } = reprocessPendingReference({ walletMissing: true });

    const attempts = await execute();

    expect(attempts).toEqual([
      { transactionId: ROLLBACK_ID, correlationId: CORRELATION_ID, outcome: 'failed' },
    ]);
    expect(parkedTransaction(store)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
    });
    expect(parkedTransaction(store)?.observedBalance?.toString()).toBe('460.00');
  });
});
