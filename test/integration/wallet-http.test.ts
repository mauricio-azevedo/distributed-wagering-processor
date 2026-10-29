import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** `Uuid` and the RFC 3339 instant of the contract, as the response shape has to spell them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `wallet.read-shape`: the members a wallet is returned as, and no others. */
const WALLET_MEMBERS = ['balance', 'createdAt', 'id', 'playerId', 'updatedAt', 'version'];

/** `recon.report-shape`: the members a reconciliation is returned as, and no others. */
const REPORT_MEMBERS = [
  'calculatedBalance',
  'checkedAt',
  'checkedEntries',
  'consistent',
  'difference',
  'storedBalance',
  'walletId',
];

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  app = await NestFactory.create(AppModule.create(env), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): this suite opens wallets, so every test ends by rebuilding
// the balance of each one from its ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

/** The members this suite reads off a response body, a wallet's and a problem's together. */
interface Body {
  readonly id?: string;
  readonly playerId?: string;
  readonly balance?: { readonly amount: string; readonly currency: string };
  readonly version?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly walletId?: string;
  readonly storedBalance?: { readonly amount: string; readonly currency: string };
  readonly calculatedBalance?: { readonly amount: string; readonly currency: string };
  readonly difference?: { readonly amount: string; readonly currency: string };
  readonly consistent?: boolean;
  readonly checkedEntries?: number;
  readonly checkedAt?: string;
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly correlationId: string | null;
  readonly location: string | null;
  readonly body: Body;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; raw?: string; correlationId?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(options.body === undefined && options.raw === undefined
      ? {}
      : {
          headers: {
            'content-type': 'application/json',
            ...(options.correlationId === undefined
              ? {}
              : { 'x-correlation-id': options.correlationId }),
          },
          body: options.raw ?? JSON.stringify(options.body),
        }),
    ...(options.body === undefined &&
    options.raw === undefined &&
    options.correlationId !== undefined
      ? { headers: { 'x-correlation-id': options.correlationId } }
      : {}),
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    correlationId: response.headers.get('x-correlation-id'),
    location: response.headers.get('location'),
    body: (await response.json()) as Body,
  };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(
  initialBalance: { amount: string; currency: string },
  playerId = PLAYER_ID,
): Promise<Answer> {
  const answer = await request('POST', '/wallets', {
    body: { playerId, initialBalance },
    correlationId: CORRELATION_ID,
  });

  if (typeof answer.body.id === 'string') {
    touched.add(answer.body.id);
  }

  return answer;
}

/**
 * A stored balance that disagrees with its ledger, which only the owner of the tables can write:
 * SCHEMA-023 means no write the service issues leaves one behind. The commit-time mirror is disabled
 * for the single statement and re-enabled whatever happens, so the next test faces the real schema,
 * and the wallet leaves the RECON-004 sweep because the invariant it asserts is the one this breaks.
 */
async function divergeStoredBalance(walletId: string, balance: string): Promise<void> {
  touched.forget(walletId);
  const owner = schema.em.getConnection();

  await owner.execute(`alter table "wallets" disable trigger "wallets_mirror_ledger_head"`);
  try {
    await owner.execute(`update "wallets" set "balance" = ? where "id" = ?`, [balance, walletId]);
  } finally {
    await owner.execute(`alter table "wallets" enable trigger "wallets_mirror_ledger_head"`);
  }
}

