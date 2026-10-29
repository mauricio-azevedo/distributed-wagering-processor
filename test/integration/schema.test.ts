import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * The half of ADR 0003 that a single row or a single table can decide: uniqueness, validity,
 * referential integrity, the append-only triggers and the privileges that keep the runtime role
 * out of history. Every case is direct SQL, issued as the role the scenario names, asserting the
 * constraint or the trigger that refused it; nothing here goes through a repository, because the
 * point is what the database refuses whatever wrote it.
 *
 * The deferred wallet-to-ledger triggers (SCHEMA-017, SCHEMA-021 to SCHEMA-023) are not installed
 * yet, so a wallet row and its ledger are independent here: a case may append an entry without
 * moving the balance of the wallet it belongs to.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const WALLET = '0193f0c0-0003-7000-8000-000000000001';
const OTHER_WALLET = '0193f0c0-0003-7000-8000-000000000002';
const PLAYER = '0193f0c0-0003-7000-8000-000000000003';
const OTHER_PLAYER = '0193f0c0-0003-7000-8000-000000000004';
const TRANSACTION = '0193f0c0-0003-7000-8000-000000000005';
const OTHER_TRANSACTION = '0193f0c0-0003-7000-8000-000000000006';
const THIRD_TRANSACTION = '0193f0c0-0003-7000-8000-000000000007';
const ENTRY = '0193f0c0-0003-7000-8000-000000000008';
const OTHER_ENTRY = '0193f0c0-0003-7000-8000-000000000009';
const EVENT = '0193f0c0-0003-7000-8000-00000000000a';

const AT = new Date('2026-10-29T12:00:00.000Z');

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** The monetary columns of the schema, each closed to `NaN` by `money.finite-in-database`. */
const MONEY_COLUMNS = [
  ['wager_transactions', 'amount'],
  ['wager_transactions', 'observed_balance'],
  ['wallet_ledger_entries', 'amount'],
  ['wallet_ledger_entries', 'balance_after'],
  ['wallet_ledger_entries', 'balance_before'],
  ['wallets', 'balance'],
];

/** The three checks that stand between `NaN` and a ledger entry. */
const LEDGER_FINITENESS = [
  'wallet_ledger_entries_amount_is_finite_check',
  'wallet_ledger_entries_balance_after_is_finite_check',
  'wallet_ledger_entries_balance_before_is_finite_check',
];

type Column = string | number | Date | null;
type Row = Record<string, Column>;

let migrator: MikroORM;
let app: MikroORM;

beforeAll(async () => {
  migrator = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await migrator.migrator.up();
  app = await MikroORM.init(ormConfig(env.DATABASE_URL));
});

afterAll(async () => {
  await app.close(true);
  await migrator.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003). Truncation
// fires no row trigger, which is what lets a suite reset an append-only table between cases.
beforeEach(async () => {
  await run(migrator, `truncate table ${TABLES.join(', ')}`);
});

/** Issues a statement and discards whatever it returns. */
function run(orm: MikroORM, statement: string, params: Column[] = []): Promise<unknown> {
  return orm.em.getConnection().execute(statement, params);
}

function insert(orm: MikroORM, table: string, row: Row): Promise<unknown> {
  const columns = Object.keys(row);
  const values = columns.map(() => '?').join(', ');
  return run(
    orm,
    `insert into "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) values (${values})`,
    Object.values(row),
  );
}

interface Refusal {
  readonly message: string;
  /** The SQLSTATE the server raised: `23000` for a trigger of ADR 0003, `235xx` for a constraint. */
  readonly sqlState: string | undefined;
}

/** The refusal of a statement the database must not accept; a success here fails the test. */
async function refused(statement: Promise<unknown>): Promise<Refusal> {
  try {
    await statement;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      sqlState: sqlStateOf(error),
    };
  }
  throw new Error('expected the database to refuse the statement');
}

function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

const walletRow = (overrides: Row = {}): Row => ({
  id: WALLET,
  player_id: PLAYER,
  currency: 'BRL',
  balance: '100.00',
  version: 1,
  created_at: AT,
  updated_at: AT,
  ...overrides,
});

const transactionRow = (overrides: Row = {}): Row => ({
  id: TRANSACTION,
  provider_id: 'provider-acme',
  external_transaction_id: 'acme-tx-000123',
  idempotency_key: 'provider-acme:acme-tx-000123',
  payload_hash: `sha256:${'5'.repeat(64)}`,
  wallet_id: WALLET,
  player_id: PLAYER,
  round_id: 'round-7f3a',
  game_id: 'lucky-sevens',
  kind: 'BET',
  currency: 'BRL',
  amount: '40.00',
  status: 'PENDING',
  failure_code: null,
  observed_balance: null,
  observed_balance_currency: null,
  reference_external_transaction_id: null,
  reference_transaction_id: null,
  processed_at: null,
  created_at: AT,
  ...overrides,
});

