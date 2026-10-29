import {
  type IntegrationEvent,
  type ResolvedReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  transactionIdentity,
} from '../domain/integration-events';
import { OutboxMessage } from '../domain/outbox-message';
import {
  type RejectionCode,
  type WagerTransaction,
  requiresReference,
} from '../domain/wager-transaction';
import type { Wallet, WalletOperationOutcome } from '../domain/wallet';
import { isDebitOperation } from '../domain/wallet-ledger-entry';
import type { IdGenerator } from './ports/id-generator';
import type { Repositories } from './ports/unit-of-work';

/**
 * What the rows of one recorded outcome are written from: the transaction carrying the operation,
 * the wallet state it is decided against, the id an entry would take, the moment and the
 * correlation id of whatever is applying it.
 */
export interface AppliedWagerOperation {
  readonly submission: WagerTransaction;
  readonly wallet: Wallet;
  /** The id the entry of a balance change carries, minted before the transaction opened. */
  readonly entryId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

/**
 * What one attempt at applying an operation ended in: an outcome recorded with its events, or a
 * reference that did not resolve, which is a wait rather than an outcome
 * (`rule.reference.missing-is-pending`). Nothing is written in the second case, so the caller
 * decides what waiting means for it — a first arrival parks and schedules, a scheduled attempt
 * reschedules or lets the window close (`ref.expiry`).
 */
export type WagerOperationApplication = 'recorded' | 'unresolved-reference';

/**
 * What one provider operation does to a wallet, written where both financial entry points reach
 * it: a first arrival through `SubmitWagerTransaction` and a scheduled attempt at a parked
 * transaction through `ReprocessPendingReference`. The two differ in how the operation got here
 * and in what they do while it waits; what the operation itself does to the wallet, the ledger and
 * the outbox is this class, so neither path can record an outcome the other would not.
 *
 * Every method here runs inside the caller's open transaction, with the wallet already locked
 * (`conc.lock-order`): the decision is taken against the balance the lock read and the reference as
 * it stands under that lock (ADR 0009). Nothing published, no clock read, no id minted for a row —
 * the moment and the entry id arrive with the operation.
 *
 * A refusal a provider caused comes back as a failure code to persist (ADR 0006) and never as an
 * exception: the rejection is an outcome of the system, auditable and replayable, and the row and
 * its event are its only effects (`rule.rejected.no-effect`).
 */
export class ApplyWagerOperation {
  constructor(private readonly ids: IdGenerator) {}

  /**
   * The decision and the rows the outcome it reaches is written from. The reference is resolved
   * first, because a kind that applies to another transaction has nothing to decide until it knows
   * which (`rule.reference.*`); then the aggregate decides the movement of the kinds that move
   * money, and a `LOSS` is answered without one (`rule.loss.no-effect`).
   */
  async apply(
    repositories: Repositories,
    operation: AppliedWagerOperation,
  ): Promise<WagerOperationApplication> {
    const { submission, wallet } = operation;
    const resolution = await this.resolveReference(repositories, submission);

    if (!resolution.resolved) {
      return 'unresolved-reference';
    }

    const reference = resolution.reference;
    const refused = await this.refuseReference(repositories, submission, reference);

    if (refused !== null) {
      await this.reject(repositories, operation, refused, reference);

      return 'recorded';
    }

    const movement = submission.movement(reference);

    if (movement === null) {
      const refusal = wallet.refuseUnmoved(submission);

      if (refusal === null) {
        await this.recordWithoutMovement(repositories, operation, reference);
      } else {
        await this.reject(repositories, operation, refusal, reference);
      }

      return 'recorded';
    }

    const request = {
      transactionId: submission.id,
      entryId: operation.entryId,
      playerId: submission.playerId,
      money: submission.money,
      occurredAt: operation.occurredAt,
    };
    const outcome = isDebitOperation(movement)
      ? wallet.debit({ ...request, operation: movement })
      : wallet.credit({ ...request, operation: movement });

    if (outcome.applied) {
      await this.applyBalanceChange(repositories, operation, outcome, reference);
    } else {
      await this.reject(repositories, operation, outcome.failureCode, reference);
    }

    return 'recorded';
  }

