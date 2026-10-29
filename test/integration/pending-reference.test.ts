import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import { ServiceUnavailableError, WalletNotFoundError } from '../../src/application/errors';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import {
  type PendingReferenceAttempt,
  ReprocessPendingReference,
} from '../../src/application/use-cases/reprocess-pending-reference';
import { AppModule } from '../../src/app.module';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { recordingLogger } from '../helpers/recording-logger';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const LOCK_TIMEOUT_MS = 2_000;

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const PROVIDER_ID = 'provider-acme';
const ROUND_ID = 'round-7f3a';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const ROOT = path.resolve(import.meta.dirname, '../..');
const SWEEP_IN_A_PROCESS = path.join(ROOT, 'test', 'helpers', 'reprocess-pending-references.ts');

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
let app: INestApplication;
let baseUrl: string;
let unitOfWork: MikroOrmUnitOfWork;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  app = await NestFactory.create(AppModule.create({ ...env, LOCK_TIMEOUT_MS }), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
  unitOfWork = app.get(MikroOrmUnitOfWork);
});

afterAll(async () => {
  await app.close();
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  log.records.length = 0;
  metrics = new MetricsRegistry();
});

// `recon.final-invariant` (RECON-004): every wallet a case touched is rebuilt from its ledger
// before the next truncation, whether the case moved money through the endpoint or the scheduler.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface Body {
  readonly id?: string;
  readonly transactionId?: string;
  readonly status?: string;
  readonly balance?: MoneyBody;
  readonly observedBalance?: MoneyBody;
  readonly idempotentReplay?: boolean;
  readonly failureCode?: string;
}

interface Answer {
  readonly status: number;
  readonly location: string | null;
  readonly body: Body;
}

const brl = (amount: string): MoneyBody => ({ amount, currency: 'BRL' });

type Operation = Record<string, unknown>;

async function post(path: string, body: unknown, idempotencyKey?: string): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': CORRELATION_ID,
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    location: response.headers.get('location'),
    body: (await response.json()) as Body,
  };
}

/** The transaction as `GET /wagering/transactions/{transactionId}` serves it (`api.transaction-read`). */
async function read(path: string): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-correlation-id': CORRELATION_ID },
  });

  return {
    status: response.status,
    location: response.headers.get('location'),
    body: (await response.json()) as Body,
  };
}

async function openWallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const answer = await post('/wallets', { playerId, initialBalance: brl(initialBalance) });

  if (answer.status !== 201 || typeof answer.body.id !== 'string') {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(answer.body.id);
}

function operation(
  externalTransactionId: string,
  kind: string,
  walletId: string,
  overrides: Operation = {},
): Operation {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: PLAYER_ID,
    walletId,
    roundId: ROUND_ID,
    gameId: 'lucky-sevens',
    kind,
    money: brl('40.00'),
    ...overrides,
  };
}

/** One submission, keyed as the contract recommends: the provider and its transaction id. */
function submit(body: Operation): Promise<Answer> {
  return post(
    '/wagering/transactions',
    body,
    `${String(body['providerId'])}:${String(body['externalTransactionId'])}`,
  );
}

/** A submission that has to have been applied for the case to mean anything. */
async function applied(body: Operation): Promise<string> {
  const answer = await submit(body);

  if (answer.status !== 200 || typeof answer.body.transactionId !== 'string') {
    throw new Error(
      `${String(body['kind'])} ${String(body['externalTransactionId'])} answered ${answer.status.toString()} ${answer.body.failureCode ?? ''}`,
    );
  }

  return answer.body.transactionId;
}

/** A submission that has to have been parked for the case to mean anything (`ref.parked-state`). */
async function parked(body: Operation): Promise<string> {
  const answer = await submit(body);

  if (answer.status !== 202 || typeof answer.body.transactionId !== 'string') {
    throw new Error(
      `${String(body['kind'])} ${String(body['externalTransactionId'])} answered ${answer.status.toString()} instead of being parked`,
    );
  }

  return answer.body.transactionId;
}

interface WalletRow {
  readonly balance: string;
  readonly version: number;
}

/*
 * A raw statement reads the timestamps as the strings PostgreSQL rendered, because the ORM converts
 * only the columns it hydrates itself, so the suite compares moments rather than values.
 */
interface TransactionRow {
  readonly status: string;
  readonly failure_code: string | null;
  readonly observed_balance: string | null;
  readonly reference_transaction_id: string | null;
  readonly processed_at: string | null;
  readonly created_at: string;
}

