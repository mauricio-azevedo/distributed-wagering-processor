import { InvalidMessageStateError } from './errors';
import type {
  IntegrationEvent,
  IntegrationEventEnvelope,
  IntegrationEventType,
} from './integration-events';

/** An outbox row as the database holds it; `publishedAt` is `null` while the row is pending. */
export interface OutboxMessageState {
  readonly eventId: string;
  readonly eventType: IntegrationEventType;
  readonly aggregateId: string;
  readonly payload: IntegrationEventEnvelope;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt: Date | null;
}

/** `outbox.retry-backoff`: the cap of the exponential backoff, five minutes. */
const MAX_BACKOFF_SECONDS = 300;

/**
 * `outbox.retry-backoff`: the failure count at which a row stops being an ordinary retry and
 * becomes something an operator has to look at. It lives here, beside the backoff it shares a rule
 * with, because the threshold is part of the contract and not a knob of whichever publisher
 * happens to observe it.
 */
const ALERT_AFTER_ATTEMPTS = 10;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * An event waiting to be published, written in the transaction that committed the financial
 * change (`outbox.single-transaction`) and relayed afterwards by any publisher instance
 * (ADR 0005). The row carries the envelope it was enqueued with, so every publication of it is
 * byte for byte the same message (`outbox.duplicate-safe`) and nothing has to be rebuilt from
 * state that may have moved on.
 *
 * `eventId` is the primary key: it is fixed when the event is recorded and is the id consumers
 * deduplicate by (`outbox.stable-event-id`, `event.at-least-once`).
 */
export class OutboxMessage implements OutboxMessageState {
  readonly eventId: string;
  readonly eventType: IntegrationEventType;
  readonly aggregateId: string;
  readonly payload: IntegrationEventEnvelope;
  readonly occurredAt: Date;

  /** Behind getters so that `markPublished` and `scheduleRetry` are the only state changes. */
  private failedAttempts: number;
  private dueAt: Date;
  private sentAt: Date | null;

  private constructor(state: OutboxMessageState) {
    this.eventId = state.eventId;
    this.eventType = state.eventType;
    this.aggregateId = state.aggregateId;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this.failedAttempts = state.attempts;
    this.dueAt = state.nextAttemptAt;
    this.sentAt = state.publishedAt;
  }

  /**
   * Takes the row from the event itself: its id, type, aggregate and envelope. The row is due at
   * the moment the event records, so the next publisher pass claims it; no publication has been
   * attempted yet.
   */
  static enqueue(event: IntegrationEvent): OutboxMessage {
    return new OutboxMessage({
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored row, trusting the database. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this.failedAttempts;
  }

  get nextAttemptAt(): Date {
    return this.dueAt;
  }

  get publishedAt(): Date | null {
    return this.sentAt;
  }

  isPublished(): boolean {
    return this.sentAt !== null;
  }

  /**
   * Whether this row has failed often enough that retrying is no longer the whole story
   * (`outbox.retry-backoff`): ten attempts mean the broker has been refusing this event for at
   * least seventeen minutes of backoff, which is an operational condition and not a hiccup.
   *
   * It is a question and not a state: nothing changes when a row crosses the threshold, the
   * retries continue unchanged, and the row keeps answering `true` until it is published. The
   * publisher is what turns the answer into an alert.
   */
  hasStalled(): boolean {
    return this.failedAttempts >= ALERT_AFTER_ATTEMPTS;
  }

  /**
   * Records a successful publication, in the publisher's own transaction. A published row is
   * never claimed again (`outbox.publish-after-commit`), so publishing a published row is a
   * programming error.
   */
  markPublished(publishedAt: Date): void {
    this.assertPending('published');
    this.sentAt = publishedAt;
  }

  /**
   * Counts a failed publication and puts the row back in the queue of pending work, due after
   * `min(2^attempts seconds, 5 minutes)` counted from the failure (ADR 0005,
   * `outbox.retry-backoff`). Nothing discards a row: there is no state in which an unpublished
   * event stops being retried, and after ten attempts the backlog metrics raise the alert while
   * the retries continue.
   */
  scheduleRetry(failedAt: Date): void {
    this.assertPending('rescheduled');
    this.failedAttempts += 1;
    this.dueAt = new Date(failedAt.getTime() + this.backoffSeconds() * MILLISECONDS_PER_SECOND);
  }

  private backoffSeconds(): number {
    return Math.min(2 ** this.failedAttempts, MAX_BACKOFF_SECONDS);
  }

  private assertPending(transition: string): void {
    if (this.sentAt !== null) {
      throw new InvalidMessageStateError(
        `event ${this.eventId} was published at ${this.sentAt.toISOString()} and cannot be ${transition}`,
      );
    }
  }
}
