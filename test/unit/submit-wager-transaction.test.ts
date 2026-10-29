import { describe, expect, test } from 'bun:test';

import {
  ExternalTransactionAlreadyBoundError,
  IdempotencyPayloadMismatchError,
  InboxPayloadConflictError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { Clock } from '../../src/application/ports/clock';
import type { IdGenerator } from '../../src/application/ports/id-generator';
import type { InboxClaim, Reservation } from '../../src/application/ports/repositories';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import {
  type MessageDelivery,
  SubmitWagerTransaction,
  type SubmittedWagerOperation,
} from '../../src/application/use-cases/submit-wager-transaction';
import type { FailureCode } from '../../src/domain/failure-code';
import { contentHashOf, payloadHashOf } from '../../src/domain/idempotency';
import { InboxMessage } from '../../src/domain/inbox-message';
import type { IntegrationEventType } from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import type { TransactionKind, WagerOperationKind } from '../../src/domain/transaction-kind';
import { WagerTransaction, requiresReference } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');
const SUBMITTED_AT = new Date('2026-10-28T12:05:00.000Z');

/** The ids the use case mints, in the order it asks for them. */
const TRANSACTION_ID = 'id-1';
const ENTRY_ID = 'id-2';

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
const BET: SubmittedWagerOperation = {
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: { amount: '40.00', currency: 'BRL' },
};

const IDEMPOTENCY_KEY = 'provider-acme:acme-tx-000123';

/** The delivery the `bet` message example of [docs/asyncapi.yaml] arrives as (`msg.inbox-identity`). */
const CONSUMER_NAME = 'wager-transactions-consumer';
const MESSAGE_ID = 'acme-msg-000123';

/** `data` of that message: the operation plus the key the header carries over HTTP. */
const contentOf = (operation: SubmittedWagerOperation, idempotencyKey: string) => ({
  providerId: operation.providerId,
  externalTransactionId: operation.externalTransactionId,
  idempotencyKey,
  playerId: operation.playerId,
  walletId: operation.walletId,
  roundId: operation.roundId,
  gameId: operation.gameId,
  kind: operation.kind,
  money: { amount: operation.money.amount, currency: operation.money.currency },
  referenceExternalTransactionId: operation.referenceExternalTransactionId ?? null,
});

const brl = (amount: string) => Money.from(amount, 'BRL');

/** A wallet opened with its credit, which is the state every bet here is decided against. */
function walletHolding(balance: string, playerId = PLAYER_ID): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId,
    currency: 'BRL',
    openedAt: OPENED_AT,
    openingCredit: {
      transactionId: 'opening-transaction',
      entryId: 'opening-entry',
      money: brl(balance),
    },
  }).wallet;
}

/** What one operation committed, in the order the use case wrote it. */
interface Committed {
  readonly wallets: Wallet[];
  readonly outcomes: WagerTransaction[];
  readonly entries: WalletLedgerEntry[];
  readonly outbox: OutboxMessage[];
  readonly inbox: InboxMessage[];
}

const empty = (): Committed => ({
  wallets: [],
  outcomes: [],
  entries: [],
  outbox: [],
  inbox: [],
});

interface Ports {
  /** The locked wallet the reservation's foreign key guarantees; `null` is an unknown wallet. */
  readonly wallet?: Wallet | null;
  readonly reservation?: Reservation;
  /** The inbox's answer to the claim of a delivery; absent, the claim wins (ADR 0010). */
  readonly claim?: InboxClaim;
  /** Raised by the ledger port, to prove a failure mid-operation commits nothing. */
  readonly rejectLedger?: Error;
  /** What the reference resolves to; absent is a provider transaction id nothing carries yet. */
  readonly reference?: WagerTransaction;
  /** Whether a processed reversal of the resolved reference already exists (RULE-016). */
  readonly reversed?: boolean;
}

/**
 * A `UnitOfWork` over arrays that only reach `committed` when the work resolves, so an operation
 * that failed mid-way leaves nothing behind (`outbox.single-transaction`), and a log of the port
 * calls in the order they were issued, which is the lock order of ADR 0002 (`conc.lock-order`).
 */
