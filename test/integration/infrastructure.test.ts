import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import { type Env, loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import {
  WAGER_INTEGRATION_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../../src/infrastructure/messaging/sqs';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);

async function start(overrides: Partial<Env> = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.create({ ...env, ...overrides }), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  return app;
}

async function probe(app: INestApplication, name: 'live' | 'ready') {
  const response = await fetch(`${await app.getUrl()}/health/${name}`);
  return { status: response.status, body: await response.json() };
}

async function currentUser(orm: MikroORM): Promise<string | undefined> {
  const rows = await orm.em
    .getConnection()
    .execute<{ current_user: string }[]>('select current_user');
  return rows[0]?.current_user;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
}

describe('readiness-tracks-dependencies', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await start();
  });

  afterAll(async () => {
    await app.close();
  });

  test('liveness answers ok while the process serves HTTP', async () => {
    expect(await probe(app, 'live')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  test('readiness answers 200 with one entry per dependency when both are reachable', async () => {
    expect(await probe(app, 'ready')).toMatchObject({
      status: 200,
      body: { status: 'ok', details: { postgres: { status: 'up' }, sqs: { status: 'up' } } },
    });
  });

  test('readiness answers 503 when PostgreSQL is unreachable', async () => {
    const unreachable = await start({
      DATABASE_URL: 'postgres://wagering_app:wagering_app@127.0.0.1:1/wagering',
    });
    try {
      expect(await probe(unreachable, 'ready')).toMatchObject({
        status: 503,
        body: { status: 'error', details: { postgres: { status: 'down' }, sqs: { status: 'up' } } },
      });
    } finally {
      await unreachable.close();
    }
  });

  test('readiness answers 503 when SQS is unreachable', async () => {
    const unreachable = await start({ SQS_ENDPOINT: 'http://127.0.0.1:1' });
    try {
      expect(await probe(unreachable, 'ready')).toMatchObject({
        status: 503,
        body: { status: 'error', details: { postgres: { status: 'up' }, sqs: { status: 'down' } } },
      });
    } finally {
      await unreachable.close();
    }
  });
});

describe('compose-stack', () => {
  const sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  const queueUrl = async (QueueName: string) =>
    (await sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl;

  test('the three FIFO queues exist', async () => {
    for (const name of [
      WAGER_TRANSACTIONS_QUEUE,
      WAGER_TRANSACTIONS_DLQ,
      WAGER_INTEGRATION_EVENTS_QUEUE,
    ]) {
      expect(await queueUrl(name)).toEndWith(`/${name}`);
    }
  });

  test('the input queue redrives to the dead-letter queue after five receives', async () => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await queueUrl(WAGER_TRANSACTIONS_QUEUE),
        AttributeNames: ['FifoQueue', 'RedrivePolicy'],
      }),
    );

    expect(Attributes?.FifoQueue).toBe('true');
    const redrive = JSON.parse(Attributes?.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string;
    };
    expect(redrive.maxReceiveCount).toBe('5');
    expect(redrive.deadLetterTargetArn).toEndWith(`:${WAGER_TRANSACTIONS_DLQ}`);
  });
});

describe('two-database-roles', () => {
  test('migrations run as the migrator role and leave nothing pending', async () => {
    const orm = await MikroORM.init(
      ormConfig(loadMigrationEnv(process.env).MIGRATION_DATABASE_URL),
    );
    try {
      await orm.migrator.up();

      expect(await orm.migrator.getPending()).toEqual([]);
      expect(await currentUser(orm)).toBe('wagering_migrator');
    } finally {
      await orm.close(true);
    }
  });

  test('every table is owned by the migrator role', async () => {
    const orm = await MikroORM.init(
      ormConfig(loadMigrationEnv(process.env).MIGRATION_DATABASE_URL),
    );
    try {
      const owners = await orm.em
        .getConnection()
        .execute<{ tableowner: string }[]>(
          `select distinct tableowner from pg_tables where schemaname = 'public'`,
        );

      expect(owners.map((row) => row.tableowner)).toEqual(['wagering_migrator']);
    } finally {
      await orm.close(true);
    }
  });

  test('the service connects as the runtime role, which cannot change the schema', async () => {
    const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));
    try {
      expect(await currentUser(orm)).toBe('wagering_app');
      expect(
        await rejection(
          orm.em.getConnection().execute('create table schema_change_by_runtime_role (id int)'),
        ),
      ).toMatch(/permission denied/);
    } finally {
      await orm.close(true);
    }
  });
});
