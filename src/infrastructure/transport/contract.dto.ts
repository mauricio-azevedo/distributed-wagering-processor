import { z } from 'zod';

import { AMOUNT_PATTERN, CURRENCY_PATTERN, Money } from '../../domain/money';

/**
 * The primitive shapes of [docs/openapi.yaml](../../../docs/openapi.yaml) every endpoint is written
 * in: `Uuid`, `ExternalId`, `MoneyProps` and its positive variant (`model.contract-first`). They
 * live in one module because the document defines them once and more than one endpoint implements
 * them; a second spelling of `MoneyProps` would be a second contract.
 *
 * The patterns and the notion of a positive amount come from the domain, which is where money is
 * defined, so a request the validator admits is one `Money.from` can parse and a refusal names the
 * member instead of surfacing as a parse error with no path (`money.decimal-string`).
 */

/** `Uuid`: RFC 9562 canonical lowercase form, the shape of every id the service mints or receives. */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    error: 'must be a lowercase UUID',
  });

/**
 * `ExternalId`: an identifier minted outside the service — a provider, a provider transaction, a
 * round or a game. The 120-character cap is what keeps the recommended idempotency key inside its
 * own limit (`idem.recommended-default`).
 */
export const externalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/, {
  error: 'must be 1 to 120 characters of A-Z a-z 0-9 . _ : - starting with a letter or a digit',
});

/** `MoneyProps`: an exact amount as a string, never a JSON number (`model.money-props-in-contracts`). */
export const moneyPropsSchema = z.strictObject({
  amount: z.string({ error: 'must be a decimal string' }).regex(AMOUNT_PATTERN, {
    error: `must match ${AMOUNT_PATTERN.source}`,
  }),
  currency: z.string({ error: 'must be a string' }).regex(CURRENCY_PATTERN, {
    error: `must be an ISO 4217 alphabetic code matching ${CURRENCY_PATTERN.source}`,
  }),
});

export type MoneyPropsRequest = z.infer<typeof moneyPropsSchema>;

/**
 * `PositiveMoneyProps`, as the question rather than as a second pattern: whether an amount is
 * refused for not moving money (`money.positive-in-operations`). The amount reaches the domain
 * parser, so "strictly positive" has one definition and the one the ledger enforces
 * (`ledger.positive-amount`).
 *
 * It answers `false` for an amount that is not a `MoneyProps` amount at all, because that is not
 * this rule's refusal: the pattern of the member has already reported it. The guard is required
 * rather than defensive — an object-level rule still runs after a member of the object was refused,
 * since a failed pattern records its issue and parsing carries on — and without it an amount like
 * `-5.00` would reach the domain parser and leave as a `500` where a violation belongs.
 */
export function movesNoMoney(money: MoneyPropsRequest): boolean {
  return (
    AMOUNT_PATTERN.test(money.amount) &&
    CURRENCY_PATTERN.test(money.currency) &&
    !Money.from(money.amount, money.currency).isPositive()
  );
}
