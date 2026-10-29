import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { type TransactionKind, affectsBalance } from './transaction-kind';
import {
  type LedgerOperation,
  REVERSIBLE_KINDS,
  type ReversibleKind,
  ROLLBACK_OF,
  isReversibleKind,
} from './wallet-ledger-entry';

/**
 * `tx.transitions`: the lifecycle of a transaction row. `PENDING` is what `create` yields and
 * exists only inside the database transaction that records the first outcome, so it is never
 * observable through the API; `TransactionStatus` in [docs/openapi.yaml](../../docs/openapi.yaml)
 * enumerates the other four for that reason (`model.contract-first`).
 */
export type TransactionStatus =
  'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

/**
 * The statuses a recorded outcome can carry, which are the four `TransactionStatus` of
 * [docs/openapi.yaml](../../docs/openapi.yaml): every answer about a transaction and every replay
 * is one of them, because `PENDING` is only ever the status of a row inside the transaction that is
 * about to record its first outcome.
 */
export type RecordedTransactionStatus = Exclude<TransactionStatus, 'PENDING'>;

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

/** What a kind does with `referenceExternalTransactionId`, and what it may point at. */
interface ReferenceRule {
  readonly requirement: 'forbidden' | 'optional' | 'required';
  /** `targets`: the kinds the referenced transaction may be. Empty when the kind carries none. */
  readonly targets: readonly TransactionKind[];
}

/**
 * `tx.reference-matrix` and the kind half of the reference rules, as one table: whether a kind
 * carries a reference, and which kinds the transaction it names may be
 * (`rule.win.optional-reference`, `rule.loss.optional-reference`, `rule.refund.bet-only`,
 * `rule.rollback.allowed-kinds`). They are two readings of one rule — a kind that carries no
 * reference admits no target, and a `ROLLBACK` admits exactly the kinds it can invert — so the
 * table states them together and the predicates below read it.
 */
const REFERENCE_MATRIX: Record<TransactionKind, ReferenceRule> = {
  OPENING: { requirement: 'forbidden', targets: [] },
  BET: { requirement: 'forbidden', targets: [] },
  WIN: { requirement: 'optional', targets: ['BET'] },
  LOSS: { requirement: 'optional', targets: ['BET'] },
  REFUND: { requirement: 'required', targets: ['BET'] },
  ROLLBACK: { requirement: 'required', targets: REVERSIBLE_KINDS },
};

/** `tx.reference-matrix`: a `REFUND` and a `ROLLBACK` apply to the transaction they reference. */
export function requiresReference(kind: TransactionKind): boolean {
  return REFERENCE_MATRIX[kind].requirement === 'required';
}

/** `tx.reference-matrix`: a `BET` and the internal `OPENING` credit never carry a reference. */
export function allowsReference(kind: TransactionKind): boolean {
  return REFERENCE_MATRIX[kind].requirement !== 'forbidden';
}

/**
 * The failure codes a resolved reference can be refused with: the reference rules one pair of
 * transactions decides on its own (RULE-020). `REFERENCE_NOT_FOUND` is not among them, because it
 * is the expiry of a wait and not a judgement about a reference that was found (`ref.expiry`), and
 * neither is `REFERENCE_ALREADY_REVERSED`, which is a question about rows that may not exist yet
 * (`rule.reference.reversed-once`).
 */
export type ReferenceRefusalCode = Extract<
  FailureCode,
  | 'REFERENCE_KIND_NOT_ALLOWED'
  | 'REFERENCE_MISMATCH'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_AMOUNT_MISMATCH'
