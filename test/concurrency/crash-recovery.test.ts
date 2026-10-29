import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import type { IntegrationEventEnvelope } from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { EventsQueue } from '../helpers/events-queue';
import { ReferenceConsumer } from '../helpers/reference-consumer';
import { SpawnedProcess, helperScript } from '../helpers/spawned-process';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * The drill: every failure window of ARCHITECTURE.md section 8 that produces a duplicate, opened in
 * one run of the service by killing the processes that are standing in it.
 *
 * Each guarantee already has a suite of its own, and each of those suites opens one window at a
 * time with the rest of the system quiet. What this one adds is the only thing those cannot: the
 * windows open together, in a service that is doing other work, and what closes them is the
 * ordinary recovery of the surviving and restarted instances rather than a step the case drives.
 * The evidence is `SIGKILL` on real processes — the one signal that allows no cleanup, so no
 * handler, no drain and no rollback written in this repository can be what makes the drill pass.
 *
 * The two windows and what they must cost:
 *
 * - A worker that commits a delivery and dies before acknowledging it (`msg.ack-after-commit`,
 *   MSG-006). The message is redelivered; the inbox row that committed with the money is what
 *   absorbs it, so the redelivery is acknowledged and no second debit exists.
 * - A publisher whose message reached the broker and whose commit never happened
 *   (`outbox.duplicate-safe`, OUTBOX-005, OUTBOX-006). The row stays pending, the next publisher
 *   sends the same envelope under the same `eventId`, and a consumer deduplicating by that id
 *   applies the event once however many copies it is handed.
 *
 * Both are driven by a barrier and never by a timer: the instance announces that it has reached the
 * point, the case asserts the durable state the kill is meant to interrupt, and only then does the
 * kill happen (`crash-recovery-barriers` below is what makes a missed window a failure rather than
 * a quiet pass). Between the kills the drill also delivers a reversal before the operation it
 * reverses and duplicates with deduplication ids the broker has not seen, so neither FIFO order nor
 * the broker's own filter can be what keeps the books straight (`msg.broker-features-optional`,
 * MSG-011), and it ends on the invariant every money-moving suite ends on: every wallet it touched,
 * rebuilt from its own ledger in SQL (`recon.final-invariant`, RECON-004).
 *
 * Load is not what this suite is about; `wallet-contention.test.ts` races the submissions and
 * `outbox-publishers.test.ts` drains thousands of rows. Here the quantity that matters is the
 * number of instances alive at every step, which is three throughout (`conc.multi-instance`,
 * CONC-005): a window that only one process can be standing in is not a window a deployment has.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
/** The trio this run addresses: the suites namespace theirs away from the stack. */
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const migrationEnv = loadMigrationEnv(process.env);

const INSTANCE = helperScript('recovery-instance.ts');

/** `conc.multi-instance`: three, which is what "three or more instances" asks for. */
const INSTANCES = 3;

/**
 * How long a received message stays invisible, which is the length of the worker window: the drill
 * has that long to assert the committed state and kill the holder before another instance receives
 * the message and absorbs it, and a redelivery is then due that long after the receive. Ten seconds
 * is two orders of magnitude more than the handful of queries the assertion costs, and short enough
 * that waiting for the redelivery is not what the drill spends its time on.
 */
const VISIBILITY_TIMEOUT_SECONDS = 10;

/**
 * The configuration the instances run on. The three loops poll far faster than a deployment would,
 * because a drill waits on them; the lock ceiling is far above any wait it produces, because
 * nothing here is about contention. None of it changes an outcome: what is due is claimed by the
 * next cycle whenever that is.
 */
const INSTANCE_ENV: Record<string, string> = {
  APP_ROLE: 'worker',
  LOCK_TIMEOUT_MS: '60000',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_VISIBILITY_TIMEOUT_SECONDS: VISIBILITY_TIMEOUT_SECONDS.toString(),
  OUTBOX_POLL_INTERVAL_MS: '50',
  PENDING_REFERENCE_SWEEP_INTERVAL_MS: '100',
  SHUTDOWN_GRACE_PERIOD_MS: '5000',
};

const PROVIDER_ID = 'provider-acme';
const ROUND_ID = 'round-7f3a';
const GAME_ID = 'lucky-sevens';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';

