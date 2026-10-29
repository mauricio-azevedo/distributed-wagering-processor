import { DomainError } from '../../domain/errors';
import type { PendingReferenceSchedule } from '../../domain/pending-reference-schedule';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { ApplyWagerOperation, type AppliedWagerOperation } from '../apply-wager-operation';
import { ApplicationError, ServiceUnavailableError, WalletNotFoundError } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { Logger } from '../ports/logger';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

/**
 * How one attempt ended. The labels are the outcomes `ref.*` distinguishes, which is also the
 * dimension `wager_pending_reference_total{outcome}` counts them by when the metrics arrive:
 *
 * - `settled`: the reference resolved and the operation was applied under the normal rules, which
 *   records `PROCESSED` or the `REJECTED` one of those rules decides (`ref.resolution-on-arrival`).
 * - `pending`: the reference still has not resolved and the window is open, so the attempt was
 *   counted and the next one scheduled (`ref.backoff`).
 * - `expired`: the window closed with the reference still unresolved (`ref.expiry`).
 * - `retried`: a transient failure, so nothing was recorded and the attempt was rescheduled
 *   (`ref.transient-failure`).
 * - `failed`: a permanent failure, so the transaction is `FAILED` (`ref.permanent-failure`).
 */
export type PendingReferenceOutcome = 'settled' | 'pending' | 'expired' | 'retried' | 'failed';

export interface PendingReferenceAttempt {
  readonly transactionId: string;
  readonly outcome: PendingReferenceOutcome;
}

export interface ReprocessPendingReferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
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
   * One sweep: due transactions, claimed and attempted one by one until none is due or the sweep
   * is full. It reports what each attempt ended in, which is what a driver logs and counts.
   *
   * A transient failure with nothing claimed — the database itself being unreachable — ends the
   * sweep by rejecting: there is no transaction to report an attempt for, and the caller has to
   * learn that the dependency is gone rather than read it as an empty claim list. Nothing is
   * recorded and every row stays due (`ref.transient-failure`).
   */
  async execute(): Promise<readonly PendingReferenceAttempt[]> {
    const attempts: PendingReferenceAttempt[] = [];

    for (let claimed = 0; claimed < this.sweepSize; claimed += 1) {
      const attempt = await this.attempt();

      if (attempt === null) {
        break;
      }

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
   * The correlation id is minted per attempt: a scheduled attempt has no request or message behind
   * it, so there is no id to propagate, and a fresh one ties the rows and events of this attempt
   * together in the logs (`obs.correlation-propagation`).
   */
  private async attempt(): Promise<PendingReferenceAttempt | null> {
    const attemptedAt = this.dependencies.clock.now();
    const entryId = this.dependencies.ids.next();
    const correlationId = this.dependencies.ids.next();

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
            correlationId,
          });
          const outcome = await this.reprocess(repositories, operation, schedule, attemptedAt);

          schedule.recordAttempt(attemptedAt);
          await repositories.pendingReferences.update(schedule);

          return { transactionId: schedule.transactionId, outcome };
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

      return { transactionId: schedule.transactionId, outcome: 'failed' };
    }

    await this.reschedule(schedule);

    return { transactionId: schedule.transactionId, outcome: 'retried' };
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
   * authority, and nothing may overwrite an outcome (`tx.terminal-immutable`).
   */
  private async fail(schedule: PendingReferenceSchedule, error: unknown): Promise<void> {
    this.dependencies.logger.error(
      'reprocessing a pending reference hit a permanent failure, so the transaction is FAILED',
      {
        transactionId: schedule.transactionId,
        attempts: schedule.attempts,
        reason: error instanceof Error ? error.message : String(error),
      },
    );

    await this.dependencies.unitOfWork.transactional(async ({ transactions }) => {
      const transaction = await transactions.findById(schedule.transactionId);

      if (transaction === null || transaction.isTerminal()) {
        return;
      }

      transaction.fail({ observedBalance: observedBalanceOf(transaction) });

      await transactions.recordOutcome(transaction);
    });
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