const entryRow = (overrides: Row = {}): Row => ({
  id: ENTRY,
  wallet_id: WALLET,
  transaction_id: TRANSACTION,
  kind: 'BET',
  direction: 'DEBIT',
  currency: 'BRL',
  amount: '40.00',
  balance_before: '100.00',
  balance_after: '60.00',
  wallet_version: 2,
  created_at: AT,
  ...overrides,
});

/** A processed outcome, the shape the terminal-consistency checks demand. */
const processed = (overrides: Row = {}): Row => ({
  status: 'PROCESSED',
  processed_at: AT,
  observed_balance: '60.00',
  observed_balance_currency: 'BRL',
  ...overrides,
});

/** A second submission of the same provider, free of the identity and key of the first. */
const secondSubmission = (overrides: Row = {}): Row => ({
  id: OTHER_TRANSACTION,
  external_transaction_id: 'acme-tx-000124',
  idempotency_key: 'provider-acme:acme-tx-000124',
  ...overrides,
});

/** A wallet and the transaction every ledger entry needs as the target of its foreign keys. */
async function givenWalletAndTransaction(transaction: Row = {}): Promise<void> {
  await insert(app, 'wallets', walletRow());
  await insert(app, 'wager_transactions', transactionRow(transaction));
}

async function rowCount(table: string): Promise<number> {
  const rows = await app.em
    .getConnection()
    .execute<{ count: number }[]>(`select count(*)::int as count from "${table}"`);
  return rows[0]?.count ?? 0;
}

async function statusOf(transactionId: string): Promise<string | undefined> {
  const rows = await app.em
    .getConnection()
    .execute<{ status: string }[]>('select status from wager_transactions where id = ?', [
      transactionId,
    ]);
  return rows[0]?.status;
}

describe('schema-unique-wallet-per-player-currency', () => {
  test('a second wallet for one player and currency is refused', async () => {
    await insert(app, 'wallets', walletRow());

    expect(
      (await refused(insert(app, 'wallets', walletRow({ id: OTHER_WALLET })))).message,
    ).toMatch(/wallets_player_id_currency_unique/);
  });

  test('the same player in another currency is a wallet of its own', async () => {
    await insert(app, 'wallets', walletRow());

    await insert(app, 'wallets', walletRow({ id: OTHER_WALLET, currency: 'EUR' }));

    expect(await rowCount('wallets')).toBe(2);
  });
});

describe('schema-balance-non-negative', () => {
  test('a balance below zero is refused on update', async () => {
    await insert(app, 'wallets', walletRow());

    const refusal = await refused(
      run(app, 'update wallets set balance = -0.01 where id = ?', [WALLET]),
    );

    expect(refusal.message).toMatch(/wallets_balance_non_negative_check/);
  });

  test('a balance below zero is refused on insert', async () => {
    expect(
      (await refused(insert(app, 'wallets', walletRow({ balance: '-1.00' })))).message,
    ).toMatch(/wallets_balance_non_negative_check/);
  });
});

describe('schema-version-at-least-one', () => {
  test('a wallet version below one is refused', async () => {
    expect((await refused(insert(app, 'wallets', walletRow({ version: 0 })))).message).toMatch(
      /wallets_version_at_least_one_check/,
    );
  });
});

describe('schema-unique-provider-transaction', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
  });

  test('two rows for one provider transaction id are refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wager_transactions',
        transactionRow({ id: OTHER_TRANSACTION, idempotency_key: 'provider-acme:other' }),
      ),
    );

    expect(refusal.message).toMatch(
      /wager_transactions_provider_id_external_transaction_id_unique/,
    );
  });

  test('another provider may submit the same external transaction id', async () => {
    await insert(
      app,
      'wager_transactions',
      transactionRow({
        id: OTHER_TRANSACTION,
        provider_id: 'provider-zeta',
        idempotency_key: 'provider-zeta:acme-tx-000123',
      }),
    );

    expect(await rowCount('wager_transactions')).toBe(2);
  });
});

describe('schema-unique-provider-key', () => {
  test('two rows for one provider idempotency key are refused', async () => {
    await givenWalletAndTransaction();

    const refusal = await refused(
      insert(
        app,
        'wager_transactions',
        transactionRow({ id: OTHER_TRANSACTION, external_transaction_id: 'acme-tx-000124' }),
      ),
    );

    expect(refusal.message).toMatch(/wager_transactions_provider_id_idempotency_key_unique/);
  });

  test('two providers may use the same key string', async () => {
    await givenWalletAndTransaction({ idempotency_key: 'daily-000123' });

    await insert(
      app,
      'wager_transactions',
      transactionRow({
        id: OTHER_TRANSACTION,
        provider_id: 'provider-zeta',
        idempotency_key: 'daily-000123',
      }),
    );

    expect(await rowCount('wager_transactions')).toBe(2);
  });
});