const OPENING_BALANCE = '500.00';
const BET_AMOUNT = '40.00';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** How long a barrier is waited for. An instance that has not reached one by now never will. */
const BARRIER_TIMEOUT_MS = 60_000;

/**
 * How long the drill waits for the service to settle after the kills: the redelivery of the held
 * message, the republication of the held row, and the attempt at which the parked reversal finds
 * its reference. The last of those is the slow one — `ref.backoff` doubles the spacing of the
 * attempts from one second, so a reversal whose reference arrives during the kills waits out
 * whichever step the schedule had reached — and it is bounded by the five-minute cap it never comes
 * close to here.
 */
const SETTLE_TIMEOUT_MS = 120_000;

/** The whole drill, in one test, because the windows have to be opened in one run of the service. */
const DRILL_TIMEOUT_MS = 300_000;

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let openWallet: OpenWallet;
let sqs: SQSClient;
let inputQueueUrl: string;
let deadLetterQueueUrl: string;
let events: EventsQueue;
let fleet: Fleet;
/** The downstream consumer of the drill, started by it once the queue holds nothing else. */
let feed: EventFeed | undefined;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  openWallet = new OpenWallet({
    unitOfWork: new MikroOrmUnitOfWork(runtime.em),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });
  sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
  });
  inputQueueUrl = await urlOf(queues.input);
  deadLetterQueueUrl = await urlOf(queues.deadLetter);
  events = await EventsQueue.open(env);
  await events.drain();
  fleet = await Fleet.start(INSTANCES);
}, 120_000);

afterAll(async () => {
  await feed?.stop();
  await fleet.stop();
  await drainInputQueue();
  await drainDeadLetterQueue();
  await events.drain();
  await runtime.close(true);
  await schema.close(true);
  sqs.destroy();
}, 120_000);

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003). The instances
// are running while this happens, which is harmless: both queues are empty, so the three loops have
// nothing claimed and nothing to claim.
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): the drill moves money, so it ends by rebuilding the balance
// of every wallet it touched from that wallet's ledger, before the next truncation removes the rows.
afterEach(async () => {
  await touched.expectReconciled(runtime);
}, 60_000);

/**
 * One instance of the drill: the three loops of the `worker` role in a process of its own, with the
 * two crash barriers of `test/helpers/recovery-instance.ts` armed from here.
 */
class Instance {
  private constructor(
    private readonly process: SpawnedProcess,
    readonly pid: number,
  ) {}

  static async start(): Promise<Instance> {
    const process = SpawnedProcess.spawn({ script: INSTANCE, env: INSTANCE_ENV, stdin: true });
    const ready = await process.waitFor(/^ready /, BARRIER_TIMEOUT_MS);

    return new Instance(process, Number(ready.slice('ready '.length)));
  }

  /** Arms a barrier, acknowledged, so the drill never produces work a barrier was not yet watching. */
  async arm(barrier: 'consumer' | 'publisher'): Promise<void> {
    await this.process.send({ arm: barrier });
    await this.process.waitFor(new RegExp(`^armed ${barrier}$`), BARRIER_TIMEOUT_MS);
  }

  async disarm(barrier: 'consumer' | 'publisher'): Promise<void> {
    await this.process.send({ disarm: barrier });
    await this.process.waitFor(new RegExp(`^disarmed ${barrier}$`), BARRIER_TIMEOUT_MS);
  }

  waitFor(pattern: RegExp, timeoutMs = BARRIER_TIMEOUT_MS): Promise<string> {
    return this.process.waitFor(pattern, timeoutMs);
  }

  /**
   * The uncleaned death: `SIGKILL` runs no handler, finishes no transaction and releases nothing in
   * code. What the drill then observes is PostgreSQL releasing the locks with the connection and
   * SQS redelivering what was never acknowledged, which is the whole of the recovery under test.
   */
  async kill(): Promise<void> {
    this.process.signal('SIGKILL');
    await this.process.exited();

    if (this.process.killedBy() !== 'SIGKILL') {
      throw new Error(
        `the instance was meant to die of SIGKILL and exited by itself: ${this.process.output()}`,
      );
    }
  }

  alive(): boolean {
    return this.process.alive();
  }

  output(): string {
    return this.process.output();
  }

