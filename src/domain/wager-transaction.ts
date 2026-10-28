import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { type TransactionKind, affectsBalance } from './transaction-kind';

/**
 * `tx.transitions`: the lifecycle of a transaction row. `PENDING` is what `create` yields and
 * exists only inside the database transaction that records the first outcome, so it is never
 * observable through the API; `TransactionStatus` in [docs/openapi.yaml](../../docs/openapi.yaml)
 * enumerates the other four for that reason (`model.contract-first`).
 */
export type TransactionStatus =
  'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

/**
 * The failure codes a rejection can carry. `PROCESSING_FAILED` is the outcome of `fail` alone, and
 * a `FAILED` transaction carries nothing else (`tx.failed-semantics`), so the code each transition
 * owns is settled by the type rather than by review (`failure.stable-codes`).
 */
export type RejectionCode = Exclude<FailureCode, 'PROCESSING_FAILED'>;

/** A transaction row as the database holds it (`tx.read-shape`). */
export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: Money;
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly observedBalance: Money | null;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * What a provider submitted, which is all a transaction is born with: the outcome fields are
 * recorded by a transition and never supplied (`tx.born-pending`).
 */
export type NewWagerTransaction = Omit<
  WagerTransactionState,
  'status' | 'failureCode' | 'observedBalance' | 'referenceTransactionId' | 'processedAt'
>;

/** `tx.observed-balance`: every recorded outcome carries the balance observed when it was taken. */
export interface ObservedOutcome {
  readonly observedBalance: Money;
}

/** A `referenceTransactionId` is present exactly when the outcome resolved a reference. */
export interface ProcessedOutcome extends ObservedOutcome {
  readonly processedAt: Date;
  readonly referenceTransactionId?: string;
}

export interface Rejection extends ObservedOutcome {
  readonly failureCode: RejectionCode;
  readonly referenceTransactionId?: string;
}

/** The five columns a transition writes (`tx.row-append-only`), as one value to apply at once. */
interface RecordedOutcome {
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly observedBalance: Money;
  readonly referenceTransactionId: string | null;
  readonly processedAt: Date | null;
}

/**
 * `tx.transitions`: the only status changes that exist. `PENDING` is a source and never a target,
 * because a recorded outcome is never re-opened; that downgrade is also what the trigger of
 * ADR 0003 refuses in the database. A status with no exit is terminal (`tx.terminal-immutable`),
 * so this table is the single definition of both rules.
 */
const TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  PENDING: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

/** `tx.reference-matrix`: what each kind does with `referenceExternalTransactionId`. */
const REFERENCE_REQUIREMENT: Record<TransactionKind, 'forbidden' | 'optional' | 'required'> = {
  OPENING: 'forbidden',
  BET: 'forbidden',
  WIN: 'optional',
  LOSS: 'optional',
  REFUND: 'required',
  ROLLBACK: 'required',
};

/** `tx.reference-matrix`: a `REFUND` and a `ROLLBACK` apply to the transaction they reference. */
export function requiresReference(kind: TransactionKind): boolean {
  return REFERENCE_REQUIREMENT[kind] === 'required';
}

/** `tx.reference-matrix`: a `BET` and the internal `OPENING` credit never carry a reference. */
export function allowsReference(kind: TransactionKind): boolean {
  return REFERENCE_REQUIREMENT[kind] !== 'forbidden';
}

/**
 * The audit log of what a provider submitted and the carrier of the outcome every replay returns
 * (`idem.replay-follows-persisted-outcome`). Its state machine decides what can still be written:
 * while the transaction is not terminal, a transition writes the five columns of
 * `tx.row-append-only`; once it is, nothing writes anything again (`tx.terminal-immutable`).
 *
 * Transitions change this instance instead of returning a new one, unlike `Wallet` (ADR 0007): the
 * transaction is one row with one outcome, not a balance that has to be produced together with a
 * ledger entry, and the row is written as the `UPDATE` of a managed entity. Immutability is
 * structural where the contract freezes state: identity, context, kind and amount are `readonly`,
 * and the five fields a transition writes have no writable property at all, so an outcome is
 * reachable only through `markProcessed`, `markPendingReference`, `reject` and `fail`
 * (`model.explicit-transitions`).
 *
 * A transition on a terminal transaction throws `InvalidTransactionStateError`: a provider
 * resending a closed operation is a replay served from the stored outcome, so only a defect
 * reaches that call, and the trigger of ADR 0003 refuses the same write whatever issued it.
 */