function fakeUnitOfWork(ports: Ports = {}): {
  readonly unitOfWork: UnitOfWork;
  readonly committed: Committed;
  readonly calls: string[];
} {
  const committed = empty();
  const calls: string[] = [];
  const unitOfWork: UnitOfWork = {
    snapshot() {
      throw new Error('a submission writes, so it must not run in a read-only snapshot');
    },
    async transactional(work) {
      const staged = empty();
      const result = await work(repositoriesOver(staged, calls, ports));

      committed.wallets.push(...staged.wallets);
      committed.outcomes.push(...staged.outcomes);
      committed.entries.push(...staged.entries);
      committed.outbox.push(...staged.outbox);
      committed.inbox.push(...staged.inbox);

      return result;
    },
  };

  return { unitOfWork, committed, calls };
}

function repositoriesOver(staged: Committed, calls: string[], ports: Ports): Repositories {
  const unreachable = (port: string) => () => {
    throw new Error(`submitting a transaction must not reach the ${port} port`);
  };

  return {
    wallets: {
      insert: unreachable('wallet insert'),
      findById: unreachable('wallet lookup'),
      lockById: (walletId) => {
        calls.push(`lock ${walletId}`);

        return Promise.resolve(ports.wallet ?? null);
      },
      update: (wallet, expectedVersion) => {
        calls.push(`update wallet from version ${expectedVersion.toString()}`);
        staged.wallets.push(wallet);

        return Promise.resolve();
      },
    },
    transactions: {
      insert: unreachable('transaction insert'),
      reserve: (transaction) => {
        calls.push(`reserve ${transaction.id}`);

        return Promise.resolve(ports.reservation ?? { reserved: true });
      },
      recordOutcome: (transaction) => {
        calls.push(`record ${transaction.status}`);
        staged.outcomes.push(transaction);

        return Promise.resolve();
      },
      findById: unreachable('transaction lookup'),
      findByProviderTransaction: (identity) => {
        calls.push(`resolve ${identity.providerId}:${identity.externalTransactionId}`);

        return Promise.resolve(ports.reference ?? null);
      },
      hasProcessedReversal: (transactionId) => {
        calls.push(`reversals of ${transactionId}`);

        return Promise.resolve(ports.reversed ?? false);
      },
    },
    ledger: {
      insert: (entry) => {
        calls.push('insert entry');

        if (ports.rejectLedger !== undefined) {
          return Promise.reject(ports.rejectLedger);
        }
        staged.entries.push(entry);

        return Promise.resolve();
      },
      findByTransactionId: unreachable('ledger lookup'),
      summarize: unreachable('ledger summary'),
      page: unreachable('ledger page'),
    },
    inbox: {
      claim: (message) => {
        calls.push(`claim ${message.messageId}`);

        return Promise.resolve(ports.claim ?? { claimed: true });
      },
      complete: (message) => {
        calls.push(`complete ${message.messageId}`);
        staged.inbox.push(message);

        return Promise.resolve();
      },
      findByIdentity: unreachable('inbox lookup'),
    },
    outbox: {
      insert: (message) => {
        calls.push(`enqueue ${message.eventType}`);
        staged.outbox.push(message);

        return Promise.resolve();
      },
      findByEventId: unreachable('outbox lookup'),
      claimPending: unreachable('outbox claim'),
      recordAttempt: unreachable('publication attempt'),
    },
  };
}

const fixedClock: Clock = { now: () => SUBMITTED_AT };

/** `id-1`, `id-2`, ...: the mint, so a test can name the id of each row the use case writes. */
function sequencedIds(): IdGenerator {
  let minted = 0;

  return {
    next: () => {
      minted += 1;

      return `id-${minted.toString()}`;
    },
  };
}

function submitWagerTransaction(ports: Ports = {}) {
  const { unitOfWork, committed, calls } = fakeUnitOfWork(ports);
  const useCase = new SubmitWagerTransaction({
    unitOfWork,
    clock: fixedClock,
    ids: sequencedIds(),
    sha256Hex,
  });

  const execute = (operation: SubmittedWagerOperation = BET, idempotencyKey = IDEMPOTENCY_KEY) =>
    useCase.execute({ operation, idempotencyKey, correlationId: CORRELATION_ID });

  const deliver = (
    delivery: Partial<MessageDelivery> = {},
    operation: SubmittedWagerOperation = BET,
    idempotencyKey = IDEMPOTENCY_KEY,
  ) =>
    useCase.deliver(
      { operation, idempotencyKey, correlationId: CORRELATION_ID },
      {
        consumerName: CONSUMER_NAME,
        messageId: MESSAGE_ID,
        content: contentOf(operation, idempotencyKey),
        ...delivery,
      },
    );

  return { execute, deliver, committed, calls };
}

