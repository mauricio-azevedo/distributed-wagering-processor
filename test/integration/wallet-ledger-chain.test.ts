import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Money } from '../../src/domain/money';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * The half of ADR 0003 that no single row can decide: the wallet row mirrors the head of its
 * ledger and the ledger is one contiguous chain from `0.00` to that head (`wallet.ledger-mirror`,
 * `ledger.chain`, `ledger.wallet-version-sequence`). Both sides are written in the same
 * transaction, so both constraint triggers are `DEFERRABLE INITIALLY DEFERRED` and judge the state
 * of the whole transaction at commit.
 *
 * Every case here is direct SQL as `wagering_app`, the role the service runs with, because the
 * guarantee is what the database refuses whatever wrote it; the use cases that will write both
 * sides arrive in later slices (WALLET-004, TX-001). A refusal is asserted three ways: the message
 * naming the rows that disagree, SQLSTATE 23000, and the state the transaction left behind.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const uuid = (suffix: number): string =>
  `0193f0c0-0007-7000-8000-${suffix.toString(16).padStart(12, '0')}`;

const WALLET = uuid(1);
const OTHER_WALLET = uuid(2);
const PLAYER = uuid(3);
const OTHER_PLAYER = uuid(4);

const AT = new Date('2026-10-29T12:00:00.000Z');

/**
 * The three financial tables a case here writes, plus the schedule table: truncation has to cover
 * every table referencing the ones it empties, and `pending_reference_schedule` references
 * `wager_transactions`.
 */
const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'pending_reference_schedule',
];

type Column = string | number | Date | null;
type Row = Record<string, Column>;

/**
 * A transaction and a ledger entry need an identity of their own and nothing else from a case
 * here, so one counter mints both. It never resets: uniqueness across the whole suite costs
 * nothing and makes a leaked row traceable to the case that wrote it.
 */
let minted = 0;
const next = (): number => (minted += 1);

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

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await migrator.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

/** The writes of one case, issued inside a single database transaction. */
interface Session {
  run(statement: string, params?: Column[]): Promise<unknown>;
  all<T>(statement: string, params?: Column[]): Promise<T[]>;
  insert(table: string, row: Row): Promise<unknown>;
}

/**
 * Commits one transaction, so a deferred trigger judges the whole of it. The error of a refusal
 * comes from the commit, not from the statement that queued the check.
 */
