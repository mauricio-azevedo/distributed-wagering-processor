/**
 * `auth.deferred` with an extension point that works: the service authenticates nobody, and the one
 * binding that would change that is enough to change it (AUTH-001, AUTH-002).
 *
 * Both halves run against the same application, built by the same composition root, differing in
 * one argument: the `ProviderIdentityPort` it is given. With the implementation of this version
 * every request is admitted; with a test implementation that identifies its caller, a payload
 * naming another provider is refused before anything is read or written — and no controller, use
 * case or route is different between the two, which is what makes the deferral an extension point
 * rather than a hole.
 */
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import type { ProviderIdentityPort } from '../../src/application/ports/provider-identity';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { WagerTransactionsConsumer } from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
/** The trio this run addresses: the suites namespace theirs away from the stack. */
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const migrationEnv = loadMigrationEnv(process.env);

/** The suite drives `poll` itself, so a receive answers at once instead of long polling. */
const CONSUMER_ENV = { SQS_WAIT_TIME_SECONDS: 1, SQS_VISIBILITY_TIMEOUT_SECONDS: 1 };

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const PROVIDER_ID = 'provider-acme';
const ANOTHER_PROVIDER_ID = 'provider-other';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/**
 * The deployment `auth.intended-design` describes, as far as the boundary is concerned: the caller
 * has been identified, and the identity is the one claim the guard compares a payload with. What a
 * real implementation adds is where the claim comes from — an OpenID Connect token — which is #29
 * and changes nothing here.
 */
const identifiesEveryCallerAs = (providerId: string): ProviderIdentityPort => ({
  identify: () => Promise.resolve({ providerId }),
});

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let unauthenticated: INestApplication;
let authenticated: INestApplication;
let consumer: WagerTransactionsConsumer;
let sqs: SQSClient;
let queueUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));

  unauthenticated = await NestFactory.create(AppModule.create({ ...env, ...CONSUMER_ENV }), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await unauthenticated.listen(0);

  authenticated = await NestFactory.create(
    AppModule.create(
      { ...env, ...CONSUMER_ENV },
      { providerIdentity: identifiesEveryCallerAs(PROVIDER_ID) },
    ),
    { logger: false, abortOnError: false },
  );
  await authenticated.listen(0);

  consumer = authenticated.get(WagerTransactionsConsumer);
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queues.input }));
  queueUrl = QueueUrl ?? '';
});

afterAll(async () => {
  await drainQueue();
  await authenticated.close();
  await unauthenticated.close();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  await drainQueue();
}, 20_000);

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

/** Receives and deletes whatever the queue holds, so one test never sees another's message. */
async function drainQueue(): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: CONSUMER_ENV.SQS_VISIBILITY_TIMEOUT_SECONDS,
      }),
    );

    if (Messages === undefined || Messages.length === 0) {
      return;
    }

    for (const message of Messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
}

interface Answer {
  readonly status: number;
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
    body: contentType.includes('json')
      ? ((await response.json()) as Record<string, unknown>)
      : { text: await response.text() },
  };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(playerId = PLAYER_ID): Promise<string> {
  const answer = await request(unauthenticated, 'POST', '/wallets', {
    body: { playerId, initialBalance: brl('100.00') },
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

const submit = (app: INestApplication, body: Record<string, unknown>) =>
  request(app, 'POST', '/wagering/transactions', { body, idempotencyKey: keyFor(body) });

const transactionsOf = (walletId: string) =>
  runtime.em
    .getConnection()
    .execute<{ provider_id: string; status: string; failure_code: string | null }[]>(
      `select provider_id, status, failure_code from wager_transactions where wallet_id = ? and provider_id <> 'system'`,
      [walletId],
    );

describe('auth-extension-point', () => {
  test('a submission with no credentials is processed, because this version establishes no identity', async () => {
    const walletId = await openWallet();

    const answer = await submit(unauthenticated, bet(walletId));

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
  });

  test('with an identifying implementation bound, a payload naming another provider is refused before the domain', async () => {
    const walletId = await openWallet();

    const refused = await submit(
      authenticated,
      bet(walletId, { providerId: ANOTHER_PROVIDER_ID, externalTransactionId: 'other-tx-000001' }),
    );

    expect(refused.status).toBe(403);
    // Nothing was read and nothing was written: the request never reached a use case.
    expect(await transactionsOf(walletId)).toEqual([]);
  });

  test('the same implementation admits the provider it identified, so the rule is the identity and not the guard', async () => {
    const walletId = await openWallet();

    const applied = await submit(authenticated, bet(walletId));

    expect(applied.status).toBe(200);
    expect(await transactionsOf(walletId)).toEqual([
      { provider_id: PROVIDER_ID, status: 'PROCESSED', failure_code: null },
    ]);
  });

  test('a provider read of another provider is refused on the path the same way', async () => {
    const refused = await request(
      authenticated,
      'GET',
      `/providers/${ANOTHER_PROVIDER_ID}/wagering/transactions/other-tx-000001`,
    );

    expect(refused.status).toBe(403);
  });
});

describe('open-endpoints-and-queue-validation', () => {
  test('health and metrics answer without credentials whatever is bound', async () => {
    const answers = [];

    for (const app of [unauthenticated, authenticated]) {
      for (const path of ['/health/live', '/health/ready', '/metrics']) {
        answers.push({ path, status: (await request(app, 'GET', path)).status });
      }
    }

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });

  test('the documentation routes stay open too, so a reviewer needs no credentials', async () => {
    for (const app of [unauthenticated, authenticated]) {
      expect((await request(app, 'GET', '/docs-json')).status).toBe(200);
      expect((await request(app, 'GET', '/docs')).status).toBe(200);
    }
  });

  test('a queue message carries no credentials and is still subject to every domain rule', async () => {
    const walletId = await openWallet();
    const another = await openWallet(OTHER_PLAYER_ID);
    const operation = bet(another, {
      playerId: PLAYER_ID,
      externalTransactionId: 'acme-tx-000777',
    });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId: 'acme-msg-000777',
          type: 'WagerTransactionRequested',
          occurredAt: '2026-10-28T12:05:00.000Z',
          data: { ...operation, idempotencyKey: keyFor(operation) },
        }),
        MessageGroupId: another,
        MessageDeduplicationId: Bun.randomUUIDv7(),
      }),
    );

    const [report] = await consumer.poll();

    // The guard never saw the message, and the wallet rule still did: the queue is an internal
    // channel, not a trusted payload (`auth.queue-trusted-channel`).
    expect(report?.disposition).toBe('acknowledged');
    expect(await transactionsOf(another)).toEqual([
      { provider_id: PROVIDER_ID, status: 'REJECTED', failure_code: 'WALLET_PLAYER_MISMATCH' },
    ]);
    expect(await transactionsOf(walletId)).toEqual([]);
  });
});
