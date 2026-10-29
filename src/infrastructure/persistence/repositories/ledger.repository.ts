import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  LedgerRepository,
  LedgerSummary,
  LedgerSummaryQuery,
} from '../../../application/ports/repositories';
import { Money } from '../../../domain/money';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import {
  WalletLedgerEntryRow,
  toWalletLedgerEntry,
  toWalletLedgerEntryRow,
} from '../mappings/wallet-ledger-entry.mapping';

/**
 * The ledger's account of one wallet, in one statement over the `(wallet_id, wallet_version)` index.
 *
 * Both amounts come back as `text` rather than as a `numeric` the driver would hand to a JavaScript
 * `number`: the cast to `NUMERIC(20,2)` fixes the scale the sum is rendered at, so the string is the
 * decimal form `Money` parses, and a non-finite value arrives as `NaN` for the parser to refuse
 * rather than as a silently equal quantity (ADR 0001, `money.finite-in-database`).
 *
 * `-amount` on the `DEBIT` branch is exact and loses no sign information, because the direction
 * check of ADR 0003 admits the two values alone, so no entry falls through to a `NULL` the sum
 * would skip. `count(*)` counts the rows the sum was taken over, which is what makes an empty
 * ledger distinguishable from one that happens to add up to `0.00`.
 */
const SUMMARIZE = `select coalesce(sum(case when "direction" = 'CREDIT' then "amount" else -"amount" end), 0)
                          ::numeric(20,2)::text as "calculated",
                        count(*)::int as "entries",
                        max(case when "wallet_version" = ? then "balance_after" end)::text as "head"
                   from "wallet_ledger_entries"
                  where "wallet_id" = ?`;

interface LedgerSummaryRow {
  readonly calculated: string;
  readonly entries: number;
  readonly head: string | null;
}

/**
 * `LedgerRepository` over the entity manager of one open transaction (ADR 0008). It only appends
 * and reads: the ledger has no update and no delete anywhere in the service (`ledger.immutable`).
 */
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(toWalletLedgerEntryRow(entry));
    await this.em.flush();
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const row = await this.em.findOne(WalletLedgerEntryRow, { transactionId });

    return row === null ? null : toWalletLedgerEntry(row);
  }

  /**
   * The aggregate is issued through the entity manager, so it runs inside whatever transaction the
   * unit of work opened and therefore in the same snapshot as the wallet read beside it
   * (`recon.snapshot`). It goes to SQL rather than through the row mapping because the result is
   * one account of the whole ledger and not a row: nothing is loaded, nothing is cached, and the
   * cost does not grow with how long the wallet has been played.
   */
  async summarize(query: LedgerSummaryQuery): Promise<LedgerSummary> {
    const [row] = await this.em.execute<LedgerSummaryRow[]>(SUMMARIZE, [
      query.atVersion,
      query.walletId,
    ]);

    if (row === undefined) {
      // An aggregate with no GROUP BY always answers with one row, over an empty table included.
      throw new Error(`summarizing the ledger of wallet ${query.walletId} returned no row`);
    }

    return {
      calculatedBalance: Money.from(row.calculated, query.currency),
      checkedEntries: row.entries,
      headBalance: row.head === null ? null : Money.from(row.head, query.currency),
    };
  }
}
