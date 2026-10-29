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
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import { ReprocessPendingReference } from '../../src/application/use-cases/reprocess-pending-reference';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { WagerTransactionsConsumer } from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
/** The trio this run addresses: the suites namespace theirs away from the stack. */
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const migrationEnv = loadMigrationEnv(process.env);

const SERVICE_ENV = {
  LOCK_TIMEOUT_MS: 250,
  SQS_WAIT_TIME_SECONDS: 1,
  SQS_VISIBILITY_TIMEOUT_SECONDS: 1,
};

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

/** An amount no identifier, timestamp or counter of this suite can be mistaken for (OBS-002). */
const AMOUNT = '33.77';
const OPENING_BALANCE = '511.13';
const BALANCE_AFTER = '477.36';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** `obs.structured-logs`: the fields a line carries whenever they are known. */
const IDENTITY_FIELDS = [
  'correlationId',
  'transactionId',
  'walletId',
  'providerId',
  'externalTransactionId',
];

/** `obs.metrics`: every name the operational contract promises, with its exposition type. */
const DOCUMENTED_METRICS = [
  ['wager_transactions_total', 'counter'],
  ['wager_duplicates_detected_total', 'counter'],
  ['wager_retries_total', 'counter'],
  ['wager_dlq_messages_total', 'counter'],
  ['wager_lock_conflicts_total', 'counter'],
  ['wager_outbox_pending', 'gauge'],
  ['wager_outbox_lag_seconds', 'gauge'],
  ['wager_processing_duration_seconds', 'histogram'],
  ['wager_reconciliation_divergence_total', 'counter'],
  ['wager_pending_reference_total', 'counter'],
] as const;

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let app: INestApplication;
let baseUrl: string;
let consumer: WagerTransactionsConsumer;
let metrics: MetricsRegistry;
let sqs: SQSClient;
let queueUrl: string;
let deadLetterQueueUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  app = await NestFactory.create(AppModule.create({ ...env, ...SERVICE_ENV }), {
    // The framework's own lines are off, so what this suite captures is the service's own output.
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
  consumer = app.get(WagerTransactionsConsumer);
  metrics = app.get(MetricsRegistry);
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  queueUrl = await urlOf(queues.input);
  deadLetterQueueUrl = await urlOf(queues.deadLetter);
});

afterAll(async () => {
  await drain(queueUrl);
  await drain(deadLetterQueueUrl);
  await app.close();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await asMigrator(`truncate table ${TABLES.join(', ')}`);
  await drain(queueUrl);
}, 20_000);

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

function asMigrator(statement: string, params: unknown[] = []): Promise<unknown> {
  return schema.em.getConnection().execute(statement, params);
}

