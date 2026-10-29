import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import type { Reservation } from '../../src/application/ports/repositories';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import {
  type SubmittedOperation,
  classifyReservationConflict,
  payloadHashOf,
  recommendedIdempotencyKey,
} from '../../src/domain/idempotency';
import { Money } from '../../src/domain/money';
import { type NewWagerTransaction, WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const ROOT = path.resolve(import.meta.dirname, '../..');
const RESERVE_IN_A_PROCESS = path.join(ROOT, 'test', 'helpers', 'reserve-transaction.ts');

const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');
const SUBMITTED_AT = new Date('2026-10-28T12:05:00.000Z');

/** One service id per arrival: a duplicate of an operation is still a new request. */
const FIRST_ARRIVAL = '01a18266-39e0-758b-a289-fb48c2dd9c8b';
const SECOND_ARRIVAL = '01a18267-2440-758c-b6af-c1ec0229822d';
const THIRD_ARRIVAL = '01a18268-0ea0-758d-9828-d2f91413b8b3';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
const BET: SubmittedOperation = {
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: { amount: '40.00', currency: 'BRL' },
};

const hashOf = (operation: SubmittedOperation): string => payloadHashOf(operation, sha256Hex);

let schema: MikroORM;
let runtime: MikroORM;
let unitOfWork: UnitOfWork;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  // The wallet the foreign key of every submission points at; it is opened and never touched
  // again, so every case can assert that a refused arrival moved nothing.
  await unitOfWork.transactional(({ wallets }) =>
    wallets.insert(
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        currency: 'BRL',
        openedAt: OPENED_AT,
        openingCredit: null,
      }).wallet,
    ),
  );
});

/**
 * A submission as it reaches the reservation: the service id and the arrival time of this request,
 * the identity the provider chose, and the canonical hash of the operation itself.
 */
function submissionOf(
  id: string,
  operation: SubmittedOperation,
  overrides: { readonly idempotencyKey?: string } = {},
): NewWagerTransaction {
  return {
    id,
    providerId: operation.providerId,
    externalTransactionId: operation.externalTransactionId,
    idempotencyKey:
      overrides.idempotencyKey ??
      recommendedIdempotencyKey(operation.providerId, operation.externalTransactionId),
    payloadHash: hashOf(operation),
    walletId: operation.walletId,
    playerId: operation.playerId,
    roundId: operation.roundId,
    gameId: operation.gameId,
    kind: operation.kind,
    money: Money.from(operation.money.amount, operation.money.currency),
    referenceExternalTransactionId: operation.referenceExternalTransactionId ?? null,
    createdAt: SUBMITTED_AT,
  };
}

const reserve = (submission: NewWagerTransaction): Promise<Reservation> =>
  unitOfWork.transactional(({ transactions }) =>
    transactions.reserve(WagerTransaction.create(submission)),
  );

async function countOf(table: string): Promise<number> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ count: number }[]>(`select count(*)::int as count from ${table}`);

  return rows[0]?.count ?? 0;
}

/** What a refused arrival must leave untouched: every table but the one row already reserved. */
async function assertNothingElseWasStored(transactions: number): Promise<void> {
  expect(await countOf('wager_transactions')).toBe(transactions);
  expect(await countOf('wallet_ledger_entries')).toBe(0);
  expect(await countOf('outbox_messages')).toBe(0);

  const wallet = await unitOfWork.transactional(({ wallets }) => wallets.findById(WALLET_ID));

  expect(wallet?.balance.toString()).toBe('0.00');
  expect(wallet?.version).toBe(1);
}

/**
 * The row that already held the submitted key, or a failure naming what the reservation did
 * instead: won the race, or lost it on the provider transaction id.
 */
function keyHolderOf(reservation: Reservation): WagerTransaction {
  if (reservation.reserved) {
    throw new Error('expected the reservation to lose to the row already holding the key');
  }

  if (reservation.keyHolder === null) {
    throw new Error('expected the submitted idempotency key to be the key that collided');
  }

  return reservation.keyHolder;
}

describe('idempotency-reservation', () => {
  test('the first arrival takes the keys and the row is committed', async () => {
    expect(await reserve(submissionOf(FIRST_ARRIVAL, BET))).toEqual({ reserved: true });

    const stored = await unitOfWork.transactional(({ transactions }) =>
      transactions.findById(FIRST_ARRIVAL),
    );

    expect(stored?.payloadHash).toBe(hashOf(BET));
    expect(stored?.status).toBe('PENDING');
    expect(stored?.idempotencyKey).toBe('provider-acme:acme-tx-000123');
  });

  test('the same operation arriving again reserves nothing and reads the stored row', async () => {
    await reserve(submissionOf(FIRST_ARRIVAL, BET));

    const keyHolder = keyHolderOf(await reserve(submissionOf(SECOND_ARRIVAL, BET)));

    expect(keyHolder.id).toBe(FIRST_ARRIVAL);
    expect(classifyReservationConflict(keyHolder, hashOf(BET))).toEqual({
      replay: true,
      stored: keyHolder,
    });
    await assertNothingElseWasStored(1);
  });
});

/** IDEM-002: the keys of one provider are the keys of that provider alone. */
describe('idempotency-key-scoped-per-provider', () => {
  test('two providers use the same key string for two different operations', async () => {
    const shared = 'shared-key-000001';
    const acme = submissionOf(FIRST_ARRIVAL, BET, { idempotencyKey: shared });
    const other = submissionOf(
      SECOND_ARRIVAL,
      { ...BET, providerId: 'provider-other', externalTransactionId: 'other-tx-000777' },
      { idempotencyKey: shared },
    );

    expect(await reserve(acme)).toEqual({ reserved: true });
    expect(await reserve(other)).toEqual({ reserved: true });
    expect(await countOf('wager_transactions')).toBe(2);
  });
});

