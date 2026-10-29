import { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { Clock } from '../../application/ports/clock';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { Logger } from '../../application/ports/logger';
import { PublishOutbox } from '../../application/use-cases/publish-outbox';
import { systemClock } from '../clock';
import type { Env } from '../config/env';
import { nestLogger } from '../observability/logger';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm.unit-of-work';
import { SqsEventPublisher } from './sqs-event-publisher';

export interface OutboxPublisherOptions {
  /** How long to wait after a cycle that found nothing to publish. */
  readonly pollIntervalMs: number;
  readonly logger: Logger;
}

/**
 * The publisher as a running process: cycles of `PublishOutbox`, one after another, for as long as
 * it is started (ADR 0005). It holds no state about the outbox — the rows are the state — so any
 * number of these run against one table and a new one takes over whatever a dead one was holding
 * (`outbox.concurrent-publishers`, `outbox.crash-recovery`).
 *
 * A cycle that claimed anything is followed immediately by the next one, because a full batch
 * means there is probably more due; only an empty cycle waits, which is what keeps an idle
 * deployment from polling PostgreSQL as fast as it can and a backlog from draining at one batch
 * per interval.
 *
 * A cycle that fails is reported and the loop continues. There is nothing else to do and nothing
 * is lost: the rows it did not publish are still pending, and a database that is unavailable now
 * makes the next cycle fail too, which is the backoff this loop needs and the only one it has,
 * because a cycle that cannot reach PostgreSQL cannot record an attempt either.
 *
 * `stop` resolves once the cycle in flight has finished, so a publication that was sent is always
 * recorded before the process exits (`ops.graceful-shutdown`); the role that signals it on
 * `SIGTERM` is wired separately.
 */
export class OutboxPublisher {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly options: OutboxPublisherOptions,
  ) {}

  /** Starts the loop, or does nothing if it is already running. */
  start(): void {
    this.running ??= this.run();
  }

  /** Stops claiming and resolves when the batch in flight has been committed or rolled back. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
    this.stopping = false;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      if (await this.cycle()) {
        await this.waitForWork();
      }
    }
  }

  /** One cycle; `true` when it found nothing to do, including because it failed. */
  private async cycle(): Promise<boolean> {
    try {
      return (await this.publishOutbox.execute()).claimed === 0;
    } catch (error) {
      this.options.logger.error('outbox.publication-cycle-failed', {
        reason: error instanceof Error ? error.message : String(error),
      });

      return true;
    }
  }

  /** The poll interval, cut short by `stop` so a shutdown never waits out an idle wait. */
  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.options.pollIntervalMs);

      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
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
}

/**
 * The publisher wired from the validated environment: the one place its adapters are chosen, so
 * the loop a test drives is the loop a deployment runs and neither has to be assembled twice.
 */
export function outboxPublisher(dependencies: OutboxPublisherDependencies): OutboxPublisher {
  const { em, env } = dependencies;
  const logger = dependencies.logger ?? nestLogger('outbox-publisher');
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
        new SqsEventPublisher(sqs, { timeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS }),
      clock: dependencies.clock ?? systemClock,
      logger,
      batchSize: env.OUTBOX_BATCH_SIZE,
    }),
    { pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS, logger },
  );
}
