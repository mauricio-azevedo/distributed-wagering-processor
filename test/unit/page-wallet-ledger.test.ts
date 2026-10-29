import { describe, expect, test } from 'bun:test';

import { WalletNotFoundError } from '../../src/application/errors';
import type { LedgerPageQuery } from '../../src/application/ports/repositories';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { PageWalletLedger } from '../../src/application/use-cases/page-wallet-ledger';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';
const AT = new Date('2026-10-28T12:00:00.000Z');

/**
 * The paging arithmetic of `api.ledger-read`, decided over a fake ledger so the off-by-one that
 * `nextCursor` is cannot hide behind a database: the page asks for one entry more than it returns,
 * and that extra entry is the only evidence that another page exists. Whether the entries come back
 * in order is the adapter's and the index's, proven against PostgreSQL.
 */

const brl = (amount: string) => Money.from(amount, 'BRL');

function wallet(): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balance: brl('500.00'),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
}

/** A ledger of `count` credits of `1.00`, carrying wallet versions 1 to `count`. */
function ledgerOf(count: number): WalletLedgerEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    WalletLedgerEntry.rehydrate({
      id: `entry-${(index + 1).toString()}`,
      walletId: WALLET_ID,
      transactionId: `transaction-${(index + 1).toString()}`,
      kind: 'WIN',
      direction: 'CREDIT',
      money: brl('1.00'),
      balanceBefore: brl(`${index.toString()}.00`),
      balanceAfter: brl(`${(index + 1).toString()}.00`),
      walletVersion: index + 1,
      createdAt: AT,
    }),
  );
}

interface Asked {
  readonly queries: LedgerPageQuery[];
}

/**
 * A read-only `UnitOfWork` over one in-memory ledger. `transactional` is unreachable, because a
 * page is a read and the boundary it runs in is what guarantees it takes no lock (`recon.snapshot`);
 * `queries` records what the use case asked the port for, which is where the probe shows up.
 */
function fakeUnitOfWork(options: {
  readonly entries?: WalletLedgerEntry[];
  readonly wallet?: Wallet | null;
}): { readonly unitOfWork: UnitOfWork; readonly asked: Asked } {
  const entries = options.entries ?? [];
  const asked: Asked = { queries: [] };
  const repositories: Repositories = {
    wallets: {
      findById: () => Promise.resolve(options.wallet === undefined ? wallet() : options.wallet),
      insert: unreachable('wallet insert'),
      lockById: unreachable('wallet lock'),
      update: unreachable('wallet update'),
    },
    ledger: {
      page: (query: LedgerPageQuery) => {
        asked.queries.push(query);

        return Promise.resolve(
          entries
            .filter(
              (entry) =>
                query.afterWalletVersion === null || entry.walletVersion > query.afterWalletVersion,
            )
            .slice(0, query.limit),
        );
      },
      insert: unreachable('ledger insert'),
      findByTransactionId: unreachable('ledger lookup'),
      summarize: unreachable('ledger summary'),
    },
    transactions: {
      insert: unreachable('transaction insert'),
      reserve: unreachable('reservation'),
      recordOutcome: unreachable('outcome update'),
      findById: unreachable('transaction lookup'),
      findByProviderTransaction: unreachable('reference resolution'),
      hasProcessedReversal: unreachable('reversal lookup'),
    },
    inbox: {
      claim: unreachable('inbox claim'),
      complete: unreachable('inbox completion'),
      findByIdentity: unreachable('inbox lookup'),
    },
    outbox: {
      insert: unreachable('outbox'),
      findByEventId: unreachable('outbox lookup'),
      claimPending: unreachable('outbox claim'),
      recordAttempt: unreachable('publication attempt'),
      backlog: unreachable('outbox backlog'),
    },
    pendingReferences: {
      insert: unreachable('pending reference schedule'),
      claimNextDue: unreachable('pending reference claim'),
      update: unreachable('pending reference reschedule'),
    },
  };

  return {
    unitOfWork: {
      transactional() {
        throw new Error('paging the ledger is a read, so it must not open a writable transaction');
      },
      snapshot: (work) => work(repositories),
    },
    asked,
  };
}

function unreachable(port: string): () => never {
  return () => {
    throw new Error(`paging the ledger must not reach the ${port} port`);
  };
}

