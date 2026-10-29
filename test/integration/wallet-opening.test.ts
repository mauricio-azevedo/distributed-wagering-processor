import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { WalletAlreadyExistsError } from '../../src/application/errors';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { GetWallet } from '../../src/application/use-cases/get-wallet';
import { Money } from '../../src/domain/money';
import type { Wallet } from '../../src/domain/wallet';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '0193f0c0-0000-7000-8000-000000000002';
const OTHER_PLAYER_ID = '0193f0c0-0000-7000-8000-00000000000a';
const UNKNOWN_WALLET_ID = '0193f0c0-0000-7000-8000-0000000000ff';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: UnitOfWork;
let openWallet: OpenWallet;
let getWallet: GetWallet;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
  openWallet = useCaseOver(unitOfWork);
  getWallet = new GetWallet(unitOfWork);
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it opened from the ledger. It runs before the next truncation, which is
// what makes the sweep see the rows the test committed.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

function useCaseOver(over: UnitOfWork): OpenWallet {
  return new OpenWallet({
    unitOfWork: over,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function open(
  initialBalance: { amount: string; currency: string },
  playerId = PLAYER_ID,
): Promise<Wallet> {
  const wallet = await openWallet.execute({
    playerId,
    initialBalance,
    correlationId: CORRELATION_ID,
  });
  touched.add(wallet.id);

  return wallet;
}

async function rowsOf<T>(table: string, walletId: string, column = 'wallet_id'): Promise<T[]> {
  return runtime.em
    .getConnection()
    .execute<T[]>(`select * from ${table} where ${column} = ?`, [walletId]);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/**
 * The real unit of work with a failure injected after the `OPENING` transaction is inserted: the
 * window WALLET-008 has to close, in which the wallet and the transaction are written and the entry
 * and the outbox rows are not. Only the database can prove it, because the statements have already
 * reached PostgreSQL when the failure is raised.
 */
function failingAfterTheTransactionInsert(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional((repositories) =>
        work({
          ...repositories,
          transactions: injectedFailureAfterInsert(repositories),
        }),
      ),
  };
}

function injectedFailureAfterInsert(repositories: Repositories): Repositories['transactions'] {
  return {
    ...repositories.transactions,
    insert: async (transaction) => {
      await repositories.transactions.insert(transaction);

      throw new Error('injected failure after the transaction insert');
    },
  };
}

interface TransactionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly round_id: string;
  readonly game_id: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly observed_balance: string;
  readonly processed_at: Date | null;
}

interface EntryRow {
  readonly transaction_id: string;
  readonly kind: string;
  readonly direction: string;
  readonly amount: string;
  readonly balance_before: string;
  readonly balance_after: string;
  readonly wallet_version: number;
  readonly currency: string;
}

interface OutboxRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly published_at: Date | null;
  readonly attempts: number;
}

interface WalletRowShape {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
}

describe('opening-credit-is-atomic', () => {
  test('a positive initial balance commits the wallet, the OPENING transaction, its entry and both events', async () => {
    const wallet = await open(brl('500.00'));

    const [walletRow] = await rowsOf<WalletRowShape>('wallets', wallet.id, 'id');
    expect(walletRow).toMatchObject({
      id: wallet.id,
      player_id: PLAYER_ID,
      currency: 'BRL',
      balance: '500.00',
      version: 1,
    });

    const [transaction] = await rowsOf<TransactionRow>('wager_transactions', wallet.id);
    expect(transaction).toMatchObject({
      provider_id: 'system',
      external_transaction_id: wallet.id,
      idempotency_key: `system:${wallet.id}`,
      round_id: wallet.id,
      game_id: 'wallet-opening',
      kind: 'OPENING',
      amount: '500.00',
      currency: 'BRL',
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '500.00',
    });
    expect(transaction?.payload_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(transaction?.processed_at).not.toBeNull();

    const [entry] = await rowsOf<EntryRow>('wallet_ledger_entries', wallet.id);
    expect(entry).toMatchObject({
      transaction_id: transaction?.id,
      kind: 'OPENING',
      direction: 'CREDIT',
      amount: '500.00',
      balance_before: '0.00',
      balance_after: '500.00',
      wallet_version: 1,
      currency: 'BRL',
    });

    const outbox = await rowsOf<OutboxRow>('outbox_messages', wallet.id, 'aggregate_id');
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(outbox.every((row) => row.published_at === null && row.attempts === 0)).toBe(true);
  });

  test('a failure after the transaction insert leaves no row in any table', async () => {
    const failing = useCaseOver(failingAfterTheTransactionInsert(unitOfWork));

    expect(
      await rejection(
        failing.execute({
          playerId: PLAYER_ID,
          initialBalance: brl('500.00'),
          correlationId: CORRELATION_ID,
        }),
      ),
    ).toMatchObject({ message: 'injected failure after the transaction insert' });

    for (const table of TABLES) {
      const [count] = await runtime.em
        .getConnection()
        .execute<{ count: string }[]>(`select count(*)::text as count from ${table}`);

      expect({ table, count: count?.count }).toEqual({ table, count: '0' });
    }
  });

  test('the opening credit is readable as the provider transaction of the reserved system provider', async () => {
    const wallet = await open(brl('500.00'));

    const [transaction] = await runtime.em.getConnection().execute<TransactionRow[]>(
      `select * from wager_transactions
          where provider_id = ? and external_transaction_id = ?`,
      ['system', wallet.id],
    );

    expect(transaction?.kind).toBe('OPENING');
  });
});

describe('zero-opening-writes-only-the-wallet', () => {
  test('an initial balance of 0.00 commits the wallet alone, at version 1', async () => {
    const wallet = await open(brl('0.00'));

    expect(wallet.balance.toJSON()).toEqual(brl('0.00'));
    expect(await rowsOf('wager_transactions', wallet.id)).toEqual([]);
    expect(await rowsOf('wallet_ledger_entries', wallet.id)).toEqual([]);
    expect(await rowsOf('outbox_messages', wallet.id, 'aggregate_id')).toEqual([]);

    const [walletRow] = await rowsOf<WalletRowShape>('wallets', wallet.id, 'id');
    expect(walletRow).toMatchObject({ balance: '0.00', version: 1 });
  });
});

describe('wallet-opens-at-version-one', () => {
  test('a funded and an unfunded wallet both report version 1, and only the funded one has an entry', async () => {
    const funded = await open(brl('500.00'));
    const unfunded = await open(brl('0.00'), OTHER_PLAYER_ID);

    expect([funded.version, unfunded.version]).toEqual([1, 1]);

    const entries = await rowsOf<EntryRow>('wallet_ledger_entries', funded.id);
    expect(entries.map((entry) => entry.wallet_version)).toEqual([1]);
    expect(await rowsOf('wallet_ledger_entries', unfunded.id)).toEqual([]);
  });
});

describe('one-wallet-per-player-and-currency', () => {
  test('a second opening for the same player and currency is a conflict and leaves the first untouched', async () => {
    const first = await open(brl('500.00'));

    const conflict = await rejection(
      openWallet.execute({
        playerId: PLAYER_ID,
        initialBalance: brl('10.00'),
        correlationId: CORRELATION_ID,
      }),
    );

    expect(conflict).toBeInstanceOf(WalletAlreadyExistsError);
    expect(conflict).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', playerId: PLAYER_ID });

    const wallets = await runtime.em
      .getConnection()
      .execute<WalletRowShape[]>('select * from wallets where player_id = ?', [PLAYER_ID]);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: first.id, balance: '500.00', version: 1 });
  });

  test('the same player may hold one wallet per currency', async () => {
    const brlWallet = await open(brl('500.00'));
    const usdWallet = await open({ amount: '500.00', currency: 'USD' });

    expect(brlWallet.currency).toBe('BRL');
    expect(usdWallet.currency).toBe('USD');
  });

  test('two instances opening the same wallet at once leave exactly one, the other told it exists', async () => {
    const command = JSON.stringify({
      playerId: PLAYER_ID,
      initialBalance: brl('500.00'),
      correlationId: CORRELATION_ID,
    });
    const attempt = () =>
      // process.execPath, because the runner's own Bun is not assumed to be on PATH.
      Bun.spawn([process.execPath, 'run', 'test/helpers/open-wallet.ts', command], {
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

    const [left, right] = [attempt(), attempt()];
    const outcomes = await Promise.all(
      [left, right].map(async (process) => ({
        exitCode: await process.exited,
        output: await new Response(process.stdout).text(),
      })),
    );

    const opened = outcomes.filter((outcome) => outcome.exitCode === 0);
    const refused = outcomes.filter((outcome) => outcome.exitCode !== 0);

    expect(opened).toHaveLength(1);
    expect(refused.map((outcome) => outcome.output)).toEqual(['WALLET_ALREADY_EXISTS']);

    const wallets = await runtime.em
      .getConnection()
      .execute<WalletRowShape[]>('select * from wallets where player_id = ?', [PLAYER_ID]);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.id).toBe(opened[0]?.output);
    touched.add(wallets[0]?.id ?? '');
  });
});

describe('wallet-balance-never-negative', () => {
  test('the aggregate refuses an uncovered debit and the schema refuses the same write', async () => {
    const wallet = await open(brl('100.00'));

    const outcome = wallet.debit({
      transactionId: UNKNOWN_WALLET_ID,
      entryId: UNKNOWN_WALLET_ID,
      playerId: PLAYER_ID,
      operation: { kind: 'BET' },
      money: Money.from('101.00', 'BRL'),
      occurredAt: new Date(),
    });

    expect(outcome).toEqual({ applied: false, failureCode: 'INSUFFICIENT_BALANCE' });

    const refusal = await rejection(
      runtime.em
        .getConnection()
        .execute('update wallets set balance = -1.00, version = 2 where id = ?', [wallet.id]),
    );
    expect((refusal as Error).message).toMatch(/wallets_balance_non_negative_check/);

    const [walletRow] = await rowsOf<WalletRowShape>('wallets', wallet.id, 'id');
    expect(walletRow).toMatchObject({ balance: '100.00', version: 1 });
  });
});

describe('get-wallet-reads-committed-state', () => {
  test('a wallet opened by the use case comes back with the state it committed', async () => {
    const opened = await open(brl('500.00'));

    const read = await getWallet.execute(opened.id);

    expect(read.id).toBe(opened.id);
    expect(read.playerId).toBe(PLAYER_ID);
    expect(read.balance.toJSON()).toEqual(brl('500.00'));
    expect(read.version).toBe(1);
    expect(read.createdAt).toEqual(opened.createdAt);
    expect(read.updatedAt).toEqual(opened.updatedAt);
  });

  test('an unknown id is refused by the use case, not answered with an empty wallet', async () => {
    expect(await rejection(getWallet.execute(UNKNOWN_WALLET_ID))).toMatchObject({
      code: 'WALLET_NOT_FOUND',
      walletId: UNKNOWN_WALLET_ID,
    });
  });
});
