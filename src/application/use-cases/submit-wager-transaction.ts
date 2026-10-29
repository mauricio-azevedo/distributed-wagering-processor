import type { CanonicalValue } from '../../domain/canonical-json';
import {
  type Sha256Hex,
  type SubmittedOperation,
  classifyReservationConflict,
  contentHashOf,
  payloadHashOf,
} from '../../domain/idempotency';
import { InboxMessage } from '../../domain/inbox-message';
import {
  type IntegrationEvent,
  type ResolvedReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  transactionIdentity,
} from '../../domain/integration-events';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import type { WagerOperationKind } from '../../domain/transaction-kind';
import {
  type RejectionCode,
  WagerTransaction,
  requiresReference,
} from '../../domain/wager-transaction';
import type { Wallet, WalletOperationOutcome } from '../../domain/wallet';
import { isDebitOperation } from '../../domain/wallet-ledger-entry';
import { InboxPayloadConflictError, WalletNotFoundError, idempotencyConflict } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

/**
 * One provider operation as the entry points hand it over: the business fields of
 * `WagerOperationFields` in [docs/openapi.yaml](../../../docs/openapi.yaml), already validated
 * against the contract, with the kinds a provider may submit (`tx.kinds`, `tx.opening-internal`).
 *
 * The fields are the ones the payload hash is taken over and nothing else: the key, the correlation
 * id and every transport header stay out of the operation, which is what makes two arrivals of one
 * operation hash equal whichever entry point they came through (`idem.payload-hash`).
 */
export type SubmittedWagerOperation = SubmittedOperation & { readonly kind: WagerOperationKind };

/** `idem.key-required`: the operation, the key that identifies it and the request's correlation id. */
export interface SubmitWagerTransactionCommand {
  readonly operation: SubmittedWagerOperation;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/**
 * What one queue message is as a delivery, which is the only thing the queue entry point adds to a
 * submission (`msg.inbox-identity`): the consumer that received it, the producer-assigned message
 * id, and the content the delivery hash is taken over — the `data` of the message
 * (`msg.inbox-payload-conflict`, ADR 0010).
 *
 * The broker's receipt id is deliberately absent: it changes on every delivery and on every
 * producer resend, so it is diagnostic and can never be an identity.
 */
export interface MessageDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly content: CanonicalValue;
}

/**
 * What the submission answers with: the transaction row carrying the outcome, and whether that
 * outcome was recorded now or read back from a previous arrival (`idem.replay-same-outcome`). The
 * status, the failure code and the observed balance all come off the row, so the adapters answer
 * from the same facts the read endpoints serve and no response is rebuilt from a second copy of
 * state (ADR 0004).
 */
export interface SubmissionOutcome {
  readonly transaction: WagerTransaction;
  readonly idempotentReplay: boolean;
}

/**
 * What one delivery of a message amounted to: the outcome it recorded or replayed, or nothing at
 * all because the inbox already held that delivery (`msg.redelivery-safe`). The second case exists
 * on the queue alone, which is why it is the result of `deliver` and not of `execute`: an HTTP
 * request has no delivery identity and therefore nothing that could already be absorbed.
 */
export type DeliveryOutcome =
  { readonly absorbed: true } | ({ readonly absorbed: false } & SubmissionOutcome);

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sha256Hex: Sha256Hex;
}

/** What one submission is prepared as before its transaction opens (`prepare`). */
interface PreparedSubmission {
  readonly submission: WagerTransaction;
  readonly entryId: string;
  readonly receivedAt: Date;
  readonly correlationId: string;
}