const eventTypes = (committed: Committed): IntegrationEventType[] =>
  committed.outbox.map((message) => message.eventType);

/** The error a refused execution rejected with, so a test can assert on it directly. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** A stored outcome a replay is served from, as the database would hand it back. */
function storedOutcome(payloadHash: string): WagerTransaction {
  const stored = WagerTransaction.create({
    id: 'first-arrival',
    providerId: BET.providerId,
    externalTransactionId: BET.externalTransactionId,
    idempotencyKey: IDEMPOTENCY_KEY,
    payloadHash,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: BET.roundId,
    gameId: BET.gameId,
    kind: 'BET',
    money: brl('40.00'),
    referenceExternalTransactionId: null,
    createdAt: OPENED_AT,
  });
  stored.markProcessed({ observedBalance: brl('460.00'), processedAt: OPENED_AT });

  return stored;
}

const hashOfBet = payloadHashOf(BET, sha256Hex);
const hashOfDelivery = contentHashOf(contentOf(BET, IDEMPOTENCY_KEY), sha256Hex);

/** The inbox row a previous delivery of this message left behind, as the claim reads it back. */
function storedDelivery(payloadHash: string): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: CONSUMER_NAME,
    messageId: MESSAGE_ID,
    payloadHash,
    receivedAt: OPENED_AT,
    processedAt: OPENED_AT,
  });
}

/** The provider transaction id every reference in this file names, and the row that carries it. */
const REFERENCE_EXTERNAL_ID = 'acme-tx-000099';
const REFERENCE_TRANSACTION_ID = 'reference-transaction';

/**
 * The transaction a reference resolves to: a `PROCESSED` operation of the same provider, player,
 * wallet, currency and round as the submissions below (`rule.reference.same-context`).
 */
function processedReference(kind: TransactionKind = 'BET', amount = '40.00'): WagerTransaction {
  const reference = WagerTransaction.create({
    id: REFERENCE_TRANSACTION_ID,
    providerId: BET.providerId,
    externalTransactionId: REFERENCE_EXTERNAL_ID,
    idempotencyKey: `${BET.providerId}:${REFERENCE_EXTERNAL_ID}`,
    payloadHash: hashOfBet,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: BET.roundId,
    gameId: BET.gameId,
    kind,
    money: brl(amount),
    // A REFUND is itself a reversal, so the row that carries one names its own target.
    referenceExternalTransactionId: requiresReference(kind) ? 'acme-tx-000098' : null,
    createdAt: OPENED_AT,
  });
  reference.markProcessed({ observedBalance: brl('460.00'), processedAt: OPENED_AT });

  return reference;
}

/** The same submission under another kind, carrying the reference that kind requires. */
function operationOf(
  kind: WagerOperationKind,
  overrides: Partial<SubmittedWagerOperation> = {},
): SubmittedWagerOperation {
  return {
    ...BET,
    kind,
    ...(requiresReference(kind) ? { referenceExternalTransactionId: REFERENCE_EXTERNAL_ID } : {}),
    ...overrides,
  };
}

