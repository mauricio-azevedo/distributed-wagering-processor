import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { payloadHashOf } from '../../src/domain/idempotency';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * The two guarantees of ADR 0002 that are about one database transaction rather than about a load:
 * the version guard behind the lock (CONC-003), and the lock mode that makes the fixed order of
 * `conc.lock-order` deadlock-free (CONC-009).
 *
 * Both need the statements of a financial operation issued by hand from two sessions, interleaved
 * at a point the use case never exposes — between the reservation and the wallet lock — so this
 * suite drives the repositories inside transactions it begins and commits itself. What it drives
 * is the production statements: the reservation insert with its foreign key, the repository's own
 * lock statement, the guarded update and the real aggregate's arithmetic. The one hand-written
 * statement is the control's `FOR UPDATE`, which exists to show what the mode under test avoids.
 *
 * `conc.row-lock` under load, the canonical scenario and the duplicate storm are
 * `test/concurrency/wallet-contention.test.ts`; the check constraint that refuses a negative
 * balance whatever the code does is SCHEMA-002 in `schema.test.ts`.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

/**
 * Well above any wait a case here produces, because none of them is about the ceiling: the real arm
 * queues one session behind another's commit and must not give up, and the control has to reach
 * PostgreSQL's deadlock detector, which runs a second after a wait begins. The ceiling itself is
 * CONC-002, proven over HTTP in `bet-submission.test.ts` and on the queue in
 * `queue-submission.test.ts`.
 */
const LOCK_CEILING_MS = 10_000;

/** The acceptance scenario's repetition: ten pairs, so one lucky ordering cannot pass for a rule. */
const PAIRS = 10;

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
let unitOfWork: MikroOrmUnitOfWork;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em, LOCK_CEILING_MS);
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): every case here moves money, so each one ends by rebuilding
// the balance of the wallet it touched from its ledger.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

const brl = (amount: string): Money => Money.from(amount, 'BRL');

async function openWallet(initialBalance: string): Promise<string> {
  const wallet = await new OpenWallet({
    unitOfWork,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  }).execute({
    playerId: PLAYER_ID,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
    correlationId: CORRELATION_ID,
  });

  return touched.add(wallet.id);
}

/** One `BET` of `amount` on `walletId`, with an identity of its own (`idem.provider-scoped`). */
function bet(walletId: string, amount: string): WagerTransaction {
  const operation = {
    providerId: 'provider-acme',
    externalTransactionId: `acme-tx-${uuidV7IdGenerator.next()}`,
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET' as const,
    money: { amount, currency: 'BRL' },
  };

  return WagerTransaction.create({
    id: uuidV7IdGenerator.next(),
    ...operation,
    idempotencyKey: operation.externalTransactionId,
    payloadHash: payloadHashOf(operation, sha256Hex),
    money: brl(amount),
    referenceExternalTransactionId: null,
    createdAt: systemClock.now(),
  });
}

/** The lock mode a session takes the wallet with: the repository's, or the control's. */
type LockMode = 'repository' | 'for update';

/**
 * One financial transaction, opened and driven statement by statement. It is the body of
 * `SubmitWagerTransaction.apply` with the steps exposed, so two of them can be interleaved: the
 * reservation of one can be made to commit after the other has already asked for the lock, which
 * is the ordering the deadlock of `FOR UPDATE` needs and the one no entry point can produce.
 */
class FinancialSession {
  private readonly em: EntityManager;

  constructor(orm: MikroORM) {
    this.em = orm.em.fork({ clear: true });
  }

  /** `SET LOCAL lock_timeout`, as the unit of work opens every financial transaction with. */
  async open(): Promise<void> {
    await this.em.begin();
    await this.em.execute(`set local lock_timeout = ${LOCK_CEILING_MS.toString()}`);
  }

  /** Step 1 of `conc.lock-order`: the insert whose foreign key holds `FOR KEY SHARE` on the wallet. */
  async reserve(submission: WagerTransaction): Promise<void> {
    const reservation = await new MikroOrmWagerTransactionRepository(this.em).reserve(submission);

    if (!reservation.reserved) {
      throw new Error(`the submission ${submission.id} was already reserved`);
    }
  }

