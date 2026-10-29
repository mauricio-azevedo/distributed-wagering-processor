import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { Clock } from '../../src/application/ports/clock';
import type { LogFields, Logger } from '../../src/application/ports/logger';
import type { CounterName, Metrics } from '../../src/application/ports/metrics';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import {
  ReconcileWallet,
  type ReconciliationReport,
} from '../../src/application/use-cases/reconcile-wallet';
import { MoneyValidationError } from '../../src/domain/errors';
import { Wallet } from '../../src/domain/wallet';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * Reconciliation against PostgreSQL: the report (RECON-002), the snapshot it is read from
 * (`recon.snapshot`), a divergence the schema no longer admits (RECON-003) and stored data that is
 * not money at all (RECON-005).
 *
 * The divergence fixtures are the point of the suite. SCHEMA-023 means no write the service can
 * issue leaves a wallet whose balance disagrees with its ledger, so a divergence is manufactured as
 * `wagering_migrator`, which owns the tables: the commit-time mirror is disabled for one statement,
 * or the finiteness exclusions are dropped and restored `NOT VALID`, because no trigger-disabling
 * mechanism bypasses a `CHECK`. Every fixture puts the schema back, so the catalogue OPS-002
 * compares against stays the one the migrations left behind.
 *
 * The use case is driven directly rather than over HTTP: the log record and the counter of
 * `recon.divergence-handling` are what a divergence produces wherever reconciliation runs, and a
 * recording `Logger` and `Metrics` are how a test sees them. The endpoint has its own cases in
 * `wallet-http.test.ts` (API-008).
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '0193f0c0-0009-7000-8000-000000000001';
const OTHER_PLAYER_ID = '0193f0c0-0009-7000-8000-000000000002';
const UNKNOWN_WALLET_ID = '0193f0c0-0009-7000-8000-0000000000ff';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const AT = new Date('2026-10-29T12:00:00.000Z');

/**
 * The moment every report of this suite is stamped with. The clock is a port, so `checkedAt` is a
 * value the use case decided and a test can name it; a report stamped by a row default or by a
 * `new Date()` somewhere in the adapters would not match.
 */
const CHECKED_AT = new Date('2026-10-29T12:10:00.000Z');
const fixedClock: Clock = { now: () => CHECKED_AT };

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** `recon.report-shape`: the members a report carries, and no others. */
const REPORT_MEMBERS = [
  'calculatedBalance',
  'checkedAt',
  'checkedEntries',
  'consistent',
  'difference',
  'storedBalance',
  'walletId',
];

/** The four exclusions of `money.finite-in-database` standing between `NaN` and a balance change. */
const BALANCE_CHANGE_FINITENESS = [
  'wallet_ledger_entries_amount_is_finite_check',
  'wallet_ledger_entries_balance_after_is_finite_check',
  'wallet_ledger_entries_balance_before_is_finite_check',
  'wallets_balance_is_finite_check',
];

type Column = string | number | Date | null;
type Row = Record<string, Column>;

/** A fixture mints the identity of every row it writes; uniqueness across the suite is free. */
let minted = 0;
const uuid = (): string =>
  `0193f0c0-0009-7000-9000-${(minted += 1).toString(16).padStart(12, '0')}`;

interface RecordedLog {
  readonly event: string;
  readonly fields: LogFields;
}

class RecordingLogger implements Logger {
  readonly errors: RecordedLog[] = [];

  error(event: string, fields: LogFields): void {
    this.errors.push({ event, fields });
  }
}

class CountingMetrics implements Metrics {
  private readonly counters = new Map<CounterName, number>();

  increment(counter: CounterName): void {
    this.counters.set(counter, this.total(counter) + 1);
  }

