import { DomainError } from '../../domain/errors';
import { Money } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import { WalletNotFoundError } from '../errors';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { LedgerSummary } from '../ports/repositories';
import type { UnitOfWork } from '../ports/unit-of-work';

/**
 * `recon.report-shape`: the comparison, as the one result every entry point serializes.
 * `difference` is `storedBalance - calculatedBalance` and is the only signed amount the service
 * produces anywhere (`money.signed-difference-only`).
 */
export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly checkedAt: Date;
}

export interface ReconcileWalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Proves that a wallet's stored balance is the one its ledger implies, or reports exactly how far
 * off it is (`recon.calculation`). The stored balance is a materialized value and the ledger is the
 * source of truth, so this is the invariant every financial scenario ends with (RECON-004).
 *
 * It reports and never repairs (`recon.divergence-handling`). A service that silently corrected a
 * balance would destroy the only evidence of the defect that caused the divergence, and would do it
 * at the moment an operator most needs it; the read-only snapshot makes that structural rather than
 * a matter of what this code happens to call.
 *
 * Both readings come from one `REPEATABLE READ` snapshot taken without locking the wallet
 * (`recon.snapshot`): mutually consistent, so a balance change committed while the report is being
 * built can neither be counted twice nor be missed by one of the two sides, and invisible to the
 * operations on that wallet, so reconciling a hot wallet costs its processing nothing.
 *
 * Reconciliation under real parallel load is RECON-001, exercised by the concurrency suite.
 */
export class ReconcileWallet {
  constructor(private readonly dependencies: ReconcileWalletDependencies) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.read(walletId, this.dependencies.clock.now());

    if (!report.consistent) {
      /*
       * The record an operator acts on: the wallet, how far off it is and over how many entries.
       * `divergence` is the one method of the port that carries an amount, which is what makes this
       * line the single documented exception rather than a habit (`obs.no-sensitive-data`).
       */
      this.dependencies.logger.divergence('recon.balance-diverged', {
        walletId: report.walletId,
        difference: report.difference.toString(),
        checkedEntries: report.checkedEntries,
      });
      this.dependencies.metrics.increment('wager_reconciliation_divergence_total');
    }

    return report;
  }

  /**
   * The snapshot, and the one failure mode that produces no report at all: stored data the domain
   * cannot represent (RECON-005). A `NaN` balance is the case the schema is built to prevent
   * (`money.finite-in-database`) precisely because it would pass every equality underneath this one
   * — in SQL a `NaN` stored balance equals a `NaN` derived sum — and the rehydration parser is what
   * catches it if it is ever there (`money.exact-persistence`).
   *
   * Operationally it is the same fact as a divergence, and a worse one, so it is logged and counted
   * the same way; it is not a report because a non-finite balance has no serialization. The error
   * reaches the caller unchanged: nothing about it is a refusal of the request, and a wallet whose
   * stored state is not money is not something a caller can be answered about.
   */
  private async read(walletId: string, checkedAt: Date): Promise<ReconciliationReport> {
    try {
      return await this.dependencies.unitOfWork.snapshot(async ({ wallets, ledger }) => {
        const wallet = await wallets.findById(walletId);

        if (wallet === null) {
          throw new WalletNotFoundError(walletId);
        }

        return reportOf(
          wallet,
          await ledger.summarize({
            walletId: wallet.id,
            currency: wallet.currency,
            atVersion: wallet.version,
          }),
          checkedAt,
        );
      });
    } catch (error) {
      if (error instanceof DomainError) {
        this.dependencies.logger.divergence('recon.stored-state-not-money', {
          walletId,
          reason: error.message,
        });
        this.dependencies.metrics.increment('wager_reconciliation_divergence_total');
      }

      throw error;
    }
  }
}

function reportOf(wallet: Wallet, ledger: LedgerSummary, checkedAt: Date): ReconciliationReport {
  return {
    walletId: wallet.id,
    storedBalance: wallet.balance,
    calculatedBalance: ledger.calculatedBalance,
    difference: wallet.balance.subtract(ledger.calculatedBalance),
    consistent:
      wallet.balance.equals(ledger.calculatedBalance) && mirrorsLedgerHead(wallet, ledger),
    checkedEntries: ledger.checkedEntries,
    checkedAt,
  };
}

/**
 * The second half of `recon.calculation`, and not a restatement of the first: the sum says the
 * movements add up to the balance, the head says the wallet row sits on the entry its own version
 * names. A wallet whose version has drifted off its ledger sums correctly and is still wrong, and
 * only this comparison sees it. A wallet with no ledger is the state `wallet.zero-opening` leaves:
 * `0.00` at version 1, and nothing else.
 */
function mirrorsLedgerHead(wallet: Wallet, ledger: LedgerSummary): boolean {
  if (ledger.checkedEntries === 0) {
    return wallet.version === 1 && wallet.balance.equals(Money.zero(wallet.currency));
  }

  return ledger.headBalance !== null && wallet.balance.equals(ledger.headBalance);
}
