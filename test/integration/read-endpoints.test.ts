import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';
const UNKNOWN_TRANSACTION_ID = '01a18266-39e0-758b-a289-fb48c2dd0000';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const PROVIDER_ID = 'provider-acme';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `tx.read-shape`: the members every transaction is returned with, whatever its outcome. */
const TRANSACTION_MEMBERS = [
  'createdAt',
  'externalTransactionId',
  'gameId',
  'idempotencyKey',
  'kind',
  'money',
  'observedBalance',
  'payloadHash',
  'playerId',
  'providerId',
  'roundId',
  'status',
  'transactionId',
  'walletId',
];

/** `ledger.read-shape`: the members every entry is returned with. */
const ENTRY_MEMBERS = [
  'balanceAfter',
  'balanceBefore',
  'createdAt',
  'direction',
  'id',
  'kind',
  'money',
  'transactionId',
  'walletId',
  'walletVersion',
];

/** The ledger LEDGER-008 pages, and the entries appended while a cursor is in the caller's hands. */
const LEDGER_ENTRIES = 120;
const APPENDED_BETWEEN_PAGES = 10;

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

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface EntryBody {
  readonly id?: string;
  readonly walletId?: string;
  readonly transactionId?: string;
  readonly kind?: string;
  readonly direction?: string;
  readonly money?: MoneyBody;
  readonly balanceBefore?: MoneyBody;
  readonly balanceAfter?: MoneyBody;
  readonly walletVersion?: number;
  readonly createdAt?: string;
}

/** The members this suite reads off a response body: a wallet's, a transaction's, a page's and a problem's. */
interface Body {
  readonly id?: string;
  readonly transactionId?: string;
  readonly status?: string | number;
  readonly balance?: MoneyBody;
  readonly failureCode?: string;
  readonly items?: readonly EntryBody[];
  readonly nextCursor?: string | null;
  readonly type?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly correlationId: string | null;
  readonly body: Body;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-correlation-id': CORRELATION_ID,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    correlationId: response.headers.get('x-correlation-id'),
    body: (await response.json()) as Body,
  };
}

async function openWallet(initialBalance: string): Promise<string> {
  const answer = await request('POST', '/wallets', {
    body: { playerId: PLAYER_ID, initialBalance: brl(initialBalance) },
  });

  if (answer.status !== 201 || typeof answer.body.id !== 'string') {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(answer.body.id);
}

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
async function bet(
  walletId: string,
  externalTransactionId: string,
  amount = '1.00',
): Promise<Answer> {
  return request('POST', '/wagering/transactions', {
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER_ID,
      externalTransactionId,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl(amount),
    },
  });
}

/**
 * Appends `count` balance changes to a wallet through the submission endpoint, one at a time: the
 * entries have to be the ones a real operation writes, and bets of one wallet are serialized by the
 * row lock anyway (`conc.row-lock`).
 */
async function appendEntries(walletId: string, from: number, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const sequence = (from + index).toString().padStart(4, '0');
    const answer = await bet(walletId, `acme-tx-${sequence}`);

    if (answer.status !== 200) {
      throw new Error(`appending entry ${sequence} answered ${answer.status.toString()}`);
    }
  }
}

/** The content of a cursor, decoded by the test rather than by the code that issued it. */
const cursorContent = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

const base64url = (content: string) => Buffer.from(content, 'utf8').toString('base64url');

async function rowCount(table: string): Promise<number> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ count: string }[]>(`select count(*)::text as count from "${table}"`);

  return Number(row?.count ?? '-1');
}

