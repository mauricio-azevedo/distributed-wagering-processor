import {
  type Sha256Hex,
  type SubmittedOperation,
  classifyReservationConflict,
  payloadHashOf,
} from '../../domain/idempotency';
import {
  type IntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  transactionIdentity,
} from '../../domain/integration-events';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import type { WagerOperationKind } from '../../domain/transaction-kind';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet, WalletOperationOutcome } from '../../domain/wallet';
import type { DebitOperation } from '../../domain/wallet-ledger-entry';
import { WalletNotFoundError, idempotencyConflict } from '../errors';
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

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sha256Hex: Sha256Hex;
}

/** What the rows of one recorded outcome are written from: the submission, the state it was decided against, the moment and the correlation id. */
interface Application {
  readonly submission: WagerTransaction;
  readonly wallet: Wallet;
  readonly occurredAt: Date;
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
 * The order inside the transaction is the fixed one of ADR 0002 (`conc.lock-order`):
 *
 * 1. Reservation. The transaction row is inserted before anything else, so the two unique keys of
 *    the submission are claimed by the database rather than by a look-then-write two arrivals
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
 *    entry, then the events.
 *
 * No network call happens while the lock is held, and nothing in the path reads a clock or mints an
 * id after the transaction opened its first statement, so the window the lock covers is the
 * database work alone.
 */
export class SubmitWagerTransaction {
  constructor(private readonly dependencies: SubmitWagerTransactionDependencies) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionOutcome> {
    const receivedAt = this.dependencies.clock.now();
    const submission = this.record(command, receivedAt);
    const entryId = this.dependencies.ids.next();

    return this.dependencies.unitOfWork.transactional(async (repositories) => {
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

      const outcome = wallet.debit({
        transactionId: submission.id,
        entryId,
        playerId: submission.playerId,
        money: submission.money,
        occurredAt: receivedAt,
        operation: debitOf(command.operation.kind),
      });
      const application: Application = {
        submission,
        wallet,
        occurredAt: receivedAt,
        correlationId: command.correlationId,
      };

      await (outcome.applied
        ? this.applyBalanceChange(repositories, application, outcome)
        : this.recordRejection(repositories, application, outcome.failureCode));

      return { transaction: submission, idempotentReplay: false };
    });
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
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = application;

    submission.markProcessed({
      observedBalance: outcome.entry.balanceAfter,
      processedAt: occurredAt,
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
        reference: null,
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
    failureCode: Extract<WalletOperationOutcome, { applied: false }>['failureCode'],
  ): Promise<void> {
    const { submission, wallet, occurredAt, correlationId } = application;

    submission.reject({ failureCode, observedBalance: wallet.balance });

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
 * `ledger.direction-by-kind`: the balance change the kind asks the wallet for. A `BET` is the one
 * kind this slice applies; the four that remain need their reference resolved first, so the
 * submission schemas refuse them at the request boundary and this is the defect guard behind that,
 * not the refusal a provider sees.
 */
function debitOf(kind: WagerOperationKind): DebitOperation {
  if (kind !== 'BET') {
    throw new Error(
      `submitting a ${kind} is not implemented yet, so no request should have reached the use case`,
    );
  }

  return { kind };
}