  total(counter: CounterName): number {
    return this.counters.get(counter) ?? 0;
  }
}

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: UnitOfWork;
let openWallet: OpenWallet;
let reconcileWallet: ReconcileWallet;
let logger: RecordingLogger;
let metrics: CountingMetrics;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
  openWallet = new OpenWallet({
    unitOfWork,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await asMigrator(`truncate table ${TABLES.join(', ')}`);
  logger = new RecordingLogger();
  metrics = new CountingMetrics();
  reconcileWallet = reconcilingOver(unitOfWork);
});

// `recon.final-invariant` (RECON-004): the wallets this suite leaves consistent are rebuilt from
// their ledger. A wallet corrupted on purpose is forgotten by the fixture that corrupted it, since
// the invariant the sweep asserts is the one such a case breaks to prove the report sees it.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

function reconcilingOver(over: UnitOfWork): ReconcileWallet {
  return new ReconcileWallet({ unitOfWork: over, clock: fixedClock, logger, metrics });
}

function asMigrator(statement: string, params: Column[] = []): Promise<unknown> {
  return schema.em.getConnection().execute(statement, params);
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function open(amount: string, playerId = PLAYER_ID): Promise<Wallet> {
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: brl(amount),
    correlationId: CORRELATION_ID,
  });
  touched.add(wallet.id);

  return wallet;
}

/**
 * The writes of one fixture as a single transaction, so the deferred triggers of ADR 0003 judge the
 * state it leaves behind rather than each statement on the way there.
 */
function committing(
  orm: MikroORM,
  body: (session: {
    run: (statement: string, params?: Column[]) => Promise<unknown>;
    insert: (table: string, row: Row) => Promise<unknown>;
  }) => Promise<unknown>,
): Promise<unknown> {
  const connection = orm.em.getConnection();

  return connection.transactional((context) => {
    const run = (statement: string, params: Column[] = []): Promise<unknown> =>
      connection.execute(statement, params, 'run', context);

    return body({
      run,
      insert: (table, row) => {
        const columns = Object.keys(row);

        return run(
          `insert into "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
             values (${columns.map(() => '?').join(', ')})`,
          Object.values(row),
        );
      },
    });
  });
}

/**
 * A second balance change on a wallet, written as the runtime role in one transaction: a `BET`
 * already `PROCESSED`, the `DEBIT` entry that mirrors it and the wallet moved onto that entry.
 * `SubmitWagerTransaction` writes this from TX-001 onwards; reconciliation has to compare a ledger
 * of more than one entry, and of both directions, before that exists (RECON-002).
 */
async function givenBetOf(wallet: Wallet, amount: string, balanceAfter: string): Promise<void> {
  const transactionId = uuid();
  const external = `acme-tx-${transactionId.slice(-6)}`;

  await committing(runtime, async (session) => {
    await session.insert('wager_transactions', {
      id: transactionId,
      provider_id: 'provider-acme',
      external_transaction_id: external,
      idempotency_key: `provider-acme:${external}`,
      payload_hash: `sha256:${'5'.repeat(64)}`,
      wallet_id: wallet.id,
      player_id: wallet.playerId,
      round_id: 'round-7f3a',
      game_id: 'lucky-sevens',
      kind: 'BET',
      currency: 'BRL',
      amount,
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: balanceAfter,
      observed_balance_currency: 'BRL',
      reference_external_transaction_id: null,
      reference_transaction_id: null,
      processed_at: AT,
      created_at: AT,
    });
    await session.insert('wallet_ledger_entries', {
      id: uuid(),
      wallet_id: wallet.id,
      transaction_id: transactionId,
      kind: 'BET',
      direction: 'DEBIT',
      currency: 'BRL',
      amount,
      balance_before: wallet.balance.toString(),
      balance_after: balanceAfter,
      wallet_version: wallet.version + 1,
      created_at: AT,
    });
    await session.run(
      `update "wallets" set "balance" = ?, "version" = ?, "updated_at" = ? where "id" = ?`,
      [balanceAfter, wallet.version + 1, AT, wallet.id],
    );
  });
}

