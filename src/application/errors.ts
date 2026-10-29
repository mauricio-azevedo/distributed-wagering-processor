import type { ErrorCode } from '../domain/error-code';
import type { IdempotencyConflictCode } from '../domain/idempotency';

/**
 * The refusals a use case answers with when a request cannot be carried out at all: the stored
 * state conflicts with it, or names nothing. They persist nothing and have no financial effect, so
 * repeating the request is always safe and the answer changes only when the stored state does
 * (`api.validation-stateless`).
 *
 * They are the counterpart of a `FailureCode`, which a `REJECTED` transaction carries forever: a
 * business rejection is an outcome the service recorded, an application error is a request it never
 * started. Each one carries its `ErrorCode`, the stable identifier a caller reacts to
 * (`failure.caller-action`), and a message that is the problem's `detail`: it names the occurrence
 * and never an amount or a balance (`obs.no-sensitive-data`).
 *
 * The HTTP status each code answers with is transport and lives with the adapter that writes the
 * problem details, so a use case never names one.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: ErrorCode;

  constructor(detail: string) {
    super(detail);
    this.name = new.target.name;
  }
}

/**
 * `wallet.duplicate-is-conflict`: the player already has a wallet in this currency and it is
 * unchanged. Raised by the wallet port, because the unique key of the table is what decides it for
 * every instance at once, including two opening the same wallet at the same time (WALLET-001).
 */
export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = 'WALLET_ALREADY_EXISTS' as const;

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet.`);
  }
}

/** `api.wallet-read`: no wallet has this id. */
export class WalletNotFoundError extends ApplicationError {
  override readonly code = 'WALLET_NOT_FOUND' as const;

  constructor(readonly walletId: string) {
    super(`No wallet has id ${walletId}.`);
  }
}

/**
 * `idem.payload-mismatch-conflict`: the key was first used for another operation. Nothing is
 * processed or stored, and the provider needs a new key rather than a retry, because the stored
 * outcome belongs to a payload this one is not.
 */
export class IdempotencyPayloadMismatchError extends ApplicationError {
  override readonly code = 'IDEMPOTENCY_PAYLOAD_MISMATCH' as const;

  constructor(readonly idempotencyKey: string) {
    super(`Key ${idempotencyKey} was first used with a different payload.`);
  }
}

/**
 * `idem.external-id-bound`: the provider transaction id already exists under the key that first
 * used it (additional policy C). Resending under the original key replays that outcome; a genuinely
 * new operation needs a new provider transaction id.
 */
export class ExternalTransactionAlreadyBoundError extends ApplicationError {
  override readonly code = 'EXTERNAL_TRANSACTION_ALREADY_BOUND' as const;

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(
      `Transaction ${externalTransactionId} of ${providerId} is bound to another idempotency key.`,
    );
  }
}

/**
 * `api.transient-failure`: the operation did not complete and the same request may be resent with
 * the same key after `retryAfterSeconds`.
 *
 * It does not promise that nothing was written. A failure known to have happened before the commit
 * — a lock wait longer than `lock_timeout` (`conc.row-lock`), a refused connection, a transaction
 * this service rolled back — leaves nothing behind, and the resend is a new operation. When the
 * commit outcome is unknown, because the connection is lost after `COMMIT` is sent and before its
 * confirmation arrives, the service cannot tell the two apart and answers the same; the resend
 * replays the stored outcome if it committed and applies the operation once if it did not
 * (`api.indeterminate-commit`).
 */
export class ServiceUnavailableError extends ApplicationError {
  override readonly code = 'SERVICE_UNAVAILABLE' as const;

  constructor(
    detail: string,
    readonly retryAfterSeconds: number,
  ) {
    super(detail);
  }
}

/**
 * The conflict a lost reservation is, as the error that carries it (IDEM-012). The domain decides
 * which of the two codes a taken key means (`classifyReservationConflict`); this is the one place
 * each code becomes the refusal a caller receives, so neither entry point can answer one of them
 * with a shape of its own.
 */
export function idempotencyConflict(
  code: IdempotencyConflictCode,
  submission: {
    readonly idempotencyKey: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
  },
): ApplicationError {
  return code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
    ? new IdempotencyPayloadMismatchError(submission.idempotencyKey)
    : new ExternalTransactionAlreadyBoundError(
        submission.providerId,
        submission.externalTransactionId,
      );
}
