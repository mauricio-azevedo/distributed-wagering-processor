/**
 * `api.status-classes`: one situation answers with one status class wherever it can arise, so a
 * provider's error handling is written once and not per endpoint (API-001).
 *
 * The cases are a table over the two axes the contract names — the operations of
 * [docs/openapi.yaml](../../docs/openapi.yaml) and the four situations a request can be refused in
 * — and every cell is exercised against the running service. A malformed request, an unknown id and
 * a conflict are built by sending one; a transient failure is a second instance of the service whose
 * database is not there, which is the one refusal that is about the dependency rather than the
 * request and therefore reaches every endpoint that touches it (`api.transient-failure`).
 *
 * `422` is left out of the table on purpose: it is not a refusal of a request but a recorded
 * business outcome, and the last cases here are what hold that line — the only operation that
 * answers `422` is a submission, and the answer carries a persisted transaction.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import type { ErrorCode } from '../../src/domain/error-code';
import { type Env, loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

/** A database nothing listens on: every statement fails with `ECONNREFUSED` (`api.transient-failure`). */
const UNREACHABLE_DATABASE = 'postgres://wagering_app:wagering_app@127.0.0.1:1/wagering';

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';
const UNKNOWN_TRANSACTION_ID = '01a18266-39e0-758b-a289-fb48c2dd0000';
const PROVIDER_ID = 'provider-acme';

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
let service: INestApplication;
let withoutItsDatabase: INestApplication;

async function start(overrides: Partial<Env> = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.create({ ...env, ...overrides }), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);

  return app;
}

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  service = await start();
  withoutItsDatabase = await start({ DATABASE_URL: UNREACHABLE_DATABASE });
});