describe('wallet-create-endpoint', () => {
  test('a positive initial balance answers 201 with the wallet and its Location', async () => {
    const answer = await openWallet(brl('500.00'));

    expect(answer.status).toBe(201);
    expect(answer.contentType).toStartWith('application/json');
    expect(answer.location).toBe(`/wallets/${String(answer.body.id)}`);
    expect(Object.keys(answer.body).sort()).toEqual(WALLET_MEMBERS);
    expect(answer.body.id).toMatch(UUID);
    expect(answer.body.playerId).toBe(PLAYER_ID);
    expect(answer.body.balance).toEqual(brl('500.00'));
    expect(answer.body.version).toBe(1);
    expect(answer.body.createdAt).toMatch(RFC_3339);
    expect(answer.body.updatedAt).toBe(answer.body.createdAt ?? '');
  });

  test('a second wallet for the same player and currency answers 409 and leaves the first unchanged', async () => {
    const first = await openWallet(brl('500.00'));

    const duplicate = await openWallet(brl('10.00'));

    expect(duplicate.status).toBe(409);
    expect(duplicate.contentType).toStartWith('application/problem+json');
    expect(duplicate.body).toMatchObject({
      type: 'urn:problem-type:wagering:WALLET_ALREADY_EXISTS',
      title: 'Wallet already exists',
      status: 409,
      code: 'WALLET_ALREADY_EXISTS',
      correlationId: CORRELATION_ID,
    });
    expect(duplicate.body).not.toHaveProperty('errors');

    const unchanged = await request('GET', `/wallets/${String(first.body.id)}`);
    expect(unchanged.body).toEqual(first.body);
  });

  test('a body without initialBalance answers 400 VALIDATION_FAILED naming the member', async () => {
    const answer = await request('POST', '/wallets', { body: { playerId: PLAYER_ID } });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      type: 'urn:problem-type:wagering:VALIDATION_FAILED',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'The request violates the contract in 1 place.',
      errors: [{ path: '/body/initialBalance', message: 'is required' }],
    });
  });

  test('a member the contract does not define is a violation, not an ignored extra', async () => {
    const answer = await request('POST', '/wallets', {
      body: { playerId: PLAYER_ID, initialBalance: brl('500.00'), nickname: 'lucky' },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toEqual([
      { path: '/body/nickname', message: 'is not a member of this request' },
    ]);
  });

  test('an amount sent as a JSON number is refused, never rounded into money', async () => {
    const answer = await request('POST', '/wallets', {
      body: { playerId: PLAYER_ID, initialBalance: { amount: 500, currency: 'BRL' } },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toMatchObject([{ path: '/body/initialBalance/amount' }]);
  });

  test('a body that is not JSON answers 400 VALIDATION_FAILED rather than a framework error', async () => {
    const answer = await request('POST', '/wallets', { raw: '{"playerId":' });

    expect(answer.status).toBe(400);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });
});

describe('zero-initial-balance-accepted', () => {
  test('0.00 answers 201 with balance 0.00 at version 1 and writes no ledger entry', async () => {
    const answer = await openWallet(brl('0.00'));

    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ balance: brl('0.00'), version: 1 });

    const entries = await runtime.em
      .getConnection()
      .execute<{ count: string }[]>(
        'select count(*)::text as count from wallet_ledger_entries where wallet_id = ?',
        [answer.body.id],
      );
    expect(entries[0]?.count).toBe('0');
  });
});

describe('wallet-read-endpoint', () => {
  test('an existing wallet answers 200 with id, playerId, balance, version, createdAt and updatedAt', async () => {
    const created = await openWallet(brl('500.00'));

    const answer = await request('GET', `/wallets/${String(created.body.id)}`);

    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(WALLET_MEMBERS);
    expect(answer.body).toEqual(created.body);
  });

  test('an unknown id answers 404 WALLET_NOT_FOUND', async () => {
    const answer = await request('GET', `/wallets/${UNKNOWN_WALLET_ID}`);

    expect(answer.status).toBe(404);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({
      type: 'urn:problem-type:wagering:WALLET_NOT_FOUND',
      title: 'Wallet not found',
      status: 404,
      detail: `No wallet has id ${UNKNOWN_WALLET_ID}.`,
      code: 'WALLET_NOT_FOUND',
    });
    expect(answer.body).not.toHaveProperty('errors');
  });

  test('an id that is not a UUID answers 400 naming the path parameter', async () => {
    const answer = await request('GET', '/wallets/not-a-uuid');

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/path/walletId', message: 'must be a lowercase UUID' }],
    });
  });
});

