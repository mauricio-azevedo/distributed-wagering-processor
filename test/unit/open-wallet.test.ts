import { describe, expect, test } from 'bun:test';

import { WalletAlreadyExistsError } from '../../src/application/errors';
import type { Clock } from '../../src/application/ports/clock';
import type { IdGenerator } from '../../src/application/ports/id-generator';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { canonicalOperationPayload, payloadHashOf } from '../../src/domain/idempotency';
import type { IntegrationEventType } from '../../src/domain/integration-events';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import type { WagerTransaction } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const PLAYER_ID = '0193f0c0-0000-7000-8000-000000000002';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');

/** The ids the use case mints, in the order it asks for them. */
const WALLET_ID = 'id-1';
const TRANSACTION_ID = 'id-2';
const ENTRY_ID = 'id-3';

/** What one operation committed, in the order the use case wrote it. */
interface Committed {
  readonly wallets: Wallet[];
  readonly transactions: WagerTransaction[];
  readonly entries: WalletLedgerEntry[];
  readonly outbox: OutboxMessage[];
}

const empty = (): Committed => ({ wallets: [], transactions: [], entries: [], outbox: [] });

/**
 * A `UnitOfWork` over arrays that only reach `committed` when the work resolves, so a use case that
 * wrote outside the transaction, or one whose transaction failed, leaves nothing behind
 * (`outbox.single-transaction`). `rejectWallet` is the duplicate the database would refuse.
 */
function fakeUnitOfWork(options: { readonly rejectWallet?: Error } = {}): {
  readonly unitOfWork: UnitOfWork;
  readonly committed: Committed;
} {
  const committed = empty();
  const unitOfWork: UnitOfWork = {
    snapshot() {
      throw new Error('opening a wallet writes, so it must not run in a read-only snapshot');
    },
    async transactional(work) {
      const staged = empty();
      const result = await work(repositoriesOver(staged, options));

      committed.wallets.push(...staged.wallets);
      committed.transactions.push(...staged.transactions);
      committed.entries.push(...staged.entries);
      committed.outbox.push(...staged.outbox);

      return result;
    },
  };

  return { unitOfWork, committed };
}

function repositoriesOver(staged: Committed, options: { rejectWallet?: Error }): Repositories {
  const unreachable = (port: string) => () => {
    throw new Error(`opening a wallet must not reach the ${port} port`);
  };

  return {
    wallets: {
      insert: (wallet) => {
        if (options.rejectWallet !== undefined) {
          return Promise.reject(options.rejectWallet);
        }
        staged.wallets.push(wallet);

        return Promise.resolve();
      },
      findById: unreachable('wallet lookup'),
      lockById: unreachable('wallet lock'),
      update: unreachable('wallet update'),
    },
    transactions: {
      insert: (transaction) => {
        staged.transactions.push(transaction);

        return Promise.resolve();
      },
      reserve: unreachable('reservation'),
      recordOutcome: unreachable('outcome update'),
      findById: unreachable('transaction lookup'),
      findByProviderTransaction: unreachable('reference resolution'),
      hasProcessedReversal: unreachable('reversal lookup'),
    },
    ledger: {
      insert: (entry) => {
        staged.entries.push(entry);

        return Promise.resolve();
      },
      findByTransactionId: unreachable('ledger lookup'),
      summarize: unreachable('ledger summary'),
      page: unreachable('ledger page'),
    },
    inbox: {
      claim: unreachable('inbox'),
      complete: unreachable('inbox'),
      findByIdentity: unreachable('inbox'),
    },
    outbox: {
      insert: (message) => {
        staged.outbox.push(message);

        return Promise.resolve();
      },
      findByEventId: unreachable('outbox lookup'),
      claimPending: unreachable('outbox claim'),
      recordAttempt: unreachable('publication attempt'),
    },
  };
}

const fixedClock: Clock = { now: () => OPENED_AT };

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