async function urlOf(queueName: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queueName}`);
  }

  return QueueUrl;
}

/** Receives and deletes whatever is in a queue, so one test never sees another's message. */
async function drain(url: string): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, VisibilityTimeout: 1 }),
    );

    if (Messages === undefined || Messages.length === 0) {
      return;
    }

    for (const message of Messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
}

/**
 * What the service wrote while `work` ran. The lines are taken off the sink the service actually
 * writes to rather than from a logger a test passed in, which is what makes `obs.structured-logs`
 * and `obs.no-sensitive-data` assertions about the output of the running service (OBS-001,
 * OBS-002). The sink is restored whatever `work` did, so a failing expectation still prints.
 */
async function captured<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const written: string[] = [];
  const sink = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk: unknown): boolean => {
    written.push(String(chunk));

    return true;
  };

  try {
    const result = await work();

    return {
      result,
      lines: written
        .join('')
        .split('\n')
        .filter((line) => line !== ''),
    };
  } finally {
    process.stdout.write = sink;
  }
}

type Line = Readonly<Record<string, unknown>>;

/** Every captured line as a record, which fails the test when one of them is not JSON. */
function records(lines: string[]): Line[] {
  return lines.map((line) => {
    try {
      return JSON.parse(line) as Line;
    } catch {
      throw new Error(`a line the service wrote is not JSON: ${line}`);
    }
  });
}

const of = (lines: Line[], event: string): Line[] =>
  lines.filter((line) => line['event'] === event);

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/**
 * A wallet whose stored balance is not the one its ledger implies. The mirror trigger of ADR 0003
 * is what makes that state unreachable through any statement, so the fixture disables it for the
 * one update and puts it back; the wallet leaves the suite's closing sweep, which asserts exactly
 * the invariant this case breaks on purpose (RECON-003).
 */
async function divergedWallet(storedBalance: string): Promise<string> {
  const walletId = await openWallet(OPENING_BALANCE);
  const owner = schema.em.getConnection();

  touched.forget(walletId);
  await owner.execute('alter table "wallets" disable trigger "wallets_mirror_ledger_head"');
  try {
    await owner.execute('update "wallets" set "balance" = ? where "id" = ?', [
      storedBalance,
      walletId,
    ]);
  } finally {
    await owner.execute('alter table "wallets" enable trigger "wallets_mirror_ledger_head"');
  }

  return walletId;
}

async function openWallet(initialBalance: string): Promise<string> {
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

function operation(
  walletId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    playerId: PLAYER_ID,
    walletId,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET',
    money: brl(AMOUNT),
    ...overrides,
  };
}

interface Answer {
  readonly status: number;
  readonly correlationId: string | null;
  readonly body: Record<string, unknown>;
}

async function submit(
  body: Record<string, unknown>,
  options: { readonly correlationId?: string; readonly idempotencyKey?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key':
        options.idempotencyKey ??
        `${String(body['providerId'])}:${String(body['externalTransactionId'])}`,
      ...(options.correlationId !== undefined && { 'x-correlation-id': options.correlationId }),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    correlationId: response.headers.get('x-correlation-id'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** The `bet` message example of [docs/asyncapi.yaml](../../docs/asyncapi.yaml). */
function message(
  walletId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const fields = operation(walletId);

  return {
    messageId: 'acme-msg-000123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-28T12:05:00.000Z',
    correlationId: CORRELATION_ID,
    data: {
      ...fields,
      idempotencyKey: `${String(fields['providerId'])}:${String(fields['externalTransactionId'])}`,
    },
    ...overrides,
  };
}

async function send(body: Record<string, unknown>, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: `${String(body['messageId'])}-${Date.now().toString()}`,
    }),
  );
}

/**
 * The correlation id of every event one transaction enqueued, as the stored envelope carries it.
 * It is filtered by causation rather than read whole, because the wallet this suite opens enqueues
 * the events of its own opening credit under the correlation id of that request
 * (`event.correlation-causation`).
 */
async function eventCorrelationIds(transactionId: unknown): Promise<string[]> {
  const rows = await runtime.em.getConnection().execute<{ correlation_id: string }[]>(
    `select "payload" ->> 'correlationId' as correlation_id
         from "outbox_messages"
        where "payload" ->> 'causationId' = ?
        order by "occurred_at", "event_id"`,
    [String(transactionId)],
  );

  return rows.map((row) => row.correlation_id);
}

/** The service's own publisher, without the loop around it (ADR 0005). */
function publisher(): PublishOutbox {
  return new PublishOutbox({
    unitOfWork: new MikroOrmUnitOfWork(runtime.em, SERVICE_ENV.LOCK_TIMEOUT_MS, metrics),
    publisher: new SqsEventPublisher(sqs, {
      queueName: queues.events,
      timeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS,
    }),
    clock: systemClock,
    logger: jsonLinesLogger('outbox-publisher'),
    metrics,
  });
}

async function scrape(): Promise<{ readonly contentType: string | null; readonly body: string }> {
  const response = await fetch(`${baseUrl}/metrics`);

  return { contentType: response.headers.get('content-type'), body: await response.text() };
}

/**
 * One sample of a scrape. The labels are matched as the exposition spells them, so a test asserts
 * the series a dashboard would select and not merely that the name occurs.
 */
function sample(exposition: string, name: string, labels = ''): number | undefined {
  const series = `${name}${labels === '' ? '' : `{${labels}}`}`;
  const sampled = exposition.split('\n').find((line) => line.startsWith(`${series} `));

  return sampled === undefined ? undefined : Number(sampled.slice(series.length + 1));
}

describe('structured-log-fields', () => {
  test('every line of an HTTP submission is JSON carrying the identity fields it knows', async () => {
    const walletId = await openWallet(OPENING_BALANCE);

    const { result, lines } = await captured(() =>
      submit(operation(walletId), { correlationId: CORRELATION_ID }),
    );

    expect(result.status).toBe(200);
    const written = records(lines);
    expect(written.length).toBeGreaterThan(0);

    const recorded = of(written, 'wager.transaction.recorded');
    expect(recorded).toHaveLength(1);
    for (const field of IDENTITY_FIELDS) {
      expect(recorded[0]?.[field]).toBeString();
    }
    expect(recorded[0]).toMatchObject({
      correlationId: CORRELATION_ID,
      transactionId: result.body['transactionId'],
      walletId,
      providerId: 'provider-acme',
      externalTransactionId: 'acme-tx-000123',
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
  });

  test('every line of a delivery also carries the message id (OBS-001)', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    await send(message(walletId), walletId);

    const { lines } = await captured(() => consumer.poll());

    const written = records(lines);
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) {
      expect(line).toMatchObject({ correlationId: CORRELATION_ID, messageId: 'acme-msg-000123' });
    }
    expect(of(written, 'wager.transaction.recorded')[0]).toMatchObject({
      walletId,
      providerId: 'provider-acme',
      externalTransactionId: 'acme-tx-000123',
      status: 'PROCESSED',
    });
    expect(of(written, 'wager.message.handled')[0]).toMatchObject({
      classification: 'business',
      disposition: 'acknowledged',
    });
  });
});

describe('logs-redact-financial-data', () => {
  test('no line of a submission carries the amount, the balance or the body', async () => {
    const walletId = await openWallet(OPENING_BALANCE);

    const { lines } = await captured(async () => {
      await submit(operation(walletId), { correlationId: CORRELATION_ID });
      await send(message(walletId, { messageId: 'acme-msg-000124' }), walletId);

      return consumer.poll();
    });

    const output = lines.join('\n');
    records(lines); // every line is still JSON, redaction included

    expect(output).not.toContain(AMOUNT);
    expect(output).not.toContain(OPENING_BALANCE);
    expect(output).not.toContain(BALANCE_AFTER);
    expect(output).not.toContain('idempotencyKey');
  });

  test('the divergence record is the one line that carries an amount (OBS-002)', async () => {
    const walletId = await divergedWallet(BALANCE_AFTER);

    const { lines } = await captured(() =>
      fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' }),
    );

    const diverged = of(records(lines), 'recon.balance-diverged');
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatchObject({ walletId, difference: `-${AMOUNT}`, checkedEntries: 1 });
  });
});

describe('correlation-reaches-events', () => {
  test('the id of a request reaches the response, every line and every event', async () => {
    const walletId = await openWallet(OPENING_BALANCE);

    const { result, lines } = await captured(() =>
      submit(operation(walletId), { correlationId: CORRELATION_ID }),
    );

    expect(result.correlationId).toBe(CORRELATION_ID);
    expect(await eventCorrelationIds(result.body['transactionId'])).toEqual([
      CORRELATION_ID,
      CORRELATION_ID,
    ]);
    for (const line of records(lines)) {
      expect(line['correlationId']).toBe(CORRELATION_ID);
    }
  });

  test('a response carries a generated id when the request brought none', async () => {
    const walletId = await openWallet(OPENING_BALANCE);

    const answer = await submit(operation(walletId));
    const generated = String(answer.correlationId);

    expect(generated).toMatch(/^[!-~]{1,128}$/);
    expect(await eventCorrelationIds(answer.body['transactionId'])).toEqual([generated, generated]);
  });

  test('a message without a correlationId is searchable by its message id (OBS-005)', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    await send(message(walletId, { correlationId: undefined }), walletId);

    const { lines } = await captured(() => consumer.poll());

    const written = records(lines);
    const recorded = of(written, 'wager.transaction.recorded')[0];
    expect(await eventCorrelationIds(recorded?.['transactionId'])).toEqual([
      'acme-msg-000123',
      'acme-msg-000123',
    ]);
    for (const line of written) {
      expect(line['correlationId']).toBe('acme-msg-000123');
    }
  });

  test('a scheduled retry and a later publication carry the id of the operation that created the work', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    const parked = await submit(
      operation(walletId, {
        externalTransactionId: 'acme-rollback-1',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'acme-bet-unknown',
      }),
      { correlationId: CORRELATION_ID },
    );

    expect(parked.status).toBe(202);
    expect(
      await runtime.em
        .getConnection()
        .execute<{ correlation_id: string }[]>(
          'select "correlation_id" from "pending_reference_schedule"',
        ),
    ).toEqual([{ correlation_id: CORRELATION_ID }]);

    const sweep = await captured(() =>
      new ReprocessPendingReference({
        unitOfWork: new MikroOrmUnitOfWork(runtime.em, SERVICE_ENV.LOCK_TIMEOUT_MS, metrics),
        clock: { now: () => new Date(Date.now() + 2000) },
        ids: { next: () => crypto.randomUUID() },
        logger: jsonLinesLogger('pending-reference-scheduler'),
        metrics,
      }).execute(),
    );

    expect(sweep.result).toEqual([
      {
        transactionId: String(parked.body['transactionId']),
        correlationId: CORRELATION_ID,
        outcome: 'pending',
      },
    ]);
    expect(of(records(sweep.lines), 'wager.pending-reference.attempted')[0]).toMatchObject({
      correlationId: CORRELATION_ID,
      outcome: 'pending',
    });

    const published = await captured(() => publisher().execute());

    // The three pending rows: the two events of the wallet's opening credit and the one that
    // announced the wait.
    expect(published.result).toMatchObject({ claimed: 3, published: 3, failed: 0 });
    const announced = of(records(published.lines), 'outbox.published').filter(
      (line) => line['eventType'] === 'WagerTransactionPendingReference',
    );
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ correlationId: CORRELATION_ID, attempts: 0 });
  }, 20_000);
});

describe('metrics-exported', () => {
  test('the endpoint answers the Prometheus text format', async () => {
    const exposition = await scrape();

    expect(exposition.contentType).toContain('text/plain');
    expect(exposition.contentType).toContain('version=0.0.4');
  });

  test.each(DOCUMENTED_METRICS)('%s is exported as a %s', async (name, type) => {
    const exposition = await scrape();

    expect(exposition.body).toContain(`# TYPE ${name} ${type}`);
  });

  test('a recorded outcome and its replay are counted by the paths that own them', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    const bets = await metrics.total('wager_transactions_total', {
      kind: 'BET',
      status: 'PROCESSED',
    });
    const replays = await metrics.total('wager_duplicates_detected_total', {
      source: 'idempotency',
    });

    await submit(operation(walletId), { correlationId: CORRELATION_ID });
    await submit(operation(walletId), { correlationId: CORRELATION_ID });

    const exposition = (await scrape()).body;
    expect(sample(exposition, 'wager_transactions_total', 'kind="BET",status="PROCESSED"')).toBe(
      bets + 1,
    );
    expect(sample(exposition, 'wager_duplicates_detected_total', 'source="idempotency"')).toBe(
      replays + 1,
    );
  });

  test('an attempt at a parked transaction is counted by its outcome', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    const attempts = await metrics.total('wager_pending_reference_total', { outcome: 'pending' });
    await submit(
      operation(walletId, {
        externalTransactionId: 'acme-rollback-2',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'acme-bet-unknown',
      }),
      { correlationId: CORRELATION_ID },
    );

    await new ReprocessPendingReference({
      unitOfWork: new MikroOrmUnitOfWork(runtime.em, SERVICE_ENV.LOCK_TIMEOUT_MS, metrics),
      clock: { now: () => new Date(Date.now() + 2000) },
      ids: { next: () => crypto.randomUUID() },
      logger: jsonLinesLogger('pending-reference-scheduler'),
      metrics,
    }).execute();

    expect(
      sample((await scrape()).body, 'wager_pending_reference_total', 'outcome="pending"'),
    ).toBe(attempts + 1);
  });

  test('both entrypoints measure how long an operation took', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    await submit(operation(walletId), { correlationId: CORRELATION_ID });
    await send(message(walletId, { messageId: 'acme-msg-000125' }), walletId);
    await consumer.poll();

    const exposition = (await scrape()).body;
    expect(
      sample(exposition, 'wager_processing_duration_seconds_count', 'entrypoint="http"'),
    ).toBeGreaterThan(0);
    expect(
      sample(exposition, 'wager_processing_duration_seconds_count', 'entrypoint="queue"'),
    ).toBeGreaterThan(0);
  });

  /**
   * The operator's own endpoints are bound to a correlation id like everything else and measured by
   * nobody, so a scrape never moves the histogram it is reading (`obs.metrics`).
   */
  test('a scrape carries a correlation id and is not measured as an operation', async () => {
    const before = sample(
      (await scrape()).body,
      'wager_processing_duration_seconds_count',
      'entrypoint="http"',
    );
    const response = await fetch(`${baseUrl}/metrics`);

    expect(response.headers.get('x-correlation-id')).toBeString();
    expect(
      sample(await response.text(), 'wager_processing_duration_seconds_count', 'entrypoint="http"'),
    ).toBe(before);
  });
});

describe('outbox-metrics', () => {
  test('the backlog and its age are exported continuously, and fall back to zero', async () => {
    const walletId = await openWallet(OPENING_BALANCE);
    await submit(operation(walletId), { correlationId: CORRELATION_ID });
    await asMigrator(`update "outbox_messages" set "occurred_at" = now() - interval '30 seconds'`);

    // Four rows: the two events of the opening credit and the two of the bet.
    const backlogged = (await scrape()).body;
    expect(sample(backlogged, 'wager_outbox_pending')).toBe(4);
    expect(sample(backlogged, 'wager_outbox_lag_seconds')).toBeGreaterThanOrEqual(30);

    expect(await publisher().execute()).toMatchObject({ claimed: 4, published: 4, failed: 0 });

    const drained = (await scrape()).body;
    expect(sample(drained, 'wager_outbox_pending')).toBe(0);
    expect(sample(drained, 'wager_outbox_lag_seconds')).toBe(0);
  }, 20_000);
});
