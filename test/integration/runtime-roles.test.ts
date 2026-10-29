import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { EventsQueue } from '../helpers/events-queue';
import { SERVICE_MAIN, SpawnedProcess, freePort } from '../helpers/spawned-process';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
/** The trio this run addresses: the suites namespace theirs away from the stack. */
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const migrationEnv = loadMigrationEnv(process.env);

/**
 * What every role in this suite runs with, over the addresses of the stack. The queue and outbox
 * intervals are short because the suite waits for the work rather than for a schedule, and the
 * grace period is short because two cases here assert an exit.
 */
const ROLE_ENV: Record<string, string> = {
  SQS_WAIT_TIME_SECONDS: '1',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_SWEEP_INTERVAL_MS: '100',
  SHUTDOWN_GRACE_PERIOD_MS: '10000',
};

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** How long a case waits for a worker to pick a message up and for its event to be published. */
const WORK_TIMEOUT_MS = 30_000;

/** How long the input queue is watched before a case concludes that nothing consumed a message. */
const UNCONSUMED_MS = 3000;

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
let events: EventsQueue;
let api: SpawnedProcess;
let apiUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queues.input }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queues.input}`);
  }
  queueUrl = QueueUrl;
  events = await EventsQueue.open(env);

  // One `api` instance for the suite: it is the surface the cases open wallets through, and the
  // role two of them assert about.
  api = SpawnedProcess.spawn({
    script: SERVICE_MAIN,
    env: { ...ROLE_ENV, APP_ROLE: 'api', HTTP_PORT: freePort().toString() },
  });
  apiUrl = await api.listening();
}, 60_000);

afterAll(async () => {
  await api.dispose();
  await drainInput();
  await events.drain();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
  await drainInput();
  await events.drain();
}, 30_000);

// `recon.final-invariant` (RECON-004): a case here moves money through a worker, so every wallet it
// touched is rebuilt from its ledger before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** The `bet` message example of [docs/asyncapi.yaml], with the identity this case sends it under. */
function betMessage(walletId: string, messageId: string): Record<string, unknown> {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-28T12:05:00.000Z',
    correlationId: 'acme-req-5f2c',
    data: {
      providerId: 'provider-acme',
      externalTransactionId: messageId,
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl('40.00'),
      idempotencyKey: `provider-acme:${messageId}`,
    },
  };
}

async function send(walletId: string, messageId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(betMessage(walletId, messageId)),
      MessageGroupId: walletId,
      MessageDeduplicationId: `${messageId}-${Bun.randomUUIDv7()}`,
    }),
  );
}

/** Whatever is in the input queue, received and deleted, so one case never sees another's message. */
async function drainInput(): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
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

/** The messages waiting in the input queue, taken out of it: a receive is the only honest count. */
async function takeInput(): Promise<string[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
  );
  const taken: string[] = [];

  for (const message of Messages ?? []) {
    taken.push((JSON.parse(message.Body ?? '{}') as { messageId?: string }).messageId ?? '');
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  return taken;
}

const sql = <Row>(query: string, parameters: unknown[] = []): Promise<Row[]> =>
  runtime.em.getConnection().execute<Row[]>(query, parameters);

/**
 * The statuses of the bets of a wallet, which is the work a role did or did not do. Opening a
 * wallet records a `PROCESSED` transaction of its own, so the kind is part of the question.
 */
const betStatusesOf = async (walletId: string): Promise<string[]> =>
  (
    await sql<{ status: string }>(
      `select "status" from "wager_transactions"
        where "wallet_id" = ? and "kind" = 'BET' order by "created_at"`,
      [walletId],
    )
  ).map((row) => row.status);

/** Whether anything answered at all on that address, which is what "no port opened" denies. */
const reached = (url: string): Promise<boolean> =>
  fetch(url).then(
    () => true,
    () => false,
  );

/** Waits for the condition the case is about, so nothing is asserted on a fixed sleep. */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  timeoutMs = WORK_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();

  while (!holds(last)) {
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${timeoutMs.toString()} ms`);
    }

    await Bun.sleep(100);
    last = await read();
  }

  return last;
}

async function openWallet(baseUrl: string, initialBalance: string): Promise<string> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: PLAYER_ID, initialBalance: brl(initialBalance) }),
  });
  const body = (await response.json()) as { id?: string };

  if (response.status !== 201 || typeof body.id !== 'string') {
    throw new Error(`opening a wallet answered ${response.status.toString()}`);
  }

  return touched.add(body.id);
}

/**
 * `ops.single-image-roles` (OPS-003): one image, three compositions. What a role is cannot be read
 * off an application object a suite built — it is what the process serves and what it claims — so
 * every case here runs `src/main.ts` as a process and asserts both halves: the surface it answers
 * on, and the queue work it does or leaves alone.
 */
