import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  type TransactionIdentity,
  WagerTransactionProcessed,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { EventsQueue } from '../helpers/events-queue';
import { ReferenceConsumer } from '../helpers/reference-consumer';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const ROOT = path.resolve(import.meta.dirname, '../..');
const PUBLISHER = path.join(ROOT, 'test', 'helpers', 'publish-outbox.ts');

/**
 * The backlog of OUTBOX-003's scenario. It is large enough that two publishers overlap for several
 * batches rather than racing once, and that one of them cannot plausibly have taken every row.
 */
const BACKLOG = 5000;

/** More than one batch of 50, so a held claim leaves work for the publisher that survives. */
const CRASH_BACKLOG = 120;

const TRANSACTION_ID = '01a19100-0000-7000-8000-000000000001';
const PLAYER_ID = '01a19100-0000-7000-8000-000000000002';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const ENQUEUED_AT = new Date('2026-10-28T12:00:00.000Z');

/**
 * Ids unique to this run, because the event id is the broker's `MessageDeduplicationId`: a run
 * repeated inside the five-minute window would have its messages filtered as duplicates of the
 * previous run's and the suite would be asserting that window instead of the publishers.
 */
const RUN = Bun.randomUUIDv7().slice(0, 8);

const idOf = (kind: number, index: number): string =>
  `${RUN}-0000-7000-${kind.toString().padStart(4, '0')}-${index.toString().padStart(12, '0')}`;

/** One process's worth of time for 5000 publications and their delivery, with room to spare. */
const DRAIN_TIMEOUT_MS = 180_000;

const brl = (amount: string): Money => Money.from(amount, 'BRL');

let schema: MikroORM;
let runtime: MikroORM;
let queue: EventsQueue;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  queue = await EventsQueue.open(env);
});

afterAll(async () => {
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute('truncate table "outbox_messages"');
  await queue.drain();
});

const identity = (walletId: string): TransactionIdentity => ({
  transactionId: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  walletId,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
});

/**
 * A backlog of committed rows, each a processed event of a wallet of its own: one FIFO message
 * group per wallet, which is what the publishers would produce from that many operations.
 */
async function enqueueBacklog(rows: number, kind: number): Promise<string[]> {
  const unitOfWork = new MikroOrmUnitOfWork(runtime.em.fork());
  const eventIds: string[] = [];

  for (let batch = 0; batch < rows; batch += 500) {
    const messages = Array.from(
      { length: Math.min(500, rows - batch) },
      (_unused, offset): OutboxMessage => {
        const index = batch + offset;
        const id = idOf(kind, index);
        eventIds.push(id);

        return OutboxMessage.enqueue(
          WagerTransactionProcessed.record({
            eventId: id,
            correlationId: CORRELATION_ID,
            occurredAt: new Date(ENQUEUED_AT.getTime() + index),
            identity: identity(idOf(kind + 1, index)),
            balanceAfter: brl('460.00'),
            walletVersion: 2,
            processedAt: ENQUEUED_AT,
            reference: null,
          }),
        );
      },
    );

    await unitOfWork.transactional(async ({ outbox }) => {
      for (const message of messages) {
        await outbox.insert(message);
      }
    });
  }

  return eventIds;
}

const pendingCount = async (): Promise<number> => {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ pending: string }[]>(
      'select count(*)::text as "pending" from "outbox_messages" where "published_at" is null',
    );

  return Number(row?.pending ?? '0');
};

const attemptsOf = async (): Promise<number[]> => {
  const rows = await runtime.em
    .getConnection()
    .execute<{ attempts: number }[]>('select distinct "attempts" from "outbox_messages"');

  return rows.map((row) => row.attempts).toSorted();
};

/**
 * A publisher instance, as a process the case can wait on and kill. Its lines are what it says
 * about itself: the state it reached, and how many messages it sent before it stopped.
 */
class PublisherProcess {
  private readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  private readonly lines: string[] = [];
  private readonly reading: Promise<void>;

