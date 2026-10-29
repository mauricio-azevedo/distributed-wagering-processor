import { z } from 'zod';

import { AMOUNT_PATTERN, CURRENCY_PATTERN, type MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';

/**
 * The request and response shapes of the wallet endpoints, implementing `OpenWalletRequest`,
 * `Wallet`, `MoneyProps` and `Uuid` of [docs/openapi.yaml](../../../docs/openapi.yaml)
 * (`model.contract-first`). The document is authoritative; these schemas are how the service
 * enforces it at runtime.
 *
 * The money patterns come from the domain, which is the one place they are written, so a request
 * the validator admits is one `Money.from` can parse and a rejection names the member instead of
 * surfacing as a parse error with no path (`money.decimal-string`).
 */

/** `Uuid`: RFC 9562 canonical lowercase form, the shape of every id the service mints or receives. */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    error: 'must be a lowercase UUID',
  });

/** `MoneyProps`: an exact amount as a string, never a JSON number (`model.money-props-in-contracts`). */
const moneyPropsSchema = z.strictObject({
  amount: z.string({ error: 'must be a decimal string' }).regex(AMOUNT_PATTERN, {
    error: `must match ${AMOUNT_PATTERN.source}`,
  }),
  currency: z.string({ error: 'must be a string' }).regex(CURRENCY_PATTERN, {
    error: `must be an ISO 4217 alphabetic code matching ${CURRENCY_PATTERN.source}`,
  }),
});

/**
 * `OpenWalletRequest`: the owner and the amount the wallet opens with, whose currency is the
 * wallet's. `0.00` is admitted here and on a `LOSS` alone (`money.zero-only-initial-balance`), so
 * this schema uses `MoneyProps` rather than the positive variant the money-moving operations take.
 */
export const openWalletRequestSchema = z.strictObject({
  playerId: uuidSchema,
  initialBalance: moneyPropsSchema,
});

export type OpenWalletRequest = z.infer<typeof openWalletRequestSchema>;

/** `Wallet`: the read shape, with timestamps as RFC 3339 and the balance as `MoneyProps`. */
export interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `wallet.read-shape`: the six members, and nothing the aggregate happens to carry beside them. */
export function walletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
