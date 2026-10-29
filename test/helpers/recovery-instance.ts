/**
 * One `worker` instance in a process of its own, with the two crash barriers the recovery drill
 * kills it at. It is the composition the `worker` role runs — the queue consumer, the outbox
 * publisher and the pending-reference scheduler, started and drained as one `WorkerRuntime`
 * (`ops.single-image-roles`, ADR 0013) — plus one seam per failure window:
 *
 * - after the commit of a delivery and before the acknowledgement of its message
 *   (`msg.ack-after-commit`), which is the window MSG-006 exists for;
 * - after a publication reached the broker and before the commit that records it
 *   (`outbox.duplicate-safe`), which is the window OUTBOX-006 exists for.
 *
 * A barrier is a pause and not a death: the instance announces that it reached the point and then
 * blocks there forever, so the drill asserts the state the kill is meant to interrupt and only then
 * sends `SIGKILL`. A kill at an arbitrary moment would prove nothing — it might land before the
 * commit, where there is no window at all — and a helper that killed itself would decide the moment
 * the drill has to assert.
 *
 * Both barriers are armed from outside and are one-shot, because every instance of a drill is
 * identical and any of them may be the one that claims the work: the drill arms them all, kills
 * whichever reached the barrier and disarms the survivors, which is what keeps the window
 * deterministic without deciding in advance which process wins the race for a message or a row.
 *
 * Usage: `bun run test/helpers/recovery-instance.ts`, with one JSON instruction per line on stdin:
 *
 * - `{"arm":"consumer"}` / `{"arm":"publisher"}` — answered `armed <barrier>`.
 * - `{"disarm":"consumer"}` / `{"disarm":"publisher"}` — answered `disarmed <barrier>`.
 *
 * It writes one line per event to stdout — `ready <pid>` once the loops are running,
 * `committed <transactionId> <messageId>` and `held-after-commit` at the consumer barrier,
 * `sent <eventId>` after every publication and `held-after-send <eventId>` at the publisher barrier
 * — and its log to stderr, so a drill parses the protocol off one stream and reads the service's own
 * records off the other. `SIGTERM` drains it through the production shutdown.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { sha256Hex } from '../../src/application/sha256';
import { ReprocessPendingReference } from '../../src/application/use-cases/reprocess-pending-reference';
import type {
  DeliveryOutcome,
  MessageDelivery,
  SubmitWagerTransactionCommand,
} from '../../src/application/use-cases/submit-wager-transaction';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { outboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import {
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  queueUrlResolver,
} from '../../src/infrastructure/messaging/sqs';
import {
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
} from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import {
  PENDING_REFERENCE_SCHEDULER,
  PendingReferenceScheduler,
} from '../../src/infrastructure/runtime/pending-reference-scheduler';
import { onShutdownSignal } from '../../src/infrastructure/runtime/shutdown';
import { WORKER_RUNTIME, WorkerRuntime } from '../../src/infrastructure/runtime/worker-runtime';

const instructionSchema = z.union([
  z.object({ arm: z.enum(['consumer', 'publisher']) }),
  z.object({ disarm: z.enum(['consumer', 'publisher']) }),
]);

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** The two barriers, armed and disarmed from stdin and consumed by the first point that reaches one. */
const armed = { consumer: false, publisher: false };

/**
 * The pause a barrier is. Nothing resolves it: the drill asserts the durable state the barrier
 * stopped in and then kills the process, which is the only thing that ends this wait.
 */
const forever = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * The consumer barrier: the transaction has committed — the outcome, the wallet, the ledger entry,
 * the inbox row and the outbox rows are durable — and the delete that would acknowledge the message
 * has not been issued. An absorbed delivery is never held, because it committed nothing: the
 * redelivery of a message whose effect is already recorded is what the drill expects a *survivor*
 * to acknowledge, so the window belongs to the first delivery alone (`msg.redelivery-safe`).
 */