describe('schema-kinds-statuses-reference-matrix', () => {
  describe('on a transaction row', () => {
    beforeEach(async () => {
      await insert(app, 'wallets', walletRow());
    });

    test('an unknown kind is refused', async () => {
      const refusal = await refused(
        insert(app, 'wager_transactions', transactionRow({ kind: 'SPLIT' })),
      );

      expect(refusal.message).toMatch(/wager_transactions_kind_check/);
    });

    test('an unknown status is refused', async () => {
      const refusal = await refused(
        insert(app, 'wager_transactions', transactionRow({ status: 'SETTLED' })),
      );

      expect(refusal.message).toMatch(/wager_transactions_status_check/);
    });

    test('an unknown failure code is refused', async () => {
      const refusal = await refused(
        insert(
          app,
          'wager_transactions',
          transactionRow({ status: 'REJECTED', failure_code: 'NOT_IN_THE_VOCABULARY' }),
        ),
      );

      expect(refusal.message).toMatch(/wager_transactions_failure_code_check/);
    });

    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      test(`a ${kind} without a reference is refused`, async () => {
        const refusal = await refused(insert(app, 'wager_transactions', transactionRow({ kind })));

        expect(refusal.message).toMatch(/wager_transactions_reference_matrix_check/);
      });
    }

    for (const kind of ['BET', 'OPENING'] as const) {
      test(`a ${kind} carrying a reference is refused`, async () => {
        const refusal = await refused(
          insert(
            app,
            'wager_transactions',
            transactionRow({ kind, reference_external_transaction_id: 'acme-tx-000100' }),
          ),
        );

        expect(refusal.message).toMatch(/wager_transactions_reference_matrix_check/);
      });
    }

    test('a WIN is admitted with a reference and without one', async () => {
      await insert(app, 'wager_transactions', transactionRow({ kind: 'WIN' }));
      await insert(
        app,
        'wager_transactions',
        transactionRow(
          secondSubmission({ kind: 'WIN', reference_external_transaction_id: 'acme-tx-000100' }),
        ),
      );

      expect(await rowCount('wager_transactions')).toBe(2);
    });
  });

  describe('on a ledger entry', () => {
    beforeEach(async () => {
      await givenWalletAndTransaction();
    });

    /**
     * An unknown direction satisfies neither branch of the balanced arithmetic, so no row can
     * carry one and nothing else: which of the two checks reports the refusal is the server's
     * choice, that one of them does is the guarantee.
     */
    test('an unknown direction is refused', async () => {
      const refusal = await refused(
        insert(app, 'wallet_ledger_entries', entryRow({ direction: 'SIDEWAYS' })),
      );

      expect(refusal.message).toMatch(/wallet_ledger_entries_(direction|balanced)_check/);
    });

    test('a LOSS entry is refused: the kind that moves nothing writes no entry', async () => {
      const refusal = await refused(
        insert(app, 'wallet_ledger_entries', entryRow({ kind: 'LOSS' })),
      );

      expect(refusal.message).toMatch(/wallet_ledger_entries_kind_check/);
    });
  });
});

describe('schema-terminal-consistency', () => {
  beforeEach(async () => {
    await insert(app, 'wallets', walletRow());
  });

  test('PROCESSED without a processed time is refused', async () => {
    const refusal = await refused(
      insert(app, 'wager_transactions', transactionRow({ status: 'PROCESSED' })),
    );

    expect(refusal.message).toMatch(/wager_transactions_processed_at_presence_check/);
  });

  test('a processed time on a row that is not PROCESSED is refused', async () => {
    const refusal = await refused(
      insert(app, 'wager_transactions', transactionRow({ processed_at: AT })),
    );

    expect(refusal.message).toMatch(/wager_transactions_processed_at_presence_check/);
  });

  test('REJECTED without a failure code is refused', async () => {
    const refusal = await refused(
      insert(app, 'wager_transactions', transactionRow({ status: 'REJECTED' })),
    );

    expect(refusal.message).toMatch(/wager_transactions_failure_code_presence_check/);
  });

  test('a failure code on a PENDING row is refused', async () => {
    const refusal = await refused(
      insert(app, 'wager_transactions', transactionRow({ failure_code: 'INSUFFICIENT_BALANCE' })),
    );

    expect(refusal.message).toMatch(/wager_transactions_failure_code_presence_check/);
  });

  test('a failure code on a PROCESSED row is refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wager_transactions',
        transactionRow(processed({ failure_code: 'INSUFFICIENT_BALANCE' })),
      ),
    );

    expect(refusal.message).toMatch(/wager_transactions_failure_code_presence_check/);
  });
});

