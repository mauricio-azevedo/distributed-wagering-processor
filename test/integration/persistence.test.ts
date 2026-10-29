import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { InboxMessage } from '../../src/domain/inbox-message';
import {
  type TransactionIdentity,
  WagerTransactionProcessed,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import {
  type NewWagerTransaction,
  WagerTransaction,
  type WagerTransactionState,
} from '../../src/domain/wager-transaction';
import { type OpenedWallet, Wallet } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const WALLET_ID = '0193f0c0-0000-7000-8000-000000000001';
const PLAYER_ID = '0193f0c0-0000-7000-8000-000000000002';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-000000000003';
const ENTRY_ID = '0193f0c0-0000-7000-8000-000000000004';
const OPENING_TRANSACTION_ID = '0193f0c0-0000-7000-8000-000000000005';
const OPENING_ENTRY_ID = '0193f0c0-0000-7000-8000-000000000006';
const REFERENCE_TRANSACTION_ID = '0193f0c0-0000-7000-8000-000000000007';
const EVENT_ID = '0193f0c0-0000-7000-8000-000000000008';
const OTHER_WALLET_ID = '0193f0c0-0000-7000-8000-000000000009';
const OTHER_PLAYER_ID = '0193f0c0-0000-7000-8000-00000000000a';
const OTHER_OPENING_TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000b';
const OTHER_OPENING_ENTRY_ID = '0193f0c0-0000-7000-8000-00000000000c';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');
const OCCURRED_AT = new Date('2026-10-28T12:30:00.000Z');
const PROCESSED_AT = new Date('2026-10-28T12:30:01.000Z');
const FAILED_AT = new Date('2026-10-28T12:30:05.000Z');

/** `money.bound`: the largest magnitude a money column stores. */
const BOUND = '999999999999999999.99';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** Every money column of the schema, as SCHEMA-020 sweeps them. */
const MONEY_COLUMNS = [
  ['wager_transactions', 'amount'],
  ['wager_transactions', 'observed_balance'],
  ['wallet_ledger_entries', 'amount'],
  ['wallet_ledger_entries', 'balance_after'],
  ['wallet_ledger_entries', 'balance_before'],
  ['wallets', 'balance'],
];

const brl = (amount: string): Money => Money.from(amount, 'BRL');

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: UnitOfWork;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  // Over a long-lived context manager, the shape an application injects: one manager serving many
  // operations is exactly what the unit of work has to isolate them from.
  unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
}

/** The stored object, or a failure naming what the round trip did not bring back. */
function stored<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`expected the ${what} to come back from the database`);
  }

  return value;
}

/** Which wallet a fixture opens, when a case needs a second one beside the default. */
interface WalletIdentity {
  readonly id?: string;
  readonly playerId?: string;
  readonly currency?: string;
  readonly transactionId?: string;
  readonly entryId?: string;
}

/**
 * A wallet as `Wallet.open` leaves it: with its `OPENING` entry when the credit is positive
 * (`wallet.opening-credit`), with none at `0.00` (`wallet.zero-opening`). Both halves are
 * committed together by `given`, because a wallet row carrying a balance has to mirror the head of
 * its ledger (ADR 0003, SCHEMA-017).
 */
const openedWallet = (balance: string, wallet: WalletIdentity = {}): OpenedWallet => {
  const currency = wallet.currency ?? 'BRL';
  return Wallet.open({
    id: wallet.id ?? WALLET_ID,
    playerId: wallet.playerId ?? PLAYER_ID,
    currency,
    openedAt: OPENED_AT,
    openingCredit:
      balance === '0.00'
        ? null
        : {
            transactionId: wallet.transactionId ?? OPENING_TRANSACTION_ID,
            entryId: wallet.entryId ?? OPENING_ENTRY_ID,
            money: Money.from(balance, currency),
          },
  });
};

/**
 * A wallet as the database holds it past its opening: opened at `0.00` and credited once, so it
 * carries version 2, an `updatedAt` later than its `createdAt`, and a ledger whose first entry is
 * at version 2, the shape `ledger.chain` admits for a wallet opened with nothing.
 */
