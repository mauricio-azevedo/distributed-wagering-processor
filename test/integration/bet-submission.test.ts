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

/**
 * The lock ceiling this suite runs the service with (`conc.row-lock`). It is the deployment's
 * setting, so a test is free to choose one: a quarter of a second proves the mapping of a lock wait
 * to `503` without holding the suite for the three seconds a production ceiling would.
 */
const LOCK_TIMEOUT_MS = 250;

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `api.outcome-shape`: the members every submission outcome carries, and no others. */
const OUTCOME_MEMBERS = ['balance', 'idempotentReplay', 'status', 'transactionId'];

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let app: INestApplication;
let baseUrl: string;
let metrics: MetricsRegistry;

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
  metrics = app.get(MetricsRegistry);
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

/** The members this suite reads off a response body, an outcome's and a problem's together. */
interface Body {
  readonly id?: string;
  readonly transactionId?: string;
  readonly status?: string | number;
  readonly balance?: MoneyBody;
  readonly idempotentReplay?: boolean;
  readonly failureCode?: string;
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
  readonly retryAfter: string | null;
  readonly body: Body;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function post(
  path: string,
  options: {
    body?: unknown;
    idempotencyKey?: string | null;
    correlationId?: string | null;
  } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.idempotencyKey === undefined || options.idempotencyKey === null
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
      ...(options.correlationId === null ? {} : { 'x-correlation-id': CORRELATION_ID }),
    },
    body: JSON.stringify(options.body ?? {}),
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    correlationId: response.headers.get('x-correlation-id'),
    retryAfter: response.headers.get('retry-after'),
    body: (await response.json()) as Body,
  };
}

async function openWallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const answer = await post('/wallets', {
    body: { playerId, initialBalance: brl(initialBalance) },
  });

  if (answer.status !== 201 || typeof answer.body.id !== 'string') {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(answer.body.id);
}

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
function bet(walletId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl('40.00'),
    ...overrides,
  };
}

const keyFor = (body: Record<string, unknown>): string =>
  `${String(body['providerId'])}:${String(body['externalTransactionId'])}`;

/** One submission, with the recommended key unless the case is about the key itself. */
function submit(
  body: Record<string, unknown>,
  options: { idempotencyKey?: string | null; correlationId?: string | null } = {},
): Promise<Answer> {
  return post('/wagering/transactions', {
    body,
    idempotencyKey: options.idempotencyKey === undefined ? keyFor(body) : options.idempotencyKey,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  });
}

interface WalletRow {
  readonly balance: string;
  readonly version: number;
}

interface LedgerRow {
  readonly transaction_id: string;
  readonly kind: string;
  readonly direction: string;
  readonly amount: string;
  readonly balance_before: string;
  readonly balance_after: string;
  readonly wallet_version: number;
}

interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly observed_balance: string | null;
  readonly observed_balance_currency: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly processed_at: Date | null;
  readonly payload_hash: string;
  readonly idempotency_key: string;
}

interface OutboxRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly published_at: Date | null;
  readonly payload: { readonly correlationId: string; readonly causationId: string };
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

const ledgerRows = (walletId: string): Promise<LedgerRow[]> =>
  sql<LedgerRow>(
    `select "transaction_id", "kind", "direction", "amount"::text as "amount",
            "balance_before"::text as "balance_before", "balance_after"::text as "balance_after",
            "wallet_version"
       from "wallet_ledger_entries" where "wallet_id" = ? order by "wallet_version"`,
    [walletId],
  );

const transactionRows = (walletId: string): Promise<TransactionRow[]> =>
  sql<TransactionRow>(
    `select "id", "kind", "status", "failure_code", "observed_balance"::text as "observed_balance",
            "observed_balance_currency", "amount"::text as "amount", "currency", "processed_at",
            "payload_hash", "idempotency_key"
       from "wager_transactions" where "wallet_id" = ? order by "created_at", "kind"`,
    [walletId],
  );

const outboxRows = (walletId: string): Promise<OutboxRow[]> =>
  sql<OutboxRow>(
    `select "event_id", "event_type", "aggregate_id", "published_at", "payload"
       from "outbox_messages" where "aggregate_id" = ? order by "occurred_at", "event_type"`,
    [walletId],
  );