afterAll(async () => {
  await withoutItsDatabase.close();
  await service.close();
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Record<string, unknown>;
}

async function request(
  app: INestApplication,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${await app.getUrl()}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const contentType = response.headers.get('content-type') ?? '';

  return {
    status: response.status,
    contentType,
    body: contentType.includes('json')
      ? ((await response.json()) as Record<string, unknown>)
      : { text: await response.text() },
  };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const answer = await request(service, 'POST', '/wallets', {
    body: { playerId, initialBalance: brl(initialBalance) },
  });

  if (answer.status !== 201 || typeof answer.body['id'] !== 'string') {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(answer.body['id']);
}

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
const bet = (walletId: string, overrides: Record<string, unknown> = {}) => ({
  providerId: PROVIDER_ID,
  externalTransactionId: 'acme-tx-000123',
  playerId: PLAYER_ID,
  walletId,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
  ...overrides,
});

const keyFor = (body: Record<string, unknown>) =>
  `${String(body['providerId'])}:${String(body['externalTransactionId'])}`;

/** The state the cases below are refused against: a funded wallet with one applied bet. */
interface Fixture {
  readonly walletId: string;
  readonly transactionId: string;
}

async function fixture(): Promise<Fixture> {
  const walletId = await openWallet('100.00');
  const applied = await request(service, 'POST', '/wagering/transactions', {
    body: bet(walletId),
    idempotencyKey: keyFor(bet(walletId)),
  });

  if (applied.status !== 200) {
    throw new Error(`the applied bet answered ${applied.status.toString()}`);
  }

  return { walletId, transactionId: String(applied.body['transactionId']) };
}

type Situation = 'malformed' | 'unknown' | 'conflict' | 'transient';

interface Case {
  readonly operation: string;
  readonly situation: Situation;
  readonly status: number;
  readonly code: ErrorCode;
  readonly act: (state: Fixture) => Promise<Answer>;
}

/**
 * Every cell of the matrix. An operation is absent from a situation only where the situation cannot
 * arise: opening a wallet names no stored id, so nothing about it can be unknown, and a read has no
 * stored state to conflict with.
 */
const CASES: readonly Case[] = [
  {
    operation: 'openWallet',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: () =>
      request(service, 'POST', '/wallets', {
        body: { playerId: 'not-a-uuid', initialBalance: brl('1.00') },
      }),
  },
  {
    operation: 'openWallet',
    situation: 'conflict',
    status: 409,
    code: 'WALLET_ALREADY_EXISTS',
    act: () =>
      request(service, 'POST', '/wallets', {
        body: { playerId: PLAYER_ID, initialBalance: brl('1.00') },
      }),
  },
  {
    operation: 'openWallet',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: () =>
      request(withoutItsDatabase, 'POST', '/wallets', {
        body: { playerId: PLAYER_ID, initialBalance: brl('1.00') },
      }),
  },
  {
    operation: 'getWallet',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: () => request(service, 'GET', '/wallets/not-a-uuid'),
  },
  {
    operation: 'getWallet',
    situation: 'unknown',
    status: 404,
    code: 'WALLET_NOT_FOUND',
    act: () => request(service, 'GET', `/wallets/${UNKNOWN_WALLET_ID}`),
  },
  {
    operation: 'getWallet',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: ({ walletId }) => request(withoutItsDatabase, 'GET', `/wallets/${walletId}`),
  },
  {
    operation: 'listWalletLedger',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: ({ walletId }) => request(service, 'GET', `/wallets/${walletId}/ledger?limit=0`),
  },
  {
    operation: 'listWalletLedger',
    situation: 'malformed',
    status: 400,
    code: 'INVALID_CURSOR',
    act: ({ walletId }) => request(service, 'GET', `/wallets/${walletId}/ledger?cursor=nonsense`),
  },
  {
    operation: 'listWalletLedger',
    situation: 'unknown',
    status: 404,
    code: 'WALLET_NOT_FOUND',
    act: () => request(service, 'GET', `/wallets/${UNKNOWN_WALLET_ID}/ledger`),
  },
  {
    operation: 'listWalletLedger',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: ({ walletId }) => request(withoutItsDatabase, 'GET', `/wallets/${walletId}/ledger`),
  },
  {
    operation: 'reconcileWallet',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: () => request(service, 'POST', '/wallets/not-a-uuid/reconciliation'),
  },
  {
    operation: 'reconcileWallet',
    situation: 'unknown',
    status: 404,
    code: 'WALLET_NOT_FOUND',
    act: () => request(service, 'POST', `/wallets/${UNKNOWN_WALLET_ID}/reconciliation`),
  },
  {
    operation: 'reconcileWallet',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: ({ walletId }) =>
      request(withoutItsDatabase, 'POST', `/wallets/${walletId}/reconciliation`),
  },
  {
    operation: 'submitWagerTransaction',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: ({ walletId }) =>
      request(service, 'POST', '/wagering/transactions', {
        body: bet(walletId, { kind: 'OPENING' }),
        idempotencyKey: 'provider-acme:acme-tx-000900',
      }),
  },
  {
    operation: 'submitWagerTransaction',
    situation: 'malformed',
    status: 400,
    code: 'IDEMPOTENCY_KEY_REQUIRED',
    act: ({ walletId }) =>
      request(service, 'POST', '/wagering/transactions', { body: bet(walletId) }),
  },
  {
    operation: 'submitWagerTransaction',
    situation: 'unknown',
    status: 404,
    code: 'WALLET_NOT_FOUND',
    act: () =>
      request(service, 'POST', '/wagering/transactions', {
        body: bet(UNKNOWN_WALLET_ID, { externalTransactionId: 'acme-tx-000901' }),
        idempotencyKey: 'provider-acme:acme-tx-000901',
      }),
  },
  {
    operation: 'submitWagerTransaction',
    situation: 'conflict',
    status: 409,
    code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    act: ({ walletId }) =>
      request(service, 'POST', '/wagering/transactions', {
        body: bet(walletId, { money: brl('41.00') }),
        idempotencyKey: keyFor(bet(walletId)),
      }),
  },
  {
    operation: 'submitWagerTransaction',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: ({ walletId }) =>
      request(withoutItsDatabase, 'POST', '/wagering/transactions', {
        body: bet(walletId, { externalTransactionId: 'acme-tx-000902' }),
        idempotencyKey: 'provider-acme:acme-tx-000902',
      }),
  },
  {
    operation: 'getWagerTransaction',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: () => request(service, 'GET', '/wagering/transactions/not-a-uuid'),
  },
  {
    operation: 'getWagerTransaction',
    situation: 'unknown',
    status: 404,
    code: 'TRANSACTION_NOT_FOUND',
    act: () => request(service, 'GET', `/wagering/transactions/${UNKNOWN_TRANSACTION_ID}`),
  },
  {
    operation: 'getWagerTransaction',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: ({ transactionId }) =>
      request(withoutItsDatabase, 'GET', `/wagering/transactions/${transactionId}`),
  },
  {
    operation: 'getWagerTransactionByProvider',
    situation: 'malformed',
    status: 400,
    code: 'VALIDATION_FAILED',
    act: () =>
      request(service, 'GET', `/providers/${PROVIDER_ID}/wagering/transactions/${'x'.repeat(121)}`),
  },
  {
    operation: 'getWagerTransactionByProvider',
    situation: 'unknown',
    status: 404,
    code: 'TRANSACTION_NOT_FOUND',
    act: () =>
      request(service, 'GET', `/providers/${PROVIDER_ID}/wagering/transactions/acme-tx-999999`),
  },
  {
    operation: 'getWagerTransactionByProvider',
    situation: 'transient',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    act: () =>
      request(
        withoutItsDatabase,
        'GET',
        `/providers/${PROVIDER_ID}/wagering/transactions/acme-tx-000123`,
      ),
  },
];

const label = (subject: Case) => `${subject.operation} ${subject.situation} ${subject.code}`;

describe('status-classes-consistent', () => {
  test('one situation answers with one status class on every endpoint it can arise on', async () => {
    const state = await fixture();
    const answers = [];

    for (const subject of CASES) {
      const answer = await subject.act(state);

      answers.push({
        case: label(subject),
        status: answer.status,
        code: answer.body['code'],
        problem: answer.contentType.startsWith('application/problem+json'),
      });
    }

    expect(answers).toEqual(
      CASES.map((subject) => ({
        case: label(subject),
        status: subject.status,
        code: subject.code,
        problem: true,
      })),
    );
  });

  test('the four situations are each exercised on every endpoint they can arise on', () => {
    const operations = [...new Set(CASES.map((subject) => subject.operation))];
    const covered = new Set(CASES.map((subject) => `${subject.operation} ${subject.situation}`));

    // A read conflicts with nothing and opening a wallet names no stored id; everything else is a
    // cell the table has to carry, and a missing one is a situation nobody checked.
    expect(
      operations.flatMap((operation) =>
        (['malformed', 'unknown', 'conflict', 'transient'] as const)
          .filter((situation) => !covered.has(`${operation} ${situation}`))
          .map((situation) => `${operation} ${situation}`),
      ),
    ).toEqual([
      'openWallet unknown',
      'getWallet conflict',
      'listWalletLedger conflict',
      'reconcileWallet conflict',
      'getWagerTransaction conflict',
      'getWagerTransactionByProvider conflict',
    ]);
  });

  test('422 is a recorded business rejection and nothing else answers with it', async () => {
    const { walletId } = await fixture();
    const rejection = await request(service, 'POST', '/wagering/transactions', {
      body: bet(walletId, { externalTransactionId: 'acme-tx-000903', money: brl('500.00') }),
      idempotencyKey: 'provider-acme:acme-tx-000903',
    });

    expect(rejection.status).toBe(422);
    expect(rejection.contentType).toStartWith('application/json');
    expect(rejection.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      idempotentReplay: false,
    });

    // The rejection is persisted, which is what separates a `422` from the request-level refusals
    // of the table above (`api.validation-stateless`).
    expect(
      await runtime.em
        .getConnection()
        .execute<{ status: string }[]>(
          `select "status" from "wager_transactions" where "idempotency_key" = ?`,
          ['provider-acme:acme-tx-000903'],
        ),
    ).toEqual([{ status: 'REJECTED' }]);

    // A reconciliation that finds a divergence is an answer about the wallet and not a rejection of
    // the request, so the one other operation that could have claimed `422` answers `200`
    // (`api.reconciliation`).
    expect((await request(service, 'POST', `/wallets/${walletId}/reconciliation`)).status).toBe(
      200,
    );
  });
});
