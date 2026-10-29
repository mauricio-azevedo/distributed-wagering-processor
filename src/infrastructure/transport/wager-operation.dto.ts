import { z } from 'zod';

import type { SubmittedWagerOperation } from '../../application/use-cases/submit-wager-transaction';
import { WAGER_OPERATION_KINDS } from '../../domain/transaction-kind';
import { allowsReference, requiresReference } from '../../domain/wager-transaction';
import { externalIdSchema, moneyPropsSchema, movesNoMoney, uuidSchema } from './contract.dto';

/**
 * `WagerOperationFields` and its rules, as both transport contracts define them: the body of
 * `POST /wagering/transactions` in [docs/openapi.yaml](../../../docs/openapi.yaml) and the `data`
 * of a `WagerTransactionRequested` in [docs/asyncapi.yaml](../../../docs/asyncapi.yaml), which is
 * the same object plus `idempotencyKey` (`model.contract-first`).
 *
 * The documents define the shape twice so each one stands alone; the code defines it once, because
 * the two entry points run the same use case and must admit exactly the same operations
 * (`msg.same-use-case`). A second spelling here would be a second contract, and the difference
 * would show up as a message a provider could send and a request it could not.
 *
 * Every rule below is payload-level: it depends on the operation alone, persists nothing and
 * answers the same every time (`api.validation-stateless`). Everything that depends on stored
 * state — the balance, the wallet's owner and currency, the reference — is the use case's decision
 * and comes back as a persisted outcome.
 */

/** `tx.opening-internal`: the provider id the service keeps for its own opening credits. */
const RESERVED_PROVIDER_ID = 'system';

/**
 * The business fields, with `WagerOperationKind` as `kind`, so the internal `OPENING` credit is
 * unrepresentable in a submission rather than refused by a check (`tx.kinds`). An unknown member is
 * a violation and not an ignored extra, which is what `additionalProperties: false` means.
 */
export const wagerOperationFieldsSchema = z.strictObject({
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

export type WagerOperationFields = z.infer<typeof wagerOperationFieldsSchema>;

/**
 * The three rules that need more than one member to decide, as a check every schema carrying the
 * fields applies — the HTTP body and the message `data` alike.
 *
 * The reference matrix is the domain's (`tx.reference-matrix`), read here rather than restated, so
 * the transport boundary, the transaction factory and the `CHECK` constraint of SCHEMA-006 cannot
 * disagree about which kind carries a reference. The amount is strictly positive on every kind that
 * moves money and `0.00` only on a `LOSS` (`money.positive-in-operations`), and a reference to the
 * operation's own id is refused (`tx.self-reference-invalid`).
 *
 * Whether the referenced transaction exists, is of a kind this one may reference, shares its
 * context and has not been reversed already is decided nowhere near here: it depends on stored
 * state, so it is the use case's decision and comes back as a persisted outcome with its failure
 * code (`rule.reference.*`).
 */
export function checkWagerOperationRules(context: z.core.ParsePayload<WagerOperationFields>): void {
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
}

/**
 * The validated fields as the use case takes them. The absent reference becomes `null`, which the
 * contracts treat as the same thing — a reference sent as `null` hashes as an absent one
 * (`idem.payload-hash`) — so the operation has one shape whichever entry point assembled it, and
 * two arrivals of it hash equal across entry points (`idem.cross-entry-point`).
 */
export function submittedOperationOf(fields: WagerOperationFields): SubmittedWagerOperation {
  return {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money,
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  };
}