  /** How many lines matching `pattern` this instance has written, which is how copies are counted. */
  count(pattern: RegExp): number {
    return this.process
      .output()
      .split('\n')
      .filter((line) => pattern.test(line)).length;
  }

  dispose(): Promise<void> {
    return this.process.dispose();
  }
}

/**
 * The instances of the drill. Every one of them is identical and any of them may be the one that
 * claims a message or a row, so a barrier is armed on all of them and the drill kills whichever
 * reached it: the window is then deterministic without the case having to decide in advance which
 * process wins a race PostgreSQL and the broker are there to settle.
 *
 * A killed instance is replaced at once, so three are alive at every step of the drill
 * (`conc.multi-instance`): a guarantee that held because only one process was left would be no
 * guarantee at all.
 */
class Fleet {
  private readonly members: Instance[] = [];
  private readonly dead: Instance[] = [];

  static async start(count: number): Promise<Fleet> {
    const fleet = new Fleet();

    for (let started = 0; started < count; started += 1) {
      fleet.members.push(await Instance.start());
    }

    return fleet;
  }

  get live(): readonly Instance[] {
    return this.members;
  }

  /** Every instance the drill has run, the killed ones included: their output is evidence too. */
  get everyone(): readonly Instance[] {
    return [...this.members, ...this.dead];
  }

  aliveCount(): number {
    return this.members.filter((instance) => instance.alive()).length;
  }

  /**
   * How many lines matching `pattern` the instances of this drill have written, the killed ones
   * included: a copy a dead process sent and a line it logged are evidence of what it did, and the
   * drill reads them off the output it collected while the process was alive.
   */
  count(pattern: RegExp): number {
    return this.everyone.reduce((total, instance) => total + instance.count(pattern), 0);
  }

  async arm(barrier: 'consumer' | 'publisher'): Promise<void> {
    await Promise.all(this.members.map((instance) => instance.arm(barrier)));
  }

  async disarm(barrier: 'consumer' | 'publisher'): Promise<void> {
    await Promise.all(this.members.map((instance) => instance.disarm(barrier)));
  }

  /**
   * The instance that reached the barrier, and the line it announced it with. `Promise.any` is what
   * makes it the first of them rather than a named one; a barrier none of them reached rejects with
   * every instance's output, which is the loud failure a drill needs — a window that never opened
   * must never read as a window that was survived.
   */
  async firstToReach(
    pattern: RegExp,
    timeoutMs = BARRIER_TIMEOUT_MS,
  ): Promise<{ instance: Instance; line: string }> {
    const waiting = this.members.map(async (instance) => ({
      instance,
      line: await instance.waitFor(pattern, timeoutMs),
    }));

    try {
      return await Promise.any(waiting);
    } catch {
      throw new Error(
        `no instance reached the barrier ${pattern.source} within ${timeoutMs.toString()} ms, so the window it stands for was never opened: ${this.diagnostics()}`,
      );
    }
  }

  /** Kills one instance and starts its replacement, so the drill carries on with three. */
  async kill(instance: Instance): Promise<void> {
    await instance.kill();
    this.members.splice(this.members.indexOf(instance), 1);
    this.dead.push(instance);
    this.members.push(await Instance.start());
  }

  async stop(): Promise<void> {
    await Promise.all(this.everyone.map((instance) => instance.dispose()));
  }

  diagnostics(): string {
    return this.everyone
      .map((instance, index) => `instance ${index.toString()}: ${instance.output()}`)
      .join('\n');
  }
}

/**
 * The downstream consumer, running for the length of the drill: it receives from
 * `wager-integration-events.fifo` and deduplicates by `eventId`, which is the whole of what
 * `event.at-least-once` asks of a consumer. It runs continuously rather than being drained at each
 * assertion because the publications it has to see are the ones a crash produced, and when those
 * reach the queue is the broker's business and not the drill's.
 */
class EventFeed {
  readonly consumer = new ReferenceConsumer();

  private running = true;
  private readonly pumping: Promise<void>;

  private constructor(private readonly queue: EventsQueue) {
    this.pumping = this.pump();
  }

  static start(queue: EventsQueue): EventFeed {
    return new EventFeed(queue);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.pumping;
  }