describe('reconciliation-endpoint', () => {
  test('a consistent wallet answers 200 with the report', async () => {
    const created = await openWallet(brl('500.00'));

    const answer = await request('POST', `/wallets/${String(created.body.id)}/reconciliation`, {
      correlationId: CORRELATION_ID,
    });

    expect(answer.status).toBe(200);
    expect(answer.contentType).toStartWith('application/json');
    expect(answer.correlationId).toBe(CORRELATION_ID);
    expect(Object.keys(answer.body).sort()).toEqual(REPORT_MEMBERS);
    expect(answer.body).toMatchObject({
      walletId: created.body.id,
      storedBalance: brl('500.00'),
      calculatedBalance: brl('500.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 1,
    });
    expect(answer.body.checkedAt).toMatch(RFC_3339);
  });

  test('a diverged wallet answers 200 with consistent false, the signed difference and one divergence counted', async () => {
    const created = await openWallet(brl('500.00'));
    const walletId = String(created.body.id);
    const counters = app.get(MetricsRegistry);
    const counted = await counters.total('wager_reconciliation_divergence_total');
    await divergeStoredBalance(walletId, '460.00');

    const answer = await request('POST', `/wallets/${walletId}/reconciliation`);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      storedBalance: brl('460.00'),
      calculatedBalance: brl('500.00'),
      difference: brl('-40.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(await counters.total('wager_reconciliation_divergence_total')).toBe(counted + 1);

    // Reported, never repaired: the wallet is still as divergent as the report said it was.
    const unchanged = await request('GET', `/wallets/${walletId}`);
    expect(unchanged.body.balance).toEqual(brl('460.00'));
  });

  test('an unknown wallet answers 404 WALLET_NOT_FOUND', async () => {
    const answer = await request('POST', `/wallets/${UNKNOWN_WALLET_ID}/reconciliation`);

    expect(answer.status).toBe(404);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({ code: 'WALLET_NOT_FOUND', status: 404 });
  });

  test('an id that is not a UUID answers 400 naming the path parameter', async () => {
    const answer = await request('POST', '/wallets/not-a-uuid/reconciliation');

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/path/walletId', message: 'must be a lowercase UUID' }],
    });
  });
});

describe('problem-details-shape', () => {
  test('a 400 lists every violation of the request in errors', async () => {
    const answer = await request('POST', '/wallets', {
      body: { playerId: 'not-a-uuid', initialBalance: { amount: '1', currency: 'BRL' } },
    });

    expect(answer.status).toBe(400);
    expect(answer.body.detail).toBe('The request violates the contract in 2 places.');
    expect(answer.body.errors).toEqual([
      { path: '/body/playerId', message: 'must be a lowercase UUID' },
      {
        path: '/body/initialBalance/amount',
        message: 'must match ^(0|[1-9][0-9]{0,17})\\.[0-9]{2}$',
      },
    ]);
  });

  test('every problem carries type, title, status, detail, code and correlationId', async () => {
    const taken = await openWallet(brl('500.00'), OTHER_PLAYER_ID);
    expect(taken.status).toBe(201);

    const problems = [
      await request('POST', '/wallets', { body: {} }),
      await request('GET', `/wallets/${UNKNOWN_WALLET_ID}`),
      await openWallet(brl('500.00'), OTHER_PLAYER_ID),
    ];

    for (const problem of problems) {
      expect([400, 404, 409]).toContain(problem.status);
      expect(problem.contentType).toStartWith('application/problem+json');
      expect(problem.body.type).toMatch(/^urn:problem-type:wagering:[A-Z_]+$/);
      expect(problem.body.title).toMatch(/^[A-Z][a-z]/);
      expect(problem.body.status).toBe(problem.status);
      expect(problem.body.detail).toMatch(/\S/);
      expect(problem.body.code).toMatch(/^[A-Z_]+$/);
      expect(problem.body.correlationId).toBe(problem.correlationId ?? '');
      expect(problem.body.type).toBe(`urn:problem-type:wagering:${problem.body.code ?? ''}`);
    }
  });

  test('the correlation id is echoed when the caller sends one and generated when it does not', async () => {
    const echoed = await request('GET', `/wallets/${UNKNOWN_WALLET_ID}`, {
      correlationId: CORRELATION_ID,
    });
    const generated = await request('GET', `/wallets/${UNKNOWN_WALLET_ID}`);

    expect(echoed.correlationId).toBe(CORRELATION_ID);
    expect(echoed.body.correlationId).toBe(CORRELATION_ID);
    expect(generated.correlationId).toMatch(/^[!-~]{1,128}$/);
    expect(generated.body.correlationId).toBe(generated.correlationId ?? '');
    expect(generated.correlationId).not.toBe(CORRELATION_ID);
  });

  test('a successful response carries the correlation id too', async () => {
    const answer = await openWallet(brl('500.00'));

    expect(answer.correlationId).toBe(CORRELATION_ID);
  });
});

describe('opening-credit-events-are-committed-with-the-wallet', () => {
  test('the two events of an opening credit carry the request correlation id', async () => {
    const answer = await openWallet(brl('500.00'));

    const rows = await runtime.em
      .getConnection()
      .execute<{ event_type: string; payload: { correlationId: string } }[]>(
        'select event_type, payload from outbox_messages where aggregate_id = ? order by event_type',
        [answer.body.id],
      );

    expect(rows.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(rows.map((row) => row.payload.correlationId)).toEqual([CORRELATION_ID, CORRELATION_ID]);
  });
});