interface ScheduleRow {
  readonly transaction_id: string;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly expires_at: string;
}

const moment = (value: string | undefined): number => new Date(value ?? 0).getTime();

interface LedgerRow {
  readonly kind: string;
  readonly direction: string;
  readonly amount: string;
}

interface OutboxRow {
  readonly event_type: string;
  readonly payload: { readonly data: Record<string, unknown> };
}

const sql = <T>(query: string, params: unknown[] = []): Promise<T[]> =>
  runtime.em.getConnection().execute<T[]>(query, params);

const walletRow = async (walletId: string): Promise<WalletRow | undefined> =>
  (
    await sql<WalletRow>(
      'select "balance"::text as "balance", "version" from "wallets" where "id" = ?',
      [walletId],
    )
  )[0];

const transactionRow = async (transactionId: string): Promise<TransactionRow | undefined> =>
  (
    await sql<TransactionRow>(
      `select "status", "failure_code", "observed_balance"::text as "observed_balance",
              "reference_transaction_id", "processed_at", "created_at"
         from "wager_transactions" where "id" = ?`,
      [transactionId],
    )
  )[0];

const scheduleRow = async (transactionId: string): Promise<ScheduleRow | undefined> =>
  (
    await sql<ScheduleRow>(
      'select * from "pending_reference_schedule" where "transaction_id" = ?',
      [transactionId],
    )
  )[0];

const ledgerKinds = async (walletId: string): Promise<string[]> =>
  (
    await sql<LedgerRow>(
      `select "kind", "direction", "amount"::text as "amount" from "wallet_ledger_entries"
        where "wallet_id" = ? order by "wallet_version"`,
      [walletId],
    )
  ).map((entry) => `${entry.kind} ${entry.direction} ${entry.amount}`);

const eventsOf = (transactionId: string): Promise<OutboxRow[]> =>
  sql<OutboxRow>(
    `select "event_type", "payload" from "outbox_messages"
      where "payload" ->> 'causationId' = ? order by "occurred_at", "event_type"`,
    [transactionId],
  );

const eventTypesOf = async (transactionId: string): Promise<string[]> =>
  (await eventsOf(transactionId)).map((row) => row.event_type);

/** What the scheduler logged, which `ref.permanent-failure` requires of a `FAILED` outcome. */
const log = recordingLogger();

/**
 * What the scheduler counted, which `obs.metrics` requires of every attempt (OBS-003). A registry
 * of its own per test, because a counter is cumulative and a case asserts what its own sweep raised.
 */
let metrics = new MetricsRegistry();

/**
 * The scheduler, with the moment of its sweep as an argument. The first attempt of a parked
 * transaction is due a second after it was received (`ref.backoff`), so a case sweeps with a clock
 * just past that instead of sleeping, and the expiry cases sweep with one past the window
 * (`ref.ttl`). Everything else is the service's own wiring: the same unit of work, repositories and
 * use case the running application holds.
 */
function sweepAt(
  at: Date,
  over: UnitOfWork = unitOfWork,
): Promise<readonly PendingReferenceAttempt[]> {
  return new ReprocessPendingReference({
    unitOfWork: over,
    clock: { now: () => at },
    ids: uuidV7IdGenerator,
    logger: log.logger,
    metrics,
  }).execute();
}

/** A sweep a second after the park, which is when the first attempt is due. */
const sweep = (over?: UnitOfWork): Promise<readonly PendingReferenceAttempt[]> =>
  sweepAt(new Date(Date.now() + 2 * SECOND), over);

/** A sweep after the sixty-minute window closed (`ref.expiry`). */
const sweepAfterTheWindow = (): Promise<readonly PendingReferenceAttempt[]> =>
  sweepAt(new Date(Date.now() + 61 * MINUTE));

/**
 * The service's unit of work with one port call made to fail, which is how a case drives the
 * failure classes of `ref.transient-failure` and `ref.permanent-failure` against the real database:
 * everything else commits exactly as it would, and the attempt fails where the test says.
 */
function failing(over: UnitOfWork, fail: (call: string) => void): UnitOfWork {
  return {
    snapshot: (work) => over.snapshot(work),
    transactional: (work) =>
      over.transactional((repositories) => {
        const intercepted: Repositories = {
          ...repositories,
          ledger: {
            findByTransactionId: (id) => repositories.ledger.findByTransactionId(id),
            summarize: (query) => repositories.ledger.summarize(query),
            page: (query) => repositories.ledger.page(query),
            insert: async (entry) => {
              fail('insert entry');

              return repositories.ledger.insert(entry);
            },
          },
        };

        return work(intercepted);
      }),
  };
}