  /**
   * `ref.parked-state`: the transaction waits for its reference, recorded with the balance it
   * observed and nothing else — no balance moved and no reference was resolved. It is written at
   * every attempt that still cannot resolve the reference, which is why `PENDING_REFERENCE` is a
   * target of itself (`tx.transitions`); the event that announces the wait is emitted once, by the
   * arrival that parked it (`event.pending-reference-when`).
   */
  async park(repositories: Repositories, operation: AppliedWagerOperation): Promise<void> {
    operation.submission.markPendingReference({ observedBalance: operation.wallet.balance });

    await repositories.transactions.recordOutcome(operation.submission);
  }

  /**
   * The refusal, as the outcome the contract persists: the row, its stable failure code and the
   * balance observed when it was taken, with `WagerTransactionRejected` as its only other effect
   * (`rule.rejected.no-effect`, `event.rejected-when`). The wallet is never written, so "balance,
   * ledger and version are unchanged" holds by construction: a refusal hands back no wallet to
   * write (ADR 0006).
   *
   * It is public because one rejection is not a refusal of the operation at all: a waiting window
   * that closed is `REFERENCE_NOT_FOUND`, which only the scheduler can decide (`ref.expiry`).
   */
  async reject(
    repositories: Repositories,
    operation: AppliedWagerOperation,
    failureCode: RejectionCode,
    reference: WagerTransaction | null = null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = operation;

    submission.reject({
      failureCode,
      observedBalance: wallet.balance,
      ...resolvedBy(reference),
    });

    await repositories.transactions.recordOutcome(submission);
    await this.enqueue(repositories, [
      WagerTransactionRejected.record({
        eventId: this.ids.next(),
        correlationId,
        occurredAt,
        identity: transactionIdentity(submission),
        failureCode,
        observedBalance: wallet.balance,
        rejectedAt: occurredAt,
        referenceExternalTransactionId: submission.referenceExternalTransactionId,
      }),
    ]);
  }

  /** The events of one outcome, enqueued in the transaction that produced it, never published. */
  async enqueue(repositories: Repositories, events: readonly IntegrationEvent[]): Promise<void> {
    for (const event of events) {
      await repositories.outbox.insert(OutboxMessage.enqueue(event));
    }
  }

  /**
   * The transaction this operation references, read under the lock the decision is taken with.
   *
   * The read is after the lock on purpose. A reference belongs to the same wallet
   * (`rule.reference.same-context`), so the wallet lock is what serializes every reversal of one
   * target: what this read and the reversed-once check below see is everything that committed
   * about that target, rather than a state another instance is still about to change
   * (`conc.lock-order`, `conc.no-unguarded-rmw`).
   */
  private async resolveReference(
    repositories: Repositories,
    submission: WagerTransaction,
  ): Promise<Resolution> {
    const externalTransactionId = submission.referenceExternalTransactionId;

    if (externalTransactionId === null) {
      return { resolved: true, reference: null };
    }

    const reference = await repositories.transactions.findByProviderTransaction({
      providerId: submission.providerId,
      externalTransactionId,
    });

    return reference?.isTerminal() === true ? { resolved: true, reference } : { resolved: false };
  }

  /**
   * The failure code a resolved reference is refused with, or `null` when none refuses it. The
   * domain decides everything one pair of transactions settles (RULE-020); this adds the single
   * rule that is about rows elsewhere in the table — a target is reversed at most once, whatever
   * the reversal kind, so a `REFUND` and a `ROLLBACK` of one `BET` cannot both credit it
   * (`rule.reference.reversed-once`).
   */
  private async refuseReference(
    repositories: Repositories,
    submission: WagerTransaction,
    reference: WagerTransaction | null,
  ): Promise<RejectionCode | null> {
    if (reference === null) {
      return null;
    }

    const refusal = submission.refuseReference(reference);

    if (refusal !== null || !requiresReference(submission.kind)) {
      return refusal;
    }

    return (await repositories.transactions.hasProcessedReversal(reference.id))
      ? 'REFERENCE_ALREADY_REVERSED'
      : null;
  }