describe('submit-bet-debits-under-the-wallet-lock', () => {
  test('a covered bet records PROCESSED, the new balance, one DEBIT entry and both events', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await execute();

    expect(outcome.idempotentReplay).toBe(false);
    expect(outcome.transaction.id).toBe(TRANSACTION_ID);
    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.transaction.failureCode).toBeNull();
    expect(outcome.transaction.processedAt).toEqual(SUBMITTED_AT);
    expect(outcome.transaction.observedBalance?.toJSON()).toEqual({
      amount: '460.00',
      currency: 'BRL',
    });

    expect(committed.wallets).toHaveLength(1);
    expect(committed.wallets[0]?.balance.toJSON()).toEqual({ amount: '460.00', currency: 'BRL' });
    expect(committed.wallets[0]?.version).toBe(2);
    expect(committed.wallets[0]?.updatedAt).toEqual(SUBMITTED_AT);
    expect(eventTypes(committed)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('the entry mirrors the balance change and carries the version it produced', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    const [entry] = committed.entries;

    expect(entry).toMatchObject({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      kind: 'BET',
      direction: 'DEBIT',
      walletVersion: 2,
      createdAt: SUBMITTED_AT,
    });
    expect(entry?.money.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(entry?.balanceBefore.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(entry?.balanceAfter.toJSON()).toEqual({ amount: '460.00', currency: 'BRL' });
  });

  test('the observed balance of a processed bet is the balanceAfter of its entry', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await execute();

    expect(outcome.transaction.observedBalance?.toString()).toBe(
      committed.entries[0]?.balanceAfter.toString(),
    );
  });

  test('the reservation comes first, then the wallet lock, then the entry and the events', async () => {
    const { execute, calls } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    expect(calls).toEqual([
      `reserve ${TRANSACTION_ID}`,
      `lock ${WALLET_ID}`,
      'record PROCESSED',
      'update wallet from version 1',
      'insert entry',
      'enqueue WagerTransactionProcessed',
      'enqueue WalletBalanceChanged',
    ]);
  });

  test('the wallet update is guarded by the version the lock read, never by the new one', async () => {
    const { execute, calls } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    expect(calls).toContain('update wallet from version 1');
  });

  test('both events carry the request correlation id, the wallet as aggregate and the transaction as causation', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    for (const message of committed.outbox) {
      expect(message.payload).toMatchObject({
        aggregateId: WALLET_ID,
        causationId: TRANSACTION_ID,
        correlationId: CORRELATION_ID,
        occurredAt: SUBMITTED_AT.toISOString(),
        version: 1,
      });
      expect(message.publishedAt).toBeNull();
      expect(message.attempts).toBe(0);
    }
  });

  test('the balance-changed event reports the movement the entry recorded', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    const balanceChanged = committed.outbox.find(
      (message) => message.eventType === 'WalletBalanceChanged',
    );

    expect(balanceChanged?.payload.data).toEqual({
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      direction: 'DEBIT',
      money: { amount: '40.00', currency: 'BRL' },
      balanceBefore: { amount: '500.00', currency: 'BRL' },
      balanceAfter: { amount: '460.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('the processed event reports the identity, the new balance and the version', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await execute();

    const processed = committed.outbox.find(
      (message) => message.eventType === 'WagerTransactionProcessed',
    );

    expect(processed?.payload.data).toEqual({
      transactionId: TRANSACTION_ID,
      providerId: BET.providerId,
      externalTransactionId: BET.externalTransactionId,
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: BET.roundId,
      gameId: BET.gameId,
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
      balanceAfter: { amount: '460.00', currency: 'BRL' },
      walletVersion: 2,
      processedAt: SUBMITTED_AT.toISOString(),
    });
  });

  test('the payload hash is taken over the submitted business fields alone', async () => {
    const { execute } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await execute();

    expect(outcome.transaction.payloadHash).toBe(hashOfBet);
    expect(outcome.transaction.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });
});

describe('submit-bet-persists-every-refusal-the-wallet-decides', () => {
  test('a bet above the balance is REJECTED with INSUFFICIENT_BALANCE and moves nothing', async () => {
    const { execute, committed, calls } = submitWagerTransaction({
      wallet: walletHolding('30.00'),
    });

    const outcome = await execute();

    expect(outcome.idempotentReplay).toBe(false);
    expect(outcome.transaction.status).toBe('REJECTED');
    expect(outcome.transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(outcome.transaction.processedAt).toBeNull();
    expect(outcome.transaction.observedBalance?.toJSON()).toEqual({
      amount: '30.00',
      currency: 'BRL',
    });

    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
    expect(eventTypes(committed)).toEqual(['WagerTransactionRejected']);
    expect(calls).toEqual([
      `reserve ${TRANSACTION_ID}`,
      `lock ${WALLET_ID}`,
      'record REJECTED',
      'enqueue WagerTransactionRejected',
    ]);
  });

  test('a bet in another currency than the wallet is REJECTED with CURRENCY_MISMATCH', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await execute({ ...BET, money: { amount: '40.00', currency: 'USD' } });

    expect(outcome.transaction.failureCode).toBe('CURRENCY_MISMATCH');
    expect(outcome.transaction.observedBalance?.toJSON()).toEqual({
      amount: '500.00',
      currency: 'BRL',
    });
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
  });

  test('a bet naming another player is REJECTED with WALLET_PLAYER_MISMATCH', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await execute({ ...BET, playerId: OTHER_PLAYER_ID });

    expect(outcome.transaction.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
  });

  test('the rejected event carries the failure code and the balance observed with it', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('30.00') });

    await execute();

    expect(committed.outbox[0]?.payload.data).toMatchObject({
      transactionId: TRANSACTION_ID,
      kind: 'BET',
      failureCode: 'INSUFFICIENT_BALANCE',
      observedBalance: { amount: '30.00', currency: 'BRL' },
      rejectedAt: SUBMITTED_AT.toISOString(),
    });
  });
});