/** The error of a rejection, as the suites assert refusals without `.rejects`. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a rejection');
}

const versionsOf = (entries: readonly WalletLedgerEntry[]) =>
  entries.map((entry) => entry.walletVersion);

describe('ledger-page-arithmetic', () => {
  test('a page shorter than its limit is the last page', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: ledgerOf(3) });

    const page = await new PageWalletLedger(unitOfWork).execute({
      walletId: WALLET_ID,
      afterWalletVersion: null,
      limit: 50,
    });

    expect(versionsOf(page.items)).toEqual([1, 2, 3]);
    expect(page.nextWalletVersion).toBeNull();
  });

  test('a full page with an entry behind it continues at the version of its last item', async () => {
    const { unitOfWork, asked } = fakeUnitOfWork({ entries: ledgerOf(3) });

    const page = await new PageWalletLedger(unitOfWork).execute({
      walletId: WALLET_ID,
      afterWalletVersion: null,
      limit: 2,
    });

    expect(versionsOf(page.items)).toEqual([1, 2]);
    expect(page.nextWalletVersion).toBe(2);
    // The probe: one entry more than the page returns is what tells it another page exists.
    expect(asked.queries).toEqual([{ walletId: WALLET_ID, afterWalletVersion: null, limit: 3 }]);
  });

  test('a full page that exhausts the ledger is still the last page', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: ledgerOf(2) });

    const page = await new PageWalletLedger(unitOfWork).execute({
      walletId: WALLET_ID,
      afterWalletVersion: null,
      limit: 2,
    });

    expect(versionsOf(page.items)).toEqual([1, 2]);
    expect(page.nextWalletVersion).toBeNull();
  });

  test('a cursor is an exclusive lower bound, so pages neither repeat nor skip an entry', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: ledgerOf(5) });
    const pageWalletLedger = new PageWalletLedger(unitOfWork);

    const first = await pageWalletLedger.execute({
      walletId: WALLET_ID,
      afterWalletVersion: null,
      limit: 2,
    });
    const second = await pageWalletLedger.execute({
      walletId: WALLET_ID,
      afterWalletVersion: first.nextWalletVersion,
      limit: 2,
    });
    const third = await pageWalletLedger.execute({
      walletId: WALLET_ID,
      afterWalletVersion: second.nextWalletVersion,
      limit: 2,
    });

    expect([
      ...versionsOf(first.items),
      ...versionsOf(second.items),
      ...versionsOf(third.items),
    ]).toEqual([1, 2, 3, 4, 5]);
    expect(third.nextWalletVersion).toBeNull();
  });

  test('a cursor beyond the last entry is an empty last page, not a refusal', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: ledgerOf(3) });

    const page = await new PageWalletLedger(unitOfWork).execute({
      walletId: WALLET_ID,
      afterWalletVersion: 9,
      limit: 50,
    });

    expect(page.items).toEqual([]);
    expect(page.nextWalletVersion).toBeNull();
  });

  test('a wallet with no ledger is an empty last page', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: [] });

    const page = await new PageWalletLedger(unitOfWork).execute({
      walletId: WALLET_ID,
      afterWalletVersion: null,
      limit: 50,
    });

    expect(page.items).toEqual([]);
    expect(page.nextWalletVersion).toBeNull();
  });
});

describe('ledger-page-refusals', () => {
  test('an unknown wallet is WalletNotFoundError and the ledger is never read', async () => {
    const { unitOfWork, asked } = fakeUnitOfWork({ wallet: null, entries: ledgerOf(3) });

    const refused = await refusal(
      new PageWalletLedger(unitOfWork).execute({
        walletId: UNKNOWN_WALLET_ID,
        afterWalletVersion: null,
        limit: 50,
      }),
    );

    expect(refused).toBeInstanceOf(WalletNotFoundError);
    expect(asked.queries).toEqual([]);
  });

  /**
   * The adapter validates `limit` against the contract, so one that arrives out of range is a
   * defect of the caller and not a provider's mistake: it raises rather than becoming a page of
   * whatever the probe happened to return.
   */
  test('a limit the adapter should have refused raises instead of answering a page', async () => {
    const { unitOfWork } = fakeUnitOfWork({ entries: ledgerOf(3) });
    const pageWalletLedger = new PageWalletLedger(unitOfWork);

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const refused = await refusal(
        pageWalletLedger.execute({ walletId: WALLET_ID, afterWalletVersion: null, limit }),
      );

      expect(refused).not.toBeInstanceOf(WalletNotFoundError);
      expect((refused as Error).message).toMatch(/limit of at least 1 entry/);
    }
  });
});