  constructor(args: readonly string[]) {
    // `process.execPath`, as every other helper process in the suites is spawned: a publisher runs
    // the runtime this suite runs on rather than whichever `bun` the PATH of the moment resolves to.
    this.child = Bun.spawn([process.execPath, 'run', PUBLISHER, ...args], {
      cwd: ROOT,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.reading = this.read();
  }

  /** Waits until the process has written a line starting with `prefix`, and returns it. */
  async waitFor(prefix: string, timeoutMs = DRAIN_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const line = this.lines.find((written) => written.startsWith(prefix));

      if (line !== undefined) {
        return line;
      }

      if (this.child.exitCode !== null) {
        throw new Error(
          `the publisher exited with ${String(this.child.exitCode)} before saying "${prefix}": ${await this.diagnostics()}`,
        );
      }

      await Bun.sleep(50);
    }

    throw new Error(`the publisher never said "${prefix}": ${await this.diagnostics()}`);
  }

  /** How many messages this instance sent, read off the line it writes before exiting. */
  async published(timeoutMs = DRAIN_TIMEOUT_MS): Promise<number> {
    const line = await this.waitFor('published ', timeoutMs);
    await this.child.exited;

    return Number(line.slice('published '.length));
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  async exited(): Promise<number> {
    return this.child.exited;
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';

    for await (const chunk of this.child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      this.lines.push(...parts);
    }
  }

  private async diagnostics(): Promise<string> {
    return `stdout ${JSON.stringify(this.lines)}, stderr ${await new Response(this.child.stderr).text()}`;
  }
}

/**
 * Several publisher instances work on one outbox table, and the only coordination between them is
 * PostgreSQL (ADR 0005). Each row has to be published at least once, nothing may be left behind,
 * and a publisher that dies holding rows may not take them with it.
 */
describe('two-publishers-one-outbox', () => {
  test(
    'two publishers drain one outbox, claiming disjoint rows and losing none',
    async () => {
      const eventIds = await enqueueBacklog(BACKLOG, 1);

      const publishers = [
        new PublisherProcess(['--drain', '--batch-size', '50', '--poll-interval', '50']),
        new PublisherProcess(['--drain', '--batch-size', '50', '--poll-interval', '50']),
      ];
      await Promise.all(publishers.map((publisher) => publisher.waitFor('ready')));

      const counts = await Promise.all(publishers.map((publisher) => publisher.published()));

      // Disjoint claims: the two counts add up to the backlog exactly, so no row was published
      // twice, and neither publisher was left idle while the other did the work.
      expect(counts.reduce((total, count) => total + count, 0)).toBe(BACKLOG);
      expect(counts.every((count) => count > 0)).toBe(true);

      // Nothing was left behind, and nothing was retried: every row is published at its first
      // attempt (`outbox.concurrent-publishers`).
      expect(await pendingCount()).toBe(0);
      expect(await attemptsOf()).toEqual([0]);

      const delivered = await queue.receive(BACKLOG);
      const consumer = new ReferenceConsumer();
      for (const event of delivered) {
        consumer.apply(event.envelope);
      }

      expect(consumer.appliedCount).toBe(BACKLOG);
      expect(consumer.appliedEventIds().toSorted()).toEqual(eventIds.toSorted());
    },
    DRAIN_TIMEOUT_MS,
  );
});

describe('publisher-crash-recovery', () => {
  test(
    'a publisher killed while holding a claim leaves its rows to the next instance',
    async () => {
      await enqueueBacklog(CRASH_BACKLOG, 3);

      const dying = new PublisherProcess(['--hold', '--batch-size', '50']);
      await dying.waitFor('holding');

      // While it lives, the rows it claimed are nobody else's: a claim over the whole backlog sees
      // only what the dying publisher did not take (`outbox.concurrent-publishers`).
      const claimable = await new MikroOrmUnitOfWork(runtime.em.fork()).transactional(
        ({ outbox }) => outbox.claimPending({ dueAt: new Date(), limit: CRASH_BACKLOG }),
      );
      expect(claimable).toHaveLength(CRASH_BACKLOG - 50);

      // SIGKILL allows no cleanup: nothing marks the rows, nothing releases them in code. The
      // locks go with the connection, which is the whole of `outbox.crash-recovery`.
      dying.kill('SIGKILL');
      await dying.exited();

      const surviving = new PublisherProcess([
        '--drain',
        '--batch-size',
        '50',
        '--poll-interval',
        '50',
      ]);
      await surviving.waitFor('ready');

      expect(await surviving.published()).toBe(CRASH_BACKLOG);
      expect(await pendingCount()).toBe(0);
      expect(await attemptsOf()).toEqual([0]);

      const delivered = await queue.receive(CRASH_BACKLOG);
      const consumer = new ReferenceConsumer();
      for (const event of delivered) {
        consumer.apply(event.envelope);
      }

      expect(consumer.appliedCount).toBe(CRASH_BACKLOG);
    },
    DRAIN_TIMEOUT_MS,
  );
});
