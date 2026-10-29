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
  WagerTransactionPendingReference,
  transactionIdentity,
} from '../../domain/integration-events';
import { Money } from '../../domain/money';
import { PendingReferenceSchedule } from '../../domain/pending-reference-schedule';
import type { WagerOperationKind } from '../../domain/transaction-kind';
import { WagerTransaction } from '../../domain/wager-transaction';
import { ApplyWagerOperation, type AppliedWagerOperation } from '../apply-wager-operation';
import { InboxPayloadConflictError, WalletNotFoundError, idempotencyConflict } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
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
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/** What one submission is prepared as before its transaction opens (`prepare`). */
interface PreparedSubmission {
  readonly submission: WagerTransaction;
  readonly entryId: string;
  readonly receivedAt: Date;
  readonly correlationId: string;
}

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
 * 3. The decision, by the aggregate, under the lock, and the rows it is recorded in
 *    (`ApplyWagerOperation`, the step the scheduler of a parked transaction shares). A refusal a
 *    provider caused comes back as a failure code to persist (ADR 0006) and never as an exception:
 *    the rejection is an outcome of the system, auditable and replayable, and the row and its event
 *    are its only effects (`rule.rejected.no-effect`).
 * 4. The wait, when the reference has not resolved: the parked row, its place in the scheduler's
 *    claim list and the one event that announces it (`ref.parked-state`); and last, when the
 *    submission was delivered, the completion of its inbox row.
 *
 * No network call happens while the lock is held, and nothing in the path reads a clock or mints an
 * id after the transaction opened its first statement, so the window the lock covers is the
 * database work alone.
 *
 * What one submission reports — the line an operator follows it by and the counter its outcome
 * belongs to — is written after the commit and from here rather than from the entry points, so the
 * record of an operation is the same whichever way it arrived (`obs.structured-logs`, `obs.metrics`).
 */
export class SubmitWagerTransaction {
  private readonly operations: ApplyWagerOperation;

  constructor(private readonly dependencies: SubmitWagerTransactionDependencies) {
    this.operations = new ApplyWagerOperation(dependencies.ids);
  }

  /** The HTTP entry point: one submission, in one transaction of its own. */
  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionOutcome> {
    const prepared = this.prepare(command);
    const outcome = await this.dependencies.unitOfWork.transactional((repositories) =>
      this.apply(repositories, prepared),
    );

    this.report(outcome, prepared.correlationId);

    return outcome;
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

    const delivered = await this.dependencies.unitOfWork.transactional(
      async (repositories): Promise<DeliveryOutcome> => {
        const claim = await repositories.inbox.claim(received);

        if (!claim.claimed) {
          if (!claim.stored.matchesPayload(received.payloadHash)) {
            /*
             * Counted before the rollback and not after it, because this is where the reuse is
             * recognised: the claim read a row holding this message id under other content, which no
             * caller of `deliver` can see from the refusal alone (`msg.inbox-payload-conflict`).
             */
            this.dependencies.metrics.increment('wager_duplicates_detected_total', {
              source: 'inbox-conflict',
            });

            throw new InboxPayloadConflictError(delivery.consumerName, delivery.messageId);
          }

          return { absorbed: true };
        }

        const outcome = await this.apply(repositories, prepared);

        received.markProcessed(prepared.receivedAt);
        await repositories.inbox.complete(received);

        return { absorbed: false, ...outcome };
      },
    );

    if (delivered.absorbed) {
      this.dependencies.metrics.increment('wager_duplicates_detected_total', { source: 'inbox' });
      this.dependencies.logger.info('wager.delivery.absorbed', {
        correlationId: command.correlationId,
        messageId: delivery.messageId,
      });

      return delivered;
    }

    this.report(delivered, prepared.correlationId);

    return delivered;
  }

  /**
   * What one committed submission reports: the line an operator follows the operation by and the
   * counter the outcome belongs to (`obs.structured-logs`, `obs.metrics`).
   *
   * It runs after the commit and never inside it, so nothing is reported for work that rolled back,
   * and it is here rather than in the two entry points so that the record of an operation is the
   * same whichever way it arrived (`msg.same-use-case`). No amount and no balance reaches it; the
   * identity fields are what a line is searched by (`obs.no-sensitive-data`).
   */
  private report(outcome: SubmissionOutcome, correlationId: string): void {
    const transaction = outcome.transaction;

    if (outcome.idempotentReplay) {
      this.dependencies.metrics.increment('wager_duplicates_detected_total', {
        source: 'idempotency',
      });
    } else if (transaction.status !== 'PENDING') {
      // One recorded outcome, which is what the counter counts: a transaction parked now and
      // settled later is counted under both of the statuses it reached (`obs.metrics`).
      this.dependencies.metrics.increment('wager_transactions_total', {
        kind: transaction.kind,
        status: transaction.status,
      });
    }

    this.dependencies.logger.info('wager.transaction.recorded', {
      correlationId,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay: outcome.idempotentReplay,
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

    const operation: AppliedWagerOperation = {
      submission,
      wallet,
      entryId,
      occurredAt: receivedAt,
      correlationId,
    };

    if ((await this.operations.apply(repositories, operation)) === 'unresolved-reference') {
      await this.park(repositories, operation);
    }

    return { transaction: submission, idempotentReplay: false };
  }

  /**
   * `rule.reference.missing-is-pending`: the referenced transaction has not arrived, or has not
   * reached an outcome yet, so the submission is parked with the balance it observed and answered
   * `202` (`ref.parked-state`, `api.location-on-pending`). No balance moved and no reference was
   * resolved, so the row, its schedule and its event are everything this writes.
   *
   * The schedule row is what hands the transaction to the scheduler (ADR 0011): it carries the
   * attempts, the next one and the window, all counted from this receipt, and it commits with the
   * parked row, so a transaction is never parked without being claimable and never claimable
   * without being parked. The event is emitted here and only here, because this is the one arrival
   * that makes a transaction pending; the attempts that follow emit nothing
   * (`event.pending-reference-when`).
   */
  private async park(repositories: Repositories, operation: AppliedWagerOperation): Promise<void> {
    const { submission, occurredAt, correlationId } = operation;

    await this.operations.park(repositories, operation);

    const schedule = PendingReferenceSchedule.open(submission, correlationId);

    await repositories.pendingReferences.insert(schedule);
    await this.operations.enqueue(repositories, [
      WagerTransactionPendingReference.record({
        eventId: this.dependencies.ids.next(),
        correlationId,
        occurredAt,
        identity: transactionIdentity(submission),
        referenceExternalTransactionId: awaitedReference(submission),
        expiresAt: schedule.expiresAt,
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
}

/**
 * The reference a parked transaction is waiting for. A transaction that carried none cannot be
 * parked — `markPendingReference` refuses it (`tx.reference-matrix`) — so the absence here is a
 * defect rather than an event with a missing member.
 */
function awaitedReference(submission: WagerTransaction): string {
  const reference = submission.referenceExternalTransactionId;

  if (reference === null) {
    throw new Error(
      `transaction ${submission.id} is parked without a reference to wait for (tx.reference-matrix)`,
    );
  }

  return reference;
}