describe('schema-positive-amounts', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
  });

  // The arithmetic of each entry below holds, so the amount check is the only one in play.
  for (const amount of ['0.00', '-1.00']) {
    test(`a ledger entry of ${amount} is refused`, async () => {
      const balanceAfter = amount === '0.00' ? '100.00' : '101.00';
      const refusal = await refused(
        insert(app, 'wallet_ledger_entries', entryRow({ amount, balance_after: balanceAfter })),
      );

      expect(refusal.message).toMatch(/wallet_ledger_entries_amount_positive_check/);
    });
  }

  for (const kind of ['BET', 'WIN', 'REFUND', 'ROLLBACK'] as const) {
    test(`a ${kind} of 0.00 is refused`, async () => {
      const reference = kind === 'REFUND' || kind === 'ROLLBACK' ? 'acme-tx-000100' : null;
      const refusal = await refused(
        insert(
          app,
          'wager_transactions',
          transactionRow(
            secondSubmission({
              kind,
              amount: '0.00',
              reference_external_transaction_id: reference,
            }),
          ),
        ),
      );

      expect(refusal.message).toMatch(/wager_transactions_amount_positive_check/);
    });
  }

  test('a LOSS of -1.00 is refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wager_transactions',
        transactionRow(secondSubmission({ kind: 'LOSS', amount: '-1.00' })),
      ),
    );

    expect(refusal.message).toMatch(/wager_transactions_amount_positive_check/);
  });

  test('a LOSS of 0.00 commits, the only amount exception in the schema', async () => {
    await insert(
      app,
      'wager_transactions',
      transactionRow(secondSubmission({ kind: 'LOSS', amount: '0.00' })),
    );

    expect(await rowCount('wager_transactions')).toBe(2);
  });
});

describe('schema-one-entry-per-transaction', () => {
  test('a second entry for one transaction is refused', async () => {
    await givenWalletAndTransaction();
    await insert(app, 'wallet_ledger_entries', entryRow());

    const refusal = await refused(
      insert(
        app,
        'wallet_ledger_entries',
        entryRow({
          id: OTHER_ENTRY,
          direction: 'CREDIT',
          balance_before: '60.00',
          balance_after: '100.00',
          wallet_version: 3,
        }),
      ),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_transaction_id_unique/);
  });
});

describe('schema-unique-wallet-version', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
  });

  test('two entries with one wallet version are refused', async () => {
    await insert(app, 'wager_transactions', transactionRow(secondSubmission()));
    await insert(app, 'wallet_ledger_entries', entryRow({ wallet_version: 3 }));

    const refusal = await refused(
      insert(
        app,
        'wallet_ledger_entries',
        entryRow({ id: OTHER_ENTRY, transaction_id: OTHER_TRANSACTION, wallet_version: 3 }),
      ),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_wallet_id_wallet_version_unique/);
  });

  test('a wallet version below one is refused', async () => {
    const refusal = await refused(
      insert(app, 'wallet_ledger_entries', entryRow({ wallet_version: 0 })),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_wallet_version_at_least_one_check/);
  });
});

describe('schema-balanced-entries', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
  });

  test('a CREDIT whose arithmetic does not add up is refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wallet_ledger_entries',
        entryRow({
          direction: 'CREDIT',
          amount: '40.00',
          balance_before: '100.00',
          balance_after: '150.00',
        }),
      ),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_balanced_check/);
  });

  test('a DEBIT that lands below zero is refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wallet_ledger_entries',
        entryRow({ amount: '20.00', balance_before: '10.00', balance_after: '-10.00' }),
      ),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_balance_after_non_negative_check/);
  });
});

describe('schema-entry-currency-fk', () => {
  test("an entry in a currency other than its wallet's is refused", async () => {
    await givenWalletAndTransaction();

    const refusal = await refused(
      insert(app, 'wallet_ledger_entries', entryRow({ currency: 'USD' })),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries_wallet_id_currency_foreign/);
  });

  // The same mechanism, on the other two references the financial tables carry.
  test('an entry for an unknown transaction is refused', async () => {
    await insert(app, 'wallets', walletRow());

    const refusal = await refused(insert(app, 'wallet_ledger_entries', entryRow()));

    expect(refusal.message).toMatch(/wallet_ledger_entries_transaction_id_foreign/);
  });

  test('a transaction for an unknown wallet is refused', async () => {
    const refusal = await refused(insert(app, 'wager_transactions', transactionRow()));

    expect(refusal.message).toMatch(/wager_transactions_wallet_id_foreign/);
  });
});

describe('schema-ledger-trigger', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
    await insert(app, 'wallet_ledger_entries', entryRow());
  });

  test('the owner of the table cannot update an entry', async () => {
    const refusal = await refused(
      run(migrator, 'update wallet_ledger_entries set amount = 1.00 where id = ?', [ENTRY]),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries is immutable/);
    expect(refusal.sqlState).toBe('23000');
  });

  test('the owner of the table cannot delete an entry', async () => {
    const refusal = await refused(
      run(migrator, 'delete from wallet_ledger_entries where id = ?', [ENTRY]),
    );

    expect(refusal.message).toMatch(/wallet_ledger_entries is immutable/);
    expect(refusal.sqlState).toBe('23000');
    expect(await rowCount('wallet_ledger_entries')).toBe(1);
  });
});