  /**
   * Step 2: the wallet lock. `repository` is the production statement, read off the repository
   * itself so the mode under test cannot drift from the one the service uses; `for update` is the
   * control of CONC-009, the mode ADR 0002 rejected, issued here and nowhere in `src`.
   */
  async lock(walletId: string, mode: LockMode): Promise<Wallet> {
    const wallets = new MikroOrmWalletRepository(this.em);

    if (mode === 'repository') {
      const wallet = await wallets.lockById(walletId);

      if (wallet === null) {
        throw new Error(`no wallet has the id ${walletId}`);
      }

      return wallet;
    }

    await this.em.execute('select "id" from "wallets" where "id" = ? for update', [walletId]);
    const wallet = await wallets.findById(walletId);

    if (wallet === null) {
      throw new Error(`no wallet has the id ${walletId}`);
    }

    return wallet;
  }

  /** The wallet read without locking it, which is the bypass `conc.version-guard` exists to catch. */
  async read(walletId: string): Promise<Wallet> {
    const wallet = await new MikroOrmWalletRepository(this.em).findById(walletId);

    if (wallet === null) {
      throw new Error(`no wallet has the id ${walletId}`);
    }

    return wallet;
  }

  /** Steps 3 and 4: the aggregate's debit, the guarded update and the entry that mirrors it. */
  async debit(wallet: Wallet, submission: WagerTransaction): Promise<void> {
    const occurredAt = systemClock.now();
    const outcome = wallet.debit({
      transactionId: submission.id,
      entryId: uuidV7IdGenerator.next(),
      playerId: submission.playerId,
      money: submission.money,
      occurredAt,
      operation: { kind: 'BET' },
    });

    if (!outcome.applied) {
      throw new Error(`the debit was refused with ${outcome.failureCode}`);
    }

    submission.markProcessed({
      observedBalance: outcome.entry.balanceAfter,
      processedAt: occurredAt,
    });
    await new MikroOrmWagerTransactionRepository(this.em).recordOutcome(submission);
    await new MikroOrmWalletRepository(this.em).update(outcome.wallet, wallet.version);
    await new MikroOrmLedgerRepository(this.em).insert(outcome.entry);
  }

  /** The guarded update alone, against a version the caller chooses (`conc.version-guard`). */
  async updateAt(wallet: Wallet, expectedVersion: number): Promise<void> {
    const outcome = wallet.debit({
      transactionId: uuidV7IdGenerator.next(),
      entryId: uuidV7IdGenerator.next(),
      playerId: PLAYER_ID,
      money: brl('1.00'),
      occurredAt: systemClock.now(),
      operation: { kind: 'BET' },
    });

    if (!outcome.applied) {
      throw new Error(`the debit was refused with ${outcome.failureCode}`);
    }

    await new MikroOrmWalletRepository(this.em).update(outcome.wallet, expectedVersion);
  }

  async commit(): Promise<void> {
    await this.em.commit();
  }

  async rollback(): Promise<void> {
    await this.em.rollback();
  }
}

/** The wallet row as the suite reads it, by the migrator, outside every transaction under test. */
async function walletRow(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await schema.em
    .getConnection()
    .execute<{ balance: string; version: number }[]>(
      'select "balance"::text as "balance", "version" from "wallets" where "id" = ?',
      [walletId],
    );

  if (row === undefined) {
    throw new Error(`no wallet has the id ${walletId}`);
  }

  return row;
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = await schema.em
    .getConnection()
    .execute<{ entries: string }[]>(
      'select count(*)::text as "entries" from "wallet_ledger_entries" where "wallet_id" = ?',
      [walletId],
    );

  return Number(row?.entries ?? '0');
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

/** The SQLSTATE an error carries, following `cause` as the driver wraps it. */
function sqlStateOf(error: unknown): string | null {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };

    if (typeof code === 'string') {
      return code;
    }

    current = cause;
  }

  return null;
}

/**
 * `conc.version-guard` (CONC-003): the second line of defence behind the lock. The check constraint
 * that is the third — `CHECK (balance >= 0)`, which refuses a negative balance whatever the code
 * does — is SCHEMA-002.
 */