/** IDEM-007: a key reused for different content is a conflict, never a replay. */
describe('payload-mismatch-is-conflict', () => {
  test('the same key with another amount is a payload mismatch that stores nothing', async () => {
    await reserve(submissionOf(FIRST_ARRIVAL, BET));
    const amended: SubmittedOperation = { ...BET, money: { amount: '41.00', currency: 'BRL' } };

    const keyHolder = keyHolderOf(await reserve(submissionOf(SECOND_ARRIVAL, amended)));

    expect(classifyReservationConflict(keyHolder, hashOf(amended))).toEqual({
      replay: false,
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
    expect(keyHolder.id).toBe(FIRST_ARRIVAL);
    expect(keyHolder.payloadHash).toBe(hashOf(BET));
    expect(keyHolder.money.toString()).toBe('40.00');
    await assertNothingElseWasStored(1);
  });
});

/** IDEM-008: a provider transaction id belongs to the key that first used it. */
describe('external-id-bound-to-first-key', () => {
  test('a second key for the same provider transaction id is refused', async () => {
    await reserve(submissionOf(FIRST_ARRIVAL, BET));

    const underAnotherKey = submissionOf(SECOND_ARRIVAL, BET, {
      idempotencyKey: 'provider-acme:acme-tx-000123-retry',
    });

    expect(await reserve(underAnotherKey)).toEqual({ reserved: false, keyHolder: null });
    expect(classifyReservationConflict(null, hashOf(BET))).toEqual({
      replay: false,
      code: 'EXTERNAL_TRANSACTION_ALREADY_BOUND',
    });
    await assertNothingElseWasStored(1);
  });
});

/** TX-002: one transaction per `(providerId, externalTransactionId)`, whatever is submitted. */
describe('provider-transaction-id-is-unique', () => {
  test('two different payloads under two different keys leave one row', async () => {
    await reserve(submissionOf(FIRST_ARRIVAL, BET));
    const different: SubmittedOperation = {
      ...BET,
      kind: 'WIN',
      money: { amount: '65.00', currency: 'BRL' },
    };

    const reservation = await reserve(
      submissionOf(SECOND_ARRIVAL, different, { idempotencyKey: 'provider-acme:other-key' }),
    );

    expect(reservation).toEqual({ reserved: false, keyHolder: null });
    await assertNothingElseWasStored(1);

    const stored = await unitOfWork.transactional(({ transactions }) =>
      transactions.findById(FIRST_ARRIVAL),
    );

    expect(stored?.kind).toBe('BET');
    expect(stored?.payloadHash).toBe(hashOf(BET));
  });
});

/**
 * IDEM-009: the reservation is a committed row, so a process that is gone leaves the decision
 * behind. The first arrival is reserved by a process of its own, which exits before this one asks
 * anything, and no cache, broker property or shared memory connects the two.
 */
describe('idempotency-survives-restart', () => {
  test('another instance reserved it, and this one decides a replay from the database', async () => {
    const { money, createdAt, ...identity } = submissionOf(FIRST_ARRIVAL, BET);
    const reserved = Bun.spawnSync(
      [
        process.execPath,
        'run',
        RESERVE_IN_A_PROCESS,
        JSON.stringify({
          ...identity,
          amount: money.toString(),
          currency: money.currency,
          createdAt: createdAt.toISOString(),
        }),
      ],
      { cwd: ROOT, env: process.env },
    );

    expect(reserved.stderr.toString()).toBe('');
    expect(reserved.stdout.toString()).toBe(JSON.stringify({ reserved: true }));

    const keyHolder = keyHolderOf(await reserve(submissionOf(SECOND_ARRIVAL, BET)));

    expect(keyHolder.id).toBe(FIRST_ARRIVAL);
    expect(classifyReservationConflict(keyHolder, hashOf(BET))).toEqual({
      replay: true,
      stored: keyHolder,
    });
    await assertNothingElseWasStored(1);
  });
});

/**
 * The unique index decides the race, with no coordination above it: copies of one operation that
 * arrive at the same moment wait on it, and the ones that lose read what the winner committed.
 */
describe('reservation-decides-the-race', () => {
  test('three copies of one operation arriving at once produce one row', async () => {
    const arrivals = [FIRST_ARRIVAL, SECOND_ARRIVAL, THIRD_ARRIVAL];

    const reservations = await Promise.all(arrivals.map((id) => reserve(submissionOf(id, BET))));

    expect(reservations.filter((reservation) => reservation.reserved)).toHaveLength(1);
    expect(await countOf('wager_transactions')).toBe(1);

    const stored = await unitOfWork.transactional(({ transactions }) =>
      Promise.all(arrivals.map((id) => transactions.findById(id))),
    );
    const [winner] = stored.filter((row): row is WagerTransaction => row !== null);

    if (winner === undefined) {
      throw new Error('expected the arrival that won the race to be the row in the table');
    }

    for (const reservation of reservations.filter(({ reserved }) => !reserved)) {
      const keyHolder = keyHolderOf(reservation);

      expect(keyHolder.id).toBe(winner.id);
      expect(classifyReservationConflict(keyHolder, hashOf(BET))).toEqual({
        replay: true,
        stored: keyHolder,
      });
    }
  });
});