/**
 * Runs `body` with the commit-time mirror of `wallet.ledger-mirror` disabled, as the owner of the
 * table: the only way left to store a balance that does not match its ledger (SCHEMA-023). The
 * trigger is re-enabled whatever `body` does, so the next case faces the real schema.
 */
async function withoutTheLedgerMirror(body: () => Promise<unknown>): Promise<void> {
  await asMigrator(`alter table "wallets" disable trigger "wallets_mirror_ledger_head"`);
  try {
    await body();
  } finally {
    await asMigrator(`alter table "wallets" enable trigger "wallets_mirror_ledger_head"`);
  }
}

/** The stored balance moved away from the ledger, and nothing else about the wallet touched. */
async function givenStoredBalanceOf(wallet: Wallet, balance: string): Promise<void> {
  touched.forget(wallet.id);
  await withoutTheLedgerMirror(() =>
    asMigrator(`update "wallets" set "balance" = ? where "id" = ?`, [balance, wallet.id]),
  );
}

/** The stored version moved off its head entry, with the balance still summing correctly. */
async function givenStoredVersionOf(wallet: Wallet, version: number): Promise<void> {
  touched.forget(wallet.id);
  await withoutTheLedgerMirror(() =>
    asMigrator(`update "wallets" set "version" = ? where "id" = ?`, [version, wallet.id]),
  );
}

interface Exclusion {
  readonly relation: string;
  readonly constraint: string;
  readonly definition: string;
}

async function monetaryExclusions(): Promise<Exclusion[]> {
  const exclusions = await schema.em.getConnection().execute<Exclusion[]>(
    `select conrelid::regclass::text as "relation", conname as "constraint",
            pg_get_constraintdef(oid) as "definition"
       from pg_constraint
      where connamespace = 'public'::regnamespace
        and conname in (${BALANCE_CHANGE_FINITENESS.map(() => '?').join(', ')})`,
    BALANCE_CHANGE_FINITENESS,
  );

  expect(exclusions).toHaveLength(BALANCE_CHANGE_FINITENESS.length);

  return exclusions;
}

/**
 * Stores a `NaN` entry and a `NaN` balance for one wallet, runs `body` and puts the schema back:
 * the fixture RECON-005 needs. The exclusions go first because nothing else refuses the value —
 * `NaN` satisfies `amount > 0`, `balance >= 0`, the balanced arithmetic and both deferred triggers
 * at once, since `NaN = NaN` is true and `NaN` propagates through addition. They come back
 * `NOT VALID`, the only way to hold rows they refuse, and the `finally` restores them validated
 * over an empty table, the state the migration left and OPS-002 compares against.
 */
async function withANonFiniteWallet(wallet: Wallet, body: () => Promise<unknown>): Promise<void> {
  const exclusions = await monetaryExclusions();
  touched.forget(wallet.id);

  try {
    for (const { relation, constraint } of exclusions) {
      await asMigrator(`alter table "${relation}" drop constraint "${constraint}"`);
    }

    const transactionId = uuid();
    await committing(schema, async (session) => {
      await session.insert('wager_transactions', {
        id: transactionId,
        provider_id: 'provider-acme',
        external_transaction_id: 'acme-tx-nan',
        idempotency_key: 'provider-acme:acme-tx-nan',
        payload_hash: `sha256:${'6'.repeat(64)}`,
        wallet_id: wallet.id,
        player_id: wallet.playerId,
        round_id: 'round-nan',
        game_id: 'lucky-sevens',
        kind: 'WIN',
        currency: 'BRL',
        amount: '40.00',
        status: 'PROCESSED',
        failure_code: null,
        observed_balance: '540.00',
        observed_balance_currency: 'BRL',
        reference_external_transaction_id: null,
        reference_transaction_id: null,
        processed_at: AT,
        created_at: AT,
      });
      await session.insert('wallet_ledger_entries', {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: transactionId,
        kind: 'WIN',
        direction: 'CREDIT',
        currency: 'BRL',
        amount: 'NaN',
        balance_before: wallet.balance.toString(),
        balance_after: 'NaN',
        wallet_version: wallet.version + 1,
        created_at: AT,
      });
      await session.run(`update "wallets" set "balance" = 'NaN', "version" = ? where "id" = ?`, [
        wallet.version + 1,
        wallet.id,
      ]);
    });

    for (const { relation, constraint, definition } of exclusions) {
      await asMigrator(
        `alter table "${relation}" add constraint "${constraint}" ${definition} not valid`,
      );
    }

    await body();
  } finally {
    await asMigrator(`truncate table ${TABLES.join(', ')}`);
    for (const { relation, constraint, definition } of exclusions) {
      await asMigrator(`alter table "${relation}" drop constraint if exists "${constraint}"`);
      await asMigrator(`alter table "${relation}" add constraint "${constraint}" ${definition}`);
    }
  }
}

