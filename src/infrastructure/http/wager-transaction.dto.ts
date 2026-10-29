import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

import { ApplicationError } from '../../application/errors';
import type { SubmissionOutcome } from '../../application/use-cases/submit-wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import { isIdempotencyKey } from '../../domain/idempotency';
import type { MoneyProps } from '../../domain/money';
import type { RecordedTransactionStatus, WagerTransaction } from '../../domain/wager-transaction';
import {
  type WagerOperationFields,
  checkWagerOperationRules,
  wagerOperationFieldsSchema,
} from '../transport/wager-operation.dto';
import { RequestValidationError } from './request-validation';

/**
 * The request and response shapes of `POST /wagering/transactions`, implementing
 * `SubmitWagerTransactionRequest`, `TransactionOutcome` and the `Idempotency-Key` parameter of
 * [docs/openapi.yaml](../../../docs/openapi.yaml) (`model.contract-first`).
 *
 * The operation and the rules it has to satisfy live in `transport/wager-operation.dto.ts`, because
 * the queue validates the same object and must admit exactly the same operations
 * (`msg.same-use-case`). What is HTTP's own is here: where the idempotency key comes from, and
 * which status each recorded outcome answers with.
 */

/**
 * `SubmitWagerTransactionRequest`: the operation, with the rules that need more than one member to
 * decide. The document states it as five per-kind variants; one object plus the shared check
 * enforces the same rules and names the same members, because what a caller has to fix is the
 * member and not the variant it belongs to.
 */
export const submitWagerTransactionRequestSchema =
  wagerOperationFieldsSchema.check(checkWagerOperationRules);

export type SubmitWagerTransactionRequest = WagerOperationFields;

/**
 * `idem.key-required`: the header is missing. It is its own `ErrorCode` rather than one more
 * validation violation, because the caller's next step differs — add the header and resend the
 * same operation — and because the queue, which has no header, reports the absence of
 * `data.idempotencyKey` as a validation failure instead (`msg.message-contract`).
 */
export class IdempotencyKeyRequiredError extends ApplicationError {
  override readonly code = 'IDEMPOTENCY_KEY_REQUIRED' as const;

  constructor() {
    super('The Idempotency-Key header is missing.');
  }
}

/**
 * `idem.key-required`, `idem.key-format`: the `Idempotency-Key` of this request, as a handler
 * parameter. The two refusals are different answers — an absent header is
 * `400 IDEMPOTENCY_KEY_REQUIRED` and a malformed one is `400 VALIDATION_FAILED` naming the header —
 * and the format is the domain's, the same predicate the stored key satisfies.
 *
 * It is a parameter decorator rather than a pipe because `@Headers` takes none, and the alternative
 * would be a controller reading a raw header and deciding what it means.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
  const supplied = request.headers['idempotency-key'];

  if (supplied === undefined) {
    throw new IdempotencyKeyRequiredError();
  }

  if (typeof supplied !== 'string' || !isIdempotencyKey(supplied)) {
    throw new RequestValidationError([
      {
        path: '/header/Idempotency-Key',
        message: 'must be 1 to 255 printable ASCII characters without spaces',
      },
    ]);
  }

  return supplied;
});

/**
 * `TransactionOutcome`: the one body `200`, `202`, `422` and `500` share (`api.outcome-shape`).
 * `failureCode` appears exactly when the outcome carries one, which is on a `REJECTED` and on a
 * `FAILED` transaction.
 */
export interface TransactionOutcomeResponse {
  readonly transactionId: string;
  readonly status: RecordedTransactionStatus;
  readonly balance: MoneyProps;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
}

/**
 * `api.status-classes`: the status each recorded outcome answers with. It is complete rather than
 * grown per slice, like the problem table beside it, so an outcome a later slice records cannot
 * reach a caller as an unmapped status. `PENDING` is absent because it is never a recorded outcome:
 * it exists only inside the transaction that records the first one (`tx.transitions`).
 */
const OUTCOME_STATUS: Record<RecordedTransactionStatus, number> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
  FAILED: 500,
};

export function statusOfOutcome(transaction: WagerTransaction): number {
  return OUTCOME_STATUS[recordedStatusOf(transaction)];
}

/** The outcome as the four members of the contract, read off the row that carries it (ADR 0004). */
export function transactionOutcomeResponse(outcome: SubmissionOutcome): TransactionOutcomeResponse {
  const transaction = outcome.transaction;
  const observedBalance = transaction.observedBalance;

  if (observedBalance === null) {
    throw new Error(
      `transaction ${transaction.id} is ${transaction.status} without an observed balance, so its outcome cannot be answered (tx.observed-balance)`,
    );
  }

  return {
    transactionId: transaction.id,
    status: recordedStatusOf(transaction),
    balance: observedBalance.toJSON(),
    idempotentReplay: outcome.idempotentReplay,
    ...(transaction.failureCode === null ? {} : { failureCode: transaction.failureCode }),
  };
}

function recordedStatusOf(transaction: WagerTransaction): RecordedTransactionStatus {
  if (transaction.status === 'PENDING') {
    throw new Error(
      `transaction ${transaction.id} is still PENDING, which is never an answer: a submission returns a recorded outcome (tx.transitions)`,
    );
  }

  return transaction.status;
}
