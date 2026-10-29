import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { z } from 'zod';

import { ApplicationError } from '../../application/errors';
import type {
  SubmissionOutcome,
  SubmittedWagerOperation,
} from '../../application/use-cases/submit-wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import { isIdempotencyKey } from '../../domain/idempotency';
import type { MoneyProps } from '../../domain/money';
import { WAGER_OPERATION_KINDS } from '../../domain/transaction-kind';
import {
  type RecordedTransactionStatus,
  type WagerTransaction,
  allowsReference,
  requiresReference,
} from '../../domain/wager-transaction';
import { externalIdSchema, moneyPropsSchema, movesNoMoney, uuidSchema } from './contract.dto';
import { RequestValidationError } from './request-validation';

/**
 * The request and response shapes of `POST /wagering/transactions`, implementing
 * `SubmitWagerTransactionRequest`, `TransactionOutcome` and the `Idempotency-Key` parameter of
 * [docs/openapi.yaml](../../../docs/openapi.yaml) (`model.contract-first`).
 *
 * The document states the operation as five per-kind variants; one object plus the matrix below
 * enforces the same rules and names the same members, because what a caller has to fix is the
 * member and not the variant it belongs to. Every rule here is request-level: it depends on the
 * payload alone, persists nothing and answers the same every time (`api.validation-stateless`).
 * Everything that depends on stored state — the balance, the wallet's owner and currency, the
 * reference — is the use case's decision and comes back as a persisted outcome.
 */

/** `tx.opening-internal`: the provider id the service keeps for its own opening credits. */
const RESERVED_PROVIDER_ID = 'system';

/**
 * `WagerOperationFields` with `WagerOperationKind` as its `kind`, so the internal `OPENING` credit
 * is unrepresentable in a request rather than refused by a check (`tx.kinds`). An unknown member is
 * a violation and not an ignored extra, which is what `additionalProperties: false` means.
 */
const wagerOperationFieldsSchema = z.strictObject({
  providerId: externalIdSchema.refine((providerId) => providerId !== RESERVED_PROVIDER_ID, {
    error: `must not be ${RESERVED_PROVIDER_ID}, which the service keeps for its own transactions`,
  }),
  externalTransactionId: externalIdSchema,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: externalIdSchema,
  gameId: externalIdSchema,
  kind: z.enum(WAGER_OPERATION_KINDS, {
    error: `must be one of ${WAGER_OPERATION_KINDS.join(', ')}`,
  }),
  money: moneyPropsSchema,
  referenceExternalTransactionId: externalIdSchema.optional(),
});

type WagerOperationFields = z.infer<typeof wagerOperationFieldsSchema>;

/**
 * `SubmitWagerTransactionRequest`: the operation, with the three rules that need more than one
 * member to decide.
 *
 * The reference matrix is the domain's (`tx.reference-matrix`), read here rather than restated, so
 * the request boundary, the transaction factory and the `CHECK` constraint of SCHEMA-006 cannot
 * disagree about which kind carries a reference. The amount is strictly positive on every kind that
 * moves money and `0.00` only on a `LOSS` (`money.positive-in-operations`), and a reference to the
 * operation's own id is refused (`tx.self-reference-invalid`).
 *
 * Whether the referenced transaction exists, is of a kind this one may reference, shares its
 * context and has not been reversed already is decided nowhere near here: it depends on stored
 * state, so it is the use case's decision and comes back as a persisted outcome with its failure
 * code (`rule.reference.*`).
 */
export const submitWagerTransactionRequestSchema = wagerOperationFieldsSchema.check((context) => {
  const operation = context.value;
  const reference = operation.referenceExternalTransactionId;

  if (reference === undefined && requiresReference(operation.kind)) {
    context.issues.push({
      code: 'custom',
      input: reference,
      path: ['referenceExternalTransactionId'],
      message: `is required when kind is ${operation.kind}`,
    });
  }

  if (reference !== undefined && !allowsReference(operation.kind)) {
    context.issues.push({
      code: 'custom',
      input: reference,
      path: ['referenceExternalTransactionId'],
      message: `must be absent when kind is ${operation.kind}`,
    });
  }

  if (reference !== undefined && reference === operation.externalTransactionId) {
    context.issues.push({
      code: 'custom',
      input: reference,
      path: ['referenceExternalTransactionId'],
      message: 'must differ from externalTransactionId',
    });
  }

  // `money.positive-in-operations`: every kind but a `LOSS` becomes a ledger entry, and an entry
  // records a movement. An amount the pattern already refused is not this rule's violation.
  if (operation.kind !== 'LOSS' && movesNoMoney(operation.money)) {
    context.issues.push({
      code: 'custom',
      input: operation.money.amount,
      path: ['money', 'amount'],
      message: 'must be greater than 0.00',
    });
  }
});

export type SubmitWagerTransactionRequest = WagerOperationFields;

/**
 * The validated body as the use case takes it. The absent reference becomes `null`, which the
 * contract treats as the same thing — a reference sent as `null` hashes as an absent one
 * (`idem.payload-hash`) — so the operation has one shape whichever entry point assembled it.
 */
export function submittedOperationOf(
  request: SubmitWagerTransactionRequest,
): SubmittedWagerOperation {
  return {
    ...request,
    referenceExternalTransactionId: request.referenceExternalTransactionId ?? null,
  };
}

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