  private async pump(): Promise<void> {
    while (this.running) {
      for (const delivered of await this.queue.receive(10, { timeoutMs: 1500, emptyRounds: 1 })) {
        this.consumer.apply(delivered.envelope);
      }
    }
  }
}

describe('crash-recovery-barriers', () => {
  /**
   * The drill's own safety catch. Every window below is asserted after an instance announced that
   * it was standing in it, so a barrier that is never reached has to fail the run: without this,
   * a seam that stopped working — a rename, a refactor that moved the commit — would turn the drill
   * into a suite that kills idle processes and finds the books in order.
   */
  test('a barrier that is never reached fails the drill rather than passing it', async () => {
    expect(await rejection(fleet.firstToReach(/^held-after-commit$/, 1000))).toMatch(
      /no instance reached the barrier .*, so the window it stands for was never opened/,
    );
  });

  test(`the ${INSTANCES.toString()} instances are distinct processes, none of them the suite`, () => {
    const pids = fleet.live.map((instance) => instance.pid);

    expect(new Set(pids).size).toBe(INSTANCES);
    expect(pids).not.toContain(process.pid);
    expect(fleet.aliveCount()).toBe(INSTANCES);
  });
});

/**
 * The drill. It is one test because the windows have to be opened in one run of the service: a
 * worker dies holding a committed message while a publisher is draining the events of other
 * operations, a publisher dies holding a sent row while a scheduler is attempting a parked
 * reversal, and what the assertions at the end are about is the state all of that left behind.
 */
