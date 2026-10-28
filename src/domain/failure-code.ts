/**
 * `failure.stable-codes`: the reason a transaction ends `REJECTED` or `FAILED`. One code per
 * outcome, never renamed and never reused with another meaning; section 9.1 of
 * [docs/system-contract.md](../../docs/system-contract.md) states the action each one expects from
 * the caller, and `FailureCode` in [docs/openapi.yaml](../../docs/openapi.yaml) is the
 * authoritative enumeration this type mirrors (`model.contract-first`).
 *
 * A failure code is a business outcome: it is returned and persisted, never thrown.
 */
export type FailureCode =
  | 'INSUFFICIENT_BALANCE'
  | 'REVERSAL_INSUFFICIENT_BALANCE'
  | 'BALANCE_LIMIT_EXCEEDED'
  | 'CURRENCY_MISMATCH'
  | 'WALLET_PLAYER_MISMATCH'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_MISMATCH'
  | 'REFERENCE_KIND_NOT_ALLOWED'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'PROCESSING_FAILED';