describe('submit-bet-replays-a-stored-outcome', () => {
  test('a repetition of the same payload returns the stored outcome and writes nothing', async () => {
    const stored = storedOutcome(hashOfBet);
    const { execute, committed } = submitWagerTransaction({
      reservation: { reserved: false, keyHolder: stored },
    });

    const outcome = await execute();

    expect(outcome.idempotentReplay).toBe(true);
    expect(outcome.transaction).toBe(stored);
    expect(outcome.transaction.observedBalance?.toJSON()).toEqual({
      amount: '460.00',
      currency: 'BRL',
    });
    expect(committed).toEqual(empty());
  });

  test('a replay never takes the wallet lock', async () => {
    const { execute, calls } = submitWagerTransaction({
      reservation: { reserved: false, keyHolder: storedOutcome(hashOfBet) },
    });

    await execute();

    expect(calls).toEqual([`reserve ${TRANSACTION_ID}`]);
  });

  test('the same key with another payload is a conflict, never a replay', async () => {
    const { execute, committed } = submitWagerTransaction({
      reservation: { reserved: false, keyHolder: storedOutcome('sha256:' + 'a'.repeat(64)) },
    });

    const refusal = await rejection(execute());

    expect(refusal).toBeInstanceOf(IdempotencyPayloadMismatchError);
    expect((refusal as IdempotencyPayloadMismatchError).code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect((refusal as Error).message).toContain(IDEMPOTENCY_KEY);
    expect(committed).toEqual(empty());
  });

  test('a free key means the provider transaction id collided and is bound to another key', async () => {
    const { execute, committed } = submitWagerTransaction({
      reservation: { reserved: false, keyHolder: null },
    });

    const refusal = await rejection(execute());

    expect(refusal).toBeInstanceOf(ExternalTransactionAlreadyBoundError);
    expect((refusal as ExternalTransactionAlreadyBoundError).code).toBe(
      'EXTERNAL_TRANSACTION_ALREADY_BOUND',
    );
    expect((refusal as Error).message).toContain(BET.externalTransactionId);
    expect(committed).toEqual(empty());
  });
});

describe('submit-bet-refuses-an-unknown-wallet', () => {
  test('a wallet the lock does not find is a WALLET_NOT_FOUND refusal and commits nothing', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: null });

    const refusal = await rejection(execute());

    expect(refusal).toBeInstanceOf(WalletNotFoundError);
    expect((refusal as WalletNotFoundError).code).toBe('WALLET_NOT_FOUND');
    expect(committed).toEqual(empty());
  });
});

describe('submit-bet-commits-everything-or-nothing', () => {
  test('a failure after the ledger insert leaves no outcome, no balance and no event', async () => {
    const injected = new Error('the ledger insert failed');
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('500.00'),
      rejectLedger: injected,
    });

    const failure = await rejection(execute());

    expect(failure).toBe(injected);
    expect(committed).toEqual(empty());
  });
});