describe('crash-recovery-drill', () => {
  test(
    'killed workers and publishers cost duplicates and never an effect, and every wallet reconciles',
    async () => {
      // The downstream consumer starts once the truncation above has removed every row another
      // suite left and the queue has been emptied of whatever those rows had already produced, so
      // every event it applies below is one this drill committed.
      await events.drain();
      feed = EventFeed.start(events);
      const consumer = feed.consumer;
      const absorbed = /"event":"wager\.delivery\.absorbed"/;

      const bettor = await walletWith(OPENING_BALANCE);
      const reverser = await walletWith(OPENING_BALANCE);
      const opened = {
        kind: 'OPENING',
        status: 'PROCESSED',
        failureCode: null,
        observedBalance: OPENING_BALANCE,
      };

      // ---------------------------------------------------------------- the worker window
      // MSG-006. Every instance is armed, because any of them may be the one the broker hands the
      // message to; the one that commits it announces itself and the other two never see a message.
      await fleet.arm('consumer');

      const betMessageId = `acme-msg-${bettor.walletId}`;
      const betOperation = operationOf({ ...bettor, kind: 'BET', amount: BET_AMOUNT });
      await sendToInput(
        betMessage({ messageId: betMessageId, operation: betOperation }),
        bettor.walletId,
      );

      const committed = await fleet.firstToReach(/^committed /);
      const betTransactionId = committed.line.slice('committed '.length).split(' ')[0] ?? '';

      // The state the kill is about to interrupt: everything the delivery recorded is durable, and
      // the acknowledgement that would have retired the message has not been issued.
      const betRecorded = {
        id: betTransactionId,
        kind: 'BET',
        status: 'PROCESSED',
        failureCode: null,
        observedBalance: '460.00',
      };
      expect(await transactionsOf(bettor.walletId)).toMatchObject([opened, betRecorded]);
      expect(await ledgerOf(bettor.walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
      expect(await balanceOf(bettor.walletId)).toEqual({ balance: '460.00', version: 2 });
      // The inbox row commits with the money and not with the acknowledgement (ADR 0010), so it is
      // already complete here: that is what makes the redelivery below absorbable at all.
      expect(await inboxRows()).toEqual([{ messageId: betMessageId, completed: true }]);
      expect(await outboxEventTypesOf(bettor.walletId)).toEqual([
        'WagerTransactionProcessed',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
      // Still in the queue, invisible for the rest of its visibility: nothing deleted it.
      expect(await inputQueueDepth()).toEqual({ visible: 0, inFlight: 1 });

      const absorbedBefore = fleet.count(absorbed);

      // Disarmed before the kill and not after it: the redelivery has to be an ordinary delivery,
      // acknowledged like any other, and a survivor still watching the barrier would hold it.
      await fleet.disarm('consumer');
      await fleet.kill(committed.instance);

      // ---------------------------------------------------------------- the redelivery
      // The dead instance never deleted the message, so the broker delivers it again once its
      // visibility expires. The inbox absorbs it and the surviving instance acknowledges it.
      await waitUntil(
        inputQueueEmpty,
        SETTLE_TIMEOUT_MS,
        'the redelivery of the committed message to be absorbed and acknowledged',
      );

      expect(fleet.count(absorbed)).toBeGreaterThan(absorbedBefore);

      // No second effect, and none of it moved: one transaction, one debit, one balance (MSG-006).
      expect(await transactionsOf(bettor.walletId)).toMatchObject([opened, betRecorded]);
      expect(await ledgerOf(bettor.walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
      expect(await balanceOf(bettor.walletId)).toEqual({ balance: '460.00', version: 2 });
      expect(fleet.aliveCount()).toBe(INSTANCES);

      // ------------------------------------------------- duplicates the broker cannot filter
      // MSG-011. The same message body twice more, each with a deduplication id the broker has
      // never seen, so its five-minute window filters neither and what absorbs them is the inbox
      // row and nothing else.
      const duplicates = 2;
      const duplicatesBefore = fleet.count(absorbed);

      for (let copy = 0; copy < duplicates; copy += 1) {
        await sendToInput(
          betMessage({ messageId: betMessageId, operation: betOperation }),
          bettor.walletId,
        );
      }

      await waitUntil(
        async () =>
          fleet.count(absorbed) >= duplicatesBefore + duplicates && (await inputQueueEmpty()),
        SETTLE_TIMEOUT_MS,
        'the two duplicate deliveries to be absorbed and acknowledged',
      );

      expect(await transactionsOf(bettor.walletId)).toMatchObject([opened, betRecorded]);
      expect(await ledgerOf(bettor.walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
      expect(await inboxRows()).toEqual([{ messageId: betMessageId, completed: true }]);

      // ---------------------------------------------------------------- the publisher window
      // OUTBOX-005 and OUTBOX-006. The backlog is drained first, so the row the publisher holds is
      // the only pending one and which instance claims it is decided rather than raced: a reversal
      // delivered before the operation it reverses is parked, and parking emits exactly one event.
      await waitUntil(
        async () => (await pendingOutboxRows()) === 0,
        SETTLE_TIMEOUT_MS,
        'the outbox to drain before the publisher window is opened',
      );

      await fleet.arm('publisher');

      const reversedExternalId = `acme-tx-${reverser.walletId}-bet`;
      const rollbackExternalId = `acme-tx-${reverser.walletId}-rollback`;
      await sendToInput(
        betMessage({
          messageId: `acme-msg-${reverser.walletId}-rollback`,
          operation: operationOf({
            ...reverser,
            kind: 'ROLLBACK',
            amount: BET_AMOUNT,
            externalTransactionId: rollbackExternalId,
            reference: reversedExternalId,
          }),
        }),
        reverser.walletId,
      );

      const held = await fleet.firstToReach(/^held-after-send /);
      const heldEventId = held.line.slice('held-after-send '.length);
      const pendingRow = {
        eventType: 'WagerTransactionPendingReference',
        attempts: 0,
        published: false,
      };

      // The state the kill is about to interrupt: the message is at the broker — the downstream
      // consumer has it — and the row it came from is still pending, inside a transaction that
      // holds the claim and will never commit.
      await waitUntil(
        () => Promise.resolve(consumer.copiesOf(heldEventId) >= 1),
        SETTLE_TIMEOUT_MS,
        'the publication the dying publisher sent to reach the downstream consumer',
      );
      expect(await outboxRow(heldEventId)).toEqual(pendingRow);
      expect(await transactionsOf(reverser.walletId)).toMatchObject([
        opened,
        { kind: 'ROLLBACK', status: 'PENDING_REFERENCE', failureCode: null },
      ]);
      expect(await scheduleRows()).toHaveLength(1);

      await fleet.disarm('publisher');
      await fleet.kill(held.instance);

      // The claim went with the connection, and that is the whole of `outbox.crash-recovery`:
      // nothing was reaped, nobody was called, and the next publisher to come round had the row.
      // What this waits for is the republication and not an instant — asserting that the row is
      // still pending right after the kill would be racing the recovery it is there to observe,
      // and the recovery wins, which is the point.
      await waitUntil(
        async () => (await outboxRow(heldEventId)).published,
        SETTLE_TIMEOUT_MS,
        'a surviving publisher to republish the row the killed one had sent and not recorded',
      );
      expect(fleet.aliveCount()).toBe(INSTANCES);

      // ---------------------------------------------------------------- recovery
      // The reference arrives, and from here nothing is driven: the restarted and surviving
      // instances republish the held row, apply the parked reversal and drain what is left.
      await sendToInput(
        betMessage({
          messageId: `acme-msg-${reverser.walletId}-bet`,
          operation: operationOf({
            ...reverser,
            kind: 'BET',
            amount: BET_AMOUNT,
            externalTransactionId: reversedExternalId,
          }),
        }),
        reverser.walletId,
      );

      await waitUntil(
        async () => (await statusesOf()).every((status) => status !== 'PENDING_REFERENCE'),
        SETTLE_TIMEOUT_MS,
        'the scheduler to apply the parked reversal once its reference arrived',
      );
      await waitUntil(
        async () => (await pendingOutboxRows()) === 0,
        SETTLE_TIMEOUT_MS,
        'the publishers to drain the outbox, the row the killed one had sent included',
      );
      await waitUntil(
        inputQueueEmpty,
        SETTLE_TIMEOUT_MS,
        'the input queue to be acknowledged empty',
      );

      // REF-002 and REF-005: the parked reversal was applied once, under the rules a first arrival
      // would have faced, and the inverse entry is the only thing it left behind.
      expect(await transactionsOf(reverser.walletId)).toMatchObject([
        opened,
        { kind: 'ROLLBACK', status: 'PROCESSED', failureCode: null },
        { kind: 'BET', status: 'PROCESSED', failureCode: null, observedBalance: '460.00' },
      ]);
      expect(await ledgerOf(reverser.walletId)).toEqual([
        'OPENING CREDIT',
        'BET DEBIT',
        'ROLLBACK CREDIT',
      ]);
      expect(await balanceOf(reverser.walletId)).toEqual({
        balance: OPENING_BALANCE,
        version: 3,
      });
      // One attempt per claim, so a row two schedulers had reprocessed would say so (REF-002).
      expect(await scheduleRows()).toHaveLength(1);

      // Nothing is left for nobody to advance: every transaction row carries a terminal outcome.
      expect([...new Set(await statusesOf())]).toEqual(['PROCESSED']);

      // OUTBOX-006: the row the killed publisher had sent is published, and the instances announced
      // more than one send of its event — the crash cost a copy. How many of those the queue
      // delivers is the broker's deduplication window's business and a consumer may never rely on
      // it, so the consumer is handed every copy the instances announced along with whatever the
      // queue gave it, and has to apply the event once.
      expect(await outboxRow(heldEventId)).toMatchObject({ published: true });

      const sends = fleet.count(new RegExp(`^sent ${heldEventId}$`));
      expect(sends).toBeGreaterThan(1);

      const republished = await payloadOf(heldEventId);
      const appliedBefore = consumer.appliedCount;
      const copiesBefore = consumer.copiesOf(heldEventId);

      for (let copy = 0; copy < sends; copy += 1) {
        expect(consumer.apply(republished)).toBe('duplicate');
      }

      expect(consumer.copiesOf(heldEventId)).toBe(copiesBefore + sends);
      expect(consumer.appliedCount).toBe(appliedBefore);
      expect(consumer.appliedEvent(heldEventId)).toEqual(republished);

      // Every committed event reached the consumer, and the envelope it applied is the one the row
      // stores, whatever the crashes cost in copies (`event.at-least-once`, `outbox.stable-event-id`).
      const published = await publishedEventIds();
      await waitUntil(
        () => Promise.resolve(published.every((eventId) => consumer.copiesOf(eventId) >= 1)),
        SETTLE_TIMEOUT_MS,
        'every published event to reach the downstream consumer',
      );

      for (const eventId of published) {
        expect(consumer.appliedEvent(eventId)).toEqual(await payloadOf(eventId));
      }

      // The consumer's own books, rebuilt from the balance events it applied in `walletVersion`
      // order, agree with the balances the service stored (`event.ordering`).
      for (const walletId of [bettor.walletId, reverser.walletId]) {
        expect(consumer.rebuiltBalanceOf(walletId, Money.from('0.00', 'BRL')).toString()).toBe(
          (await balanceOf(walletId)).balance,
        );
      }

      // Nothing was dead-lettered: every message of the drill was business, and a window that cost
      // a redelivery may never cost a message its five receives.
      expect(await deadLetterDepth()).toBe(0);
    },
    DRILL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------- the stack, as the drill reads it

/** The message of a rejection, as the suites assert refusals without `.rejects`. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected a rejection');
}

async function urlOf(queueName: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (QueueUrl === undefined) {
    throw new Error(`the stack has no queue ${queueName}`);
  }

  return QueueUrl;
}

interface WalletUnderTest {
  readonly walletId: string;
  readonly playerId: string;
}

/** A wallet with its player, opened through the use case and registered for the final sweep. */
async function walletWith(initialBalance: string): Promise<WalletUnderTest> {
  const playerId = uuidV7IdGenerator.next();
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
    correlationId: CORRELATION_ID,
  });

  return { walletId: touched.add(wallet.id), playerId };
}

interface OperationUnderTest extends WalletUnderTest {
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly amount: string;
  readonly externalTransactionId?: string;
  readonly reference?: string;
}

/** The business fields of `WagerOperationFields` in [docs/openapi.yaml](../../docs/openapi.yaml). */
function operationOf({
  walletId,
  playerId,
  kind,
  amount,
  externalTransactionId,
  reference,
}: OperationUnderTest): Record<string, unknown> {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId: externalTransactionId ?? `acme-tx-${walletId}`,
    playerId,
    walletId,
    roundId: ROUND_ID,
    gameId: GAME_ID,
    kind,
    money: { amount, currency: 'BRL' },
    // Absent and not null for a kind that references nothing: the schema is strict about it.
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  };
}

/** The `WagerTransactionRequested` envelope of [docs/asyncapi.yaml](../../docs/asyncapi.yaml). */
function betMessage({
  messageId,
  operation,
}: {
  readonly messageId: string;
  readonly operation: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-29T12:05:00.000Z',
    correlationId: 'acme-req-5f2c',
    data: {
      ...operation,
      idempotencyKey: `${PROVIDER_ID}:${String(operation['externalTransactionId'])}`,
    },
  };
}

/**
 * One message, with a deduplication id of its own. The producer contract asks for the wallet as
 * `MessageGroupId` and `messageId` as `MessageDeduplicationId` (`msg.producer-contract`), and both
 * are advisory: a drill that sends one body three times has to defeat the broker's five-minute
 * window to prove that what absorbs the copies is the inbox (`msg.broker-features-optional`).
 */
async function sendToInput(message: Record<string, unknown>, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: inputQueueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/** What the input queue holds: what a consumer could receive, and what one is holding. */
async function inputQueueDepth(): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: inputQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );

  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? '0'),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'),
  };
}

/**
 * Whether the input queue holds nothing a consumer could receive and nothing one is holding, which
 * is what "every message of this step was acknowledged" amounts to: a message that was processed and
 * not deleted would still be in flight, and one that was returned would be visible again.
 */
async function inputQueueEmpty(): Promise<boolean> {
  const depth = await inputQueueDepth();

  return depth.visible + depth.inFlight === 0;
}

async function deadLetterDepth(): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );

  return Number(Attributes?.ApproximateNumberOfMessages ?? '0');
}

/** Empties a queue, so the drill neither inherits a message nor leaves one for another suite. */
async function drainQueue(queueUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
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

const drainInputQueue = (): Promise<void> => drainQueue(inputQueueUrl);
const drainDeadLetterQueue = (): Promise<void> => drainQueue(deadLetterQueueUrl);

// ---------------------------------------------------------------- the rows, as the drill reads them

interface RecordedTransaction {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly observedBalance: string | null;
}

/**
 * One wallet's transactions in the order they were created, which is the order they arrived in and
 * therefore starts with the internal `OPENING` the wallet was opened by (`tx.opening-internal`).
 */
async function transactionsOf(walletId: string): Promise<RecordedTransaction[]> {
  return runtime.em.getConnection().execute<RecordedTransaction[]>(
    `select "id",
              "kind",
              "status",
              "failure_code" as "failureCode",
              "observed_balance"::text as "observedBalance"
         from "wager_transactions"
        where "wallet_id" = ?
        order by "created_at", "id"`,
    [walletId],
  );
}

/** Every status the table holds, which is how "nothing is left non-terminal" is asserted. */
async function statusesOf(): Promise<string[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ status: string }[]>('select "status" from "wager_transactions"');

  return rows.map((row) => row.status);
}

/** The ledger of one wallet, as the pairs of kind and direction its entries carry, in order. */
async function ledgerOf(walletId: string): Promise<string[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ kind: string; direction: string }[]>(
      'select "kind", "direction" from "wallet_ledger_entries" where "wallet_id" = ? order by "wallet_version"',
      [walletId],
    );

  return rows.map((row) => `${row.kind} ${row.direction}`);
}

async function balanceOf(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ balance: string; version: number }[]>(
      'select "balance"::text as "balance", "version" from "wallets" where "id" = ?',
      [walletId],
    );

  if (row === undefined) {
    throw new Error(`wallet ${walletId} does not exist`);
  }

  return row;
}

/** The inbox, as the delivery identity of each row and whether the row is complete (ADR 0010). */
async function inboxRows(): Promise<{ messageId: string; completed: boolean }[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ messageId: string; processedAt: Date | null }[]>(
      'select "message_id" as "messageId", "processed_at" as "processedAt" from "inbox_messages" order by "message_id"',
    );

  return rows.map((row) => ({ messageId: row.messageId, completed: row.processedAt !== null }));
}

