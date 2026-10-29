import { DomainError } from '../../domain/errors';
import type { PendingReferenceSchedule } from '../../domain/pending-reference-schedule';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { ApplyWagerOperation, type AppliedWagerOperation } from '../apply-wager-operation';
import { ApplicationError, ServiceUnavailableError, WalletNotFoundError } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { Logger } from '../ports/logger';
import type { Metrics, PendingReferenceOutcome } from '../ports/metrics';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

/**
 * How one attempt ended. The vocabulary is the label dimension of
 * `wager_pending_reference_total{outcome}`, so it is defined with the metric it is counted by
 * (`obs.metrics`) and re-exported here, where the behaviour that reaches each case lives.
 */
export type { PendingReferenceOutcome };

export interface PendingReferenceAttempt {
  readonly transactionId: string;
  /**
   * `obs.correlation-propagation`: the correlation id of the arrival that parked the transaction,
   * carried by the claim row, so the attempt and its events are searchable under the operation that
   * created the work rather than under an id minted for this sweep (OBS-005).
   */
  readonly correlationId: string;
  readonly outcome: PendingReferenceOutcome;
}

export interface ReprocessPendingReferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** How many claims one sweep takes at most; `DEFAULT_SWEEP_SIZE` when absent. */
  readonly sweepSize?: number;
}

/**
 * How many transactions one sweep reprocesses before returning. It bounds the work of a single
 * sweep rather than the recovery itself: what is still due is claimed by the next sweep, or by
 * another worker meanwhile, so the number trades the latency of one parked transaction against how
 * long a worker stays inside one sweep. It is a constant and not a setting because nothing about a
 * deployment changes the answer — a backlog is drained by the next sweep either way.
 */
const DEFAULT_SWEEP_SIZE = 50;

/**
 * Reprocesses the transactions parked by `rule.reference.missing-is-pending`: the recovery half of
 * the reference rules (ADR 0011). A `REFUND`, `ROLLBACK`, `WIN` or `LOSS` whose target had not
 * arrived was answered `202` and persisted as `PENDING_REFERENCE`; this is what eventually turns it
 * into one of the outcomes the contract promises, under the rules a first arrival would have faced.
 *
 * One sweep claims due transactions one at a time, each in its own database transaction, and
 * attempts them through `ApplyWagerOperation`, the same step a submission applies
 * (`ref.resolution-on-arrival`). The claim is `SELECT ... FOR UPDATE SKIP LOCKED` on the schedule
 * row and is held while the attempt runs, so several workers never pick the same transaction and a
 * worker that dies mid-attempt releases its claim with its connection: the attempt rolls back and
 * the next sweep finds the row due, unchanged (`ref.scheduler`, REF-002).
 *
 * What an attempt that cannot resolve the reference does is the one decision this use case owns:
 *
 * - The window is open, so the transaction is recorded `PENDING_REFERENCE` again against the
 *   balance it now observes, the attempt is counted and the next one is scheduled with the backoff
 *   of `ref.backoff`. No event is emitted; the arrival that parked it already announced the wait.
 * - The window has closed, so the transaction is `REJECTED` with `REFERENCE_NOT_FOUND` and the
 *   rejection is announced (`ref.expiry`). The window is consulted only after an attempt that ran
 *   and found nothing, because the expiry is a decision about a missing reference: a reference that
 *   did arrive is applied even by an attempt that runs after the window closed, since there is
 *   nothing missing to reject it for.
 *
 * A failure is classified rather than retried blindly (`ref.transient-failure`,
 * `ref.permanent-failure`). A transient one changes nothing on the transaction: the attempt is
 * rescheduled and the window is left exactly where it was, so a dependency outage spends the
 * waiting window and never shortens it by turning into an outcome. A permanent one, which is one
 * that no later attempt can get past, marks the transaction `FAILED` with `PROCESSING_FAILED`,
 * logged at error level and emitting nothing (`tx.failed-semantics`, `event.failed-no-event`). An
 * error nobody classified counts as transient, so nothing becomes terminal by mistake.
 */