describe('submit-applies-the-movement-of-every-kind', () => {
  test('a WIN credits its own amount with one CREDIT entry', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('460.00') });

    const outcome = await execute(
      operationOf('WIN', { money: { amount: '65.00', currency: 'BRL' } }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.transaction.observedBalance?.toString()).toBe('525.00');
    expect(committed.wallets[0]?.balance.toString()).toBe('525.00');
    expect(committed.wallets[0]?.version).toBe(2);
    expect(committed.entries[0]).toMatchObject({ kind: 'WIN', direction: 'CREDIT' });
    expect(eventTypes(committed)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('a REFUND credits the amount of the BET it references', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
    });

    const outcome = await execute(operationOf('REFUND'));

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.transaction.observedBalance?.toString()).toBe('500.00');
    expect(outcome.transaction.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
    expect(committed.entries[0]).toMatchObject({ kind: 'REFUND', direction: 'CREDIT' });
  });

  test.each<[TransactionKind, string]>([
    ['BET', 'CREDIT'],
    ['WIN', 'DEBIT'],
    ['REFUND', 'DEBIT'],
  ])('a ROLLBACK of a %s writes the opposite %s entry', async (referenced, direction) => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(referenced),
    });

    const outcome = await execute(operationOf('ROLLBACK'));

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(committed.entries[0]).toMatchObject({ kind: 'ROLLBACK', direction });
    expect(committed.wallets[0]?.balance.toString()).toBe(
      direction === 'CREDIT' ? '500.00' : '420.00',
    );
  });

  test('the resolved reference reaches the row and the processed event', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
    });

    await execute(operationOf('REFUND'));

    expect(committed.outbox[0]?.payload.data).toMatchObject({
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
      referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
    });
    expect(committed.outcomes[0]?.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
  });

  test('the reference is resolved after the wallet lock and before any write', async () => {
    const { execute, calls } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
    });

    await execute(operationOf('REFUND'));

    expect(calls).toEqual([
      `reserve ${TRANSACTION_ID}`,
      `lock ${WALLET_ID}`,
      `resolve ${BET.providerId}:${REFERENCE_EXTERNAL_ID}`,
      `reversals of ${REFERENCE_TRANSACTION_ID}`,
      'record PROCESSED',
      'update wallet from version 1',
      'insert entry',
      'enqueue WagerTransactionProcessed',
      'enqueue WalletBalanceChanged',
    ]);
  });

  test('a WIN with no reference resolves nothing and reports none', async () => {
    const { execute, calls, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
    });

    await execute(operationOf('WIN'));

    expect(calls).not.toContain(`resolve ${BET.providerId}:${REFERENCE_EXTERNAL_ID}`);
    expect(committed.outcomes[0]?.referenceTransactionId).toBeNull();
    expect(committed.outbox[0]?.payload.data).not.toHaveProperty('referenceTransactionId');
  });

  test('a WIN may reference the BET of its round, whatever the two amounts are', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
    });

    const outcome = await execute(
      operationOf('WIN', {
        money: { amount: '65.00', currency: 'BRL' },
        referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
      }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.transaction.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
    expect(committed.entries[0]?.money.toString()).toBe('65.00');
  });
});

describe('submit-loss-has-no-balance-effect', () => {
  test.each(['40.00', '0.00', '100000.00'])(
    'a LOSS of %s is PROCESSED against the balance it observed and moves nothing',
    async (amount) => {
      const { execute, committed, calls } = submitWagerTransaction({
        wallet: walletHolding('460.00'),
      });

      const outcome = await execute(operationOf('LOSS', { money: { amount, currency: 'BRL' } }));

      expect(outcome.transaction.status).toBe('PROCESSED');
      expect(outcome.transaction.processedAt).toEqual(SUBMITTED_AT);
      expect(outcome.transaction.observedBalance?.toString()).toBe('460.00');
      expect(committed.wallets).toEqual([]);
      expect(committed.entries).toEqual([]);
      expect(eventTypes(committed)).toEqual(['WagerTransactionProcessed']);
      expect(calls).toEqual([
        `reserve ${TRANSACTION_ID}`,
        `lock ${WALLET_ID}`,
        'record PROCESSED',
        'enqueue WagerTransactionProcessed',
      ]);
    },
  );

  test('the processed event of a LOSS reports the wallet as it stands', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('460.00') });

    await execute(operationOf('LOSS'));

    expect(committed.outbox[0]?.payload.data).toMatchObject({
      kind: 'LOSS',
      balanceAfter: { amount: '460.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('a LOSS aimed at another owner is still REJECTED and writes no entry', async () => {
    const { execute, committed } = submitWagerTransaction({ wallet: walletHolding('460.00') });

    const outcome = await execute(operationOf('LOSS', { playerId: OTHER_PLAYER_ID }));

    expect(outcome.transaction.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(committed.entries).toEqual([]);
    expect(eventTypes(committed)).toEqual(['WagerTransactionRejected']);
  });

  test('a LOSS in another currency than the wallet is REJECTED', async () => {
    const { execute } = submitWagerTransaction({ wallet: walletHolding('460.00') });

    const outcome = await execute(
      operationOf('LOSS', { money: { amount: '40.00', currency: 'USD' } }),
    );

    expect(outcome.transaction.failureCode).toBe('CURRENCY_MISMATCH');
  });
});

describe('submit-persists-every-reference-refusal', () => {
  test.each<[string, TransactionKind, Partial<SubmittedWagerOperation>, FailureCode]>([
    ['a REFUND of a WIN', 'WIN', {}, 'REFERENCE_KIND_NOT_ALLOWED'],
    ['a REFUND of another round', 'BET', { roundId: 'round-other' }, 'REFERENCE_MISMATCH'],
    [
      'a REFUND of another amount',
      'BET',
      { money: { amount: '39.99', currency: 'BRL' } },
      'REFERENCE_AMOUNT_MISMATCH',
    ],
  ])('%s is REJECTED with %s and moves nothing', async (_case, kind, overrides, failureCode) => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(kind),
    });

    const outcome = await execute(operationOf('REFUND', overrides));

    expect(outcome.transaction.status).toBe('REJECTED');
    expect(outcome.transaction.failureCode).toBe(failureCode);
    expect(outcome.transaction.observedBalance?.toString()).toBe('460.00');
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
    expect(eventTypes(committed)).toEqual(['WagerTransactionRejected']);
  });

  test('a rejection still records which transaction the reference resolved to', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference('WIN'),
    });

    await execute(operationOf('REFUND'));

    expect(committed.outcomes[0]?.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
    expect(committed.outbox[0]?.payload.data).toMatchObject({
      referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
    });
  });

  test('a target already reversed by any kind is REJECTED with REFERENCE_ALREADY_REVERSED', async () => {
    const { execute, committed, calls } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
      reversed: true,
    });

    const outcome = await execute(operationOf('ROLLBACK'));

    expect(outcome.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
    expect(calls).toContain(`reversals of ${REFERENCE_TRANSACTION_ID}`);
  });

  test('a WIN never asks whether its reference was reversed, because it reverses nothing', async () => {
    const { execute, calls } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: processedReference(),
      reversed: true,
    });

    const outcome = await execute(
      operationOf('WIN', { referenceExternalTransactionId: REFERENCE_EXTERNAL_ID }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(calls).not.toContain(`reversals of ${REFERENCE_TRANSACTION_ID}`);
  });

  test('a ROLLBACK the balance cannot absorb carries the reversal-specific code', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('10.00'),
      reference: processedReference('WIN'),
    });

    const outcome = await execute(operationOf('ROLLBACK'));

    expect(outcome.transaction.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');
    expect(committed.entries).toEqual([]);
  });

  test('a credit past the money bound is REJECTED with BALANCE_LIMIT_EXCEEDED', async () => {
    const { execute, committed } = submitWagerTransaction({
      wallet: walletHolding('999999999999999999.99'),
    });

    const outcome = await execute(
      operationOf('WIN', { money: { amount: '0.01', currency: 'BRL' } }),
    );

    expect(outcome.transaction.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(outcome.transaction.observedBalance?.toString()).toBe('999999999999999999.99');
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
  });
});