class HoldsAfterCommit extends SubmitWagerTransaction {
  override async deliver(
    command: SubmitWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<DeliveryOutcome> {
    const outcome = await super.deliver(command, delivery);

    if (armed.consumer && !outcome.absorbed) {
      armed.consumer = false;
      say(`committed ${outcome.transaction.id} ${delivery.messageId}`);
      say('held-after-commit');
      await forever();
    }

    return outcome;
  }
}

/**
 * The publisher barrier: the message is at the broker and the row it came from is still pending,
 * inside a transaction that holds the claim. Announcing every publication is what lets the drill
 * count the copies of one event the instances sent, which is the number `outbox.duplicate-safe`
 * is about: the row is republished after this process dies, and a consumer deduplicating by
 * `eventId` has to apply it once however many copies it is handed.
 */
const holdingAfterSend = (over: EventPublisher): EventPublisher => ({
  publish: async (message: OutboxMessage): Promise<void> => {
    await over.publish(message);
    say(`sent ${message.eventId}`);

    if (armed.publisher) {
      armed.publisher = false;
      say(`held-after-send ${message.eventId}`);
      await forever();
    }
  },
});

const env = loadEnv(process.env);
// On stderr, so the lines a drill parses off stdout are this helper's protocol alone.
const logger = jsonLinesLogger('recovery-instance', process.stderr);
const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));
const sqs = new SQSClient({
  region: env.AWS_REGION,
  ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
});

// One registry per instance, as the composition root builds it: a counter belongs to the process
// that raised it (`obs.metrics`).
const metrics = new MetricsRegistry();
const unitOfWork = new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS, metrics);

const consumer = new WagerTransactionsConsumer({
  sqs,
  queueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_QUEUE),
  deadLetterQueueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_DLQ),
  submit: new HoldsAfterCommit({
    unitOfWork,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
    logger,
    metrics,
  }),
  metrics,
  logger,
  consumerName: WAGER_TRANSACTIONS_CONSUMER,
  waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
  visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
  retryBackoff: {
    baseSeconds: env.SQS_RETRY_BACKOFF_BASE_SECONDS,
    maxSeconds: env.SQS_RETRY_BACKOFF_MAX_SECONDS,
  },
});

const publisher = outboxPublisher({
  em: orm.em,
  env,
  sqs,
  publisher: holdingAfterSend(
    new SqsEventPublisher(sqs, { timeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS }),
  ),
  logger,
  metrics,
});

const scheduler = new PendingReferenceScheduler(
  new ReprocessPendingReference({
    unitOfWork,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    logger: jsonLinesLogger(PENDING_REFERENCE_SCHEDULER, process.stderr),
    metrics,
  }),
  { sweepIntervalMs: env.PENDING_REFERENCE_SWEEP_INTERVAL_MS, logger },
);

const runtime = new WorkerRuntime(
  [consumer, publisher, scheduler],
  jsonLinesLogger(WORKER_RUNTIME, process.stderr),
);

/*
 * The service's own signal handling, so an instance the drill is finished with drains the way a
 * deployment drains it. An instance parked at a barrier cannot drain — the loop holding it never
 * returns — so its grace period expires and it exits with `DRAIN_INCOMPLETE_EXIT`, which is correct
 * and is also why the drill kills those with `SIGKILL` instead of asking them politely.
 */
onShutdownSignal({
  drain: async () => {
    await runtime.beforeApplicationShutdown();
    await orm.close(true);
    sqs.destroy();
  },
  gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
  logger,
});

runtime.onApplicationBootstrap();
say(`ready ${process.pid.toString()}`);

const handle = (line: string): void => {
  if (line.trim() === '') {
    return;
  }

  const instruction = instructionSchema.parse(JSON.parse(line) as unknown);

  if ('arm' in instruction) {
    armed[instruction.arm] = true;
    say(`armed ${instruction.arm}`);

    return;
  }

  armed[instruction.disarm] = false;
  say(`disarmed ${instruction.disarm}`);
};

const decoder = new TextDecoder();
let buffered = '';

for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';

  for (const line of lines) {
    handle(line);
  }
}
