import type { ErrorCode } from '../../domain/error-code';

/**
 * RFC 9457 problem details, the body of every request-level error (`api.problem-details`).
 * `ProblemDetails` of [docs/openapi.yaml](../../../docs/openapi.yaml) is the authoritative shape
 * this module implements.
 *
 * The table below is the transport half of the `ErrorCode` taxonomy: the status class each code
 * answers with (`api.status-classes`) and the fixed title of its problem type. It lives here, in the
 * adapter, because a use case names the code and never a status; it is complete rather than grown
 * per endpoint, so a code introduced by a later slice cannot reach a caller as an unmapped `500`.
 */

/** `ValidationError` of the contract: a JSON Pointer to the input and what it must satisfy. */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ErrorCode;
  readonly correlationId: string;
  readonly errors?: readonly ValidationError[];
}

interface ProblemType {
  readonly status: 400 | 404 | 409 | 503;
  readonly title: string;
}

const PROBLEM_TYPES: Record<ErrorCode, ProblemType> = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency key required' },
  INVALID_CURSOR: { status: 400, title: 'Invalid cursor' },
  WALLET_NOT_FOUND: { status: 404, title: 'Wallet not found' },
  TRANSACTION_NOT_FOUND: { status: 404, title: 'Transaction not found' },
  WALLET_ALREADY_EXISTS: { status: 409, title: 'Wallet already exists' },
  IDEMPOTENCY_PAYLOAD_MISMATCH: { status: 409, title: 'Idempotency payload mismatch' },
  EXTERNAL_TRANSACTION_ALREADY_BOUND: { status: 409, title: 'External transaction already bound' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
};

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** The status a code answers with, so a caller's status class follows from the code alone. */
export function statusOf(code: ErrorCode): number {
  return PROBLEM_TYPES[code].status;
}

/**
 * The body of one problem. `type` is the code under the service's URN namespace and `title` is
 * fixed per code, so the two carry no occurrence detail; `detail` carries it, and never an amount or
 * a balance (`obs.no-sensitive-data`). `errors` appears with `VALIDATION_FAILED` alone.
 */
export function problemDetails(problem: {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly correlationId: string;
  readonly errors?: readonly ValidationError[];
}): ProblemDetails {
  const type = PROBLEM_TYPES[problem.code];

  return {
    type: `urn:problem-type:wagering:${problem.code}`,
    title: type.title,
    status: type.status,
    detail: problem.detail,
    code: problem.code,
    correlationId: problem.correlationId,
    ...(problem.errors === undefined ? {} : { errors: problem.errors }),
  };
}