  /**
   * `rule.loss.no-effect`: a `LOSS` is `PROCESSED` against the balance it observed, and that is
   * the whole of it — the wallet is never written, so its balance and its version stand
   * (`wallet.version-increments-on-balance-change`), and no entry exists to write
   * (`ledger.no-entry-without-effect`). `WagerTransactionProcessed` is its one event, because there
   * was no balance change for `WalletBalanceChanged` to report (`event.balance-changed-when`).
   */
  private async recordWithoutMovement(
    repositories: Repositories,
    operation: AppliedWagerOperation,
    reference: WagerTransaction | null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = operation;

    submission.markProcessed({
      observedBalance: wallet.balance,
      processedAt: occurredAt,
      ...resolvedBy(reference),
    });

    await repositories.transactions.recordOutcome(submission);
    await this.enqueue(repositories, [
      WagerTransactionProcessed.record({
        eventId: this.ids.next(),
        correlationId,
        occurredAt,
        identity: transactionIdentity(submission),
        balanceAfter: wallet.balance,
        walletVersion: wallet.version,
        processedAt: occurredAt,
        reference: reportedReference(reference),
      }),
    ]);
  }

  /**
   * The applied operation: the outcome on the transaction row, the balance it produced under the
   * version the lock read (`conc.version-guard`), the single entry that mirrors it
   * (`wallet.ledger-mirror`) and the two events every processed balance change emits
   * (`event.processed-when`, `event.balance-changed-when`).
   *
   * The observed balance is the entry's `balanceAfter`, which is what every replay of this outcome
   * reports however far the balance moves afterwards (`tx.observed-balance`).
   */
  private async applyBalanceChange(
    repositories: Repositories,
    operation: AppliedWagerOperation,
    outcome: Extract<WalletOperationOutcome, { applied: true }>,
    reference: WagerTransaction | null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = operation;

    submission.markProcessed({
      observedBalance: outcome.entry.balanceAfter,
      processedAt: occurredAt,
      ...resolvedBy(reference),
    });

    await repositories.transactions.recordOutcome(submission);
    await repositories.wallets.update(outcome.wallet, wallet.version);
    await repositories.ledger.insert(outcome.entry);
    await this.enqueue(repositories, [
      WagerTransactionProcessed.record({
        eventId: this.ids.next(),
        correlationId,
        occurredAt,
        identity: transactionIdentity(submission),
        balanceAfter: outcome.wallet.balance,
        walletVersion: outcome.wallet.version,
        processedAt: occurredAt,
        reference: reportedReference(reference),
      }),
      WalletBalanceChanged.record({
        eventId: this.ids.next(),
        correlationId,
        occurredAt,
        entry: outcome.entry,
      }),
    ]);
  }
}

/**
 * What the operation's reference resolved to under the lock: the transaction it names, `null` when
 * it carries none, or nothing yet, which is a wait rather than an outcome
 * (`rule.reference.missing-is-pending`).
 */
type Resolution =
  | { readonly resolved: true; readonly reference: WagerTransaction | null }
  | { readonly resolved: false };

/**
 * The service id of the reference an outcome resolved, as the member the transitions take only when
 * one exists: a transaction that resolved nothing records nothing about a reference, and one that
 * resolved one records it whether the outcome applied or refused it, so the row says which
 * transaction the decision was taken against (`tx.row-append-only`).
 */
function resolvedBy(reference: WagerTransaction | null): { referenceTransactionId?: string } {
  return reference === null ? {} : { referenceTransactionId: reference.id };
}

/** `event.processed-when`: the reference a processed outcome resolved, as its event reports it. */
function reportedReference(reference: WagerTransaction | null): ResolvedReference | null {
  return reference === null
    ? null
    : { transactionId: reference.id, externalTransactionId: reference.externalTransactionId };
}