describe('bet-debits-once', () => {
  test('a covered bet answers 200 with the new balance and writes the four rows of the operation', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId));

    expect(answer.status).toBe(200);
    expect(answer.contentType).toStartWith('application/json');
    expect(Object.keys(answer.body).sort()).toEqual(OUTCOME_MEMBERS);
    expect(answer.body.transactionId).toMatch(UUID);
    expect(answer.body.status).toBe('PROCESSED');
    expect(answer.body.balance).toEqual(brl('460.00'));
    expect(answer.body.idempotentReplay).toBe(false);

    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });

    const entries = await ledgerRows(walletId);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      transaction_id: answer.body.transactionId,
      kind: 'BET',
      direction: 'DEBIT',
      amount: '40.00',
      balance_before: '500.00',
      balance_after: '460.00',
      wallet_version: 2,
    });
  });

  test('the transaction row carries the outcome, the observed balance and the payload hash', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId));

    const submitted = (await transactionRows(walletId)).find((row) => row.kind === 'BET');

    expect(submitted).toMatchObject({
      id: answer.body.transactionId,
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '460.00',
      observed_balance_currency: 'BRL',
      amount: '40.00',
      currency: 'BRL',
      idempotency_key: 'provider-acme:acme-tx-000123',
    });
    expect(submitted?.payload_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(submitted?.processed_at).not.toBeNull();
  });

  test('the two events of the debit are enqueued unpublished, with the request correlation id', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId));

    const events = (await outboxRows(walletId)).filter(
      (row) => row.payload.causationId === answer.body.transactionId,
    );

    expect(events.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.aggregate_id).toBe(walletId);
      expect(event.payload.correlationId).toBe(CORRELATION_ID);
      expect(event.event_id).toMatch(UUID);
      // `outbox.publish-after-commit`: a committed row is pending until a publisher relays it.
      expect(event.published_at).toBeNull();
    }
  });
});

describe('bet-insufficient-balance-rejected', () => {
  test('a bet above the balance answers 422 with INSUFFICIENT_BALANCE and the observed balance', async () => {
    const walletId = await openWallet('100.00');

    const answer = await submit(bet(walletId, { money: brl('100.01') }));

    expect(answer.status).toBe(422);
    expect(answer.contentType).toStartWith('application/json');
    expect(Object.keys(answer.body).sort()).toEqual([...OUTCOME_MEMBERS, 'failureCode'].sort());
    expect(answer.body.status).toBe('REJECTED');
    expect(answer.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(answer.body.balance).toEqual(brl('100.00'));

    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
  });

  test('the rejection is persisted and auditable, with no ledger entry of its own', async () => {
    const walletId = await openWallet('100.00');

    const answer = await submit(bet(walletId, { money: brl('100.01') }));

    const rejected = (await transactionRows(walletId)).find((row) => row.kind === 'BET');

    expect(rejected).toMatchObject({
      id: answer.body.transactionId,
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_BALANCE',
      observed_balance: '100.00',
      processed_at: null,
    });
    expect(await ledgerRows(walletId)).toHaveLength(1); // the opening credit alone
  });
});

describe('rejection-has-no-side-effects', () => {
  test('a rejected bet changes nothing but its own row and its own event', async () => {
    const walletId = await openWallet('100.00');
    const before = {
      wallet: await walletRow(walletId),
      entries: await ledgerRows(walletId),
      events: await outboxRows(walletId),
    };

    const answer = await submit(bet(walletId, { money: brl('500.00') }));

    expect(answer.status).toBe(422);
    expect(await walletRow(walletId)).toEqual(before.wallet);
    expect(await ledgerRows(walletId)).toEqual(before.entries);

    const kept = new Set(before.events.map((row) => row.event_id));
    const added = (await outboxRows(walletId)).filter((row) => !kept.has(row.event_id));

    expect(added.map((row) => row.event_type)).toEqual(['WagerTransactionRejected']);
    expect(added[0]?.payload.causationId).toBe(answer.body.transactionId ?? '');
  });
});

describe('wallet-rejects-foreign-currency', () => {
  test('a bet in another currency is 422 CURRENCY_MISMATCH, persisted, with the wallet balance observed', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { money: { amount: '40.00', currency: 'USD' } }));

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(answer.body.balance).toEqual(brl('500.00'));

    const rejected = (await transactionRows(walletId)).find((row) => row.kind === 'BET');
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failure_code: 'CURRENCY_MISMATCH',
      currency: 'USD',
      observed_balance: '500.00',
      observed_balance_currency: 'BRL',
    });
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
    expect(await ledgerRows(walletId)).toHaveLength(1);
  });
});