describe('transaction-read-endpoints', () => {
  test('a processed bet reads the same full view by service id and by provider ids', async () => {
    const walletId = await openWallet('500.00');
    const submitted = await bet(walletId, 'acme-tx-000123', '40.00');
    const transactionId = String(submitted.body.transactionId);

    const byServiceId = await request('GET', `/wagering/transactions/${transactionId}`);
    const byProviderIds = await request(
      'GET',
      `/providers/${PROVIDER_ID}/wagering/transactions/acme-tx-000123`,
    );

    expect(byServiceId.status).toBe(200);
    expect(byServiceId.contentType).toStartWith('application/json');
    expect(byServiceId.correlationId).toBe(CORRELATION_ID);
    expect(Object.keys(byServiceId.body).sort()).toEqual(
      [...TRANSACTION_MEMBERS, 'processedAt'].sort(),
    );
    expect(byServiceId.body).toMatchObject({
      transactionId,
      providerId: PROVIDER_ID,
      externalTransactionId: 'acme-tx-000123',
      idempotencyKey: `${PROVIDER_ID}:acme-tx-000123`,
      walletId,
      playerId: PLAYER_ID,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl('40.00'),
      status: 'PROCESSED',
      observedBalance: brl('460.00'),
    });
    expect(byServiceId.body).toHaveProperty(
      'payloadHash',
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    );
    expect(byServiceId.body).toHaveProperty('createdAt', expect.stringMatching(RFC_3339));
    expect(byServiceId.body).toHaveProperty('processedAt', expect.stringMatching(RFC_3339));

    // One read model behind two routes: the identity used to reach a row changes nothing about it.
    expect(byProviderIds.status).toBe(200);
    expect(byProviderIds.body).toEqual(byServiceId.body);
  });

  test('the internal opening credit is readable under the system provider', async () => {
    const walletId = await openWallet('500.00');

    const answer = await request('GET', `/providers/system/wagering/transactions/${walletId}`);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      providerId: 'system',
      externalTransactionId: walletId,
      idempotencyKey: `system:${walletId}`,
      walletId,
      playerId: PLAYER_ID,
      roundId: walletId,
      gameId: 'wallet-opening',
      kind: 'OPENING',
      money: brl('500.00'),
      status: 'PROCESSED',
      observedBalance: brl('500.00'),
    });

    const byServiceId = await request(
      'GET',
      `/wagering/transactions/${String(answer.body.transactionId)}`,
    );
    expect(byServiceId.body).toEqual(answer.body);
  });

  test('a rejected transaction is readable with its failure code, for audit', async () => {
    const walletId = await openWallet('10.00');
    const rejected = await bet(walletId, 'acme-tx-000125', '600.00');
    expect(rejected.status).toBe(422);

    const answer = await request(
      'GET',
      `/wagering/transactions/${String(rejected.body.transactionId)}`,
    );

    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual([...TRANSACTION_MEMBERS, 'failureCode'].sort());
    expect(answer.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      observedBalance: brl('10.00'),
      money: brl('600.00'),
    });
    expect(answer.body).not.toHaveProperty('processedAt');
  });

  test('an unknown service id answers 404 TRANSACTION_NOT_FOUND and writes nothing', async () => {
    const answer = await request('GET', `/wagering/transactions/${UNKNOWN_TRANSACTION_ID}`);

    expect(answer.status).toBe(404);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({
      type: 'urn:problem-type:wagering:TRANSACTION_NOT_FOUND',
      title: 'Transaction not found',
      status: 404,
      detail: `No transaction has id ${UNKNOWN_TRANSACTION_ID}.`,
      code: 'TRANSACTION_NOT_FOUND',
      correlationId: CORRELATION_ID,
    });
    expect(await rowCount('wager_transactions')).toBe(0);
  });

  test('unknown provider ids answer 404 naming the provider and its transaction', async () => {
    const answer = await request(
      'GET',
      `/providers/${PROVIDER_ID}/wagering/transactions/acme-tx-000999`,
    );

    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
      detail: `Provider ${PROVIDER_ID} has no transaction acme-tx-000999.`,
    });
    expect(await rowCount('wager_transactions')).toBe(0);
  });

  /**
   * A provider transaction is identified by `(providerId, externalTransactionId)` (`tx.identity`),
   * so the row of one provider is unreachable under another's id even though the external id is
   * right — the opening credits of the reserved `system` provider included.
   */
  test('a provider cannot reach another provider transaction by sharing its external id', async () => {
    const walletId = await openWallet('500.00');
    await bet(walletId, 'acme-tx-000123', '40.00');

    const answer = await request(
      'GET',
      '/providers/provider-other/wagering/transactions/acme-tx-000123',
    );

    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
  });

  test('a service id that is not a UUID answers 400 naming the path parameter', async () => {
    const answer = await request('GET', '/wagering/transactions/not-a-uuid');

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/path/transactionId', message: 'must be a lowercase UUID' }],
    });
  });

  test('an external transaction id outside the contract answers 400 naming the path parameter', async () => {
    const answer = await request(
      'GET',
      `/providers/${PROVIDER_ID}/wagering/transactions/${encodeURIComponent('not a valid id')}`,
    );

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/path/externalTransactionId' }],
    });
  });
});

