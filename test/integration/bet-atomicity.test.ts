import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { ServiceUnavailableError } from '../../src/application/errors';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import {
  SubmitWagerTransaction,
  type SubmittedWagerOperation,
} from '../../src/application/use-cases/submit-wager-transaction';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { silentLogger } from '../../src/infrastructure/observability/logger';
import { uncountedMetrics } from '../../src/infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * The atomicity of one financial operation and the recovery from a commit whose outcome the service
 * never learned (OUTBOX-001, API-006, API-013).
 *
 * The failures are injected into the unit of work rather than into the database, because what has to
 * be proven is where the boundary is: a failure inside the transaction leaves nothing, and a failure
 * after the commit returned leaves everything, and no amount of stopping a container reproduces the
 * second case on purpose. The suite drives the use case directly for the same reason — what the
 * caller is answered is `503` either way, which the lock-timeout case of `bet-submission.test.ts`
 * proves over HTTP, and what differs is what the database holds afterwards.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/**
 * The transient failure an injection stands for. The service answers `503` for a dropped connection
 * whichever side of the commit it happened on (`api.transient-failure`); the classification of a
 * driver error into this refusal is covered by `transient-failure.test.ts`.
 */
const DROPPED = () =>
  new ServiceUnavailableError(
    'The service could not reach the database to complete the operation.',
    5,
  );

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: UnitOfWork;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em, env.LOCK_TIMEOUT_MS);
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): every case here moves money or tries to, so each one ends by
// rebuilding the balance of the wallet it touched from its ledger.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function submitOver(over: UnitOfWork): SubmitWagerTransaction {
  return new SubmitWagerTransaction({
    unitOfWork: over,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
    logger: silentLogger,
    metrics: uncountedMetrics,
  });
}

async function openWallet(initialBalance: string): Promise<string> {
  const wallet = await new OpenWallet({
    unitOfWork,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  }).execute({
    playerId: PLAYER_ID,
    initialBalance: brl(initialBalance),
    correlationId: CORRELATION_ID,
  });

  return touched.add(wallet.id);
}

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
function bet(walletId: string): SubmittedWagerOperation {
  return {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl('40.00'),
  };
}

const submission = (walletId: string) => ({
  operation: bet(walletId),
  idempotencyKey: 'provider-acme:acme-tx-000123',
  correlationId: CORRELATION_ID,
});

/** The real transaction, failed after the ledger entry was inserted and before the events were. */
function failingAfterTheLedgerInsert(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional((repositories) => work(failingAfterInsert(repositories, 'ledger'))),
  };
}

/** The real transaction, failed after the first event was enqueued. */
function failingAfterTheFirstEvent(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional((repositories) => work(failingAfterInsert(repositories, 'outbox'))),
  };
}

function failingAfterInsert(repositories: Repositories, port: 'ledger' | 'outbox'): Repositories {
  if (port === 'ledger') {
    return {
      ...repositories,
      ledger: {
        ...repositories.ledger,
        insert: async (entry) => {
          await repositories.ledger.insert(entry);

          throw DROPPED();
        },
      },
    };
  }

  return {
    ...repositories,
    outbox: {
      ...repositories.outbox,
      insert: async (message) => {
        await repositories.outbox.insert(message);

        throw DROPPED();
      },
    },
  };
}

/**
 * The real transaction, failed at its last statement: everything the operation writes is written and
 * none of it commits. This is the transient failure the service knows happened before the commit
 * (`api.transient-failure`).
 */
function failingBeforeTheCommit(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional(async (repositories) => {
        await work(repositories);

        throw DROPPED();
      }),
  };
}

/**
 * The real transaction, committed, with the failure arriving after the database confirmed it: the
 * unknown commit outcome of `api.indeterminate-commit`. The caller is answered `503` and cannot tell
 * this case from the one above.
 */
function failingAfterTheCommit(over: UnitOfWork): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: async (work) => {
      await over.transactional(work);

      throw DROPPED();
    },
  };
}

interface Counts {
  readonly transactions: string;
  readonly entries: string;
  readonly events: string;
}

const sql = <T>(query: string, params: unknown[] = []): Promise<T[]> =>
  runtime.em.getConnection().execute<T[]>(query, params);