describe('wallet-rejects-foreign-player', () => {
  test('a bet naming another player is 422 WALLET_PLAYER_MISMATCH and moves nothing', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { playerId: OTHER_PLAYER_ID }));

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
    expect(await ledgerRows(walletId)).toHaveLength(1);
  });
});

describe('replay-returns-stored-outcome', () => {
  test('the same request twice answers the same outcome, the second time as a replay', async () => {
    const walletId = await openWallet('500.00');

    const first = await submit(bet(walletId));
    const second = await submit(bet(walletId));

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('a rejected outcome replays as the same 422 with the same failure code', async () => {
    const walletId = await openWallet('100.00');

    const first = await submit(bet(walletId, { money: brl('500.00') }));
    const second = await submit(bet(walletId, { money: brl('500.00') }));

    expect([first.status, second.status]).toEqual([422, 422]);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
  });
});

describe('replay-writes-nothing', () => {
  test('a replay touches neither the wallet, nor the ledger, nor the outbox', async () => {
    const walletId = await openWallet('500.00');
    await submit(bet(walletId));
    const before = {
      wallet: await walletRow(walletId),
      entries: await ledgerRows(walletId),
      events: await outboxRows(walletId),
      transactions: await transactionRows(walletId),
    };

    await submit(bet(walletId));

    expect(await walletRow(walletId)).toEqual(before.wallet);
    expect(await ledgerRows(walletId)).toEqual(before.entries);
    expect(await outboxRows(walletId)).toEqual(before.events);
    expect(await transactionRows(walletId)).toEqual(before.transactions);
  });
});

describe('replay-after-wallet-change', () => {
  test('a replay reports the balance observed when the outcome was recorded, not the current one', async () => {
    const walletId = await openWallet('500.00');
    const applied = await submit(bet(walletId));

    const later = await submit(
      bet(walletId, { externalTransactionId: 'acme-tx-000124', money: brl('60.00') }),
    );
    expect(later.body.balance).toEqual(brl('400.00'));

    const replay = await submit(bet(walletId));

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.balance).toEqual(brl('460.00'));
    expect(replay.body.transactionId).toBe(applied.body.transactionId);
  });
});

describe('version-tracks-balance-changes-only', () => {
  test('the version moves with the debit and stands still for the replay, the rejection and the LOSS', async () => {
    const walletId = await openWallet('100.00');
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });

    await submit(bet(walletId));
    expect(await walletRow(walletId)).toEqual({ balance: '60.00', version: 2 });

    await submit(bet(walletId));
    expect(await walletRow(walletId)).toEqual({ balance: '60.00', version: 2 });

    const rejected = await submit(
      bet(walletId, { externalTransactionId: 'acme-tx-000125', money: brl('100.00') }),
    );
    expect(rejected.status).toBe(422);
    expect(await walletRow(walletId)).toEqual({ balance: '60.00', version: 2 });

    const loss = await submit(
      bet(walletId, { externalTransactionId: 'acme-tx-000126', kind: 'LOSS' }),
    );
    expect(loss.status).toBe(200);
    expect(await walletRow(walletId)).toEqual({ balance: '60.00', version: 2 });
  });
});