describe('app-roles', () => {
  test('the api role serves the financial surface and consumes nothing', async () => {
    const live = await fetch(`${apiUrl}/health/live`);
    const ready = await fetch(`${apiUrl}/health/ready`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);

    const walletId = await openWallet(apiUrl, '500.00');
    await send(walletId, 'acme-msg-api-role');

    // Long enough for a consumer to have taken it several times over; the api role has none, so the
    // message is still there for this suite to take out itself.
    await Bun.sleep(UNCONSUMED_MS);

    expect(await takeInput()).toEqual(['acme-msg-api-role']);
    expect(await betStatusesOf(walletId)).toEqual([]);
  }, 60_000);

  test('the worker role runs the three loops and serves only health', async () => {
    const walletId = await openWallet(apiUrl, '500.00');
    const worker = SpawnedProcess.spawn({
      script: SERVICE_MAIN,
      env: { ...ROLE_ENV, APP_ROLE: 'worker', HTTP_PORT: freePort().toString() },
    });

    try {
      const workerUrl = await worker.listening();

      // Every role is probed the same way, which is what lets `docker compose up --wait` wait for a
      // worker that publishes no port of its own.
      expect((await fetch(`${workerUrl}/health/ready`)).status).toBe(200);

      // The financial surface is the api role's: a worker answers no route of it.
      const refused = await fetch(`${workerUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: PLAYER_ID, initialBalance: brl('10.00') }),
      });

      expect(refused.status).toBe(404);
      expect((await fetch(`${workerUrl}/wagering/transactions/${walletId}`)).status).toBe(404);

      // All three loops are started, which is what the role is for; the consumer and the publisher
      // are then watched doing their work, and the scheduler's is REF-002's.
      const started = await worker.waitFor(/"event":"worker\.started"/);

      expect(JSON.parse(started)).toMatchObject({
        processes: 'wager-transactions-consumer outbox-publisher pending-reference-scheduler',
      });

      await send(walletId, 'acme-msg-worker-role');

      expect(
        await until(
          'the worker processing the message',
          () => betStatusesOf(walletId),
          (statuses) => statuses.length === 1,
        ),
      ).toEqual(['PROCESSED']);

      // The same instance publishes what the operation left in the outbox (ADR 0005).
      const published = await events.receive(1, { timeoutMs: WORK_TIMEOUT_MS });

      expect(published.map(({ envelope }) => envelope.eventType)).toContain(
        'WagerTransactionProcessed',
      );
    } finally {
      await worker.dispose();
    }
  }, 90_000);

  test('the all role serves the surface and runs the loops in one process', async () => {
    const all = SpawnedProcess.spawn({
      script: SERVICE_MAIN,
      env: { ...ROLE_ENV, APP_ROLE: 'all', HTTP_PORT: freePort().toString() },
    });

    try {
      const allUrl = await all.listening();
      const walletId = await openWallet(allUrl, '500.00');

      await send(walletId, 'acme-msg-all-role');

      expect(
        await until(
          'the all role processing the message',
          () => betStatusesOf(walletId),
          (statuses) => statuses.length === 1,
        ),
      ).toEqual(['PROCESSED']);
    } finally {
      await all.dispose();
    }
  }, 90_000);
});

/**
 * `ops.config-env` (OPS-005): the environment is validated before anything is built, so a value
 * that is missing or cannot be read stops the process by name and no port is ever opened on a
 * configuration the service cannot run.
 */
describe('config-validation', () => {
  for (const [what, variable, value] of [
    ['a missing variable', 'DATABASE_URL', undefined],
    ['a non-numeric number', 'LOCK_TIMEOUT_MS', 'about three seconds'],
    ['an unknown role', 'APP_ROLE', 'publisher'],
  ] as const) {
    test(`${what} stops the process by name, with no port opened`, async () => {
      const port = freePort();
      const refused = SpawnedProcess.spawn({
        script: SERVICE_MAIN,
        // Nothing but what this case passes: the `.env` of a checkout would supply the variable the
        // case is about, and a value a deployment did not set is the point of it.
        envFile: '/dev/null',
        env: {
          ...ROLE_ENV,
          APP_ROLE: 'api',
          HTTP_PORT: port.toString(),
          DATABASE_URL: env.DATABASE_URL,
          AWS_REGION: env.AWS_REGION,
          ...(env.SQS_ENDPOINT === undefined ? {} : { SQS_ENDPOINT: env.SQS_ENDPOINT }),
          [variable]: value,
        },
      });

      expect(await refused.exited()).not.toBe(0);
      expect(refused.output()).toContain(variable);
      // Nothing was ever served on the port it was given: the refusal happens before the listener.
      expect(await reached(`http://127.0.0.1:${port.toString()}/health/live`)).toBe(false);
    }, 60_000);
  }
});