/** What the rows of one recorded outcome are written from: the submission, the state it was decided against, the moment and the correlation id. */
interface Application {
  readonly submission: WagerTransaction;
  readonly wallet: Wallet;
  /** The id the entry of a balance change carries, minted before the transaction opened. */
  readonly entryId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

/**
 * What the submission's reference resolved to under the lock: the transaction it names, `null` when
 * it carries none, or nothing yet, which is a wait rather than an outcome
 * (`rule.reference.missing-is-pending`).
 */
type Resolution =
  | { readonly resolved: true; readonly reference: WagerTransaction | null }
  | { readonly resolved: false };

/**
 * Applies one provider operation to a wallet, or replays the outcome a previous arrival of it
 * recorded. It is the financial core of the service and the one path both entry points take
 * (`msg.same-use-case`), so every rule below holds over HTTP and on the queue alike.
 *
 * Everything one submission writes commits together or not at all (`outbox.single-transaction`):
 * the transaction row with its outcome, the wallet balance, the ledger entry that mirrors it and
 * the outbox rows that announce it. Nothing is published from here — the publisher reads committed
 * rows (`outbox.publish-after-commit`).
 *
 * The queue adds one thing and only one: a delivery identity. `deliver` claims the inbox row of
 * the message in the same transaction and completes it with the same commit (ADR 0010), and runs
 * the same financial body `execute` runs, so no rule can come to exist in one entry point alone.
 *
 * The order inside the transaction is the fixed one of ADR 0002 (`conc.lock-order`), with the
 * inbox claim of a delivered submission before all of it:
 *
 * 1. Reservation. The transaction row is inserted before any operation work, so the two unique keys
 *    of the submission are claimed by the database rather than by a look-then-write two arrivals
 *    would both pass. A duplicate waits on the unique index, reads the committed row and replays
 *    without ever reaching the wallet (`idem.persistent`, `conc.duplicate-storm`). It is also the
 *    recovery from an unknown commit outcome, because the key commits exactly when the financial
 *    effect does (`api.indeterminate-commit`).
 * 2. Wallet lock. `SELECT ... FOR NO KEY UPDATE` serializes the operations of one wallet and makes
 *    the balance the decision is taken against the true one (`conc.row-lock`).
 * 3. The decision, by the aggregate, under the lock. A refusal a provider caused comes back as a
 *    failure code to persist (ADR 0006) and never as an exception: the rejection is an outcome of
 *    the system, auditable and replayable, and the row and its event are its only effects
 *    (`rule.rejected.no-effect`).
 * 4. The writes: the outcome on the reserved row, the new balance under the version guard, the
 *    entry, then the events, and last the completion of the inbox row when the submission was
 *    delivered.
 *
 * No network call happens while the lock is held, and nothing in the path reads a clock or mints an
 * id after the transaction opened its first statement, so the window the lock covers is the
 * database work alone.
 */
export class SubmitWagerTransaction {
  constructor(private readonly dependencies: SubmitWagerTransactionDependencies) {}

  /** The HTTP entry point: one submission, in one transaction of its own. */
  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionOutcome> {
    const prepared = this.prepare(command);

    return this.dependencies.unitOfWork.transactional((repositories) =>
      this.apply(repositories, prepared),
    );
  }