describe('idempotency-conflicts-persist-nothing', () => {
  test('the same key with another payload is 409 IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const walletId = await openWallet('500.00');
    await submit(bet(walletId));
    const before = await transactionRows(walletId);

    const conflict = await submit(bet(walletId, { money: brl('41.00') }));

    expect(conflict.status).toBe(409);
    expect(conflict.contentType).toStartWith('application/problem+json');
    expect(conflict.body).toMatchObject({
      type: 'urn:problem-type:wagering:IDEMPOTENCY_PAYLOAD_MISMATCH',
      title: 'Idempotency payload mismatch',
      status: 409,
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      correlationId: CORRELATION_ID,
    });
    expect(await transactionRows(walletId)).toEqual(before);
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
  });

  test('another key for the same provider transaction id is 409 EXTERNAL_TRANSACTION_ALREADY_BOUND', async () => {
    const walletId = await openWallet('500.00');
    await submit(bet(walletId));
    const before = await transactionRows(walletId);

    // Another payload too: once the provider transaction id exists, it is bound to the key that
    // first used it whatever the second arrival carries (additional policy C).
    const conflict = await submit(bet(walletId, { money: brl('41.00') }), {
      idempotencyKey: 'another-key',
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'EXTERNAL_TRANSACTION_ALREADY_BOUND',
      status: 409,
      detail: 'Transaction acme-tx-000123 of provider-acme is bound to another idempotency key.',
    });
    expect(await transactionRows(walletId)).toEqual(before);
  });

  test('two providers may use the same key string, because keys are scoped per provider', async () => {
    const walletId = await openWallet('500.00');

    const acme = await submit(bet(walletId), { idempotencyKey: 'round-7f3a' });
    const other = await submit(
      bet(walletId, { providerId: 'provider-bolt', externalTransactionId: 'bolt-tx-000001' }),
      { idempotencyKey: 'round-7f3a' },
    );

    expect([acme.status, other.status]).toEqual([200, 200]);
    expect(other.body.idempotentReplay).toBe(false);
    expect(other.body.transactionId).not.toBe(acme.body.transactionId);
    expect(await walletRow(walletId)).toEqual({ balance: '420.00', version: 3 });
  });
});

describe('request-errors-are-stateless', () => {
  test('a submission for an unknown wallet is 404 WALLET_NOT_FOUND and persists nothing', async () => {
    const answer = await submit(bet(UNKNOWN_WALLET_ID));

    expect(answer.status).toBe(404);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({
      code: 'WALLET_NOT_FOUND',
      status: 404,
      detail: `No wallet has id ${UNKNOWN_WALLET_ID}.`,
    });
    expect(await transactionRows(UNKNOWN_WALLET_ID)).toEqual([]);
  });

  test('the same submission is processed once the wallet exists, the key never having been taken', async () => {
    const absent = await submit(bet(UNKNOWN_WALLET_ID));
    expect(absent.status).toBe(404);

    const walletId = await openWallet('500.00');
    const applied = await submit(bet(walletId));

    expect(applied.status).toBe(200);
    expect(applied.body.idempotentReplay).toBe(false);
  });

  test('a missing Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId), { idempotencyKey: null });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      type: 'urn:problem-type:wagering:IDEMPOTENCY_KEY_REQUIRED',
      title: 'Idempotency key required',
      status: 400,
      detail: 'The Idempotency-Key header is missing.',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(await transactionRows(walletId)).toHaveLength(1); // the opening credit alone
  });

  test('a malformed Idempotency-Key is 400 VALIDATION_FAILED naming the header', async () => {
    const walletId = await openWallet('500.00');

    for (const idempotencyKey of ['has a space', 'k'.repeat(300)]) {
      const answer = await submit(bet(walletId), { idempotencyKey });

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(answer.body.errors).toEqual([
        {
          path: '/header/Idempotency-Key',
          message: 'must be 1 to 255 printable ASCII characters without spaces',
        },
      ]);
    }

    expect(await transactionRows(walletId)).toHaveLength(1); // the opening credit alone
  });

  test('each request error repeated answers the same and still persists nothing', async () => {
    const walletId = await openWallet('500.00');
    const before = await transactionRows(walletId);

    const repeated = [
      [
        await submit(bet(walletId, { money: brl('0.00') })),
        await submit(bet(walletId, { money: brl('0.00') })),
      ],
      [await submit(bet(UNKNOWN_WALLET_ID)), await submit(bet(UNKNOWN_WALLET_ID))],
      [
        await submit(bet(walletId), { idempotencyKey: null }),
        await submit(bet(walletId), { idempotencyKey: null }),
      ],
    ];

    expect(repeated.map(([first]) => first?.status)).toEqual([400, 404, 400]);
    for (const [first, second] of repeated) {
      expect(second?.status).toBe(first?.status ?? 0);
      expect(second?.body).toEqual(first?.body ?? {});
    }
    expect(await transactionRows(walletId)).toEqual(before);
  });
});