async function scheduleRows(): Promise<{ transactionId: string; attempts: number }[]> {
  return runtime.em
    .getConnection()
    .execute<{ transactionId: string; attempts: number }[]>(
      'select "transaction_id" as "transactionId", "attempts" from "pending_reference_schedule"',
    );
}

/** The event types one wallet's outbox rows carry, sorted, since two of a kind share a moment. */
async function outboxEventTypesOf(walletId: string): Promise<string[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ eventType: string }[]>(
      'select "event_type" as "eventType" from "outbox_messages" where "aggregate_id" = ?',
      [walletId],
    );

  return rows.map((row) => row.eventType).toSorted();
}

async function outboxRow(
  eventId: string,
): Promise<{ eventType: string; attempts: number; published: boolean }> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ eventType: string; attempts: number; publishedAt: Date | null }[]>(
      'select "event_type" as "eventType", "attempts", "published_at" as "publishedAt" from "outbox_messages" where "event_id" = ?',
      [eventId],
    );

  if (row === undefined) {
    throw new Error(`the outbox holds no row for event ${eventId}`);
  }

  return { eventType: row.eventType, attempts: row.attempts, published: row.publishedAt !== null };
}

/** The envelope a row stores, which is byte for byte what every publication of it sent. */
async function payloadOf(eventId: string): Promise<IntegrationEventEnvelope> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ payload: IntegrationEventEnvelope }[]>(
      'select "payload" from "outbox_messages" where "event_id" = ?',
      [eventId],
    );

  if (row === undefined) {
    throw new Error(`the outbox holds no row for event ${eventId}`);
  }

  return row.payload;
}

async function pendingOutboxRows(): Promise<number> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ pending: string }[]>(
      'select count(*)::text as "pending" from "outbox_messages" where "published_at" is null',
    );

  return Number(row?.pending ?? '0');
}

async function publishedEventIds(): Promise<string[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ eventId: string }[]>(
      'select "event_id" as "eventId" from "outbox_messages" where "published_at" is not null',
    );

  return rows.map((row) => row.eventId);
}

/**
 * Waits for a condition the instances are the ones producing, and fails naming what was waited for.
 * The drill never waits a number of milliseconds for recovery: when a redelivery arrives, when a
 * claim is taken and when an attempt is due are the broker's, PostgreSQL's and `ref.backoff`'s to
 * decide, so what a step waits for is the state and not the clock.
 */
async function waitUntil(
  settled: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await settled()) {
      return;
    }

    await Bun.sleep(100);
  }

  throw new Error(
    `the drill waited ${timeoutMs.toString()} ms for ${description} and it never happened: ${fleet.diagnostics()}`,
  );
}
