import type { ErrorCode } from '../domain/error-code';

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