describe('submit-parks-a-reference-it-cannot-resolve', () => {
  test('a reference no transaction carries yet parks the submission with no other effect', async () => {
    const { execute, committed, calls } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
    });

    const outcome = await execute(operationOf('ROLLBACK'));

    expect(outcome.transaction.status).toBe('PENDING_REFERENCE');
    expect(outcome.transaction.failureCode).toBeNull();
    expect(outcome.transaction.observedBalance?.toString()).toBe('460.00');
    expect(outcome.transaction.referenceTransactionId).toBeNull();
    expect(committed.wallets).toEqual([]);
    expect(committed.entries).toEqual([]);
    expect(calls).toEqual([
      `reserve ${TRANSACTION_ID}`,
      `lock ${WALLET_ID}`,
      `resolve ${BET.providerId}:${REFERENCE_EXTERNAL_ID}`,
      'record PENDING_REFERENCE',
    ]);
  });

  test('a reference that has not reached an outcome yet is waited for, not refused', async () => {
    const pending = WagerTransaction.create({
      id: REFERENCE_TRANSACTION_ID,
      providerId: BET.providerId,
      externalTransactionId: REFERENCE_EXTERNAL_ID,
      idempotencyKey: `${BET.providerId}:${REFERENCE_EXTERNAL_ID}`,
      payloadHash: hashOfBet,
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: BET.roundId,
      gameId: BET.gameId,
      kind: 'BET',
      money: brl('40.00'),
      referenceExternalTransactionId: null,
      createdAt: OPENED_AT,
    });

    const { execute } = submitWagerTransaction({
      wallet: walletHolding('460.00'),
      reference: pending,
    });

    const outcome = await execute(operationOf('REFUND'));

    expect(outcome.transaction.status).toBe('PENDING_REFERENCE');
  });
});

/**
 * The queue entry point: the same financial body, with the delivery's inbox row claimed first and
 * completed last, in the one transaction that carries the effect (ADR 0010).
 */
