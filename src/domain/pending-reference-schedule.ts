import { InvalidTransactionStateError } from './errors';
import type { WagerTransaction } from './wager-transaction';

/** A `pending_reference_schedule` row as the database holds it (ADR 0011). */
export interface PendingReferenceScheduleState {
  readonly transactionId: string;
  /**
   * `obs.correlation-propagation`: the correlation id of the arrival that parked the transaction.
   * It is stored because the work outlives what created it — an attempt runs minutes or an hour
   * later, in another process — and an operator following one operation has to reach the attempts
   * and their events under the id of the request or the message that caused them (OBS-005).
   */
  readonly correlationId: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly expiresAt: Date;
}

/** `ref.backoff`: the first delay, doubled per attempt. */
const FIRST_BACKOFF_SECONDS = 1;

/** `ref.backoff`: the cap of the exponential backoff, five minutes. */
const MAX_BACKOFF_SECONDS = 300;

/** `ref.ttl`: how long a reference is awaited, counted from the first receipt. */
const WINDOW_MINUTES = 60;

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * When a parked transaction is attempted again and when waiting for it stops (`ref.scheduler`,
 * `ref.backoff`, `ref.ttl`). It is the claim list of the scheduler: one row per transaction in
 * `PENDING_REFERENCE`, carrying how many attempts have run, when the next one is due and when the
 * window closes.
 *
 * The two timings are the whole of the decision, so they live here rather than in the use case:
 * the spacing of the attempts is a pure function of how many have run, and the window is a pure
 * function of the first receipt. The use case decides nothing about either; it asks whether the
 * window has closed and records that an attempt ran.
 *
 * The window is fixed at `open` and no attempt moves it (`ref.transient-failure`): a transient
 * failure shortens the time left to resolve the reference, it never extends it, and a reference
 * that is still missing an hour after the operation arrived almost certainly never existed.
 */
export class PendingReferenceSchedule implements PendingReferenceScheduleState {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly expiresAt: Date;

  /** Behind getters, so `recordAttempt` is the only thing that moves the schedule. */
  #attempts: number;
  #nextAttemptAt: Date;

  private constructor(state: PendingReferenceScheduleState) {
    this.transactionId = state.transactionId;
    this.correlationId = state.correlationId;
    this.expiresAt = state.expiresAt;
    this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt;
  }

  /**
   * Takes the row from the transaction it waits for: its id, and the moment it was first received,
   * which is what the window is counted from (`ref.ttl`). The first attempt is due one second
   * later, so a reversal that arrived moments before the operation it applies to resolves almost
   * at once rather than after a full backoff step.
   *
   * It takes the transaction rather than the two values so that a schedule cannot be opened for a
   * transaction that is not waiting for anything: a row in any other status would be claimed,
   * reprocessed and, after an hour, rejected for a reference nobody is waiting for. The correlation
   * id comes beside it because it is a fact of the arrival and not of the transaction: the same
   * operation reaching the service twice is one transaction and two correlation ids, and the one
   * recorded here is the arrival that created the waiting work (`obs.correlation-propagation`).
   */
  static open(transaction: WagerTransaction, correlationId: string): PendingReferenceSchedule {
    if (transaction.status !== 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(
        `transaction ${transaction.id} is ${transaction.status}, so it waits for no reference and has nothing to schedule`,
      );
    }

    const receivedAt = transaction.createdAt.getTime();

    return new PendingReferenceSchedule({
      transactionId: transaction.id,
      correlationId,
      attempts: 0,
      nextAttemptAt: new Date(receivedAt + FIRST_BACKOFF_SECONDS * MILLISECONDS_PER_SECOND),
      expiresAt: new Date(
        receivedAt + WINDOW_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
      ),
    });
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored row, trusting the database. */
  static rehydrate(state: PendingReferenceScheduleState): PendingReferenceSchedule {
    return new PendingReferenceSchedule(state);
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date {
    return this.#nextAttemptAt;
  }

  /**
   * Counts an attempt that ran and puts the row back in the queue of due work, after
   * `min(1s × 2^attempts, 5m)` counted from that attempt (`ref.backoff`). Nothing stops the
   * retries: a transaction leaves this list by reaching a terminal outcome, which the expiry of
   * its window guarantees it eventually does.
   */
  recordAttempt(attemptedAt: Date): void {
    this.#attempts += 1;
    this.#nextAttemptAt = new Date(
      attemptedAt.getTime() + this.backoffSeconds() * MILLISECONDS_PER_SECOND,
    );
  }

  /**
   * `ref.expiry`: whether waiting for the reference has stopped. The window is closed at the
   * moment it is reached, so "awaited for 60 minutes" is sixty minutes of waiting and not sixty
   * minutes plus one attempt.
   */
  hasExpired(at: Date): boolean {
    return at.getTime() >= this.expiresAt.getTime();
  }

  private backoffSeconds(): number {
    return Math.min(FIRST_BACKOFF_SECONDS * 2 ** this.#attempts, MAX_BACKOFF_SECONDS);
  }
}