describe('ledger-cursor-pagination', () => {
  test('the ledger pages contiguously while it is being appended to, and ends with a null cursor', async () => {
    const walletId = await openWallet('500.00');
    // The opening credit is the entry at version 1; the bets carry versions 2 upwards.
    await appendEntries(walletId, 1, LEDGER_ENTRIES - 1);

    // No limit: the default page is 50 (`api.ledger-read`).
    const first = await request('GET', `/wallets/${walletId}/ledger`);

    expect(first.status).toBe(200);
    expect(first.contentType).toStartWith('application/json');
    expect(first.body.items).toHaveLength(50);
    expect(cursorContent(String(first.body.nextCursor))).toBe('v1:50');

    // The ledger grows while the caller holds the cursor: the page after it must still continue.
    await appendEntries(walletId, LEDGER_ENTRIES, APPENDED_BETWEEN_PAGES);

    const second = await request(
      'GET',
      `/wallets/${walletId}/ledger?cursor=${String(first.body.nextCursor)}`,
    );
    const third = await request(
      'GET',
      `/wallets/${walletId}/ledger?cursor=${String(second.body.nextCursor)}`,
    );

    const versions = [first, second, third].flatMap((page) =>
      (page.body.items ?? []).map((entry) => entry.walletVersion),
    );
    const total = LEDGER_ENTRIES + APPENDED_BETWEEN_PAGES;

    // Every entry exactly once, in ascending order, with no duplicate and no gap.
    expect(versions).toEqual(Array.from({ length: total }, (_unused, index) => index + 1));
    expect(second.body.items).toHaveLength(50);
    expect(third.body.items).toHaveLength(total - 100);
    expect(third.body.nextCursor).toBeNull();
    expect(cursorContent(String(second.body.nextCursor))).toBe('v1:100');
  });

  test('an entry is returned as the ten members of the read shape, amounts as strings', async () => {
    const walletId = await openWallet('500.00');
    await bet(walletId, 'acme-tx-000123', '40.00');

    const answer = await request('GET', `/wallets/${walletId}/ledger`);
    const [opening, debit] = answer.body.items ?? [];

    expect(Object.keys(opening ?? {}).sort()).toEqual(ENTRY_MEMBERS);
    expect(opening).toMatchObject({
      walletId,
      kind: 'OPENING',
      direction: 'CREDIT',
      money: brl('500.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('500.00'),
      walletVersion: 1,
    });
    expect(opening).toHaveProperty('id', expect.stringMatching(UUID));
    expect(opening).toHaveProperty('createdAt', expect.stringMatching(RFC_3339));
    expect(debit).toMatchObject({
      kind: 'BET',
      direction: 'DEBIT',
      money: brl('40.00'),
      balanceBefore: brl('500.00'),
      balanceAfter: brl('460.00'),
      walletVersion: 2,
    });
    expect(answer.body.nextCursor).toBeNull();
  });

  test('limit 1 and limit 200 are both accepted, and the cursor is the wallet version', async () => {
    const walletId = await openWallet('500.00');
    await appendEntries(walletId, 1, 3);

    const smallest = await request('GET', `/wallets/${walletId}/ledger?limit=1`);
    const largest = await request('GET', `/wallets/${walletId}/ledger?limit=200`);

    expect(smallest.body.items).toHaveLength(1);
    expect(cursorContent(String(smallest.body.nextCursor))).toBe('v1:1');
    expect(largest.body.items).toHaveLength(4);
    expect(largest.body.nextCursor).toBeNull();
  });

  test('a limit outside 1 to 200 answers 400 VALIDATION_FAILED naming the query parameter', async () => {
    const walletId = await openWallet('500.00');

    for (const limit of ['0', '201', '-1', 'all', '1.5', '']) {
      const answer = await request('GET', `/wallets/${walletId}/ledger?limit=${limit}`);

      expect(answer.status).toBe(400);
      expect(answer.contentType).toStartWith('application/problem+json');
      expect(answer.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ path: '/query/limit', message: 'must be between 1 and 200' }],
      });
    }
  });

  test('a cursor the service did not issue answers 400 INVALID_CURSOR and writes nothing', async () => {
    const walletId = await openWallet('500.00');
    const entries = await rowCount('wallet_ledger_entries');

    for (const cursor of ['', 'nope', base64url('v2:1'), base64url('v1:0'), 'djE6Mg==']) {
      const answer = await request(
        'GET',
        `/wallets/${walletId}/ledger?cursor=${encodeURIComponent(cursor)}`,
      );

      expect(answer.status).toBe(400);
      expect(answer.contentType).toStartWith('application/problem+json');
      expect(answer.body).toMatchObject({
        type: 'urn:problem-type:wagering:INVALID_CURSOR',
        title: 'Invalid cursor',
        status: 400,
        detail: 'The cursor is malformed; restart pagination from the first page.',
        code: 'INVALID_CURSOR',
        correlationId: CORRELATION_ID,
      });
      expect(answer.body).not.toHaveProperty('errors');
    }

    expect(await rowCount('wallet_ledger_entries')).toBe(entries);
  });

  test('a well-formed cursor beyond the last entry is an empty last page', async () => {
    const walletId = await openWallet('500.00');

    const answer = await request('GET', `/wallets/${walletId}/ledger?cursor=${base64url('v1:99')}`);

    expect(answer.status).toBe(200);
    expect(answer.body.items).toEqual([]);
    expect(answer.body.nextCursor).toBeNull();
  });

  test('an unknown wallet answers 404 WALLET_NOT_FOUND', async () => {
    const answer = await request('GET', `/wallets/${UNKNOWN_WALLET_ID}/ledger`);

    expect(answer.status).toBe(404);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({
      code: 'WALLET_NOT_FOUND',
      detail: `No wallet has id ${UNKNOWN_WALLET_ID}.`,
    });
  });

  test('a wallet id that is not a UUID answers 400 naming the path parameter', async () => {
    const answer = await request('GET', '/wallets/not-a-uuid/ledger');

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/path/walletId', message: 'must be a lowercase UUID' }],
    });
  });

  test('a wallet opened with no ledger pages as an empty last page', async () => {
    const walletId = await openWallet('0.00');

    const answer = await request('GET', `/wallets/${walletId}/ledger`);

    expect(answer.status).toBe(200);
    expect(answer.body.items).toEqual([]);
    expect(answer.body.nextCursor).toBeNull();
  });
});