describe('deliver-records-the-delivery-with-the-effect', () => {
  test('the claim is the first statement and the completion the last', async () => {
    const { deliver, calls } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await deliver();

    expect(outcome).toMatchObject({ absorbed: false, idempotentReplay: false });
    expect(calls).toEqual([
      `claim ${MESSAGE_ID}`,
      `reserve ${TRANSACTION_ID}`,
      `lock ${WALLET_ID}`,
      'record PROCESSED',
      'update wallet from version 1',
      'insert entry',
      'enqueue WagerTransactionProcessed',
      'enqueue WalletBalanceChanged',
      `complete ${MESSAGE_ID}`,
    ]);
  });

  test('a delivered bet produces the effects the HTTP path produces', async () => {
    const delivered = submitWagerTransaction({ wallet: walletHolding('500.00') });
    const submitted = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await delivered.deliver();
    await submitted.execute();

    expect(outcome.absorbed ? null : outcome.transaction.status).toBe('PROCESSED');
    expect(delivered.committed.outcomes).toEqual(submitted.committed.outcomes);
    expect(delivered.committed.wallets).toEqual(submitted.committed.wallets);
    expect(delivered.committed.entries).toEqual(submitted.committed.entries);
    expect(eventTypes(delivered.committed)).toEqual(eventTypes(submitted.committed));
  });

  test('the row records the identity and the content hash, never the receipt id', async () => {
    const { deliver, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    await deliver();

    const [row] = committed.inbox;

    expect(row?.consumerName).toBe(CONSUMER_NAME);
    expect(row?.messageId).toBe(MESSAGE_ID);
    expect(row?.receivedAt).toEqual(SUBMITTED_AT);
    expect(row?.processedAt).toEqual(SUBMITTED_AT);
    expect(row?.isProcessed()).toBe(true);
    expect(row?.payloadHash).toBe(hashOfDelivery);
  });

  /** The two hashes answer different questions about one arrival (`msg.inbox-payload-conflict`). */
  test('the delivery hash covers the idempotency key, which the payload hash does not', async () => {
    const { deliver, committed } = submitWagerTransaction({ wallet: walletHolding('500.00') });

    const outcome = await deliver();

    expect(committed.inbox[0]?.payloadHash).not.toBe(hashOfBet);
    expect(outcome.absorbed ? null : outcome.transaction.payloadHash).toBe(hashOfBet);
  });

  test('a replay through the queue still completes the delivery, so a redelivery is absorbed', async () => {
    const stored = storedOutcome(hashOfBet);
    const { deliver, committed, calls } = submitWagerTransaction({
      reservation: { reserved: false, keyHolder: stored },
    });

    const outcome = await deliver();

    expect(outcome).toEqual({ absorbed: false, transaction: stored, idempotentReplay: true });
    expect(calls).toEqual([
      `claim ${MESSAGE_ID}`,
      `reserve ${TRANSACTION_ID}`,
      `complete ${MESSAGE_ID}`,
    ]);
    expect(committed.inbox).toHaveLength(1);
  });
});

describe('deliver-absorbs-a-redelivery-and-refuses-a-reused-message-id', () => {
  test('a delivery the inbox already holds writes nothing and never reserves', async () => {
    const { deliver, committed, calls } = submitWagerTransaction({
      wallet: walletHolding('500.00'),
      claim: { claimed: false, stored: storedDelivery(hashOfDelivery) },
    });

    expect(await deliver()).toEqual({ absorbed: true });
    expect(calls).toEqual([`claim ${MESSAGE_ID}`]);
    expect(committed).toEqual(empty());
  });

  test('the same message id with other content is a conflict that commits nothing', async () => {
    const { deliver, committed, calls } = submitWagerTransaction({
      wallet: walletHolding('500.00'),
      claim: { claimed: false, stored: storedDelivery(`sha256:${'b'.repeat(64)}`) },
    });

    const refusal = await rejection(deliver());

    expect(refusal).toBeInstanceOf(InboxPayloadConflictError);
    expect((refusal as Error).message).toContain(MESSAGE_ID);
    expect(calls).toEqual([`claim ${MESSAGE_ID}`]);
    expect(committed).toEqual(empty());
  });

  test('a delivery of an operation whose content differs is a conflict, not a replay', async () => {
    const { deliver } = submitWagerTransaction({
      wallet: walletHolding('500.00'),
      claim: { claimed: false, stored: storedDelivery(hashOfDelivery) },
    });

    const refusal = await rejection(
      deliver({}, { ...BET, money: { amount: '41.00', currency: 'BRL' } }),
    );

    expect(refusal).toBeInstanceOf(InboxPayloadConflictError);
  });
});