function openWallet(options: { readonly rejectWallet?: Error } = {}) {
  const { unitOfWork, committed } = fakeUnitOfWork(options);
  const useCase = new OpenWallet({
    unitOfWork,
    clock: fixedClock,
    ids: sequencedIds(),
    sha256Hex,
  });

  return { useCase, committed };
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

describe('open-wallet-records-the-opening-credit', () => {
  test('a positive initial balance writes the wallet, the OPENING transaction, its entry and both events', async () => {
    const { useCase, committed } = openWallet();

    const wallet = await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    expect(wallet.id).toBe(WALLET_ID);
    expect(wallet.playerId).toBe(PLAYER_ID);
    expect(wallet.balance.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(OPENED_AT);

    expect(committed.wallets).toEqual([wallet]);
    expect(committed.transactions).toHaveLength(1);
    expect(committed.entries).toHaveLength(1);
    expect(eventTypes(committed)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('the OPENING transaction carries the reserved system identity and is born processed', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    const [transaction] = committed.transactions;

    expect(transaction).toMatchObject({
      id: TRANSACTION_ID,
      providerId: 'system',
      externalTransactionId: WALLET_ID,
      idempotencyKey: `system:${WALLET_ID}`,
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: WALLET_ID,
      gameId: 'wallet-opening',
      kind: 'OPENING',
      status: 'PROCESSED',
      failureCode: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      processedAt: OPENED_AT,
      createdAt: OPENED_AT,
    });
    expect(transaction?.money.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(transaction?.observedBalance?.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
  });

  test('its payload hash is taken over the canonical business fields of the opening credit', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    const expected = payloadHashOf(
      {
        providerId: 'system',
        externalTransactionId: WALLET_ID,
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: WALLET_ID,
        gameId: 'wallet-opening',
        kind: 'OPENING',
        money: { amount: '500.00', currency: 'BRL' },
      },
      sha256Hex,
    );

    expect(committed.transactions[0]?.payloadHash).toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the CREDIT entry starts the ledger at 0.00 and carries wallet version 1', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    const [entry] = committed.entries;

    expect(entry).toMatchObject({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      kind: 'OPENING',
      direction: 'CREDIT',
      walletVersion: 1,
      createdAt: OPENED_AT,
    });
    expect(entry?.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(entry?.balanceAfter.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
  });

  test('both events carry the request correlation id, the wallet as aggregate and the transaction as causation', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    for (const message of committed.outbox) {
      expect(message.payload).toMatchObject({
        aggregateId: WALLET_ID,
        causationId: TRANSACTION_ID,
        correlationId: CORRELATION_ID,
        occurredAt: OPENED_AT.toISOString(),
        version: 1,
      });
      expect(message.publishedAt).toBeNull();
      expect(message.attempts).toBe(0);
    }
  });

  test('the balance-changed event reports the movement the entry recorded', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    const balanceChanged = committed.outbox.find(
      (message) => message.eventType === 'WalletBalanceChanged',
    );

    expect(balanceChanged?.payload.data).toEqual({
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      direction: 'CREDIT',
      money: { amount: '500.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '500.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('the processed event reports the wallet as the credit left it', async () => {
    const { useCase, committed } = openWallet();

    await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '500.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    const processed = committed.outbox.find(
      (message) => message.eventType === 'WagerTransactionProcessed',
    );

    expect(processed?.payload.data).toEqual({
      transactionId: TRANSACTION_ID,
      providerId: 'system',
      externalTransactionId: WALLET_ID,
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: WALLET_ID,
      gameId: 'wallet-opening',
      kind: 'OPENING',
      money: { amount: '500.00', currency: 'BRL' },
      balanceAfter: { amount: '500.00', currency: 'BRL' },
      walletVersion: 1,
      processedAt: OPENED_AT.toISOString(),
    });
  });
});

describe('open-wallet-at-zero-writes-only-the-wallet', () => {
  test('an initial balance of 0.00 writes the wallet alone, at version 1', async () => {
    const { useCase, committed } = openWallet();

    const wallet = await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(committed.wallets).toEqual([wallet]);
    expect(committed.transactions).toEqual([]);
    expect(committed.entries).toEqual([]);
    expect(committed.outbox).toEqual([]);
  });

  test('the wallet takes the first minted id, so no id is spent on a credit that does not exist', async () => {
    const { useCase } = openWallet();

    const wallet = await useCase.execute({
      playerId: PLAYER_ID,
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: CORRELATION_ID,
    });

    expect(wallet.id).toBe(WALLET_ID);
  });
});

describe('open-wallet-refuses-a-malformed-initial-balance', () => {
  test('an amount the domain cannot represent exactly is refused before anything is written', async () => {
    const { useCase, committed } = openWallet();

    const refusal = await rejection(
      useCase.execute({
        playerId: PLAYER_ID,
        initialBalance: { amount: '500.000', currency: 'BRL' },
        correlationId: CORRELATION_ID,
      }),
    );

    expect((refusal as Error).message).toMatch(/amount must be a decimal string/);
    expect(committed).toEqual(empty());
  });
});

describe('open-wallet-reports-a-duplicate-as-a-conflict', () => {
  test('the conflict the wallet port raises reaches the caller and nothing is committed', async () => {
    const conflict = new WalletAlreadyExistsError(PLAYER_ID, 'BRL');
    const { useCase, committed } = openWallet({ rejectWallet: conflict });

    const refusal = await rejection(
      useCase.execute({
        playerId: PLAYER_ID,
        initialBalance: { amount: '500.00', currency: 'BRL' },
        correlationId: CORRELATION_ID,
      }),
    );

    expect(refusal).toBe(conflict);
    expect(committed).toEqual(empty());
  });

  test('the conflict names the player and the currency without naming an amount', () => {
    const conflict = new WalletAlreadyExistsError(PLAYER_ID, 'BRL');

    expect(conflict.code).toBe('WALLET_ALREADY_EXISTS');
    expect(conflict.message).toBe(`Player ${PLAYER_ID} already has a BRL wallet.`);
  });
});

describe('open-wallet-hashes-what-the-contract-says', () => {
  test('the canonical payload of an opening credit carries no idempotency key and no correlation id', () => {
    const payload = canonicalOperationPayload({
      providerId: 'system',
      externalTransactionId: WALLET_ID,
      playerId: PLAYER_ID,
      walletId: WALLET_ID,
      roundId: WALLET_ID,
      gameId: 'wallet-opening',
      kind: 'OPENING',
      money: { amount: '500.00', currency: 'BRL' },
    });

    expect(payload).not.toContain('idempotencyKey');
    expect(payload).not.toContain('correlationId');
  });
});