  /**
   * The queue entry point: the same submission, plus the inbox row that makes a redelivery of it
   * harmless (`msg.inbox-identity`, ADR 0010).
   *
   * The claim is the first statement of the transaction, before the reservation
   * (`conc.lock-order`): the delivery is decided before any operation work, so a reused message id
   * is reported as what it is instead of surfacing as the idempotency conflict its changed content
   * would also cause. A claim and not a lookup, because two deliveries of one message id can be in
   * flight at once and both would pass a look-then-write; the second waits on the primary key and
   * then reads what the first committed.
   *
   * Absorbing writes nothing: the lost claim wrote no row, so the transaction has nothing to
   * commit and the consumer deletes the message (`msg.redelivery-safe`). A conflicting claim
   * throws, and the rollback is what leaves the first delivery's effects untouched
   * (`msg.inbox-payload-conflict`).
   */
  async deliver(
    command: SubmitWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<DeliveryOutcome> {
    const prepared = this.prepare(command);
    const received = InboxMessage.receive({
      consumerName: delivery.consumerName,
      messageId: delivery.messageId,
      payloadHash: contentHashOf(delivery.content, this.dependencies.sha256Hex),
      receivedAt: prepared.receivedAt,
    });

    return this.dependencies.unitOfWork.transactional(async (repositories) => {
      const claim = await repositories.inbox.claim(received);

      if (!claim.claimed) {
        if (!claim.stored.matchesPayload(received.payloadHash)) {
          throw new InboxPayloadConflictError(delivery.consumerName, delivery.messageId);
        }

        return { absorbed: true };
      }

      const outcome = await this.apply(repositories, prepared);

      received.markProcessed(prepared.receivedAt);
      await repositories.inbox.complete(received);

      return { absorbed: false, ...outcome };
    });
  }

  /**
   * Everything one submission needs before its transaction opens: the moment it was received, the
   * row that will carry its outcome and the id of the entry it may write. Neither clock nor id
   * mint is read again once the first statement has been issued, so the window the wallet lock
   * covers is the database work alone.
   */
  private prepare(command: SubmitWagerTransactionCommand): PreparedSubmission {
    const receivedAt = this.dependencies.clock.now();

    return {
      submission: this.record(command, receivedAt),
      entryId: this.dependencies.ids.next(),
      receivedAt,
      correlationId: command.correlationId,
    };
  }

  /** The financial body both entry points run, inside the transaction one of them opened. */
  private async apply(
    repositories: Repositories,
    prepared: PreparedSubmission,
  ): Promise<SubmissionOutcome> {
    const { submission, entryId, receivedAt, correlationId } = prepared;
    const reservation = await repositories.transactions.reserve(submission);

    if (!reservation.reserved) {
      const decision = classifyReservationConflict(reservation.keyHolder, submission.payloadHash);

      if (!decision.replay) {
        throw idempotencyConflict(decision.code, submission);
      }

      return { transaction: decision.stored, idempotentReplay: true };
    }

    const wallet = await repositories.wallets.lockById(submission.walletId);

    if (wallet === null) {
      throw new WalletNotFoundError(submission.walletId);
    }

    await this.decide(repositories, {
      submission,
      wallet,
      entryId,
      occurredAt: receivedAt,
      correlationId,
    });

    return { transaction: submission, idempotentReplay: false };
  }

  /**
   * The decision, taken under the lock, and the rows the outcome it reaches is written from. Every
   * path ends in exactly one recorded outcome: the reference is resolved first, because a kind that
   * applies to another transaction has nothing to decide until it knows which
   * (`rule.reference.*`); then the aggregate decides the movement of the kinds that move money, and
   * a `LOSS` is answered without one (`rule.loss.no-effect`).
   */
  private async decide(repositories: Repositories, application: Application): Promise<void> {
    const { submission, wallet } = application;
    const resolution = await this.resolveReference(repositories, submission);

    if (!resolution.resolved) {
      return this.park(repositories, application);
    }

    const reference = resolution.reference;
    const refused = await this.refuseReference(repositories, submission, reference);

    if (refused !== null) {
      return this.recordRejection(repositories, application, refused, reference);
    }

    const movement = submission.movement(reference);

    if (movement === null) {
      const refusal = wallet.refuseUnmoved(submission);

      return refusal === null
        ? this.recordWithoutMovement(repositories, application, reference)
        : this.recordRejection(repositories, application, refusal, reference);
    }

    const request = {
      transactionId: submission.id,
      entryId: application.entryId,
      playerId: submission.playerId,
      money: submission.money,
      occurredAt: application.occurredAt,
    };
    const outcome = isDebitOperation(movement)
      ? wallet.debit({ ...request, operation: movement })
      : wallet.credit({ ...request, operation: movement });

    return outcome.applied
      ? this.applyBalanceChange(repositories, application, outcome, reference)
      : this.recordRejection(repositories, application, outcome.failureCode, reference);
  }

  /**
   * The transaction this submission references, read under the lock the decision is taken with.
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
   * `rule.reference.missing-is-pending`: the referenced transaction has not arrived, or has not
   * reached an outcome yet, so the submission is parked with the balance it observed and answered
   * `202` (`ref.parked-state`, `api.location-on-pending`). Nothing else is written: no balance
   * moved and no reference was resolved.
   *
   * Reprocessing a parked transaction is the scheduler's, which this slice does not build (#15):
   * the schedule row, the backoff, the sixty-minute window, the expiry as `REFERENCE_NOT_FOUND` and
   * `WagerTransactionPendingReference` all arrive with it, so a transaction parked here waits for an
   * attempt that nothing triggers yet.
   */
  private async park(repositories: Repositories, application: Application): Promise<void> {
    const { submission, wallet } = application;

    submission.markPendingReference({ observedBalance: wallet.balance });

    await repositories.transactions.recordOutcome(submission);
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
    application: Application,
    reference: WagerTransaction | null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = application;

    submission.markProcessed({
      observedBalance: wallet.balance,
      processedAt: occurredAt,
      ...resolvedBy(reference),
    });

    await repositories.transactions.recordOutcome(submission);
    await this.enqueue(repositories, [
      WagerTransactionProcessed.record({
        eventId: this.dependencies.ids.next(),
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
   * The submission as the row that will carry its outcome, born `PENDING` (`tx.born-pending`). The
   * amount reaches the hash through the domain parser, so the hash is taken over the value and not
   * over whichever spelling a validator admitted (`idem.payload-hash`).
   */
  private record(command: SubmitWagerTransactionCommand, receivedAt: Date): WagerTransaction {
    const operation = command.operation;

    return WagerTransaction.create({
      id: this.dependencies.ids.next(),
      providerId: operation.providerId,
      externalTransactionId: operation.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: payloadHashOf(operation, this.dependencies.sha256Hex),
      walletId: operation.walletId,
      playerId: operation.playerId,
      roundId: operation.roundId,
      gameId: operation.gameId,
      kind: operation.kind,
      money: Money.from(operation.money.amount, operation.money.currency),
      referenceExternalTransactionId: operation.referenceExternalTransactionId ?? null,
      createdAt: receivedAt,
    });
  }

  /**
   * The applied operation: the outcome on the reserved row, the balance it produced under the
   * version the lock read (`conc.version-guard`), the single entry that mirrors it
   * (`wallet.ledger-mirror`) and the two events every processed balance change emits
   * (`event.processed-when`, `event.balance-changed-when`).
   *
   * The observed balance is the entry's `balanceAfter`, which is what every replay of this outcome
   * reports however far the balance moves afterwards (`tx.observed-balance`).
   */
  private async applyBalanceChange(
    repositories: Repositories,
    application: Application,
    outcome: Extract<WalletOperationOutcome, { applied: true }>,
    reference: WagerTransaction | null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = application;

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
        eventId: this.dependencies.ids.next(),
        correlationId,
        occurredAt,
        identity: transactionIdentity(submission),
        balanceAfter: outcome.wallet.balance,
        walletVersion: outcome.wallet.version,
        processedAt: occurredAt,
        reference: reportedReference(reference),
      }),
      WalletBalanceChanged.record({
        eventId: this.dependencies.ids.next(),
        correlationId,
        occurredAt,
        entry: outcome.entry,
      }),
    ]);
  }

  /**
   * The refusal the wallet decided, as the outcome the contract persists: the row, its stable
   * failure code and the balance observed when it was taken, with `WagerTransactionRejected` as its
   * only other effect (`rule.rejected.no-effect`, `event.rejected-when`). The wallet is never
   * written, so "balance, ledger and version are unchanged" holds by construction: a refusal hands
   * back no wallet to write (ADR 0006).
   */
  private async recordRejection(
    repositories: Repositories,
    application: Application,
    failureCode: RejectionCode,
    reference: WagerTransaction | null,
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = application;

    submission.reject({
      failureCode,
      observedBalance: wallet.balance,
      ...resolvedBy(reference),
    });

    await repositories.transactions.recordOutcome(submission);
    await this.enqueue(repositories, [
      WagerTransactionRejected.record({
        eventId: this.dependencies.ids.next(),
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
  private async enqueue(
    repositories: Repositories,
    events: readonly IntegrationEvent[],
  ): Promise<void> {
    for (const event of events) {
      await repositories.outbox.insert(OutboxMessage.enqueue(event));
    }
  }
}

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