export class ReprocessPendingReference {
  private readonly operations: ApplyWagerOperation;
  private readonly sweepSize: number;

  constructor(private readonly dependencies: ReprocessPendingReferenceDependencies) {
    this.operations = new ApplyWagerOperation(dependencies.ids);
    this.sweepSize = dependencies.sweepSize ?? DEFAULT_SWEEP_SIZE;
  }

  /**
   * One sweep: due transactions, claimed and attempted one by one until none is due, the sweep is
   * full, or the driver stops claiming. Each attempt is reported as it resolves — the line an
   * operator follows it by and the counter its outcome belongs to — and answered to the caller as
   * well, so a driver reads what the sweep did without having to read the logs.
   *
   * A transient failure with nothing claimed — the database itself being unreachable — ends the
   * sweep by rejecting: there is no transaction to report an attempt for, and the caller has to
   * learn that the dependency is gone rather than read it as an empty claim list. Nothing is
   * recorded and every row stays due (`ref.transient-failure`).
   *
   * `claiming` is how a shutdown reaches a sweep (`ops.graceful-shutdown`): it is read before each
   * claim, so a scheduler that was signalled finishes the attempt it had started and takes no new
   * one. The rows it never claimed are untouched and due, and the one it was holding is released by
   * the commit or the rollback of its own transaction, so another instance picks them up at once
   * rather than after a backoff this sweep never got to record.
   */
  async execute(claiming: () => boolean = () => true): Promise<readonly PendingReferenceAttempt[]> {
    const attempts: PendingReferenceAttempt[] = [];

    for (let claimed = 0; claimed < this.sweepSize && claiming(); claimed += 1) {
      const attempt = await this.attempt();

      if (attempt === null) {
        break;
      }

      this.report(attempt);
      attempts.push(attempt);
    }

    return attempts;
  }

  /**
   * One claimed transaction, attempted in the transaction that claimed it, or `null` when nothing
   * is due. The moment and the entry id are taken before the transaction opens, so no clock is read
   * and no row id is minted while the wallet lock is held (`conc.lock-order`), and the attempt is
   * decided against one moment throughout.
   *
   * The correlation id is the claim row's and is never minted here: a scheduled attempt has no
   * request and no message behind it, but it does have an arrival that created the work, and that
   * is the id an operator follows the operation by (`obs.correlation-propagation`, OBS-005).
   */
  private async attempt(): Promise<PendingReferenceAttempt | null> {
    const attemptedAt = this.dependencies.clock.now();
    const entryId = this.dependencies.ids.next();

    try {
      return await this.dependencies.unitOfWork.transactional(async (repositories) => {
        const schedule = await repositories.pendingReferences.claimNextDue(attemptedAt);

        if (schedule === null) {
          return null;
        }

        try {
          const operation = await this.claimedOperation(repositories, schedule, {
            entryId,
            attemptedAt,
            correlationId: schedule.correlationId,
          });
          const outcome = await this.reprocess(repositories, operation, schedule, attemptedAt);

          schedule.recordAttempt(attemptedAt);
          await repositories.pendingReferences.update(schedule);

          return {
            transactionId: schedule.transactionId,
            correlationId: schedule.correlationId,
            outcome,
          };
        } catch (failure) {
          // Thrown on, so the attempt's transaction rolls back and nothing it wrote survives, and
          // carrying the claim with it, so the classification below knows what was being attempted.
          throw new FailedAttempt(schedule, failure);
        }
      });
    } catch (error) {
      if (error instanceof FailedAttempt) {
        return this.classified(error.schedule, error.failure);
      }

      throw error;
    }
  }