function creditedWallet(
  balance: string,
  currency = 'BRL',
): { wallet: Wallet; transaction: WagerTransaction; entry: WalletLedgerEntry } {
  const money = Money.from(balance, currency);
  const outcome = openedWallet('0.00', { currency }).wallet.credit({
    transactionId: TRANSACTION_ID,
    entryId: ENTRY_ID,
    playerId: PLAYER_ID,
    operation: { kind: 'WIN' },
    money,
    occurredAt: OCCURRED_AT,
  });
  if (!outcome.applied) {
    throw new Error(
      `a credit inside the bound applies, it was refused with ${outcome.failureCode}`,
    );
  }

  return {
    wallet: outcome.wallet,
    transaction: WagerTransaction.create(submission({ kind: 'WIN', money })),
    entry: outcome.entry,
  };
}

const submission = (overrides: Partial<NewWagerTransaction> = {}): NewWagerTransaction => ({
  id: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  idempotencyKey: 'provider-acme:acme-tx-000123',
  payloadHash: `sha256:${'5'.repeat(64)}`,
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
  referenceExternalTransactionId: null,
  createdAt: OCCURRED_AT,
  ...overrides,
});

/** `wallet.opening-credit`: the internal transaction an opening entry belongs to. */
function openingTransactionOf(opened: OpenedWallet): WagerTransaction | null {
  const { wallet, openingEntry } = opened;
  if (openingEntry === null) {
    return null;
  }

  return WagerTransaction.create(
    submission({
      id: openingEntry.transactionId,
      providerId: 'system',
      externalTransactionId: wallet.id,
      idempotencyKey: `system:${wallet.id}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: wallet.id,
      gameId: 'wallet-opening',
      kind: 'OPENING',
      money: openingEntry.money,
    }),
  );
}

/**
 * The rows the foreign keys of ADR 0003 require around whatever a case is really writing: a
 * transaction points at its wallet, a ledger entry at its transaction. A wallet opened with a
 * credit arrives with that entry and the transaction it belongs to, because the commit-time mirror
 * admits no balance without the head of a ledger behind it.
 */
function given(opened: OpenedWallet, ...rows: WagerTransaction[]): Promise<void> {
  return unitOfWork.transactional(async ({ wallets, transactions, ledger }) => {
    await wallets.insert(opened.wallet);
    const opening = openingTransactionOf(opened);
    if (opening !== null && opened.openingEntry !== null) {
      await transactions.insert(opening);
      await ledger.insert(opened.openingEntry);
    }
    for (const row of rows) {
      await transactions.insert(row);
    }
  });
}

/**
 * A balance change committed by a writer that is not this unit of work: the submission through the
 * repositories, then the entry and the wallet row as the schema owner, in one transaction, because
 * the ledger and the balance are committed together or not at all (ADR 0003, SCHEMA-021).
 */
async function debitOutsideTheUnitOfWork(opened: OpenedWallet, money: Money): Promise<void> {
  const outcome = opened.wallet.debit({
    transactionId: TRANSACTION_ID,
    entryId: ENTRY_ID,
    playerId: opened.wallet.playerId,
    operation: { kind: 'BET' },
    money,
    occurredAt: OCCURRED_AT,
  });
  if (!outcome.applied) {
    throw new Error(`a covered debit applies, it was refused with ${outcome.failureCode}`);
  }

  await unitOfWork.transactional(({ transactions }) =>
    transactions.insert(WagerTransaction.create(submission({ money }))),
  );

  const { entry, wallet } = outcome;
  const connection = schema.em.getConnection();
  await connection.transactional(async (context) => {
    await connection.execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, kind, direction, currency,
                                          amount, balance_before, balance_after, wallet_version,
                                          created_at)
            values (?, ?, ?, 'BET', 'DEBIT', ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.money.currency,
        entry.money.toString(),
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.walletVersion,
        entry.createdAt,
      ],
      'run',
      context,
    );
    await connection.execute(
      'update wallets set balance = ?, version = ?, updated_at = ? where id = ?',
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id],
      'run',
      context,
    );
  });
}

const identity: TransactionIdentity = {
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

/**
 * The five outcome fields of a transaction sit behind getters (ADR 0007), so they are not own
 * properties and an object comparison would silently skip them. This projection is what makes the
 * round trip field by field.
 */
const stateOf = (transaction: WagerTransaction): WagerTransactionState => ({
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

describe('persistence-mapping-round-trip', () => {
  test('a wallet rehydrates to the state the factory produced', async () => {
    const opened = openedWallet('500.00');

    await given(opened);

    expect(
      await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID)),
    ).toStrictEqual(opened.wallet);
  });

  test('an unknown wallet is absent rather than an error', async () => {
    expect(await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID))).toBeNull();
  });

  test('the opening entry rehydrates with its direction, kind and arithmetic', async () => {
    const opened = openedWallet('500.00');

    await given(opened);

    const loaded = await unitOfWork.transactional(({ ledger }) =>
      ledger.findByTransactionId(OPENING_TRANSACTION_ID),
    );

    expect(loaded).toStrictEqual(stored(opened.openingEntry, 'opening entry'));
    expect(loaded?.isBalanced()).toBe(true);
  });

  /**
   * The wallet row is inserted in the state the debit left it, because the balance and the head of
   * its ledger are committed together (ADR 0003): the opening entry at version 1 and the debit
   * entry at version 2 are the chain the row at version 2 mirrors.
   */
  test('a debit entry rehydrates with the balances it recorded', async () => {
    const opened = openedWallet('500.00');
    const outcome = opened.wallet.debit({
      transactionId: TRANSACTION_ID,
      entryId: ENTRY_ID,
      playerId: PLAYER_ID,
      operation: { kind: 'BET' },
      money: brl('40.00'),
      occurredAt: OCCURRED_AT,
    });
    if (!outcome.applied) {
      throw new Error(`a covered debit applies, it was refused with ${outcome.failureCode}`);
    }

    await unitOfWork.transactional(async ({ wallets, transactions, ledger }) => {
      await wallets.insert(outcome.wallet);
      await transactions.insert(stored(openingTransactionOf(opened), 'opening transaction'));
      await ledger.insert(stored(opened.openingEntry, 'opening entry'));
      await transactions.insert(WagerTransaction.create(submission()));
      await ledger.insert(outcome.entry);
    });

    expect(
      await unitOfWork.transactional(({ ledger }) => ledger.findByTransactionId(TRANSACTION_ID)),
    ).toStrictEqual(outcome.entry);
  });

  test('a pending transaction rehydrates with every outcome column still empty', async () => {
    const transaction = WagerTransaction.create(submission());
    await given(openedWallet('500.00'));

    await unitOfWork.transactional(({ transactions }) => transactions.insert(transaction));

    const loaded = await unitOfWork.transactional(({ transactions }) =>
      transactions.findById(TRANSACTION_ID),
    );

    expect(stateOf(stored(loaded, 'transaction'))).toStrictEqual(stateOf(transaction));
  });

  test('a processed transaction rehydrates with its observed balance and resolved reference', async () => {
    const transaction = WagerTransaction.create(
      submission({ kind: 'REFUND', referenceExternalTransactionId: 'acme-tx-000100' }),
    );
    transaction.markProcessed({
      observedBalance: brl('540.00'),
      processedAt: PROCESSED_AT,
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
    });
    await given(
      openedWallet('500.00'),
      // the transaction the refund reverses, which its resolved reference points at
      WagerTransaction.create(
        submission({
          id: REFERENCE_TRANSACTION_ID,
          externalTransactionId: 'acme-tx-000100',
          idempotencyKey: 'provider-acme:acme-tx-000100',
        }),
      ),
    );

    await unitOfWork.transactional(({ transactions }) => transactions.insert(transaction));

    const loaded = await unitOfWork.transactional(({ transactions }) =>
      transactions.findById(TRANSACTION_ID),
    );

    expect(stateOf(stored(loaded, 'transaction'))).toStrictEqual(stateOf(transaction));
  });

  /**
   * `tx.observed-balance` is the wallet balance, so a `CURRENCY_MISMATCH` rejection holds an
   * amount in the submitted currency and an observed balance in the wallet's. The two currencies
   * are stored separately, or the audit log would relabel one of them.
   */
  test('a rejected transaction keeps the currency of its amount and of its observed balance', async () => {
    const transaction = WagerTransaction.create(submission({ money: Money.from('10.00', 'EUR') }));
    transaction.reject({ failureCode: 'CURRENCY_MISMATCH', observedBalance: brl('500.00') });
    await given(openedWallet('500.00'));

    await unitOfWork.transactional(({ transactions }) => transactions.insert(transaction));

    const loaded = await unitOfWork.transactional(({ transactions }) =>
      transactions.findById(TRANSACTION_ID),
    );

    expect(loaded?.money.currency).toBe('EUR');
    expect(loaded?.observedBalance?.currency).toBe('BRL');
    expect(stateOf(stored(loaded, 'transaction'))).toStrictEqual(stateOf(transaction));
  });

  test('an inbox message rehydrates, received and completed', async () => {
    const received = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: 'acme-msg-000123',
      payloadHash: `sha256:${'7'.repeat(64)}`,
      receivedAt: OCCURRED_AT,
    });
    const completed = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: 'acme-msg-000124',
      payloadHash: `sha256:${'8'.repeat(64)}`,
      receivedAt: OCCURRED_AT,
    });
    completed.markProcessed(PROCESSED_AT);
    // The claim of a delivery already recorded hands back the stored row (`msg.redelivery-safe`).
    const redelivered = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: 'acme-msg-000124',
      payloadHash: `sha256:${'8'.repeat(64)}`,
      receivedAt: PROCESSED_AT,
    });

    await unitOfWork.transactional(async ({ inbox }) => {
      expect(await inbox.claim(received)).toEqual({ claimed: true });
      expect(await inbox.claim(completed)).toEqual({ claimed: true });
      await inbox.complete(completed);
    });

    const [loadedReceived, loadedCompleted] = await unitOfWork.transactional(({ inbox }) =>
      Promise.all([
        inbox.findByIdentity({
          consumerName: 'wager-transactions',
          messageId: 'acme-msg-000123',
        }),
        inbox.findByIdentity({
          consumerName: 'wager-transactions',
          messageId: 'acme-msg-000124',
        }),
      ]),
    );

    expect(loadedReceived).toStrictEqual(received);
    expect(loadedReceived?.isProcessed()).toBe(false);
    expect(loadedCompleted).toStrictEqual(completed);
    expect(loadedCompleted?.isProcessed()).toBe(true);

    const lost = await unitOfWork.transactional(({ inbox }) => inbox.claim(redelivered));

    expect(lost).toEqual({ claimed: false, stored: completed });
    expect(lost.claimed ? null : lost.stored.matchesPayload(redelivered.payloadHash)).toBe(true);
  });

  test('an outbox message rehydrates with its envelope, attempts and next attempt', async () => {
    const message = OutboxMessage.enqueue(
      WagerTransactionProcessed.record({
        eventId: EVENT_ID,
        correlationId: CORRELATION_ID,
        occurredAt: OCCURRED_AT,
        identity,
        balanceAfter: brl('460.00'),
        walletVersion: 2,
        processedAt: PROCESSED_AT,
        reference: null,
      }),
    );
    message.scheduleRetry(FAILED_AT);

    await unitOfWork.transactional(({ outbox }) => outbox.insert(message));

    const loaded = await unitOfWork.transactional(({ outbox }) => outbox.findByEventId(EVENT_ID));

    expect(loaded).toStrictEqual(message);
    expect(loaded?.attempts).toBe(1);
    expect(loaded?.payload.data).toEqual({
      transactionId: TRANSACTION_ID,
      providerId: 'provider-acme',
      externalTransactionId: 'acme-tx-000123',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
      balanceAfter: { amount: '460.00', currency: 'BRL' },
      walletVersion: 2,
      processedAt: PROCESSED_AT.toISOString(),
    });
  });
});

/** MONEY-010: `money.exact-persistence` through the mapping, at the edges of the bound. */
describe('money-round-trips-through-postgres', () => {
  for (const amount of ['0.00', '0.01', '1.50', '40.00', '100000000000.10', BOUND]) {
    test(`a balance of ${amount} reads back to the cent`, async () => {
      const opened = openedWallet(amount);

      await given(opened);
      const loaded = await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID));

      expect(loaded?.balance.toString()).toBe(amount);
      expect(loaded?.balance.equals(opened.wallet.balance)).toBe(true);
    });
  }

  test('the column holds the amount as money, not as minor units', async () => {
    await given(openedWallet(BOUND));

    const rows = await runtime.em
      .getConnection()
      .execute<{ balance: string }[]>('select balance from wallets where id = ?', [WALLET_ID]);

    expect(rows[0]?.balance).toBe(BOUND);
  });

  /**
   * A wallet past its opening, so the round trip covers a stored version other than 1 and an
   * `updatedAt` later than the `createdAt` beside it, in a currency that is not the default.
   */
  test('a foreign currency survives the round trip with its version and times', async () => {
    const credited = creditedWallet('12.34', 'EUR');

    await unitOfWork.transactional(async ({ wallets, transactions, ledger }) => {
      await wallets.insert(credited.wallet);
      await transactions.insert(credited.transaction);
      await ledger.insert(credited.entry);
    });

    const loaded = await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID));

    expect(loaded).toStrictEqual(credited.wallet);
    expect(loaded?.version).toBe(2);
    expect(loaded?.balance.toString()).toBe('12.34');
    expect(loaded?.updatedAt).toEqual(OCCURRED_AT);
  });
});

/** SCHEMA-020: every money column is `NUMERIC(20,2)` and refuses a value past the bound. */
describe('schema-money-columns', () => {
  test('every numeric column of the schema is a money column of NUMERIC(20,2)', async () => {
    const columns = await schema.em.getConnection().execute<
      {
        table_name: string;
        column_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }[]
    >(
      `select table_name, column_name, numeric_precision, numeric_scale
         from information_schema.columns
        where table_schema = 'public' and data_type = 'numeric'
        order by table_name, column_name`,
    );

    expect(columns.map((column) => [column.table_name, column.column_name])).toEqual(MONEY_COLUMNS);
    expect(
      columns.every((column) => column.numeric_precision === 20 && column.numeric_scale === 2),
    ).toBe(true);
  });

  test('a value past the bound is refused by the column, not rounded into it', async () => {
    const insert = runtime.em.getConnection().execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', 1000000000000000000.00, 1, ?, ?)`,
      [WALLET_ID, PLAYER_ID, OPENED_AT, OPENED_AT],
    );

    expect(await rejection(insert)).toMatch(/numeric field overflow/);
  });
});