describe('internal-kind-and-provider-are-refused', () => {
  test('kind OPENING is 400 VALIDATION_FAILED naming the kinds a provider may submit', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { kind: 'OPENING' }));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toContainEqual({
      path: '/body/kind',
      message: 'must be one of BET, WIN, LOSS, REFUND, ROLLBACK',
    });
    expect(await transactionRows(walletId)).toHaveLength(1);
  });

  test('the reserved provider id system is 400 VALIDATION_FAILED', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { providerId: 'system' }));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toMatchObject([{ path: '/body/providerId' }]);
    expect(await transactionRows(walletId)).toHaveLength(1);
  });
});

describe('submission-validation-follows-the-contract', () => {
  test('a BET carrying a reference is 400, because a BET reverses nothing', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(
      bet(walletId, { referenceExternalTransactionId: 'acme-tx-000122' }),
    );

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toContainEqual({
      path: '/body/referenceExternalTransactionId',
      message: 'must be absent when kind is BET',
    });
  });

  test.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'])(
    'a %s of 0.00 is 400, because it would need a ledger entry that moves nothing',
    async (kind) => {
      const walletId = await openWallet('500.00');

      const answer = await submit(
        bet(walletId, {
          kind,
          money: brl('0.00'),
          ...(kind === 'REFUND' || kind === 'ROLLBACK'
            ? { referenceExternalTransactionId: 'acme-tx-000122' }
            : {}),
        }),
      );

      expect(answer.status).toBe(400);
      expect(answer.body.errors).toContainEqual({
        path: '/body/money/amount',
        message: 'must be greater than 0.00',
      });
      expect(await transactionRows(walletId)).toHaveLength(1);
    },
  );

  test.each(['BET', 'LOSS'])(
    'a %s of -5.00 is 400, because no input is ever negative',
    async (kind) => {
      const walletId = await openWallet('500.00');

      const answer = await submit(bet(walletId, { kind, money: brl('-5.00') }));

      expect(answer.status).toBe(400);
      expect(answer.body.errors).toMatchObject([{ path: '/body/money/amount' }]);
      expect(await transactionRows(walletId)).toHaveLength(1);
    },
  );

  test('a LOSS of 0.00 is PROCESSED, because it moves nothing and writes no entry', async () => {
    const walletId = await openWallet('460.00');

    const answer = await submit(bet(walletId, { kind: 'LOSS', money: brl('0.00') }));

    expect(answer.status).toBe(200);
    expect(answer.body.status).toBe('PROCESSED');
    expect(answer.body.balance).toEqual(brl('460.00'));
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 1 });
    expect(await ledgerRows(walletId)).toHaveLength(1);
  });

  test('a reference equal to the operation own id is 400, whatever the kind', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(
      bet(walletId, {
        kind: 'ROLLBACK',
        externalTransactionId: 'acme-tx-000126',
        referenceExternalTransactionId: 'acme-tx-000126',
      }),
    );

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toContainEqual({
      path: '/body/referenceExternalTransactionId',
      message: 'must differ from externalTransactionId',
    });
    expect(await transactionRows(walletId)).toHaveLength(1);
  });

  test('a REFUND without its reference is 400, because a reversal applies to a transaction', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { kind: 'REFUND' }));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toContainEqual({
      path: '/body/referenceExternalTransactionId',
      message: 'is required when kind is REFUND',
    });
  });

  test('a member the contract does not define is a violation, not an ignored extra', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { nickname: 'lucky' }));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toContainEqual({
      path: '/body/nickname',
      message: 'is not a member of this request',
    });
  });

  test('an amount or a currency the pattern refuses is a 400, never an unhandled parse', async () => {
    const walletId = await openWallet('500.00');

    const malformedAmount = await submit(bet(walletId, { money: brl('4') }));
    const malformedCurrency = await submit(
      bet(walletId, { money: { amount: '40.00', currency: 'brl' } }),
    );

    expect(malformedAmount.status).toBe(400);
    expect(malformedAmount.body.errors).toMatchObject([{ path: '/body/money/amount' }]);
    expect(malformedCurrency.status).toBe(400);
    expect(malformedCurrency.body.errors).toMatchObject([{ path: '/body/money/currency' }]);
    expect(await transactionRows(walletId)).toHaveLength(1);
  });

  test('an amount sent as a JSON number is refused, never rounded into money', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId, { money: { amount: 40, currency: 'BRL' } }));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toMatchObject([{ path: '/body/money/amount' }]);
  });
});