  /**
   * The claimed transaction and the wallet it names, locked for the rest of the transaction
   * (`conc.row-lock`): a scheduled attempt is a financial operation on that wallet and takes the
   * same lock a submission does, in the same order.
   *
   * Both absences are impossible rather than handled: the claim reads the transaction in the
   * statement that locks the schedule row, and a transaction row cannot exist without its wallet
   * (the foreign key of the reservation). A missing wallet is still answered with the refusal the
   * contract calls permanent (`msg.unknown-wallet-permanent`), so a transaction whose wallet has
   * somehow gone ends `FAILED` instead of being retried until its window closes.
   */
  private async claimedOperation(
    repositories: Repositories,
    schedule: PendingReferenceSchedule,
    attempt: {
      readonly entryId: string;
      readonly attemptedAt: Date;
      readonly correlationId: string;
    },
  ): Promise<AppliedWagerOperation> {
    const submission = await repositories.transactions.findById(schedule.transactionId);

    if (submission === null) {
      throw new Error(
        `the claim list holds transaction ${schedule.transactionId}, which no row carries`,
      );
    }

    const wallet = await repositories.wallets.lockById(submission.walletId);

    if (wallet === null) {
      throw new WalletNotFoundError(submission.walletId);
    }

    return {
      submission,
      wallet,
      entryId: attempt.entryId,
      occurredAt: attempt.attemptedAt,
      correlationId: attempt.correlationId,
    };
  }

  /** The attempt itself: the normal rules first, then what waiting any longer would mean. */
  private async reprocess(
    repositories: Repositories,
    operation: AppliedWagerOperation,
    schedule: PendingReferenceSchedule,
    attemptedAt: Date,
  ): Promise<PendingReferenceOutcome> {
    if ((await this.operations.apply(repositories, operation)) === 'recorded') {
      return 'settled';
    }

    if (schedule.hasExpired(attemptedAt)) {
      await this.operations.reject(repositories, operation, 'REFERENCE_NOT_FOUND');

      return 'expired';
    }

    await this.operations.park(repositories, operation);

    return 'pending';
  }

  /**
   * What a failed attempt means for the transaction it was attempting. The attempt's transaction
   * has already rolled back, so both answers are written in a transaction of their own, and neither
   * touches a balance, a ledger entry or the outbox.
   */
  private async classified(
    schedule: PendingReferenceSchedule,
    error: unknown,
  ): Promise<PendingReferenceAttempt> {
    if (isPermanent(error)) {
      await this.fail(schedule, error);

      return {
        transactionId: schedule.transactionId,
        correlationId: schedule.correlationId,
        outcome: 'failed',
      };
    }

    await this.reschedule(schedule);

    return {
      transactionId: schedule.transactionId,
      correlationId: schedule.correlationId,
      outcome: 'retried',
    };
  }

  /**
   * What one attempt reports: the counter its outcome belongs to and the line the operator follows
   * it by (`obs.metrics`, `obs.structured-logs`). A rescheduled attempt is also a retry of this
   * component, which is the measurement that separates a dependency outage from a reference that
   * simply has not arrived (`ref.transient-failure`).
   *
   * It runs after the attempt's transaction resolved, so nothing is reported for work that rolled
   * back, and it reports every attempt including the ones that changed nothing: an attempt that
   * found no reference is the fact an operator is looking for when a transaction stays pending.
   */
  private report(attempt: PendingReferenceAttempt): void {
    this.dependencies.metrics.increment('wager_pending_reference_total', {
      outcome: attempt.outcome,
    });

    if (attempt.outcome === 'retried') {
      this.dependencies.metrics.increment('wager_retries_total', {
        component: 'pending-reference',
      });
    }

    this.dependencies.logger.info('wager.pending-reference.attempted', {
      correlationId: attempt.correlationId,
      transactionId: attempt.transactionId,
      outcome: attempt.outcome,
    });
  }

  /**
   * `ref.transient-failure`: the attempt is counted and spaced like any other, and the transaction
   * is left exactly as it was. The window is not consulted and not extended, so an outage spends
   * the time a reference had left instead of ending the wait on the wrong reason.
   *
   * The row was unlocked by the rollback, so another worker may claim it before this write lands
   * and bump the same counter. That costs at most one backoff step of precision and nothing else:
   * the counter spaces attempts, it does not decide an outcome.
   */
  private async reschedule(schedule: PendingReferenceSchedule): Promise<void> {
    schedule.recordAttempt(this.dependencies.clock.now());

    await this.dependencies.unitOfWork.transactional(({ pendingReferences }) =>
      pendingReferences.update(schedule),
    );
  }