describe('missing-reference-is-parked', () => {
  test('a reference no transaction carries is parked, scheduled and announced once', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const transactionId = String(answer.body.transactionId);

    expect(answer.status).toBe(202);
    expect(answer.body.status).toBe('PENDING_REFERENCE');
    expect(answer.body.balance).toEqual(brl('500.00'));
    expect(answer.location).toBe(`/wagering/transactions/${transactionId}`);
    // `api.outcome-shape`: the body of a `202` is the outcome every other status carries, with no
    // failure code, because a parked transaction has not been refused (API-003).
    expect(Object.keys(answer.body).toSorted()).toEqual([
      'balance',
      'idempotentReplay',
      'status',
      'transactionId',
    ]);

    const located = await read(answer.location ?? '');

    expect(located.status).toBe(200);
    expect(located.body).toMatchObject({ transactionId, status: 'PENDING_REFERENCE' });

    const transaction = await transactionRow(transactionId);
    const schedule = await scheduleRow(transactionId);

    expect(transaction).toMatchObject({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      observed_balance: '500.00',
      reference_transaction_id: null,
      processed_at: null,
    });
    expect(schedule?.attempts).toBe(0);
    expect(moment(schedule?.next_attempt_at)).toBe(moment(transaction?.created_at) + SECOND);
    expect(moment(schedule?.expires_at)).toBe(moment(transaction?.created_at) + 60 * MINUTE);

    const [event, ...rest] = await eventsOf(transactionId);
    expect(event?.event_type).toBe('WagerTransactionPendingReference');
    expect(rest).toEqual([]);
    expect(event?.payload.data).toMatchObject({
      transactionId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'acme-bet-1',
      expiresAt: new Date(moment(schedule?.expires_at)).toISOString(),
    });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
  });

  test('an attempt that still cannot resolve the reference records no event and spaces the next one', async () => {
    const walletId = await openWallet('500.00');
    const transactionId = await parked(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const before = await scheduleRow(transactionId);

    const attempts = await sweep();

    expect(attempts).toEqual([
      { transactionId, correlationId: CORRELATION_ID, outcome: 'pending' },
    ]);
    expect(await transactionRow(transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      failure_code: null,
    });
    expect(await eventTypesOf(transactionId)).toEqual(['WagerTransactionPendingReference']);

    const after = await scheduleRow(transactionId);
    expect(after?.attempts).toBe(1);
    expect(moment(after?.next_attempt_at)).toBeGreaterThan(moment(before?.next_attempt_at));
    expect(moment(after?.expires_at)).toBe(moment(before?.expires_at));
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
  });

  test('a replay while the transaction is parked answers 202 and changes nothing', async () => {
    const walletId = await openWallet('500.00');
    const submission = operation('acme-rollback-1', 'ROLLBACK', walletId, {
      referenceExternalTransactionId: 'acme-bet-1',
    });
    const transactionId = await parked(submission);

    const replay = await submit(submission);

    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      transactionId,
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
      balance: brl('500.00'),
    });
    expect(replay.location).toBe(`/wagering/transactions/${transactionId}`);
    expect(await eventTypesOf(transactionId)).toEqual(['WagerTransactionPendingReference']);
    expect((await scheduleRow(transactionId))?.attempts).toBe(0);
  });
});