describe('unit-of-work', () => {
  test('a failed operation writes nothing: the rows it inserted are not committed', async () => {
    const opened = openedWallet('500.00');
    const openingEntry = stored(opened.openingEntry, 'opening entry');

    const failure = unitOfWork.transactional(async ({ wallets, transactions, ledger }) => {
      await wallets.insert(opened.wallet);
      await transactions.insert(stored(openingTransactionOf(opened), 'opening transaction'));
      await ledger.insert(openingEntry);
      throw new Error('the use case failed after writing');
    });

    expect(await rejection(failure)).toBe('the use case failed after writing');
    expect(await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID))).toBeNull();
    expect(
      await unitOfWork.transactional(({ transactions }) =>
        transactions.findById(OPENING_TRANSACTION_ID),
      ),
    ).toBeNull();
    expect(
      await unitOfWork.transactional(({ ledger }) =>
        ledger.findByTransactionId(OPENING_TRANSACTION_ID),
      ),
    ).toBeNull();
  });

  /**
   * Each operation forks its own entity manager, so no operation hands another the wallet state it
   * happened to load first. A manager shared between operations would keep serving the balance of
   * its first read.
   */
  test('an operation never serves a wallet another operation already loaded', async () => {
    const opened = openedWallet('500.00');
    await given(opened);

    const first = await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID));
    expect(first?.balance.toString()).toBe('500.00');

    await debitOutsideTheUnitOfWork(opened, brl('40.00'));

    const second = await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID));
    expect(second?.balance.toString()).toBe('460.00');
    expect(second?.version).toBe(2);
  });

  test('concurrent operations commit their own rows', async () => {
    // another player, because one wallet per player and currency is a unique key of ADR 0003
    const other = openedWallet('10.00', {
      id: OTHER_WALLET_ID,
      playerId: OTHER_PLAYER_ID,
      transactionId: OTHER_OPENING_TRANSACTION_ID,
      entryId: OTHER_OPENING_ENTRY_ID,
    });

    await Promise.all([given(openedWallet('500.00')), given(other)]);

    const [first, second] = await unitOfWork.transactional(({ wallets }) =>
      Promise.all([wallets.findById(WALLET_ID), wallets.findById(OTHER_WALLET_ID)]),
    );

    expect(first?.balance.toString()).toBe('500.00');
    expect(second?.balance.toString()).toBe('10.00');
  });
});