  /**
   * `ref.permanent-failure`: the transaction is `FAILED` with `PROCESSING_FAILED`, which is the one
   * code `fail` owns, and emits no event (`event.failed-no-event`). It is recorded against the
   * balance the last attempt observed rather than a freshly read one: re-reading would ask the
   * dependency that just proved unusable, and the balance a `FAILED` replay reports is the one the
   * operation was last decided against (`tx.observed-balance`).
   *
   * A transaction that reached a terminal outcome meanwhile is left alone: the row is the
   * authority, and nothing may overwrite an outcome (`tx.terminal-immutable`). `FAILED` is then
   * counted as the recorded outcome it is, after the commit that recorded it and only by the write
   * that did record it, so a transaction another worker had already finished is not counted twice
   * (`obs.metrics`).
   */
  private async fail(schedule: PendingReferenceSchedule, error: unknown): Promise<void> {
    this.dependencies.logger.error('wager.pending-reference.failed', {
      correlationId: schedule.correlationId,
      transactionId: schedule.transactionId,
      attempts: schedule.attempts,
      reason: error instanceof Error ? error.message : String(error),
    });

    const failed = await this.dependencies.unitOfWork.transactional(
      async ({ transactions }): Promise<WagerTransaction | null> => {
        const transaction = await transactions.findById(schedule.transactionId);

        if (transaction === null || transaction.isTerminal()) {
          return null;
        }

        transaction.fail({ observedBalance: observedBalanceOf(transaction) });

        await transactions.recordOutcome(transaction);

        return transaction;
      },
    );

    if (failed !== null) {
      this.dependencies.metrics.increment('wager_transactions_total', {
        kind: failed.kind,
        status: 'FAILED',
      });
    }
  }
}

/**
 * A failure that happened while a claimed transaction was being attempted, as opposed to one that
 * happened before anything was claimed. It is thrown so the attempt's database transaction still
 * rolls back, and it carries the claim so the classification can act on the right transaction; it
 * never leaves this use case.
 */
class FailedAttempt extends Error {
  constructor(
    readonly schedule: PendingReferenceSchedule,
    readonly failure: unknown,
  ) {
    super(`attempting the pending reference of transaction ${schedule.transactionId} failed`);
    this.name = 'FailedAttempt';
  }
}

/**
 * Whether no later attempt can get past this failure (`ref.permanent-failure`), read from the same
 * vocabulary `msg.classification` uses:
 *
 * - `ServiceUnavailableError` is the transient refusal the unit of work raises for every database
 *   failure a retry can clear, so it is the one `ApplicationError` that is not permanent.
 * - Any other `ApplicationError` is a refusal of the operation itself — an unknown wallet, a
 *   conflicting key — which the stored row will keep producing however often it is attempted.
 * - A `DomainError` means the stored state cannot be rebuilt into something the domain can reason
 *   about, which no retry repairs either.
 *
 * Everything else is transient, deliberately: an error nobody classified is not evidence that
 * retrying is hopeless, and `FAILED` is the one outcome that must never be reached by mistake
 * (`tx.failed-semantics`). The price is that a permanently broken dependency nothing classifies
 * keeps a transaction pending until its window closes, which is a rejection the provider can act on
 * rather than a terminal failure it cannot.
 */
function isPermanent(error: unknown): boolean {
  if (error instanceof ServiceUnavailableError) {
    return false;
  }

  return error instanceof ApplicationError || error instanceof DomainError;
}

function observedBalanceOf(transaction: WagerTransaction) {
  const observedBalance = transaction.observedBalance;

  if (observedBalance === null) {
    throw new Error(
      `transaction ${transaction.id} is ${transaction.status} without an observed balance, so no outcome can be recorded against it (tx.observed-balance)`,
    );
  }

  return observedBalance;
}