>;

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

  /**
   * `idem.payload-hash`: whether a submission is the operation this row already recorded. It is
   * the whole of the replay-or-conflict decision (IDEM-012): an arrival whose canonical hash
   * matches is a repetition to answer from the stored outcome, and one that does not is a key
   * reused for different content, which is a conflict and never a replay
   * (`idem.payload-mismatch-conflict`). The comparison lives here because the hash it compares
   * against is this row's; `classifyReservationConflict` of `idempotency.ts` is the caller.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** `tx.affects-balance`: whether applying this transaction moves money and writes an entry. */
  affectsBalance(): boolean {
    return affectsBalance(this.kind);
  }

  /**
   * `rule.reference.*` as one decision: the code that refuses the transaction this submission
   * resolved its reference to, or `null` when nothing refuses it (RULE-020). It reads the two
   * transactions and nothing else — no balance, no other row, no database — so every reference
   * rule but `rule.reference.reversed-once`, which is a question about rows that may not exist yet,
   * is decided here and merely persisted by the caller.
   *
   * The order is what makes each refusal the most specific one available:
   *
   * - The kind matrix comes first, so a target no kind may reference is refused for what it is
   *   rather than for the context it happens to be in. The `OPENING` credit is the case that shows
   *   why: it carries the service's own provider and the wallet id as its round
   *   (`tx.opening-internal`), so a context check would answer `REFERENCE_MISMATCH` about a kind
   *   nothing can reverse.
   * - The currency is part of the context, so the amounts are compared only once both are known to
   *   be in one currency and `Money.equals` cannot throw (`money.same-currency`).
   * - The amount is compared for the kinds the contract binds to it, which are the reversals; a
   *   `WIN` and a `LOSS` reference a `BET` whose amount theirs is independent of
   *   (`rule.win.optional-reference`).
   *
   * A target that is not terminal yet is answered `REFERENCE_NOT_PROCESSED`, the decision about the
   * state it is in. Whether to wait for it instead of recording that is the caller's, because
   * waiting is a schedule and not a judgement (`rule.reference.missing-is-pending`).
   */
  refuseReference(reference: WagerTransaction): ReferenceRefusalCode | null {
    if (!REFERENCE_MATRIX[this.kind].targets.includes(reference.kind)) {
      return 'REFERENCE_KIND_NOT_ALLOWED';
    }

    if (!this.#sharesContextWith(reference)) {
      return 'REFERENCE_MISMATCH';
    }

    if (reference.status !== 'PROCESSED') {
      return 'REFERENCE_NOT_PROCESSED';
    }

    if (requiresReference(this.kind) && !this.money.equals(reference.money)) {
      return 'REFERENCE_AMOUNT_MISMATCH';
    }

    return null;
  }

  /**
   * `ledger.direction-by-kind`, `rule.rollback.inverse`: the balance change this transaction
   * applies, or `null` when it applies none (`rule.loss.no-effect`, `ledger.no-entry-without-
   * effect`). A `ROLLBACK` is the one kind whose direction its reference decides, so it is the one
   * kind this needs the reference for; every other kind moves in the direction of its own kind,
   * whether or not it resolved one.
   *
   * A `ROLLBACK` with no resolved reference, or one of a kind the matrix refuses, has no inverse at
   * all. Reaching here with one is a defect and not a provider's mistake: `refuseReference` has
   * already answered that reference with `REFERENCE_KIND_NOT_ALLOWED`.
   */
  movement(reference: WagerTransaction | null): LedgerOperation | null {
    switch (this.kind) {
      case 'LOSS':
        return null;
      case 'BET':
        return { kind: 'BET' };
      case 'OPENING':
      case 'WIN':
      case 'REFUND':
        return { kind: this.kind };
      case 'ROLLBACK':
        return ROLLBACK_OF[this.#reverses(reference)];
    }
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

  /** `rule.reference.same-context`: the provider, player, wallet, currency and round are shared. */
  #sharesContextWith(reference: WagerTransaction): boolean {
    return (
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId
    );
  }

  /** `rule.rollback.inverse`: the kind this `ROLLBACK` inverts, which its reference carries. */
  #reverses(reference: WagerTransaction | null): ReversibleKind {
    if (reference === null) {
      throw new InvalidWagerTransactionError(
        'a ROLLBACK takes the direction opposite to the transaction it reverses, so it has no movement until its reference is resolved',
      );
    }

    if (!isReversibleKind(reference.kind)) {
      throw new InvalidWagerTransactionError(
        `a ROLLBACK cannot invert a ${reference.kind}, which wrote no entry of its own to mirror`,
      );
    }

    return reference.kind;
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