describe('ledger-rejects-update-and-delete', () => {
  beforeEach(async () => {
    await givenWalletAndTransaction();
    await insert(app, 'wallet_ledger_entries', entryRow());
  });

  test('the runtime role is refused by its privileges, before any trigger runs', async () => {
    const update = await refused(
      run(app, 'update wallet_ledger_entries set amount = 1.00 where id = ?', [ENTRY]),
    );
    const remove = await refused(
      run(app, 'delete from wallet_ledger_entries where id = ?', [ENTRY]),
    );

    expect(update.message).toMatch(/permission denied for table wallet_ledger_entries/);
    expect(remove.message).toMatch(/permission denied for table wallet_ledger_entries/);
  });

  test('the owner is refused by the trigger, and the entry is still there', async () => {
    await refused(
      run(migrator, 'update wallet_ledger_entries set amount = 1.00 where id = ?', [ENTRY]),
    );
    await refused(run(migrator, 'delete from wallet_ledger_entries where id = ?', [ENTRY]));

    expect(await rowCount('wallet_ledger_entries')).toBe(1);
  });
});

describe('schema-runtime-role-privileges', () => {
  test('the runtime role may read and append to the ledger and nothing else', async () => {
    const rows = await app.em.getConnection().execute<{ privilege_type: string }[]>(
      `select privilege_type
         from information_schema.table_privileges
        where table_schema = 'public'
          and table_name = 'wallet_ledger_entries'
          and grantee = 'wagering_app'
        order by privilege_type`,
    );

    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  test('the runtime role holds no DELETE privilege on any table', async () => {
    const rows = await app.em.getConnection().execute<{ table_name: string }[]>(
      `select table_name
         from information_schema.table_privileges
        where table_schema = 'public'
          and grantee = 'wagering_app'
          and privilege_type = 'DELETE'`,
    );

    expect(rows).toEqual([]);
  });

  test('the runtime role cannot drop the trigger that protects the ledger', async () => {
    const refusal = await refused(
      run(app, 'drop trigger wallet_ledger_entries_immutable on wallet_ledger_entries'),
    );

    expect(refusal.message).toMatch(/must be owner of (relation|table) wallet_ledger_entries/);
  });

  test('the runtime role cannot alter a table', async () => {
    const refusal = await refused(run(app, 'alter table wallets drop constraint wallets_pkey'));

    expect(refusal.message).toMatch(/must be owner of (relation|table) wallets/);
  });

  test('the runtime role cannot rewrite the migration log', async () => {
    const refusal = await refused(run(app, `delete from mikro_orm_migrations where name <> ''`));

    expect(refusal.message).toMatch(/permission denied for table mikro_orm_migrations/);
  });
});

describe('schema-reversed-once', () => {
  const reversal = (overrides: Row = {}): Row =>
    transactionRow({
      kind: 'REFUND',
      reference_external_transaction_id: 'acme-tx-000123',
      reference_transaction_id: TRANSACTION,
      ...processed(),
      ...overrides,
    });

  const firstReversal = reversal(secondSubmission());
  const secondReversal = reversal({
    id: THIRD_TRANSACTION,
    external_transaction_id: 'acme-tx-000125',
    idempotency_key: 'provider-acme:acme-tx-000125',
    kind: 'ROLLBACK',
  });

  beforeEach(async () => {
    await insert(app, 'wallets', walletRow());
    await insert(app, 'wager_transactions', transactionRow(processed()));
    await insert(app, 'wager_transactions', firstReversal);
  });

  test('a second processed reversal of one transaction is refused, whatever its kind', async () => {
    const refusal = await refused(insert(app, 'wager_transactions', secondReversal));

    expect(refusal.message).toMatch(/wager_transactions_processed_reversal_unique/);
  });

  test('a rejected reversal of the same transaction is recorded beside the processed one', async () => {
    await insert(app, 'wager_transactions', {
      ...secondReversal,
      status: 'REJECTED',
      processed_at: null,
      failure_code: 'REFERENCE_ALREADY_REVERSED',
    });

    expect(await rowCount('wager_transactions')).toBe(3);
  });
});

describe('schema-one-opening-per-wallet', () => {
  const opening = (walletId: string, overrides: Row = {}): Row =>
    transactionRow({
      provider_id: 'system',
      external_transaction_id: walletId,
      idempotency_key: `system:${walletId}`,
      wallet_id: walletId,
      round_id: walletId,
      game_id: 'wallet-opening',
      kind: 'OPENING',
      ...processed({ observed_balance: '100.00' }),
      ...overrides,
    });

  beforeEach(async () => {
    await insert(app, 'wallets', walletRow());
    await insert(app, 'wager_transactions', opening(WALLET));
  });

  test('a second opening credit for one wallet is refused', async () => {
    const refusal = await refused(
      insert(
        app,
        'wager_transactions',
        opening(WALLET, {
          id: OTHER_TRANSACTION,
          external_transaction_id: `${WALLET}-again`,
          idempotency_key: `system:${WALLET}-again`,
        }),
      ),
    );

    expect(refusal.message).toMatch(/wager_transactions_opening_per_wallet_unique/);
  });

  test('another wallet has an opening credit of its own', async () => {
    await insert(app, 'wallets', walletRow({ id: OTHER_WALLET, player_id: OTHER_PLAYER }));

    await insert(
      app,
      'wager_transactions',
      opening(OTHER_WALLET, { id: OTHER_TRANSACTION, player_id: OTHER_PLAYER }),
    );

    expect(await rowCount('wager_transactions')).toBe(2);
  });
});

describe('schema-inbox-identity', () => {
  const inboxRow = (overrides: Row = {}): Row => ({
    consumer_name: 'wager-transactions',
    message_id: 'acme-msg-000123',
    payload_hash: `sha256:${'7'.repeat(64)}`,
    received_at: AT,
    processed_at: null,
    ...overrides,
  });

  beforeEach(async () => {
    await insert(app, 'inbox_messages', inboxRow());
  });

  test('a second row for one consumer and message id is refused', async () => {
    expect((await refused(insert(app, 'inbox_messages', inboxRow()))).message).toMatch(
      /inbox_messages_pkey/,
    );
  });

  test('another consumer deduplicates the same message id on its own', async () => {
    await insert(app, 'inbox_messages', inboxRow({ consumer_name: 'reference-resolver' }));

    expect(await rowCount('inbox_messages')).toBe(2);
  });
});

describe('schema-outbox-identity-and-index', () => {
  const outboxRow = (overrides: Row = {}): Row => ({
    event_id: EVENT,
    event_type: 'WagerTransactionProcessed',
    aggregate_id: WALLET,
    payload: JSON.stringify({ eventId: EVENT }),
    occurred_at: AT,
    attempts: 0,
    next_attempt_at: AT,
    published_at: null,
    ...overrides,
  });

  test('two rows with one event id are refused', async () => {
    await insert(app, 'outbox_messages', outboxRow());

    expect(
      (await refused(insert(app, 'outbox_messages', outboxRow({ aggregate_id: OTHER_WALLET }))))
        .message,
    ).toMatch(/outbox_messages_pkey/);
  });

  test('an unknown event type is refused', async () => {
    expect(
      (await refused(insert(app, 'outbox_messages', outboxRow({ event_type: 'WalletOpened' }))))
        .message,
    ).toMatch(/outbox_messages_event_type_check/);
  });

  /**
   * The claim of ADR 0005: pending rows that are due, oldest first. On a table of a few rows the
   * planner would read it sequentially whatever indexes exist, so the session is told not to, and
   * what the plan then names is whether the index can serve the claim at all.
   */
  test('the pending claim can be served by the claim index', async () => {
    const connection = app.em.getConnection();
    const plan = await connection.transactional(async (context) => {
      await connection.execute('set local enable_seqscan = off', [], 'run', context);
      return connection.execute<{ 'QUERY PLAN': string }[]>(
        `explain select *
             from outbox_messages
            where published_at is null and next_attempt_at <= now()
            order by occurred_at, event_id
            for update skip locked
            limit 50`,
        [],
        'all',
        context,
      );
    });

    expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toMatch(
      /outbox_messages_claim_index/,
    );
  });
});

describe('schema-terminal-rows-are-frozen', () => {
  beforeEach(async () => {
    await insert(app, 'wallets', walletRow());
    await insert(app, 'wager_transactions', transactionRow(processed()));
  });

  test('a PROCESSED row cannot be set back to PENDING', async () => {
    const refusal = await refused(
      run(
        app,
        `update wager_transactions set status = 'PENDING', processed_at = null where id = ?`,
        [TRANSACTION],
      ),
    );

    expect(refusal.message).toMatch(/outcome is final/);
    expect(refusal.sqlState).toBe('23000');
    expect(await statusOf(TRANSACTION)).toBe('PROCESSED');
  });

  test('the observed balance of a PROCESSED row cannot be rewritten', async () => {
    const refusal = await refused(
      run(app, 'update wager_transactions set observed_balance = 1.00 where id = ?', [TRANSACTION]),
    );

    expect(refusal.message).toMatch(/outcome is final/);
    expect(refusal.sqlState).toBe('23000');
  });

  test('a PROCESSED row cannot become REJECTED', async () => {
    const refusal = await refused(
      run(
        app,
        `update wager_transactions
            set status = 'REJECTED', processed_at = null, failure_code = 'INSUFFICIENT_BALANCE'
          where id = ?`,
        [TRANSACTION],
      ),
    );

    expect(refusal.message).toMatch(/outcome is final/);
    expect(refusal.sqlState).toBe('23000');
  });

  test('the failure code of a REJECTED row cannot change', async () => {
    await insert(
      app,
      'wager_transactions',
      transactionRow(
        secondSubmission({ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }),
      ),
    );

    const refusal = await refused(
      run(app, `update wager_transactions set failure_code = 'CURRENCY_MISMATCH' where id = ?`, [
        OTHER_TRANSACTION,
      ]),
    );

    expect(refusal.message).toMatch(/outcome is final/);
    expect(refusal.sqlState).toBe('23000');
  });

  test('the owner of the table cannot delete a terminal row', async () => {
    const refusal = await refused(
      run(migrator, 'delete from wager_transactions where id = ?', [TRANSACTION]),
    );

    expect(refusal.message).toMatch(/cannot be deleted/);
    expect(refusal.sqlState).toBe('23000');
    expect(await statusOf(TRANSACTION)).toBe('PROCESSED');
  });

  test('the owner of the table cannot delete a row that is still open either', async () => {
    await insert(app, 'wager_transactions', transactionRow(secondSubmission()));

    const refusal = await refused(
      run(migrator, 'delete from wager_transactions where id = ?', [OTHER_TRANSACTION]),
    );

    expect(refusal.message).toMatch(/cannot be deleted/);
    expect(refusal.sqlState).toBe('23000');
    expect(await statusOf(OTHER_TRANSACTION)).toBe('PENDING');
  });

  test('a PENDING row still reaches PROCESSED with its outcome', async () => {
    await insert(app, 'wager_transactions', transactionRow(secondSubmission()));

    await run(
      app,
      `update wager_transactions
          set status = 'PROCESSED', processed_at = ?, observed_balance = '60.00',
              observed_balance_currency = 'BRL'
        where id = ?`,
      [AT, OTHER_TRANSACTION],
    );

    expect(await statusOf(OTHER_TRANSACTION)).toBe('PROCESSED');
  });

  test('a PENDING row still parks on a missing reference and resolves it later', async () => {
    await insert(
      app,
      'wager_transactions',
      transactionRow(
        secondSubmission({
          kind: 'REFUND',
          reference_external_transaction_id: 'acme-tx-000123',
        }),
      ),
    );

    await run(app, `update wager_transactions set status = 'PENDING_REFERENCE' where id = ?`, [
      OTHER_TRANSACTION,
    ]);
    await run(
      app,
      `update wager_transactions
          set status = 'PROCESSED', processed_at = ?, observed_balance = '100.00',
              observed_balance_currency = 'BRL', reference_transaction_id = ?
        where id = ?`,
      [AT, TRANSACTION, OTHER_TRANSACTION],
    );

    expect(await statusOf(OTHER_TRANSACTION)).toBe('PROCESSED');
  });

  /**
   * The checks of SCHEMA-007 stay satisfied by a row set back to `PENDING` with its processed time
   * cleared, which is why the trigger exists: the same table without it accepts the downgrade that
   * frees an idempotency key for a second debit and a reversal target for a second reversal.
   */
  test('the same table without the trigger accepts the downgrade', async () => {
    await run(
      migrator,
      'create table wager_transactions_untriggered (like wager_transactions including constraints)',
    );
    try {
      await insert(migrator, 'wager_transactions_untriggered', transactionRow(processed()));

      await run(
        migrator,
        `update wager_transactions_untriggered
            set status = 'PENDING', processed_at = null
          where id = ?`,
        [TRANSACTION],
      );

      const rows = await migrator.em
        .getConnection()
        .execute<{ status: string }[]>(
          'select status from wager_transactions_untriggered where id = ?',
          [TRANSACTION],
        );
      expect(rows[0]?.status).toBe('PENDING');
    } finally {
      await run(migrator, 'drop table wager_transactions_untriggered');
    }
  });
});

describe('schema-transaction-identity-frozen', () => {
  const FROZEN: readonly (readonly [string, Column])[] = [
    ['amount', '41.00'],
    ['currency', 'EUR'],
    ['kind', 'WIN'],
    ['wallet_id', OTHER_WALLET],
    ['player_id', OTHER_PLAYER],
    ['round_id', 'round-0000'],
    ['game_id', 'another-game'],
    ['provider_id', 'provider-zeta'],
    ['external_transaction_id', 'acme-tx-999999'],
    ['idempotency_key', 'provider-acme:acme-tx-999999'],
    ['payload_hash', `sha256:${'6'.repeat(64)}`],
    ['reference_external_transaction_id', 'acme-tx-000100'],
    ['created_at', new Date('2026-10-29T13:00:00.000Z')],
  ];

  const ROWS: readonly (readonly [string, string])[] = [
    ['PENDING', TRANSACTION],
    ['PENDING_REFERENCE', OTHER_TRANSACTION],
  ];

  beforeEach(async () => {
    await insert(app, 'wallets', walletRow());
    await insert(app, 'wallets', walletRow({ id: OTHER_WALLET, player_id: OTHER_PLAYER }));
    await insert(app, 'wager_transactions', transactionRow());
    await insert(
      app,
      'wager_transactions',
      transactionRow(
        secondSubmission({
          kind: 'REFUND',
          reference_external_transaction_id: 'acme-tx-000123',
          status: 'PENDING_REFERENCE',
        }),
      ),
    );
  });

  for (const [column, value] of FROZEN) {
    for (const [label, id] of ROWS) {
      test(`${column} cannot change on a ${label} row`, async () => {
        const refusal = await refused(
          run(app, `update wager_transactions set "${column}" = ? where id = ?`, [value, id]),
        );

        expect(refusal.message).toMatch(/cannot change/);
        expect(refusal.sqlState).toBe('23000');
      });
    }
  }

  test('the outcome fields of a parked row are still writable', async () => {
    await run(
      app,
      `update wager_transactions
          set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
              observed_balance = '100.00', observed_balance_currency = 'BRL',
              reference_transaction_id = ?
        where id = ?`,
      [TRANSACTION, OTHER_TRANSACTION],
    );

    expect(await statusOf(OTHER_TRANSACTION)).toBe('REJECTED');
  });
});

describe('schema-refuses-non-finite-amounts', () => {
  test('every monetary column carries the exclusion, and only monetary columns do', async () => {
    const rows = await app.em.getConnection().execute<{ table: string; definition: string }[]>(
      `select conrelid::regclass::text as "table", pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where connamespace = 'public'::regnamespace
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%NaN%'
        order by conrelid::regclass::text, conname`,
    );

    expect(
      rows.map((row) => [row.table, /(\w+) <> 'NaN'::numeric/.exec(row.definition)?.[1]]),
    ).toEqual(MONEY_COLUMNS);
  });

  test('a wallet balance of NaN is refused', async () => {
    expect((await refused(insert(app, 'wallets', walletRow({ balance: 'NaN' })))).message).toMatch(
      /wallets_balance_is_finite_check/,
    );
  });

  test('a transaction amount of NaN is refused', async () => {
    await insert(app, 'wallets', walletRow());

    expect(
      (await refused(insert(app, 'wager_transactions', transactionRow({ amount: 'NaN' })))).message,
    ).toMatch(/wager_transactions_amount_is_finite_check/);
  });

  test('an observed balance of NaN is refused', async () => {
    await insert(app, 'wallets', walletRow());

    const refusal = await refused(
      insert(app, 'wager_transactions', transactionRow(processed({ observed_balance: 'NaN' }))),
    );

    expect(refusal.message).toMatch(/wager_transactions_observed_balance_is_finite_check/);
  });

  /**
   * `NaN` propagates through addition, so an entry carrying it in one monetary column carries it
   * in another to keep the arithmetic check satisfied; which of the finiteness checks reports the
   * refusal is the server's choice, that one of them does is the guarantee.
   */
  test('a ledger entry carrying NaN is refused', async () => {
    await givenWalletAndTransaction();

    for (const entry of [
      { amount: 'NaN', balance_before: '100.00', balance_after: 'NaN' },
      { amount: '40.00', balance_before: 'NaN', balance_after: 'NaN' },
    ]) {
      const refusal = await refused(insert(app, 'wallet_ledger_entries', entryRow(entry)));

      expect(LEDGER_FINITENESS.some((check) => refusal.message.includes(check))).toBe(true);
    }
  });

  /**
   * Why the exclusion is the only predicate that works: with it gone, an entry of `NaN` satisfies
   * `amount > 0`, `balance_after >= 0` and the balanced arithmetic all at once. No
   * trigger-disabling mechanism bypasses a `CHECK`, so the demonstration drops the three checks as
   * the owner and restores them `NOT VALID`, the row it inserted being one they now refuse.
   */
  test('without the exclusion the other checks accept NaN, and restoring it refuses the next row', async () => {
    await givenWalletAndTransaction();
    const nanEntry = entryRow({
      direction: 'CREDIT',
      amount: 'NaN',
      balance_before: '0.00',
      balance_after: 'NaN',
      wallet_version: 1,
    });
    const definitions = await migrator.em
      .getConnection()
      .execute<{ constraint: string; definition: string }[]>(
        `select conname as "constraint", pg_get_constraintdef(oid) as "definition"
         from pg_constraint
        where conrelid = 'wallet_ledger_entries'::regclass
          and conname in (${LEDGER_FINITENESS.map(() => '?').join(', ')})`,
        LEDGER_FINITENESS,
      );

    try {
      expect(definitions).toHaveLength(LEDGER_FINITENESS.length);
      for (const check of LEDGER_FINITENESS) {
        await run(migrator, `alter table wallet_ledger_entries drop constraint "${check}"`);
      }

      await insert(app, 'wallet_ledger_entries', nanEntry);
      expect(await rowCount('wallet_ledger_entries')).toBe(1);

      for (const { constraint, definition } of definitions) {
        await run(
          migrator,
          `alter table wallet_ledger_entries add constraint "${constraint}" ${definition} not valid`,
        );
      }

      const refusal = await refused(
        insert(app, 'wallet_ledger_entries', { ...nanEntry, id: OTHER_ENTRY, wallet_version: 2 }),
      );
      expect(LEDGER_FINITENESS.some((check) => refusal.message.includes(check))).toBe(true);
    } finally {
      // The row the exclusion refuses has to go before the checks can be valid again, and a ledger
      // entry is only ever removed by truncation.
      await run(migrator, 'truncate table wallet_ledger_entries');
      for (const check of LEDGER_FINITENESS) {
        await run(migrator, `alter table wallet_ledger_entries validate constraint "${check}"`);
      }
    }
  });
});
