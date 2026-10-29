/**
 * `failure.request-errors`: the reason a request was refused before anything could be persisted.
 * Codes are stable identifiers, so a provider reacts to the code and never to a message
 * (`failure.caller-action`); section 9.2 of
 * [docs/system-contract.md](../../docs/system-contract.md) states the action each one expects, and
 * `ErrorCode` in [docs/openapi.yaml](../../docs/openapi.yaml) is the authoritative enumeration this
 * type mirrors (`model.contract-first`).
 *
 * It is the counterpart of `FailureCode`, and the difference is what the two leave behind: a
 * failure code is a business outcome persisted on a `REJECTED` or `FAILED` transaction, while an
 * error code describes a request that persisted nothing and had no financial effect
 * (`api.validation-stateless`). Which HTTP status each one carries is transport, so it lives with
 * the adapter that answers.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_CURSOR'
  | 'WALLET_NOT_FOUND'
  | 'TRANSACTION_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'EXTERNAL_TRANSACTION_ALREADY_BOUND'
  | 'SERVICE_UNAVAILABLE';