/**
 * The real unit of work with a competing writer committed between the two readings of one
 * reconciliation: the window `recon.snapshot` closes. Under `READ COMMITTED` the wallet row would
 * come from before that commit and the ledger sum from after it, and the report would invent a
 * divergence; under one `REPEATABLE READ` snapshot both readings are the state before it.
 */
function committingAfterTheWalletRead(
  over: UnitOfWork,
  writer: () => Promise<unknown>,
): UnitOfWork {
  return {
    transactional: (work) => over.transactional(work),
    snapshot: (work) =>
      over.snapshot((repositories) =>
        work({
          ...repositories,
          wallets: {
            insert: (wallet) => repositories.wallets.insert(wallet),
            findById: async (walletId) => {
              const wallet = await repositories.wallets.findById(walletId);
              await writer();

              return wallet;
            },
          },
        }),
      ),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function storedBalanceOf(walletId: string): Promise<string | undefined> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ balance: string }[]>(
      'select "balance"::text as balance from "wallets" where "id" = ?',
      [walletId],
    );

  return rows[0]?.balance;
}

/** The report as the members a caller reads, so one assertion covers every one of them. */
function serialized(report: ReconciliationReport): Record<string, unknown> {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    checkedAt: report.checkedAt.toISOString(),
  };
}