async function rowsOf(walletId: string): Promise<Counts & { wallet: string }> {
  const [counts] = await sql<Counts>(
    `select (select count(*)::text from "wager_transactions" where "wallet_id" = ?) as "transactions",
            (select count(*)::text from "wallet_ledger_entries" where "wallet_id" = ?) as "entries",
            (select count(*)::text from "outbox_messages" where "aggregate_id" = ?) as "events"`,
    [walletId, walletId, walletId],
  );
  const [wallet] = await sql<{ state: string }>(
    `select "balance"::text || ' at version ' || "version"::text as "state"
       from "wallets" where "id" = ?`,
    [walletId],
  );

  if (counts === undefined || wallet === undefined) {
    throw new Error(`wallet ${walletId} does not exist`);
  }

  return { ...counts, wallet: wallet.state };
}

const eventIds = async (walletId: string): Promise<string[]> =>
  (
    await sql<{ event_id: string }>(
      'select "event_id" from "outbox_messages" where "aggregate_id" = ? order by "event_id"',
      [walletId],
    )
  ).map((row) => row.event_id);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** What the wallet holds after its opening credit alone: one transaction, one entry, two events. */
const OPENED = { transactions: '1', entries: '1', events: '2' };

describe('financial-write-is-atomic', () => {
  test('a failure after the ledger insert leaves no row of the operation anywhere', async () => {
    const walletId = await openWallet('500.00');

    const failure = await rejection(
      submitOver(failingAfterTheLedgerInsert(unitOfWork)).execute(submission(walletId)),
    );

    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(await rowsOf(walletId)).toEqual({ ...OPENED, wallet: '500.00 at version 1' });
  });

  test('a failure after the first event is enqueued leaves no row of the operation anywhere', async () => {
    const walletId = await openWallet('500.00');

    const failure = await rejection(
      submitOver(failingAfterTheFirstEvent(unitOfWork)).execute(submission(walletId)),
    );

    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(await rowsOf(walletId)).toEqual({ ...OPENED, wallet: '500.00 at version 1' });
  });
});

describe('unknown-commit-outcome-takes-effect-once', () => {
  test('a failure after the commit is recovered by the resend, which replays the stored outcome', async () => {
    const walletId = await openWallet('500.00');

    const failure = await rejection(
      submitOver(failingAfterTheCommit(unitOfWork)).execute(submission(walletId)),
    );
    expect(failure).toBeInstanceOf(ServiceUnavailableError);

    // The effect committed: the caller does not know it, and the database does.
    const committed = await rowsOf(walletId);
    const committedEvents = await eventIds(walletId);
    expect(committed).toEqual({
      transactions: '2',
      entries: '2',
      events: '4',
      wallet: '460.00 at version 2',
    });

    const resend = await submitOver(unitOfWork).execute(submission(walletId));

    expect(resend.idempotentReplay).toBe(true);
    expect(resend.transaction.status).toBe('PROCESSED');
    expect(resend.transaction.observedBalance?.toJSON()).toEqual(brl('460.00'));
    expect(await rowsOf(walletId)).toEqual(committed);
    expect(await eventIds(walletId)).toEqual(committedEvents);
  });

  test('the replayed outcome keeps the balance it observed after the wallet moves again', async () => {
    const walletId = await openWallet('500.00');
    await rejection(submitOver(failingAfterTheCommit(unitOfWork)).execute(submission(walletId)));

    await submitOver(unitOfWork).execute({
      operation: { ...bet(walletId), externalTransactionId: 'acme-tx-000124', money: brl('60.00') },
      idempotencyKey: 'provider-acme:acme-tx-000124',
      correlationId: CORRELATION_ID,
    });

    const resend = await submitOver(unitOfWork).execute(submission(walletId));

    expect(resend.idempotentReplay).toBe(true);
    expect(resend.transaction.observedBalance?.toJSON()).toEqual(brl('460.00'));
    expect((await rowsOf(walletId)).wallet).toBe('400.00 at version 3');
  });

  test('the same failure before the commit persists nothing, so the resend is a new operation', async () => {
    const walletId = await openWallet('500.00');

    const failure = await rejection(
      submitOver(failingBeforeTheCommit(unitOfWork)).execute(submission(walletId)),
    );
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(await rowsOf(walletId)).toEqual({ ...OPENED, wallet: '500.00 at version 1' });

    const resend = await submitOver(unitOfWork).execute(submission(walletId));

    expect(resend.idempotentReplay).toBe(false);
    expect(resend.transaction.status).toBe('PROCESSED');
    expect(await rowsOf(walletId)).toEqual({
      transactions: '2',
      entries: '2',
      events: '4',
      wallet: '460.00 at version 2',
    });
  });
});
