import type { OutboxMessage } from '../../domain/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher } from '../ports/event-publisher';
import type { Logger } from '../ports/logger';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

/**
 * ADR 0005's "at most 50 pending rows". It bounds how long one cycle holds its database connection
 * while it talks to the broker, together with the publish timeout the adapter applies, and it is
 * the fallback for a publisher built without the environment; the service passes
 * `OUTBOX_BATCH_SIZE`.
 */
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;

/** What one cycle did: how many rows it held, how many reached the broker, how many did not. */
export interface PublicationBatch {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export interface PublishOutboxDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly batchSize?: number;
}

/**
 * One cycle of the outbox publisher (ADR 0005): claim a batch of due rows exclusively, send each
 * one to the broker, record what happened to it, commit.
 *
 * It is the whole publication protocol, and the protocol has no state beyond the rows. The claim
 * is a lock held for the length of the transaction, so concurrent publishers receive disjoint
 * batches by construction (`outbox.concurrent-publishers`) and a publisher that dies hands its
 * rows back the moment its connection closes, with nothing to clean up and nobody to call
 * (`outbox.crash-recovery`).
 *
 * The duplicate window is deliberate and bounded: the sends happen before the commit that records
 * them, so a crash in between republishes the row. Every publication of a row carries the
 * envelope it was enqueued with and therefore the same `eventId`, which is what makes a duplicate
 * a consumer's deduplication rather than a correctness problem (`outbox.duplicate-safe`,
 * `event.at-least-once`). The reverse order — commit first, then send — would turn the same crash
 * into a lost event, and nothing could recover it.
 *
 * Nothing here deletes or abandons a row. A failed publication is counted and rescheduled with the
 * capped backoff the domain owns, so the backlog drains by itself once the broker returns
 * (`outbox.retry-backoff`), and a row that has failed ten times is reported for an operator while
 * it keeps being retried.
 *
 * One cycle's cost is bounded by the batch size and the adapter's publish timeout, which is the
 * price ADR 0005 accepts for a protocol with no lease to tune.
 */
export class PublishOutbox {
  private readonly batchSize: number;

  constructor(private readonly dependencies: PublishOutboxDependencies) {
    this.batchSize = dependencies.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
  }

  async execute(): Promise<PublicationBatch> {
    return this.dependencies.unitOfWork.transactional(async (repositories) => {
      const claimed = await repositories.outbox.claimPending({
        dueAt: this.dependencies.clock.now(),
        limit: this.batchSize,
      });

      let published = 0;
      for (const message of claimed) {
        published += (await this.relay(repositories, message)) ? 1 : 0;
      }

      return { claimed: claimed.length, published, failed: claimed.length - published };
    });
  }

  /**
   * One row: sent, then marked. A refusal is not an exception the cycle propagates — the other
   * rows of the batch have nothing to do with this broker call, and aborting would roll back the
   * publications already recorded and republish them all.
   */
  private async relay(repositories: Repositories, message: OutboxMessage): Promise<boolean> {
    try {
      await this.dependencies.publisher.publish(message);
    } catch (error) {
      message.scheduleRetry(this.dependencies.clock.now());
      await repositories.outbox.recordAttempt(message);
      this.reportIfStalled(message, error);

      return false;
    }

    message.markPublished(this.dependencies.clock.now());
    await repositories.outbox.recordAttempt(message);

    return true;
  }

  /**
   * The alert of `outbox.retry-backoff`: a row the broker has been refusing for ten attempts is an
   * operational condition, and the only one the publisher reports, because every attempt before it
   * is a transient failure the backoff already handles. The record names the row and the reason and
   * carries no amount, as `obs.no-sensitive-data` requires of every line.
   */
  private reportIfStalled(message: OutboxMessage, error: unknown): void {
    if (!message.hasStalled()) {
      return;
    }

    this.dependencies.logger.error('outbox.publication-stalled', {
      eventId: message.eventId,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt.toISOString(),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