export class WagerTransaction implements WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;

  #status: TransactionStatus;
  #failureCode: FailureCode | null;
  #observedBalance: Money | null;
  #referenceTransactionId: string | null;
  #processedAt: Date | null;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this.#status = state.status;
    this.#failureCode = state.failureCode;
    this.#observedBalance = state.observedBalance;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#processedAt = state.processedAt;
  }

  /**
   * Records a submission as `PENDING`, with the reference requirement of its kind validated
   * (`tx.born-pending`, `tx.reference-matrix`). No outcome is recorded yet: the status is the only
   * thing a new transaction knows about itself.
   */
  static create(submission: NewWagerTransaction): WagerTransaction {
    const reference = submission.referenceExternalTransactionId;

    if (reference === null && requiresReference(submission.kind)) {
      throw new InvalidWagerTransactionError(
        `a ${submission.kind} applies to the transaction it reverses, so it must carry referenceExternalTransactionId`,
      );
    }

    if (reference !== null && !allowsReference(submission.kind)) {
      throw new InvalidWagerTransactionError(
        `a ${submission.kind} carries no reference, got referenceExternalTransactionId ${JSON.stringify(reference)}`,
      );
    }

    return new WagerTransaction({
      ...submission,
      status: 'PENDING',
      failureCode: null,
      observedBalance: null,
      referenceTransactionId: null,
      processedAt: null,
    });
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored row, trusting the database. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): TransactionStatus {
    return this.#status;
  }

  get failureCode(): FailureCode | null {
    return this.#failureCode;
  }

  get observedBalance(): Money | null {
    return this.#observedBalance;
  }

  get referenceTransactionId(): string | null {
    return this.#referenceTransactionId;
  }

  get processedAt(): Date | null {
    return this.#processedAt;
  }

  /**
   * `tx.terminal-immutable`: a status the transition table gives no exit. Terminality is read from
   * that one table, so the statuses the contract calls terminal and the transitions that exist
   * cannot drift apart.
   */
  isTerminal(): boolean {
    return TRANSITIONS[this.#status].length === 0;
  }

  /** `tx.affects-balance`: whether applying this transaction moves money and writes an entry. */
  affectsBalance(): boolean {
    return affectsBalance(this.kind);
  }

  /**
   * The operation was applied: the balance observed with it is the `balanceAfter` of its ledger
   * entry when it moved money (`tx.observed-balance`), and `processedAt` exists for this status
   * alone. `referenceTransactionId` is the service id of the reference this outcome resolved.
   */
  markProcessed(outcome: ProcessedOutcome): void {
    this.#record({
      status: 'PROCESSED',
      failureCode: null,
      observedBalance: outcome.observedBalance,
      referenceTransactionId: outcome.referenceTransactionId ?? null,
      processedAt: outcome.processedAt,
    });
  }

  /**
   * The reference could not be resolved to a terminal transaction, so the transaction is parked
   * and reprocessed by the scheduler (`ref.parked-state`). Recorded again at every attempt that
   * still cannot resolve it, which is why `PENDING_REFERENCE` is a target of itself.
   */
  markPendingReference(attempt: ObservedOutcome): void {
    this.#record({
      status: 'PENDING_REFERENCE',
      failureCode: null,
      observedBalance: attempt.observedBalance,
      referenceTransactionId: null,
      processedAt: null,
    });
  }

  /**
   * A refusal a provider caused: persisted and auditable with its stable failure code, changing no
   * balance, no ledger entry and no version (`rule.rejected.no-effect`).
   */
  reject(rejection: Rejection): void {
    this.#record({
      status: 'REJECTED',
      failureCode: rejection.failureCode,
      observedBalance: rejection.observedBalance,
      referenceTransactionId: rejection.referenceTransactionId ?? null,
      processedAt: null,
    });
  }

  /**
   * A permanent infrastructure error hit a persisted transaction, one retrying cannot fix
   * (`tx.failed-semantics`, `ref.permanent-failure`). It carries `PROCESSING_FAILED` and no other
   * code, so the transition takes none.
   */
  fail(failure: ObservedOutcome): void {
    this.#record({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      observedBalance: failure.observedBalance,
      referenceTransactionId: null,
      processedAt: null,
    });
  }

  /**
   * The one writer of the five mutable columns. Every precondition is checked before anything is
   * written, so a refused transition leaves the outcome exactly as it stood
   * (`tx.terminal-immutable`), and a transition never clears a reference it already resolved.
   */
  #record(outcome: RecordedOutcome): void {
    this.#assertCanBecome(outcome.status);

    if (outcome.status === 'PENDING_REFERENCE') {
      this.#assertCarriesReference('wait for');
    }

    if (outcome.referenceTransactionId !== null) {
      this.#assertCarriesReference('resolve');
    }

    this.#status = outcome.status;
    this.#failureCode = outcome.failureCode;
    this.#observedBalance = outcome.observedBalance;
    this.#referenceTransactionId = outcome.referenceTransactionId ?? this.#referenceTransactionId;
    this.#processedAt = outcome.processedAt;
  }

  /** `tx.transitions`, with the terminal case named for what it is (`tx.terminal-immutable`). */
  #assertCanBecome(status: TransactionStatus): void {
    if (TRANSITIONS[this.#status].includes(status)) {
      return;
    }

    throw new InvalidTransactionStateError(
      this.isTerminal()
        ? `a ${this.#status} transaction is terminal and keeps the outcome it recorded, so it cannot become ${status}`
        : `a ${this.#status} transaction cannot become ${status}`,
    );
  }

  /**
   * `tx.reference-matrix` on the outcome side: a transaction can only wait for, or resolve, a
   * reference its submission carried. The schema checks the submitted reference against the kind
   * (SCHEMA-006) but cannot tell that a resolved service id belongs to a transaction that asked
   * for none, and a parked transaction with nothing to wait for would sit until its window closed
   * and then be rejected with `REFERENCE_NOT_FOUND` (`ref.expiry`).
   */
  #assertCarriesReference(action: string): void {
    if (this.referenceExternalTransactionId === null) {
      throw new InvalidWagerTransactionError(
        `a ${this.kind} submitted without referenceExternalTransactionId has no reference to ${action}`,
      );
    }
  }
}
