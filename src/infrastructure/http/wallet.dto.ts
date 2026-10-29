import { z } from 'zod';

import type { ReconciliationReport } from '../../application/use-cases/reconcile-wallet';
import type { MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import { moneyPropsSchema, uuidSchema } from '../transport/contract.dto';

/**
 * The request and response shapes of the wallet endpoints, implementing `OpenWalletRequest`,
 * `Wallet` and `ReconciliationReport` of [docs/openapi.yaml](../../../docs/openapi.yaml)
 * (`model.contract-first`). The document is authoritative; these schemas are how the service
 * enforces it at runtime, over the primitive shapes of `contract.dto.ts`.
 */

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

/**
 * `ReconciliationReport`: the comparison as `recon.report-shape` spells it. `difference` is the
 * contract's `SignedMoneyProps`, the one member of the whole API whose amount may carry a sign
 * (`money.signed-difference-only`); the money formatter never produces `-0.00`, so the pattern that
 * excludes it needs nothing here to hold.
 */
export interface ReconciliationReportResponse {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly checkedAt: string;
}

export function reconciliationReportResponse(
  report: ReconciliationReport,
): ReconciliationReportResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    checkedAt: report.checkedAt.toISOString(),
  };
}
