import { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { Clock } from '../../application/ports/clock';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { Logger } from '../../application/ports/logger';
import type { Metrics } from '../../application/ports/metrics';
import { PublishOutbox } from '../../application/use-cases/publish-outbox';
import { systemClock } from '../clock';
import type { Env } from '../config/env';
import { jsonLinesLogger } from '../observability/logger';
import { uncountedMetrics } from '../observability/metrics';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm.unit-of-work';
import { WorkerLoop, type WorkerProcess } from '../runtime/worker-loop';
import { wagerQueues } from './sqs';
import { SqsEventPublisher } from './sqs-event-publisher';

export interface OutboxPublisherOptions {
  /** How long to wait after a cycle that found nothing to publish. */
  readonly pollIntervalMs: number;
  readonly logger: Logger;
}

/** What this process is called in the logs of a startup and of a drain. */
export const OUTBOX_PUBLISHER = 'outbox-publisher';

/**
 * The publisher as a running process: cycles of `PublishOutbox`, one after another, for as long as
 * it is started (ADR 0005). It holds no state about the outbox — the rows are the state — so any
 * number of these run against one table and a new one takes over whatever a dead one was holding
 * (`outbox.concurrent-publishers`, `outbox.crash-recovery`).
 *
 * The pacing, the failure handling and the drain are `WorkerLoop`'s, which is the loop every
 * background process of this service runs; one cycle of this one is one `PublishOutbox` transaction,
 * so `stop` resolving means a publication that was sent has been recorded before the process exits
 * (`ops.graceful-shutdown`).
 */
export class OutboxPublisher implements WorkerProcess {
  readonly name = OUTBOX_PUBLISHER;

  private readonly loop: WorkerLoop;

  constructor(publishOutbox: PublishOutbox, options: OutboxPublisherOptions) {
    this.loop = new WorkerLoop({
      cycle: async () => (await publishOutbox.execute()).claimed > 0,
      idleIntervalMs: options.pollIntervalMs,
      failureEvent: 'outbox.publication-cycle-failed',
      logger: options.logger,
    });
  }

  /** Starts the loop, or does nothing if it is already running. */
  start(): void {
    this.loop.start();
  }

  /** Stops claiming and resolves when the batch in flight has been committed or rolled back. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}

export interface OutboxPublisherDependencies {
  readonly em: EntityManager;
  readonly env: Env;
  /** Taken as a dependency so that one process's client is shared with its other SQS components. */
  readonly sqs?: SQSClient;
  readonly publisher?: EventPublisher;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /**
   * The registry of the process this publisher runs in, so `wager_retries_total{component="outbox"}`
   * is counted on the instance that backed off. A caller with no registry — a probe, or a suite
   * that asserts rows rather than metrics — counts nothing (`uncountedMetrics`).
   */
  readonly metrics?: Metrics;
}

/**
 * The publisher wired from the validated environment: the one place its adapters are chosen, so
 * the loop a test drives is the loop a deployment runs and neither has to be assembled twice.
 */
export function outboxPublisher(dependencies: OutboxPublisherDependencies): OutboxPublisher {
  const { em, env } = dependencies;
  const logger = dependencies.logger ?? jsonLinesLogger('outbox-publisher');
  const sqs =
    dependencies.sqs ??
    new SQSClient({
      region: env.AWS_REGION,
      ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
    });

  return new OutboxPublisher(
    new PublishOutbox({
      unitOfWork: new MikroOrmUnitOfWork(em, env.LOCK_TIMEOUT_MS),
      publisher:
        dependencies.publisher ??
        new SqsEventPublisher(sqs, {
          queueName: wagerQueues(env.SQS_QUEUE_PREFIX).events,
          timeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS,
        }),
      clock: dependencies.clock ?? systemClock,
      logger,
      metrics: dependencies.metrics ?? uncountedMetrics,
      batchSize: env.OUTBOX_BATCH_SIZE,
    }),
    { pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS, logger },
  );
}
