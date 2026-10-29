import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';

/** Which slice of a wallet's ledger to read: the position to continue from, and how much of it. */
export interface WalletLedgerPageQuery {
  readonly walletId: string;
  /** The version the previous page ended at, exclusive; `null` for the first page. */
  readonly afterWalletVersion: number | null;
  readonly limit: number;
}

/**
 * One page of a wallet's ledger. `nextWalletVersion` is the position the next page continues from
 * and `null` when there is no next page; the adapter is what turns it into the opaque cursor of
 * `ledger.cursor`, so the encoding belongs to the transport and the position to the ledger.
 */
export interface WalletLedgerPage {
  readonly items: readonly WalletLedgerEntry[];
  readonly nextWalletVersion: number | null;
}

/**
 * Pages the ledger of one wallet in ascending `walletVersion` (`api.ledger-read`). An unknown
 * wallet is `WalletNotFoundError`, which is why the wallet is read at all: without it an unknown id
 * and a wallet opened at `0.00` would both answer with an empty page, and a caller could not tell
 * a typo from a ledger that has nothing in it yet.
 *
 * The page is keyset pagination over the version sequence, not an offset: the cursor names the last
 * version returned, so entries committed while a caller holds it land beyond it and every entry
 * appears on exactly one page, however much is appended between two requests
 * (`ledger.wallet-version-sequence`). An offset would shift under every append and skip or repeat
 * entries, and its cost would grow with how deep into the ledger the page sits.
 *
 * Whether another page exists is answered by asking the ledger for one entry more than the page
 * returns. That probe is what makes `nextCursor` null exactly on the last page: counting the ledger
 * instead would cost a second scan and still be a count of a different moment, and issuing a cursor
 * whenever a page came back full would hand callers a cursor that answers with nothing.
 *
 * It runs in the read-only snapshot of `UnitOfWork.snapshot`: the wallet and its entries are read
 * from one committed state, the read takes no lock so paging a hot wallet costs its processing
 * nothing, and PostgreSQL itself refuses any write from inside it.
 */
export class PageWalletLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: WalletLedgerPageQuery): Promise<WalletLedgerPage> {
    /*
     * The adapter validates `limit` against the contract, so one that arrives out of range is a
     * defect of the caller rather than a provider's mistake: answering a page over a nonsense limit
     * would be silently wrong, where raising names the caller that has to be fixed.
     */
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new Error(
        `paging the ledger of wallet ${query.walletId} needs a limit of at least 1 entry, got ${query.limit.toString()}`,
      );
    }

    return this.unitOfWork.snapshot(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(query.walletId);

      if (wallet === null) {
        throw new WalletNotFoundError(query.walletId);
      }

      const found = await ledger.page({
        walletId: wallet.id,
        afterWalletVersion: query.afterWalletVersion,
        limit: query.limit + 1,
      });
      const items = found.slice(0, query.limit);
      const last = items.at(-1);

      return {
        items,
        nextWalletVersion:
          found.length > items.length && last !== undefined ? last.walletVersion : null,
      };
    });
  }
}
