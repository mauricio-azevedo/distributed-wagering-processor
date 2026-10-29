import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import { AppModule } from '../../src/app.module';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

/**
 * The lock ceiling this suite runs the service with (`conc.row-lock`). It is well above what the
 * two concurrent reversals of RULE-016 need to queue behind each other, because this suite proves
 * what the lock serializes and not what happens when it gives up; the lock timeout itself is
 * proven by the submission suite.
 */
const LOCK_TIMEOUT_MS = 2_000;

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

/** `money.bound`: the largest balance a wallet can hold (MONEY-013). */
const MONEY_BOUND = '999999999999999999.99';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SUBMIT_IN_A_PROCESS = path.join(ROOT, 'test', 'helpers', 'submit-transaction.ts');

const PROVIDER_ID = 'provider-acme';
const OTHER_PROVIDER_ID = 'provider-zeta';
const ROUND_ID = 'round-7f3a';

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

// `recon.final-invariant` (RECON-004): every kind here moves money, so each test ends by rebuilding
// the balance of the wallets it touched from their ledgers, before the next truncation.
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

async function openWallet(initialBalance: string, playerId = PLAYER_ID): Promise<string> {
  const answer = await post('/wallets', { playerId, initialBalance: brl(initialBalance) });

  if (answer.status !== 201 || typeof answer.body.id !== 'string') {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(answer.body.id);
}

/**
 * One operation of the `POST /wagering/transactions` examples of [docs/openapi.yaml], with the
 * provider transaction id as its first argument: a reference names it, so every submission a case
 * refers to later is spelled by the test rather than derived.
 */
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

/** What another instance recorded for a submission it applied (RULE-016). */
interface InstanceOutcome {
  readonly status: string;
  readonly failureCode: string | null;
}

/**
 * One submission applied by another instance of the service, in a process of its own, against the
 * same database. It is the apparatus for a rule that has to hold across instances rather than
 * inside one: nothing but PostgreSQL is shared, so no heap, entity manager or connection pool can
 * be what serializes the two.
 */
async function submitInAnotherInstance(body: Operation): Promise<InstanceOutcome> {
  const process_ = Bun.spawn(
    [
      process.execPath,
      'run',
      SUBMIT_IN_A_PROCESS,
      JSON.stringify({
        operation: body,
        idempotencyKey: `${String(body['providerId'])}:${String(body['externalTransactionId'])}`,
        correlationId: CORRELATION_ID,
      }),
    ],
    { cwd: ROOT, env: process.env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);

  if (code !== 0) {
    throw new Error(`submitting in another instance exited ${code.toString()}: ${stdout}${stderr}`);
  }

  return JSON.parse(stdout) as InstanceOutcome;
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

interface WalletRow {
  readonly balance: string;
  readonly version: number;
}

interface LedgerRow {
  readonly transaction_id: string;
  readonly kind: string;
  readonly direction: string;
  readonly amount: string;
  readonly balance_after: string;
  readonly wallet_version: number;
}

interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly observed_balance: string | null;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly processed_at: Date | null;
}

interface OutboxRow {
  readonly event_type: string;
  readonly payload: {
    readonly causationId: string;
    readonly data: Record<string, unknown>;
  };
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
            "balance_after"::text as "balance_after", "wallet_version"
       from "wallet_ledger_entries" where "wallet_id" = ? order by "wallet_version"`,
    [walletId],
  );

const transactionRow = async (transactionId: string): Promise<TransactionRow | undefined> =>
  (
    await sql<TransactionRow>(
      `select "id", "kind", "status", "failure_code",
              "observed_balance"::text as "observed_balance", "reference_external_transaction_id",
              "reference_transaction_id", "processed_at"
         from "wager_transactions" where "id" = ?`,
      [transactionId],
    )
  )[0];

const eventsOf = (transactionId: string): Promise<OutboxRow[]> =>
  sql<OutboxRow>(
    `select "event_type", "payload" from "outbox_messages"
      where "payload" ->> 'causationId' = ? order by "event_type"`,
    [transactionId],
  );

const eventTypesOf = async (transactionId: string): Promise<string[]> =>
  (await eventsOf(transactionId)).map((row) => row.event_type);

describe('win-credits-once', () => {
  test('a WIN answers 200 with the credited balance and writes one CREDIT entry', async () => {
    const walletId = await openWallet('460.00');

    const answer = await submit(operation('acme-win-1', 'WIN', walletId, { money: brl('65.00') }));

    expect(answer.status).toBe(200);
    expect(answer.body.status).toBe('PROCESSED');
    expect(answer.body.balance).toEqual(brl('525.00'));

    expect(await walletRow(walletId)).toEqual({ balance: '525.00', version: 2 });

    const entries = await ledgerRows(walletId);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      transaction_id: answer.body.transactionId,
      kind: 'WIN',
      direction: 'CREDIT',
      amount: '65.00',
      balance_after: '525.00',
      wallet_version: 2,
    });
    expect(await eventTypesOf(String(answer.body.transactionId))).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });
});

describe('win-optional-reference', () => {
  test('a WIN is processed with no reference, with one of its round, and refused for another round', async () => {
    const walletId = await openWallet('500.00');
    const betId = await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(operation('acme-bet-2', 'BET', walletId, { roundId: 'round-other' }));

    const unreferenced = await submit(
      operation('acme-win-1', 'WIN', walletId, { money: brl('65.00') }),
    );
    const referenced = await submit(
      operation('acme-win-2', 'WIN', walletId, {
        money: brl('10.00'),
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const otherRound = await submit(
      operation('acme-win-3', 'WIN', walletId, {
        referenceExternalTransactionId: 'acme-bet-2',
      }),
    );

    expect(unreferenced.body.status).toBe('PROCESSED');
    expect(referenced.body.status).toBe('PROCESSED');
    expect(
      (await transactionRow(String(referenced.body.transactionId)))?.reference_transaction_id,
    ).toBe(betId);

    expect(otherRound.status).toBe(422);
    expect(otherRound.body.failureCode).toBe('REFERENCE_MISMATCH');
    expect(await walletRow(walletId)).toEqual({ balance: '495.00', version: 5 });
  });
});

describe('loss-has-no-balance-effect', () => {
  test('a LOSS of any amount is PROCESSED while balance, version and ledger stand still', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));

    const spent = await submit(operation('acme-loss-1', 'LOSS', walletId));
    const zero = await submit(operation('acme-loss-2', 'LOSS', walletId, { money: brl('0.00') }));

    for (const answer of [spent, zero]) {
      expect(answer.status).toBe(200);
      expect(answer.body.status).toBe('PROCESSED');
      expect(answer.body.balance).toEqual(brl('460.00'));
      expect(await eventTypesOf(String(answer.body.transactionId))).toEqual([
        'WagerTransactionProcessed',
      ]);
      expect(await transactionRow(String(answer.body.transactionId))).toMatchObject({
        status: 'PROCESSED',
        failure_code: null,
        observed_balance: '460.00',
      });
    }

    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect((await ledgerRows(walletId)).map((entry) => entry.kind)).toEqual(['OPENING', 'BET']);
  });

  test('the processed event of a LOSS reports the wallet as it stands and no movement', async () => {
    const walletId = await openWallet('460.00');

    const answer = await submit(operation('acme-loss-1', 'LOSS', walletId));
    const [processed] = await eventsOf(String(answer.body.transactionId));

    expect(processed?.payload.data).toMatchObject({
      kind: 'LOSS',
      money: brl('40.00'),
      balanceAfter: brl('460.00'),
      walletVersion: 1,
    });
  });
});

describe('loss-optional-reference', () => {
  test('a LOSS referencing its round is processed, one of another player is refused', async () => {
    const walletId = await openWallet('500.00');
    const otherWalletId = await openWallet('500.00', OTHER_PLAYER_ID);
    await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(operation('acme-bet-2', 'BET', otherWalletId, { playerId: OTHER_PLAYER_ID }));

    const referenced = await submit(
      operation('acme-loss-1', 'LOSS', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const otherPlayer = await submit(
      operation('acme-loss-2', 'LOSS', walletId, {
        referenceExternalTransactionId: 'acme-bet-2',
      }),
    );

    expect(referenced.body.status).toBe('PROCESSED');
    expect(otherPlayer.status).toBe(422);
    expect(otherPlayer.body.failureCode).toBe('REFERENCE_MISMATCH');
  });
});

describe('refund-credits-bet-once', () => {
  test('a REFUND credits the referenced BET back and records which transaction it reversed', async () => {
    const walletId = await openWallet('500.00');
    const betId = await applied(operation('acme-bet-1', 'BET', walletId));

    const answer = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(answer.status).toBe(200);
    expect(answer.body.balance).toEqual(brl('500.00'));

    const entries = await ledgerRows(walletId);
    expect(entries.map((entry) => [entry.kind, entry.direction])).toEqual([
      ['OPENING', 'CREDIT'],
      ['BET', 'DEBIT'],
      ['REFUND', 'CREDIT'],
    ]);
    expect(await transactionRow(String(answer.body.transactionId))).toMatchObject({
      status: 'PROCESSED',
      reference_external_transaction_id: 'acme-bet-1',
      reference_transaction_id: betId,
    });
    expect((await eventsOf(String(answer.body.transactionId)))[0]?.payload.data).toMatchObject({
      referenceTransactionId: betId,
      referenceExternalTransactionId: 'acme-bet-1',
    });
  });
});

describe('refund-references-only-bets', () => {
  test('a REFUND of a processed WIN is 422 REFERENCE_KIND_NOT_ALLOWED and moves nothing', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-win-1', 'WIN', walletId));

    const answer = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-win-1',
      }),
    );

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    expect(await walletRow(walletId)).toEqual({ balance: '540.00', version: 2 });
  });
});

describe('rollback-inverts-reference', () => {
  test('a ROLLBACK of a BET credits it back', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(answer.body.balance).toEqual(brl('500.00'));
    expect((await ledgerRows(walletId))[2]).toMatchObject({
      kind: 'ROLLBACK',
      direction: 'CREDIT',
      amount: '40.00',
    });
  });

  test('a ROLLBACK of a WIN debits it back', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-win-1', 'WIN', walletId, { money: brl('65.00') }));

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        money: brl('65.00'),
        referenceExternalTransactionId: 'acme-win-1',
      }),
    );

    expect(answer.body.balance).toEqual(brl('500.00'));
    expect((await ledgerRows(walletId))[2]).toMatchObject({
      kind: 'ROLLBACK',
      direction: 'DEBIT',
      amount: '65.00',
    });
  });

  test('a ROLLBACK of a REFUND debits the refunded amount back', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-refund-1',
      }),
    );

    expect(answer.body.balance).toEqual(brl('460.00'));
    expect((await ledgerRows(walletId))[3]).toMatchObject({
      kind: 'ROLLBACK',
      direction: 'DEBIT',
      amount: '40.00',
    });
  });
});

describe('rollback-allowed-kinds', () => {
  test('a ROLLBACK of a ROLLBACK or of a LOSS is 422 REFERENCE_KIND_NOT_ALLOWED', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    await applied(operation('acme-loss-1', 'LOSS', walletId));

    for (const referenced of ['acme-rollback-1', 'acme-loss-1']) {
      const answer = await submit(
        operation(`acme-rollback-of-${referenced}`, 'ROLLBACK', walletId, {
          referenceExternalTransactionId: referenced,
        }),
      );

      expect(answer.status).toBe(422);
      expect(answer.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    }

    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
  });

  /*
   * The OPENING credit is the third target `rule.rollback.allowed-kinds` names, and no submission
   * can reach it: resolution is scoped to the submitting provider (`rule.reference.resolution`) and
   * the credit carries the reserved provider id, which a request may not use
   * (`tx.opening-internal`). A provider naming the wallet id, which is the external transaction id
   * of its opening credit, therefore resolves nothing and waits. That the domain answers
   * REFERENCE_KIND_NOT_ALLOWED for an OPENING is proven without a database in RULE-020.
   */
  test('the opening credit of a wallet is unreachable from a submission, so naming it waits', async () => {
    const walletId = await openWallet('500.00');

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: walletId,
      }),
    );

    expect(answer.status).toBe(202);
    expect(answer.body.status).toBe('PENDING_REFERENCE');
    expect(answer.location).toBe(`/wagering/transactions/${String(answer.body.transactionId)}`);
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 1 });
  });
});

describe('reference-resolves-within-provider', () => {
  test('two providers sharing an external id each resolve their own transaction', async () => {
    const walletId = await openWallet('500.00');
    const otherWalletId = await openWallet('500.00', OTHER_PLAYER_ID);

    const ourBet = await applied(operation('shared-tx-000001', 'BET', walletId));
    const theirBet = await applied(
      operation('shared-tx-000001', 'BET', otherWalletId, {
        providerId: OTHER_PROVIDER_ID,
        playerId: OTHER_PLAYER_ID,
      }),
    );

    const ourRefund = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'shared-tx-000001',
      }),
    );
    const theirRefund = await submit(
      operation('zeta-refund-1', 'REFUND', otherWalletId, {
        providerId: OTHER_PROVIDER_ID,
        playerId: OTHER_PLAYER_ID,
        referenceExternalTransactionId: 'shared-tx-000001',
      }),
    );

    expect(ourRefund.body.status).toBe('PROCESSED');
    expect(theirRefund.body.status).toBe('PROCESSED');
    expect(
      (await transactionRow(String(ourRefund.body.transactionId)))?.reference_transaction_id,
    ).toBe(ourBet);
    expect(
      (await transactionRow(String(theirRefund.body.transactionId)))?.reference_transaction_id,
    ).toBe(theirBet);
  });
});

describe('reference-same-context', () => {
  test('a reference of another wallet, player or round is 422 REFERENCE_MISMATCH', async () => {
    const walletId = await openWallet('500.00');
    const otherWalletId = await openWallet('500.00', OTHER_PLAYER_ID);
    await applied(operation('acme-bet-1', 'BET', otherWalletId, { playerId: OTHER_PLAYER_ID }));
    await applied(operation('acme-bet-2', 'BET', walletId, { roundId: 'round-other' }));

    const foreignWallet = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const foreignRound = await submit(
      operation('acme-refund-2', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-2',
      }),
    );
    const foreignPlayer = await submit(
      operation('acme-refund-3', 'REFUND', otherWalletId, {
        playerId: OTHER_PLAYER_ID,
        referenceExternalTransactionId: 'acme-bet-2',
      }),
    );

    for (const answer of [foreignWallet, foreignRound, foreignPlayer]) {
      expect(answer.status).toBe(422);
      expect(answer.body.failureCode).toBe('REFERENCE_MISMATCH');
    }

    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
    expect(await walletRow(otherWalletId)).toEqual({ balance: '460.00', version: 2 });
  });
});

describe('reference-must-be-processed', () => {
  test('a REFUND of a REJECTED BET is 422 REFERENCE_NOT_PROCESSED and changes nothing', async () => {
    const walletId = await openWallet('100.00');
    const rejected = await submit(
      operation('acme-bet-1', 'BET', walletId, { money: brl('100.01') }),
    );

    expect(rejected.body.failureCode).toBe('INSUFFICIENT_BALANCE');

    const answer = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        money: brl('100.01'),
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(answer.body.balance).toEqual(brl('100.00'));
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('reversal-amount-must-match', () => {
  test('a reversal of more or less than the referenced amount is 422 REFERENCE_AMOUNT_MISMATCH', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));

    const under = await submit(
      operation('acme-refund-1', 'REFUND', walletId, {
        money: brl('39.99'),
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    const over = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        money: brl('40.01'),
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    for (const answer of [under, over]) {
      expect(answer.status).toBe(422);
      expect(answer.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    }

    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 2 });
  });
});

describe('reference-reversed-once', () => {
  test('a ROLLBACK of a BET a REFUND already reversed is 422 REFERENCE_ALREADY_REVERSED', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
    expect(
      (await ledgerRows(walletId)).filter((entry) => entry.direction === 'CREDIT'),
    ).toHaveLength(2);
  });

  /*
   * Two instances, each in a process of its own, sharing nothing but PostgreSQL: the reversals of
   * one target are serialized by the wallet lock of ADR 0002, so one of them reads the other's
   * committed reversal and records the rejection the contract promises (ADR 0009).
   */
  test('two instances refunding one BET at the same time credit it once, the loser is rejected', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));

    const outcomes = await Promise.all(
      ['acme-refund-1', 'acme-refund-2'].map((externalTransactionId) =>
        submitInAnotherInstance(
          operation(externalTransactionId, 'REFUND', walletId, {
            referenceExternalTransactionId: 'acme-bet-1',
          }),
        ),
      ),
    );

    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['PROCESSED', 'REJECTED']);
    expect(outcomes.find((outcome) => outcome.status === 'REJECTED')?.failureCode).toBe(
      'REFERENCE_ALREADY_REVERSED',
    );
    expect(await walletRow(walletId)).toEqual({ balance: '500.00', version: 3 });
    expect((await ledgerRows(walletId)).filter((entry) => entry.kind === 'REFUND')).toHaveLength(1);
  });
});

describe('reversal-insufficient-balance-distinct-code', () => {
  test('a ROLLBACK of a WIN already spent is 422 REVERSAL_INSUFFICIENT_BALANCE', async () => {
    const walletId = await openWallet('0.00');
    await applied(operation('acme-win-1', 'WIN', walletId, { money: brl('65.00') }));
    await applied(operation('acme-bet-1', 'BET', walletId, { money: brl('65.00') }));

    const answer = await submit(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        money: brl('65.00'),
        referenceExternalTransactionId: 'acme-win-1',
      }),
    );

    expect(answer.status).toBe(422);
    expect(answer.body.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');
    expect(await transactionRow(String(answer.body.transactionId))).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REVERSAL_INSUFFICIENT_BALANCE',
      observed_balance: '0.00',
      processed_at: null,
    });
    expect(await walletRow(walletId)).toEqual({ balance: '0.00', version: 3 });
  });
});

describe('reversal-chain-limits', () => {
  test('a reversal of a reversal and a second reversal of one target both fail with existing codes', async () => {
    const walletId = await openWallet('500.00');
    await applied(operation('acme-bet-1', 'BET', walletId));
    await applied(
      operation('acme-refund-1', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );
    await applied(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-refund-1',
      }),
    );

    const deeper = await submit(
      operation('acme-rollback-2', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-rollback-1',
      }),
    );
    const again = await submit(
      operation('acme-refund-2', 'REFUND', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(deeper.status).toBe(422);
    expect(deeper.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await walletRow(walletId)).toEqual({ balance: '460.00', version: 4 });
  });
});

describe('credit-past-the-bound-is-rejected', () => {
  test('a credit over the money bound is a persisted rejection, one that lands on it is applied', async () => {
    const walletId = await openWallet('999999999999999999.00');

    const over = await submit(operation('acme-win-1', 'WIN', walletId, { money: brl('1.00') }));

    expect(over.status).toBe(422);
    expect(over.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(over.body.balance).toEqual(brl('999999999999999999.00'));
    expect(await walletRow(walletId)).toEqual({ balance: '999999999999999999.00', version: 1 });
    expect(await transactionRow(String(over.body.transactionId))).toMatchObject({
      status: 'REJECTED',
      failure_code: 'BALANCE_LIMIT_EXCEEDED',
    });

    const exact = await submit(operation('acme-win-2', 'WIN', walletId, { money: brl('0.99') }));

    expect(exact.status).toBe(200);
    expect(exact.body.balance).toEqual(brl(MONEY_BOUND));
    expect(await walletRow(walletId)).toEqual({ balance: MONEY_BOUND, version: 2 });
  });
});

describe('no-ledger-entry-without-effect', () => {
  test('a LOSS and a rejected BET leave the ledger and the version where they were', async () => {
    const walletId = await openWallet('100.00');

    const loss = await submit(operation('acme-loss-1', 'LOSS', walletId));
    const rejected = await submit(
      operation('acme-bet-1', 'BET', walletId, { money: brl('100.01') }),
    );

    expect(loss.body.status).toBe('PROCESSED');
    expect(rejected.body.status).toBe('REJECTED');

    const entries = await ledgerRows(walletId);
    expect(entries.map((entry) => entry.kind)).toEqual(['OPENING']);
    for (const transactionId of [loss.body.transactionId, rejected.body.transactionId]) {
      expect(entries.some((entry) => entry.transaction_id === transactionId)).toBe(false);
    }
    expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('events-fire-when-specified', () => {
  test('each outcome emits exactly the events its rule names', async () => {
    const walletId = await openWallet('500.00');
    const betId = await applied(operation('acme-bet-1', 'BET', walletId));
    const lossId = await applied(operation('acme-loss-1', 'LOSS', walletId));
    const rejected = await submit(
      operation('acme-bet-2', 'BET', walletId, { money: brl('5000.00') }),
    );
    const rollbackId = await applied(
      operation('acme-rollback-1', 'ROLLBACK', walletId, {
        referenceExternalTransactionId: 'acme-bet-1',
      }),
    );

    expect(await eventTypesOf(betId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await eventTypesOf(rollbackId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await eventTypesOf(lossId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesOf(String(rejected.body.transactionId))).toEqual([
      'WagerTransactionRejected',
    ]);
  });
});