describe('version-guard-and-check', () => {
  test('an update against a version the row no longer carries matches no row and is raised', async () => {
    const walletId = await openWallet('100.00');
    const session = new FinancialSession(runtime);
    await session.open();

    const wallet = await session.lock(walletId, 'repository');
    const stale = wallet.version + 1;

    expect(await rejection(session.updateAt(wallet, stale))).toContain(
      `matched no row at version ${stale.toString()}`,
    );

    await session.rollback();
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
  });

  /**
   * The guard doing the work it exists for, rather than a simulation of it: two writers that both
   * read the wallet and never locked it. Only one of their updates can match the row, and the
   * other's balance — computed against a state that has since moved — is refused instead of
   * overwriting it. This is the lost update that `conc.no-unguarded-rmw` forbids by construction,
   * demonstrated against the one defence that would still catch it.
   */
  test('two writers that skipped the lock cannot both commit: one update matches no row', async () => {
    const walletId = await openWallet('100.00');
    const winner = new FinancialSession(runtime);
    const loser = new FinancialSession(runtime);
    const winning = bet(walletId, '30.00');
    const losing = bet(walletId, '30.00');

    // Both reserve and then read the wallet at version 1 without locking it: the bypass under test.
    await winner.open();
    await winner.reserve(winning);
    await loser.open();
    await loser.reserve(losing);

    const readByWinner = await winner.read(walletId);
    const readByLoser = await loser.read(walletId);

    expect([readByWinner.version, readByLoser.version]).toEqual([1, 1]);

    await winner.debit(readByWinner, winning);
    await winner.commit();

    expect(await rejection(loser.debit(readByLoser, losing))).toContain(
      'matched no row at version 1',
    );
    await loser.rollback();

    expect(await walletRow(walletId)).toEqual({ balance: '70.00', version: 2 });
    expect(await ledgerCount(walletId)).toBe(2); // the opening credit and the one debit
  });
});

/**
 * `conc.lock-order` and the lock mode behind it (CONC-008, CONC-009): the reservation that precedes
 * the wallet lock holds `FOR KEY SHARE` on the wallet row through its foreign key, so the mode the
 * lock then asks for decides whether two submissions queue or deadlock.
 */
describe('reservation-then-lock-no-deadlock', () => {
  /**
   * One pair of submissions on one wallet, interleaved as only two sessions can be: both reserve,
   * and only then does either ask for the lock. Returns what each session ended as — the version it
   * saw under the lock, or the SQLSTATE that aborted it.
   */
  async function pair(
    walletId: string,
    mode: LockMode,
  ): Promise<{ versions: number[]; failures: (string | null)[] }> {
    const submitting = [
      { session: new FinancialSession(runtime), submission: bet(walletId, '1.00') },
      { session: new FinancialSession(runtime), submission: bet(walletId, '1.00') },
    ];

    for (const { session, submission } of submitting) {
      await session.open();
      await session.reserve(submission);
    }

    // Both ask for the lock while both reservations are uncommitted, which is the state that
    // decides the question: `FOR KEY SHARE` is held twice, and `FOR UPDATE` conflicts with it.
    const attempts = submitting.map(async ({ session, submission }) => {
      try {
        return { session, submission, wallet: await session.lock(walletId, mode) };
      } catch (error) {
        return { session, submission, failure: sqlStateOf(error) ?? String(error) };
      }
    });

    const versions: number[] = [];
    const failures: (string | null)[] = [];

    const finish = async (settled: Awaited<(typeof attempts)[number]>): Promise<void> => {
      if ('wallet' in settled) {
        versions.push(settled.wallet.version);
        await settled.session.debit(settled.wallet, settled.submission);

        return settled.session.commit();
      }

      failures.push(settled.failure);

      return settled.session.rollback();
    };

    // The first to settle either took the lock or was aborted by the server, and it has to finish
    // before the other can: with the repository's mode the second is queued behind this commit, and
    // in the control the survivor is waiting on the lock the aborted one released. Awaiting both at
    // once would therefore hang rather than race.
    const first = await Promise.race(attempts);
    await finish(first);

    for (const settled of await Promise.all(attempts)) {
      if (settled.session !== first.session) {
        await finish(settled);
      }
    }

    return { versions, failures };
  }

  test("the repository's lock queues: ten pairs serialize with consecutive versions and no error", async () => {
    const walletId = await openWallet('100.00');

    for (let round = 0; round < PAIRS; round += 1) {
      const { versions, failures } = await pair(walletId, 'repository');

      expect(failures).toEqual([]);
      expect(versions).toEqual([round * 2 + 1, round * 2 + 2]);
    }

    expect(await walletRow(walletId)).toEqual({
      balance: (100 - PAIRS * 2).toFixed(2),
      version: PAIRS * 2 + 1,
    });
  }, 120_000);

  test('the control, FOR UPDATE, deadlocks in every pair: the mode ADR 0002 rejected', async () => {
    const walletId = await openWallet('100.00');

    for (let round = 0; round < PAIRS; round += 1) {
      const { versions, failures } = await pair(walletId, 'for update');

      // One of the two is aborted with `deadlock_detected`, and the survivor applies its debit,
      // so the wallet advances by one version per pair instead of two.
      expect(failures).toEqual(['40P01']);
      expect(versions).toEqual([round + 1]);
    }

    expect(await walletRow(walletId)).toEqual({
      balance: (100 - PAIRS).toFixed(2),
      version: PAIRS + 1,
    });
  }, 120_000);
});