function committing<T>(orm: MikroORM, body: (session: Session) => Promise<T>): Promise<T> {
  const connection = orm.em.getConnection();
  return connection.transactional((context) => {
    const run = (statement: string, params: Column[] = []): Promise<unknown> =>
      connection.execute(statement, params, 'run', context);
    return body({
      run,
      all: <T>(statement: string, params: Column[] = []): Promise<T[]> =>
        connection.execute<T[]>(statement, params, 'all', context),
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

interface Refusal {
  readonly message: string;
  /** The SQLSTATE the server raised: `23000` for a trigger of ADR 0003. */
  readonly sqlState: string | undefined;
}

/** The refusal of a transaction the database must not commit; a success here fails the test. */
async function refused(attempt: Promise<unknown>): Promise<Refusal> {
  try {
    await attempt;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      sqlState: sqlStateOf(error),
    };
  }
  throw new Error('expected the database to refuse the transaction at commit');
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
  balance: '0.00',
  version: 1,
  created_at: AT,
  updated_at: AT,
  ...overrides,
});

/** The transaction row a ledger entry points at; its identity is all a case here needs of it. */
async function transactionFor(
  session: Session,
  walletId: string,
  overrides: Row = {},
): Promise<string> {
  const sequence = next();
  const label = sequence.toString();
  const id = uuid(0x1000 + sequence);
  await session.insert('wager_transactions', {
    id,
    provider_id: 'provider-acme',
    external_transaction_id: `acme-tx-${label}`,
    idempotency_key: `provider-acme:acme-tx-${label}`,
    payload_hash: `sha256:${'5'.repeat(64)}`,
    wallet_id: walletId,
    player_id: walletId === WALLET ? PLAYER : OTHER_PLAYER,
    round_id: `round-${label}`,
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
  return id;
}

/** One balance change, as the wallet and the ledger each record it. */
interface Change {
  readonly walletId?: string;
  readonly direction?: 'CREDIT' | 'DEBIT';
  readonly amount: string;
  readonly before: string;
  readonly after: string;
  readonly version: number;
}

/** Appends the ledger half of a change. The wallet row is the caller's business, deliberately. */
async function appendEntry(session: Session, change: Change, overrides: Row = {}): Promise<string> {
  const walletId = change.walletId ?? WALLET;
  const direction = change.direction ?? 'DEBIT';
  const transactionId = await transactionFor(session, walletId, {
    kind: direction === 'CREDIT' ? 'WIN' : 'BET',
    amount: change.amount,
  });
  const id = uuid(0x2000 + next());
  await session.insert('wallet_ledger_entries', {
    id,
    wallet_id: walletId,
    transaction_id: transactionId,
    kind: direction === 'CREDIT' ? 'WIN' : 'BET',
    direction,
    currency: 'BRL',
    amount: change.amount,
    balance_before: change.before,
    balance_after: change.after,
    wallet_version: change.version,
    created_at: AT,
    ...overrides,
  });
  return id;
}

/** Moves the wallet row onto the state an entry recorded. */
function mirrorWallet(session: Session, change: Change): Promise<unknown> {
  return session.run('update wallets set balance = ?, version = ?, updated_at = ? where id = ?', [
    change.after,
    change.version,
    AT,
    change.walletId ?? WALLET,
  ]);
}

/** Both halves of one change, the shape every committed balance change has. */
async function applyChange(session: Session, change: Change): Promise<void> {
  await appendEntry(session, change);
  await mirrorWallet(session, change);
}

/**
 * A wallet as the opening of ADR 0006 leaves it: with a credit, the row and its version-1 entry;
 * with `0.00`, a row and no entry at all, the one state a wallet without a ledger may carry.
 */
function givenWalletOpenedWith(amount: string, wallet: Row = {}): Promise<void> {
  const walletId = typeof wallet['id'] === 'string' ? wallet['id'] : WALLET;
  return committing(app, async (session) => {
    await session.insert('wallets', walletRow({ ...wallet, balance: amount, version: 1 }));
    if (amount === '0.00') {
      return;
    }

    const transactionId = await transactionFor(session, walletId, {
      provider_id: 'system',
      kind: 'OPENING',
      amount,
      status: 'PROCESSED',
      processed_at: AT,
      observed_balance: amount,
      observed_balance_currency: 'BRL',
    });
    await session.insert('wallet_ledger_entries', {
      id: uuid(0x2000 + next()),
      wallet_id: walletId,
      transaction_id: transactionId,
      kind: 'OPENING',
      direction: 'CREDIT',
      currency: 'BRL',
      amount,
      balance_before: '0.00',
      balance_after: amount,
      wallet_version: 1,
      created_at: AT,
    });
  });
}

interface WalletState {
  readonly balance: string;
  readonly version: number;
  readonly entries: number;
}

async function walletState(walletId = WALLET): Promise<WalletState> {
  const rows = await app.em
    .getConnection()
    .execute<{ balance: string; version: number }[]>(
      `select balance, version from wallets where id = ?`,
      [walletId],
    );
  const entries = await app.em
    .getConnection()
    .execute<{ count: number }[]>(
      `select count(*)::int as count from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
  const wallet = rows[0];
  if (wallet === undefined) {
    throw new Error(`expected wallet ${walletId} to exist`);
  }

  return { balance: wallet.balance, version: wallet.version, entries: entries[0]?.count ?? 0 };
}

/**
 * WALLET-005: a balance change and its ledger entry are committed together or not at all, and the
 * check is deferred, so neither half has to be written first.
 */
describe('balance-and-ledger-move-together', () => {
  beforeEach(async () => {
    await givenWalletOpenedWith('100.00');
  });

  test('a balance change commits with its entry', async () => {
    await committing(app, (session) =>
      applyChange(session, { amount: '40.00', before: '100.00', after: '60.00', version: 2 }),
    );

    expect(await walletState()).toEqual({ balance: '60.00', version: 2, entries: 2 });
  });

  test('three balance changes commit in one transaction, mirrored by the last', async () => {
    await committing(app, async (session) => {
      await appendEntry(session, { amount: '40.00', before: '100.00', after: '60.00', version: 2 });
      await appendEntry(session, {
        direction: 'CREDIT',
        amount: '10.00',
        before: '60.00',
        after: '70.00',
        version: 3,
      });
      await appendEntry(session, { amount: '25.00', before: '70.00', after: '45.00', version: 4 });
      await mirrorWallet(session, { amount: '25.00', before: '70.00', after: '45.00', version: 4 });
    });

    expect(await walletState()).toEqual({ balance: '45.00', version: 4, entries: 4 });
  });

  test('the wallet row may be moved before its entry is appended', async () => {
    const change: Change = { amount: '40.00', before: '100.00', after: '60.00', version: 2 };

    await committing(app, async (session) => {
      await mirrorWallet(session, change);
      await appendEntry(session, change);
    });

    expect(await walletState()).toEqual({ balance: '60.00', version: 2, entries: 2 });
  });

  test('a balance change without its entry is refused at commit', async () => {
    const refusal = await refused(
      committing(app, (session) =>
        mirrorWallet(session, { amount: '40.00', before: '100.00', after: '60.00', version: 2 }),
      ),
    );

    expect(refusal.message).toMatch(/does not mirror the head of its ledger/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });

  /**
   * The point of deferring: the statement that breaks the invariant is accepted, and its own
   * transaction can read what it wrote, because only the state at commit decides. An immediate
   * check would refuse the legitimate order above instead.
   */
  test('the offending statement is accepted inside the transaction and refused at commit', async () => {
    let readBack: string | undefined;

    const refusal = await refused(
      committing(app, async (session) => {
        await mirrorWallet(session, {
          amount: '40.00',
          before: '100.00',
          after: '60.00',
          version: 2,
        });
        const rows = await session.all<{ balance: string }>(
          'select balance from wallets where id = ?',
          [WALLET],
        );
        readBack = rows[0]?.balance;
      }),
    );

    expect(readBack).toBe('60.00');
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });
});

/** SCHEMA-017: the wallet side of the mirror, on every inserted or updated wallet row. */
describe('schema-balance-matches-ledger-at-commit', () => {
  beforeEach(async () => {
    await givenWalletOpenedWith('100.00');
  });

  const WITHOUT_AN_ENTRY: readonly (readonly [string, string])[] = [
    ['balance and version', `update wallets set balance = '60.00', version = 2 where id = ?`],
    ['balance only', `update wallets set balance = '60.00' where id = ?`],
    ['version only', `update wallets set version = 2 where id = ?`],
  ];

  for (const [what, statement] of WITHOUT_AN_ENTRY) {
    test(`a wallet moved by ${what} and no entry is refused at commit`, async () => {
      const refusal = await refused(committing(app, (session) => session.run(statement, [WALLET])));

      expect(refusal.message).toMatch(/does not mirror the head of its ledger/);
      expect(refusal.sqlState).toBe('23000');
      expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
    });
  }

  test('a wallet created with a balance and no entry is refused at commit', async () => {
    const refusal = await refused(
      committing(app, (session) =>
        session.insert(
          'wallets',
          walletRow({ id: OTHER_WALLET, player_id: OTHER_PLAYER, balance: '100.00' }),
        ),
      ),
    );

    expect(refusal.message).toMatch(/has no ledger entry/);
    expect(refusal.sqlState).toBe('23000');
    expect(
      await app.em
        .getConnection()
        .execute<{ count: number }[]>('select count(*)::int as count from wallets'),
    ).toEqual([{ count: 1 }]);
  });

  test('a wallet created with no balance and no entry commits', async () => {
    await givenWalletOpenedWith('0.00', { id: OTHER_WALLET, player_id: OTHER_PLAYER });

    expect(await walletState(OTHER_WALLET)).toEqual({
      balance: '0.00',
      version: 1,
      entries: 0,
    });
  });

  /** The wallet row is re-read at commit, so the last state of several moves is the judged one. */
  test('a wallet moved twice in one transaction is judged on the state it ends in', async () => {
    await committing(app, async (session) => {
      await applyChange(session, { amount: '40.00', before: '100.00', after: '60.00', version: 2 });
      await applyChange(session, { amount: '20.00', before: '60.00', after: '40.00', version: 3 });
    });

    expect(await walletState()).toEqual({ balance: '40.00', version: 3, entries: 3 });
  });
});

/** SCHEMA-021: the ledger side of the mirror, on every appended entry that has no successor. */
describe('schema-entry-requires-mirroring-wallet', () => {
  test('a well-formed next entry alone is refused at commit', async () => {
    await givenWalletOpenedWith('100.00');

    const refusal = await refused(
      committing(app, (session) =>
        appendEntry(session, { amount: '40.00', before: '100.00', after: '60.00', version: 2 }),
      ),
    );

    expect(refusal.message).toMatch(/is the head of wallet/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });

  test('the first entry of a wallet opened with 0.00 is refused alone too', async () => {
    await givenWalletOpenedWith('0.00');

    const refusal = await refused(
      committing(app, (session) =>
        appendEntry(session, {
          direction: 'CREDIT',
          amount: '30.00',
          before: '0.00',
          after: '30.00',
          version: 2,
        }),
      ),
    );

    expect(refusal.message).toMatch(/is the head of wallet/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '0.00', version: 1, entries: 0 });
  });

  test('an entry whose wallet moved its balance but not its version is refused at commit', async () => {
    await givenWalletOpenedWith('100.00');

    const refusal = await refused(
      committing(app, async (session) => {
        await appendEntry(session, {
          amount: '40.00',
          before: '100.00',
          after: '60.00',
          version: 2,
        });
        await session.run(`update wallets set balance = '60.00' where id = ?`, [WALLET]);
      }),
    );

    expect(refusal.message).toMatch(/is the head of wallet|does not mirror the head of its ledger/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });
});

/** SCHEMA-022: no broken link, no gap, no entry squeezed between two others, no orphan. */
describe('schema-ledger-chain-continuous', () => {
  test("an entry whose balance_before differs from its predecessor's balance_after is refused", async () => {
    await givenWalletOpenedWith('100.00');

    const refusal = await refused(
      committing(app, (session) =>
        applyChange(session, { amount: '40.00', before: '90.00', after: '50.00', version: 2 }),
      ),
    );

    expect(refusal.message).toMatch(/does not continue/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });

  test('an entry leaving a version gap is refused, wallet row or not', async () => {
    await givenWalletOpenedWith('100.00');

    const refusal = await refused(
      committing(app, (session) =>
        applyChange(session, { amount: '40.00', before: '100.00', after: '60.00', version: 4 }),
      ),
    );

    expect(refusal.message).toMatch(/does not continue/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });

  test('a first entry at version 3 is refused: a ledger starts at 0.00 at version 1 or 2', async () => {
    await givenWalletOpenedWith('0.00');

    const refusal = await refused(
      committing(app, (session) =>
        applyChange(session, {
          direction: 'CREDIT',
          amount: '30.00',
          before: '0.00',
          after: '30.00',
          version: 3,
        }),
      ),
    );

    expect(refusal.message).toMatch(/is the first entry of wallet/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '0.00', version: 1, entries: 0 });
  });

  test('a first entry whose balance_before is not 0.00 is refused', async () => {
    await givenWalletOpenedWith('0.00');

    const refusal = await refused(
      committing(app, (session) =>
        applyChange(session, {
          direction: 'CREDIT',
          amount: '30.00',
          before: '10.00',
          after: '40.00',
          version: 2,
        }),
      ),
    );

    expect(refusal.message).toMatch(/is the first entry of wallet/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '0.00', version: 1, entries: 0 });
  });

  /**
   * The version-1 gap a wallet opened with `0.00` leaves: its first entry carries version 2, and
   * nothing may be slipped underneath it afterwards. The successor link is what refuses it, so the
   * wallet row is left alone here; moving it would be refused by the head of the chain instead.
   */
  test('an entry squeezed under an existing head is refused', async () => {
    await givenWalletOpenedWith('0.00');
    await committing(app, (session) =>
      applyChange(session, {
        direction: 'CREDIT',
        amount: '30.00',
        before: '0.00',
        after: '30.00',
        version: 2,
      }),
    );

    const refusal = await refused(
      committing(app, (session) =>
        appendEntry(session, {
          direction: 'CREDIT',
          amount: '5.00',
          before: '0.00',
          after: '5.00',
          version: 1,
        }),
      ),
    );

    expect(refusal.message).toMatch(/is not continued by/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '30.00', version: 2, entries: 1 });
  });

  test('an orphan entry on a wallet with no entries is refused', async () => {
    await givenWalletOpenedWith('0.00');

    const refusal = await refused(
      committing(app, (session) =>
        appendEntry(session, {
          direction: 'CREDIT',
          amount: '30.00',
          before: '0.00',
          after: '30.00',
          version: 1,
        }),
      ),
    );

    expect(refusal.message).toMatch(/is the head of wallet/);
    expect(refusal.sqlState).toBe('23000');
    expect(await walletState()).toEqual({ balance: '0.00', version: 1, entries: 0 });
  });
});

/**
 * SCHEMA-023: whatever sequence of direct-SQL transactions the database accepted, the stored
 * balance, the ledger sum and the ledger head agree. The sequence is generated, so it is not the
 * cases above rewritten; the generator is seeded, so a failure is reproducible.
 */
describe('schema-balance-equals-ledger-sum', () => {
  const SEED = 0x5eed7;
  const BOUND = Money.bound('BRL');

  /**
   * A 32-bit xorshift: enough randomness for a sequence of operations, no dependency, and every
   * step exactly representable, so the seed above reproduces a failure anywhere.
   */
  function randomness(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x100000000;
    };
  }

  interface Ledger {
    readonly walletId: string;
    balance: Money;
    version: number;
    entries: number;
  }

  test('balance, ledger sum and ledger head agree after a generated sequence', async () => {
    const random = randomness(SEED);
    await givenWalletOpenedWith('100.00');
    await givenWalletOpenedWith('0.00', { id: OTHER_WALLET, player_id: OTHER_PLAYER });
    const ledgers: Ledger[] = [
      { walletId: WALLET, balance: Money.from('100.00', 'BRL'), version: 1, entries: 1 },
      { walletId: OTHER_WALLET, balance: Money.zero('BRL'), version: 1, entries: 0 },
    ];
    // A wallet with no entries has to stay in the sequence: balance 0.00 and version 1 is the one
    // state the mirror admits without a ledger, and the generator must not be able to leave it.
    const untouched: Ledger = {
      walletId: uuid(5),
      balance: Money.zero('BRL'),
      version: 1,
      entries: 0,
    };
    await givenWalletOpenedWith('0.00', { id: untouched.walletId, player_id: uuid(6) });

    for (let round = 0; round < 12; round += 1) {
      const picked = ledgers[Math.floor(random() * ledgers.length)];
      if (picked === undefined) {
        throw new Error('the generator picked a wallet that is not in the sequence');
      }
      const ledger = picked;
      const changes = 1 + Math.floor(random() * 3);

      await committing(app, async (session) => {
        let last: Change | undefined;
        for (let step = 0; step < changes; step += 1) {
          const cents = Math.floor(random() * 100)
            .toString()
            .padStart(2, '0');
          const units = (1 + Math.floor(random() * 50)).toString();
          const amount = Money.from(`${units}.${cents}`, 'BRL');
          const credit = random() < 0.5 || ledger.balance.isLessThan(amount);
          const after = credit ? ledger.balance.add(amount) : ledger.balance.subtract(amount);
          if (credit && BOUND.isLessThan(after)) {
            continue;
          }

          last = {
            walletId: ledger.walletId,
            direction: credit ? 'CREDIT' : 'DEBIT',
            amount: amount.toString(),
            before: ledger.balance.toString(),
            after: after.toString(),
            // the next version either way: a wallet opened with 0.00 carries version 1 with no
            // entry, so its first entry is the version 2 the chain admits as a first one
            version: ledger.version + 1,
          };
          await appendEntry(session, last);
          ledger.balance = after;
          ledger.version = last.version;
          ledger.entries += 1;
        }
        if (last !== undefined) {
          await mirrorWallet(session, last);
        }
      });

      // Interleaved refusals: whatever the generator just committed, these still cannot commit.
      await refused(
        committing(app, (session) =>
          session.run(`update wallets set balance = balance + 1 where id = ?`, [ledger.walletId]),
        ),
      );
      await refused(
        committing(app, (session) =>
          appendEntry(session, {
            walletId: ledger.walletId,
            direction: 'CREDIT',
            amount: '1.00',
            before: ledger.balance.toString(),
            after: ledger.balance.add(Money.from('1.00', 'BRL')).toString(),
            version: ledger.version + 1,
          }),
        ),
      );
    }

    const rows = await app.em.getConnection().execute<
      {
        id: string;
        balance: string;
        version: number;
        entries: number;
        ledger_sum: string;
        head_balance: string | null;
        head_version: number | null;
      }[]
    >(
      `select w."id", w."balance", w."version",
              (select count(*)::int from wallet_ledger_entries e where e."wallet_id" = w."id")
                as entries,
              (select coalesce(sum(case when e."direction" = 'CREDIT' then e."amount"
                                        else -e."amount" end), 0)::numeric(20,2)::text
                 from wallet_ledger_entries e where e."wallet_id" = w."id") as ledger_sum,
              head."balance_after"::text as head_balance, head."wallet_version" as head_version
         from wallets w
         left join lateral (select e."balance_after", e."wallet_version"
                              from wallet_ledger_entries e
                             where e."wallet_id" = w."id"
                             order by e."wallet_version" desc
                             limit 1) head on true
        order by w."id"`,
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const expected = [...ledgers, untouched].find((ledger) => ledger.walletId === row.id);
      if (expected === undefined) {
        throw new Error(`the database holds a wallet the sequence never opened: ${row.id}`);
      }

      expect(row.balance).toBe(expected.balance.toString());
      expect(row.ledger_sum).toBe(row.balance);
      expect(row.entries).toBe(expected.entries);
      if (row.entries === 0) {
        expect(row.balance).toBe('0.00');
        expect(row.version).toBe(1);
        expect(row.head_balance).toBeNull();
      } else {
        expect(row.head_balance).toBe(row.balance);
        expect(row.head_version).toBe(row.version);
      }
    }
    // The generator has to have exercised more than the opening of each wallet.
    expect(rows.reduce((total, row) => total + row.entries, 0)).toBeGreaterThan(12);
  });
});