describe('reconciliation-calculation', () => {
  test('a wallet with a credit and a debit reports both entries, the ledger sum and no difference', async () => {
    const wallet = await open('500.00');
    await givenBetOf(wallet, '40.00', '460.00');

    const report = await reconcileWallet.execute(wallet.id);

    expect(Object.keys(report).sort()).toEqual(REPORT_MEMBERS);
    expect(serialized(report)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('460.00'),
      calculatedBalance: brl('460.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
      checkedAt: CHECKED_AT.toISOString(),
    });
  });

  test('a wallet with no entries reports zero entries and is consistent at 0.00', async () => {
    const wallet = await open('0.00');

    expect(serialized(await reconcileWallet.execute(wallet.id))).toMatchObject({
      storedBalance: brl('0.00'),
      calculatedBalance: brl('0.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('an unknown wallet is refused by the use case, not reported as an empty ledger', async () => {
    expect(await rejection(reconcileWallet.execute(UNKNOWN_WALLET_ID))).toMatchObject({
      code: 'WALLET_NOT_FOUND',
      walletId: UNKNOWN_WALLET_ID,
    });
    expect(logger.errors).toEqual([]);
    expect(metrics.total('wager_reconciliation_divergence_total')).toBe(0);
  });

  test('a consistent wallet is neither logged nor counted', async () => {
    const wallet = await open('500.00');

    expect((await reconcileWallet.execute(wallet.id)).consistent).toBe(true);
    expect(logger.errors).toEqual([]);
    expect(metrics.total('wager_reconciliation_divergence_total')).toBe(0);
  });
});

describe('reconciliation-snapshot-is-consistent', () => {
  test('a writer committing between the two readings changes neither of them and is never blocked', async () => {
    const wallet = await open('500.00');
    const reconcile = reconcilingOver(
      committingAfterTheWalletRead(unitOfWork, () => givenBetOf(wallet, '40.00', '460.00')),
    );

    const report = await reconcile.execute(wallet.id);

    expect(serialized(report)).toMatchObject({
      storedBalance: brl('500.00'),
      calculatedBalance: brl('500.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 1,
    });
    expect(await storedBalanceOf(wallet.id)).toBe('460.00');
    expect(logger.errors).toEqual([]);
  });

  test('the snapshot is read only, so no reconciliation can write even by mistake', async () => {
    const wallet = await open('500.00');

    const refusal = await rejection(
      unitOfWork.snapshot(async ({ wallets }) => {
        await wallets.findById(wallet.id);

        return wallets.insert(
          Wallet.open({
            id: uuid(),
            playerId: OTHER_PLAYER_ID,
            currency: 'BRL',
            openedAt: AT,
            openingCredit: null,
          }).wallet,
        );
      }),
    );

    expect((refusal as Error).message).toMatch(/read-only transaction/);
    expect(await storedBalanceOf(wallet.id)).toBe('500.00');
  });
});

describe('reconciliation-divergence', () => {
  test('a stored balance below the ledger is reported with the signed difference, logged and counted', async () => {
    const wallet = await open('500.00');
    await givenStoredBalanceOf(wallet, '460.00');

    const report = await reconcileWallet.execute(wallet.id);

    expect(serialized(report)).toMatchObject({
      storedBalance: brl('460.00'),
      calculatedBalance: brl('500.00'),
      difference: brl('-40.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.fields).toMatchObject({
      walletId: wallet.id,
      difference: '-40.00',
      checkedEntries: 1,
    });
    expect(metrics.total('wager_reconciliation_divergence_total')).toBe(1);
  });

  test('a stored balance above the ledger carries a positive difference', async () => {
    const wallet = await open('500.00');
    await givenStoredBalanceOf(wallet, '540.00');

    expect(serialized(await reconcileWallet.execute(wallet.id))).toMatchObject({
      difference: brl('40.00'),
      consistent: false,
    });
  });

  test('a balance that sums correctly but mirrors no head entry is still a divergence', async () => {
    const wallet = await open('500.00');
    await givenStoredVersionOf(wallet, 2);

    expect(serialized(await reconcileWallet.execute(wallet.id))).toMatchObject({
      storedBalance: brl('500.00'),
      calculatedBalance: brl('500.00'),
      difference: brl('0.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(metrics.total('wager_reconciliation_divergence_total')).toBe(1);
  });

  test('a divergence is reported again on every call and the balance is never corrected', async () => {
    const wallet = await open('500.00');
    await givenStoredBalanceOf(wallet, '460.00');

    const reports = [
      await reconcileWallet.execute(wallet.id),
      await reconcileWallet.execute(wallet.id),
    ];

    expect(reports.map((report) => report.difference.toString())).toEqual(['-40.00', '-40.00']);
    expect(metrics.total('wager_reconciliation_divergence_total')).toBe(2);
    expect(await storedBalanceOf(wallet.id)).toBe('460.00');
  });
});

describe('reconciliation-rejects-non-finite-data', () => {
  test('a wallet holding NaN is never reported consistent, is logged and is left untouched', async () => {
    const wallet = await open('500.00');

    await withANonFiniteWallet(wallet, async () => {
      const refusal = await rejection(reconcileWallet.execute(wallet.id));

      expect(refusal).toBeInstanceOf(MoneyValidationError);
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0]?.fields).toMatchObject({ walletId: wallet.id });
      expect(metrics.total('wager_reconciliation_divergence_total')).toBe(1);
      expect(await storedBalanceOf(wallet.id)).toBe('NaN');
    });
  });
});