describe('correlation-id-propagates', () => {
  test('the id a caller sends is echoed and reaches the events of the operation', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId));

    expect(answer.correlationId).toBe(CORRELATION_ID);
    const events = (await outboxRows(walletId)).filter(
      (row) => row.payload.causationId === answer.body.transactionId,
    );
    expect(events.map((row) => row.payload.correlationId)).toEqual([
      CORRELATION_ID,
      CORRELATION_ID,
    ]);
  });

  test('a request without the header is answered with a generated id, which the events carry', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(bet(walletId), { correlationId: null });

    const generated = answer.correlationId ?? '';
    expect(generated).toMatch(/^[!-~]{1,128}$/);
    expect(generated).not.toBe(CORRELATION_ID);
    const events = (await outboxRows(walletId)).filter(
      (row) => row.payload.causationId === answer.body.transactionId,
    );
    expect(events.map((row) => row.payload.correlationId)).toEqual([generated, generated]);
  });
});

describe('outcome-shape-is-uniform', () => {
  test('the applied, the replayed and the rejected outcome carry one shape', async () => {
    const walletId = await openWallet('100.00');

    const applied = await submit(bet(walletId));
    const replayed = await submit(bet(walletId));
    const rejected = await submit(
      bet(walletId, { externalTransactionId: 'acme-tx-000127', money: brl('500.00') }),
    );

    for (const answer of [applied, replayed, rejected]) {
      expect(answer.body.transactionId).toMatch(UUID);
      expect(typeof answer.body.status).toBe('string');
      expect(answer.body.balance).toMatchObject({ currency: 'BRL' });
      expect(typeof answer.body.idempotentReplay).toBe('boolean');
    }

    expect(Object.keys(applied.body).sort()).toEqual(OUTCOME_MEMBERS);
    expect(Object.keys(replayed.body).sort()).toEqual(OUTCOME_MEMBERS);
    expect(Object.keys(rejected.body).sort()).toEqual([...OUTCOME_MEMBERS, 'failureCode'].sort());
  });
});

describe('transient-failure-503', () => {
  /**
   * A wallet row held by another session, which is what makes the submission wait on the lock of
   * ADR 0002. The migrator owns the tables, so it is the session a test may lock from; the lock is
   * released by rolling back, whatever the case did.
   */
  async function holdingTheWallet<T>(walletId: string, act: () => Promise<T>): Promise<T> {
    const holder = schema.em.fork();
    await holder.begin();

    try {
      await holder.execute('select "id" from "wallets" where "id" = ? for no key update', [
        walletId,
      ]);

      return await act();
    } finally {
      await holder.rollback();
    }
  }

  test('a lock wait past the ceiling answers 503 with Retry-After and persists nothing', async () => {
    const walletId = await openWallet('500.00');
    const conflicts = await metrics.total('wager_lock_conflicts_total');

    const answer = await holdingTheWallet(walletId, () => submit(bet(walletId)));

    expect(answer.status).toBe(503);
    expect(answer.contentType).toStartWith('application/problem+json');
    expect(answer.body).toMatchObject({
      type: 'urn:problem-type:wagering:SERVICE_UNAVAILABLE',
      title: 'Service unavailable',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: `The wallet lock was not acquired within ${LOCK_TIMEOUT_MS.toString()} ms.`,
    });
    expect(answer.retryAfter).toMatch(/^\d+$/);

    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
    expect(await transactionRows(walletId)).toHaveLength(1); // the opening credit alone

    // `obs.metrics`: the wait is counted where it was classified, so the same counter rises for a
    // request and for a message (CONC-002).
    expect(await metrics.total('wager_lock_conflicts_total')).toBe(conflicts + 1);
  });

  test('the same request after the lock is released is processed as new, not as a replay', async () => {
    const walletId = await openWallet('500.00');
    const refused = await holdingTheWallet(walletId, () => submit(bet(walletId)));
    expect(refused.status).toBe(503);

    const applied = await submit(bet(walletId));

    expect(applied.status).toBe(200);
    expect(applied.body.idempotentReplay).toBe(false);
    expect(applied.body.balance).toEqual(brl('460.00'));
    expect(await ledgerRows(walletId)).toHaveLength(2);
  });
});