describe('rollback-before-bet-resolves', () => {
  test('a ROLLBACK delivered before its BET is applied once, on the attempt after the BET', async () => {
    const walletId = await openWallet('500.00');
    const rollbackId = await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    const betId = await applied(operation('acme-bet-1', 'BET', walletId));

    // `ref.resolution-on-arrival`: the arrival itself triggers nothing.
    expect(await transactionRow(rollbackId)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });

    const attempts = await sweep();

    expect(attempts).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(await transactionRow(rollbackId)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '500.00',
      reference_transaction_id: betId,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
    expect(await ledgerKinds(walletId)).toEqual([
      'OPENING CREDIT 500.00',
      'BET DEBIT 40.00',
      'ROLLBACK CREDIT 40.00',
    ]);
    expect(await eventTypesOf(rollbackId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('a later sweep finds nothing: a settled transaction leaves the claim list', async () => {
    const walletId = await openWallet('500.00');
    await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    await applied(operation('acme-bet-1', 'BET', walletId));

    await sweep();

    expect(await sweepAt(new Date(Date.now() + 10 * MINUTE))).toEqual([]);
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
  });

  test('the frozen outcome is what a replay answers once the transaction is terminal', async () => {
    const walletId = await openWallet('500.00');
    const submission = operation('acme-rollback-1', 'ROLLBACK', walletId, {
      referenceExternalTransactionId: 'acme-bet-1',
    });
    const rollbackId = await parked(submission);
    await applied(operation('acme-bet-1', 'BET', walletId));
    await sweep();

    // A second bet moves the balance after the rollback was applied.
    await applied(operation('acme-bet-2', 'BET', walletId, { money: brl('100.00') }));

    const replay = await submit(submission);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: rollbackId,
      status: 'PROCESSED',
      idempotentReplay: true,
      balance: brl('500.00'),
    });
    expect(replay.location).toBeNull();
    expect(await walletRow(walletId)).toEqual({ balance: '400.00', version: 4 });
  });

  test('a reference rule refuses on the attempt exactly as it would on arrival', async () => {
    const walletId = await openWallet('500.00');
    const rollbackId = await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const betId = await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    const attempts = await sweep();

    expect(attempts).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(await transactionRow(rollbackId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_ALREADY_REVERSED',
      reference_transaction_id: betId,
      processed_at: null,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
    expect(await eventTypesOf(rollbackId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });
});

describe('pending-reference-expires', () => {
  test('the window closing rejects the transaction with REFERENCE_NOT_FOUND and its event', async () => {
    const walletId = await openWallet('500.00');
    const transactionId = await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    const attempts = await sweepAfterTheWindow();

    expect(attempts).toEqual([
      { transactionId, correlationId: CORRELATION_ID, outcome: 'expired' },
    ]);
    expect(await transactionRow(transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      observed_balance: '500.00',
      processed_at: null,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
    expect(await ledgerKinds(walletId)).toEqual(['OPENING CREDIT 500.00']);

    const events = await eventsOf(transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(events[1]?.payload.data).toMatchObject({
      failureCode: 'REFERENCE_NOT_FOUND',
      observedBalance: brl('500.00'),
      referenceExternalTransactionId: 'acme-bet-1',
    });
  });

  test('an expired rejection is terminal: replays answer 422 and no sweep attempts it again', async () => {
    const walletId = await openWallet('500.00');
    const submission = operation('acme-refund-1', 'REFUND', walletId, {
      referenceExternalTransactionId: 'acme-bet-1',
    });
    await parked(submission);
    await sweepAfterTheWindow();

    const replay = await submit(submission);

    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: true,
      balance: brl('500.00'),
    });
    expect(await sweepAfterTheWindow()).toEqual([]);
  });

  test('a reference that arrived is applied even by an attempt after the window closed', async () => {
    const walletId = await openWallet('500.00');
    const rollbackId = await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    await applied(operation('acme-bet-1', 'BET', walletId));

    const attempts = await sweepAfterTheWindow();

    expect(attempts).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(await transactionRow(rollbackId)).toMatchObject({ status: 'PROCESSED' });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
  });
});

describe('pending-reference-failure-classes', () => {
  test('a transient failure records nothing, keeps the window and only reschedules', async () => {
    const walletId = await openWallet('500.00');
    const rollbackId = await parked(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    await applied(operation('acme-bet-1', 'BET', walletId));
    const before = await scheduleRow(rollbackId);

    let failures = 0;
    const attempts = await sweep(
      failing(unitOfWork, () => {
        failures += 1;

        throw new ServiceUnavailableError('the database is unavailable', 5);
      }),
    );

    expect(failures).toBe(1);
    expect(attempts).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'retried' },
    ]);
    expect(await transactionRow(rollbackId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      failure_code: null,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await ledgerKinds(walletId)).toEqual(['OPENING CREDIT 500.00', 'BET DEBIT 40.00']);
    expect(await eventTypesOf(rollbackId)).toEqual(['WagerTransactionPendingReference']);

    const after = await scheduleRow(rollbackId);
    expect(after?.attempts).toBe(1);
    expect(moment(after?.expires_at)).toBe(moment(before?.expires_at));
    expect(log.at('error')).toEqual([]);
    // `obs.metrics`: the attempt counted by what it ended in, and as a retry of this component.
    expect(await metrics.total('wager_pending_reference_total', { outcome: 'retried' })).toBe(1);
    expect(await metrics.total('wager_retries_total', { component: 'pending-reference' })).toBe(1);

    // The attempt after it applies the transaction: transient failures are never limited.
    expect(await sweepAt(new Date(Date.now() + 10 * MINUTE))).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'settled' },
    ]);
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
  });

  test('a permanent failure marks the transaction FAILED with PROCESSING_FAILED and emits nothing', async () => {
    const walletId = await openWallet('500.00');
    const submission = operation('acme-rollback-1', 'ROLLBACK', walletId, {
      referenceExternalTransactionId: 'acme-bet-1',
    });
    const rollbackId = await parked(submission);
    await applied(operation('acme-bet-1', 'BET', walletId));

    const attempts = await sweep(
      failing(unitOfWork, () => {
        throw new WalletNotFoundError(walletId);
      }),
    );

    expect(attempts).toEqual([
      { transactionId: rollbackId, correlationId: CORRELATION_ID, outcome: 'failed' },
    ]);
    // `obs.metrics`: the attempt by its outcome, and the terminal outcome it recorded (OBS-003).
    expect(await metrics.total('wager_pending_reference_total', { outcome: 'failed' })).toBe(1);
    expect(
      await metrics.total('wager_transactions_total', { kind: 'ROLLBACK', status: 'FAILED' }),
    ).toBe(1);
    expect(await transactionRow(rollbackId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
      observed_balance: '500.00',
      processed_at: null,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await ledgerKinds(walletId)).toEqual(['OPENING CREDIT 500.00', 'BET DEBIT 40.00']);
    expect(await eventTypesOf(rollbackId)).toEqual(['WagerTransactionPendingReference']);
    expect(log.at('error')).toHaveLength(1);
    expect(log.at('error')[0]?.fields).toMatchObject({
      correlationId: CORRELATION_ID,
      transactionId: rollbackId,
      attempts: 0,
    });

    // `tx.failed-semantics`: a FAILED transaction is auditable, and its replay is a 500 carrying
    // the outcome the read endpoint serves.
    const read_ = await read(`/wagering/transactions/${rollbackId}`);

    expect(read_.status).toBe(200);
    expect(read_.body).toMatchObject({
      transactionId: rollbackId,
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      observedBalance: brl('500.00'),
    });

    const replay = await submit(submission);

    expect(replay.status).toBe(500);
    expect(replay.body).toEqual({
      transactionId: rollbackId,
      status: 'FAILED',
      balance: brl('500.00'),
      idempotentReplay: true,
      failureCode: 'PROCESSING_FAILED',
    });
    expect(await sweepAt(new Date(Date.now() + 10 * MINUTE))).toEqual([]);
  });
});

describe('scheduler-exclusive-claims', () => {
  /**
   * Three parked `ROLLBACK`s, one per wallet, with a worker in a process of its own holding the
   * claim on one of them: nothing is shared but PostgreSQL, so what keeps two workers off one row
   * is `FOR UPDATE SKIP LOCKED` or nothing at all. Killing the holder mid-attempt is the crash
   * REF-002 asks about — the claim goes with the connection and the attempt rolls back, so the row
   * is due again, unchanged, for whichever worker sweeps next.
   */
  test('a held claim is skipped by another worker and recovered after the holder is killed', async () => {
    const parkedRollbacks = new Map<string, string>();

    for (const slot of [1, 2, 3]) {
      const walletId = await openWallet('500.00', playerOf(slot));
      const rollbackId = await parked(
        operation(`acme-rollback-${slot.toString()}`, 'ROLLBACK', walletId, {
          playerId: playerOf(slot),
          referenceExternalTransactionId: `acme-bet-${slot.toString()}`,
        }),
      );
      await applied(
        operation(`acme-bet-${slot.toString()}`, 'BET', walletId, { playerId: playerOf(slot) }),
      );
      parkedRollbacks.set(rollbackId, walletId);
    }

    // The first attempt is due a second after the park (`ref.backoff`), and a worker in a process
    // of its own reads the host clock, so the holder is spawned once there is something to claim.
    await Bun.sleep(1200);

    const holder = Bun.spawn(
      [process.execPath, 'run', SWEEP_IN_A_PROCESS, JSON.stringify({ holdMs: 30_000 })],
      { cwd: ROOT, env: process.env, stdout: 'pipe', stderr: 'pipe' },
    );

    try {
      const held = await firstLine(holder.stdout);

      expect(parkedRollbacks.has(held)).toBe(true);

      const swept = await sweep();

      expect(swept.map((attempt) => attempt.transactionId).toSorted()).toEqual(
        [...parkedRollbacks.keys()].filter((id) => id !== held).toSorted(),
      );
      expect(await transactionRow(held)).toMatchObject({ status: 'PENDING_REFERENCE' });
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
    }

    await drainUntilSettled(parkedRollbacks);

    for (const [rollbackId, walletId] of parkedRollbacks) {
      expect(await transactionRow(rollbackId)).toMatchObject({ status: 'PROCESSED' });
      expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
      expect(await ledgerKinds(walletId)).toEqual([
        'OPENING CREDIT 500.00',
        'BET DEBIT 40.00',
        'ROLLBACK CREDIT 40.00',
      ]);
      expect((await scheduleRow(rollbackId))?.attempts).toBe(1);
    }
  });

  /**
   * Three workers, three processes, one backlog: every transaction is reprocessed exactly once, and
   * the schedule rows are the evidence — a row attempted twice would carry two attempts, and a
   * wallet credited twice would fail reconciliation and the entry count below.
   */
  test('several workers drain one backlog without attempting a transaction twice', async () => {
    const parkedRollbacks = new Map<string, string>();

    for (const slot of [1, 2, 3, 4, 5, 6]) {
      const walletId = await openWallet('500.00', playerOf(slot));
      const rollbackId = await parked(
        operation(`acme-rollback-${slot.toString()}`, 'ROLLBACK', walletId, {
          playerId: playerOf(slot),
          referenceExternalTransactionId: `acme-bet-${slot.toString()}`,
        }),
      );
      await applied(
        operation(`acme-bet-${slot.toString()}`, 'BET', walletId, { playerId: playerOf(slot) }),
      );
      parkedRollbacks.set(rollbackId, walletId);
    }

    // The first attempt is due a second after the park, so the workers wait for it rather than
    // sweeping an empty claim list; their clock is the host's.
    await Bun.sleep(1200);

    const workers = await Promise.all([sweepInAProcess(), sweepInAProcess(), sweepInAProcess()]);
    const settled = workers.flat();

    expect(settled.map((attempt) => attempt.transactionId).toSorted()).toEqual(
      [...parkedRollbacks.keys()].toSorted(),
    );
    expect(settled.every((attempt) => attempt.outcome === 'settled')).toBe(true);

    for (const [rollbackId, walletId] of parkedRollbacks) {
      expect(await transactionRow(rollbackId)).toMatchObject({ status: 'PROCESSED' });
      expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
      expect((await scheduleRow(rollbackId))?.attempts).toBe(1);
    }
  });
});

/** One player per wallet, because a player holds one wallet per currency (WALLET-001). */
const playerOf = (slot: number): string =>
  `01a17cb1-f5c0-7588-9a61-47a9444c04${slot.toString().padStart(2, '0')}`;

/** The first line a spawned worker writes, which is the transaction it claimed. */
async function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  while (!buffered.includes('\n')) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error(`the worker exited without claiming anything: ${buffered}`);
    }
    buffered += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();

  return buffered.slice(0, buffered.indexOf('\n'));
}

/** One sweeping worker in a process of its own, with the attempts it made. */
async function sweepInAProcess(): Promise<PendingReferenceAttempt[]> {
  const worker = Bun.spawn([process.execPath, 'run', SWEEP_IN_A_PROCESS, '{}'], {
    cwd: ROOT,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ]);

  if (code !== 0) {
    throw new Error(`sweeping in another process exited ${code.toString()}: ${stdout}${stderr}`);
  }

  return JSON.parse(stdout) as PendingReferenceAttempt[];
}

/**
 * Sweeps until every parked transaction is terminal. A claim a killed process held is released by
 * PostgreSQL when it notices the connection is gone, which is not instantaneous, so the recovery is
 * waited for rather than assumed to happen on the first sweep after the kill.
 */
async function drainUntilSettled(parkedRollbacks: Map<string, string>): Promise<void> {
  const deadline = Date.now() + 10 * SECOND;

  while (Date.now() < deadline) {
    await sweep();

    const statuses = await Promise.all(
      [...parkedRollbacks.keys()].map(async (id) => (await transactionRow(id))?.status),
    );

    if (statuses.every((status) => status === 'PROCESSED')) {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error('the parked transactions were not reprocessed before the deadline');
}
