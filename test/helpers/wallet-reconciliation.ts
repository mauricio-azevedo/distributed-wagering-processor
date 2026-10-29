import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';

/**
 * `final-invariant-every-suite`
 *
 * `recon.final-invariant` (RECON-004): the assertion every suite that moves money ends with. For
 * each wallet it touched, the stored balance has to equal the balance rebuilt from its ledger, both
 * as the sum of credits minus debits and as the `balanceAfter` of the entry carrying the wallet's
 * own version (`recon.calculation`).
 *
 * It reads the committed rows directly rather than through a repository, so it holds whatever wrote
 * them, and it recomputes the sum in SQL instead of reusing the service's own arithmetic, so a
 * defect in that arithmetic cannot agree with itself. Amounts stay exact: `numeric` sums are
 * compared as the decimal strings PostgreSQL renders, never as JavaScript numbers (ADR 0001).
 */

interface Reconciliation {
  readonly id: string;
  readonly stored: string;
  readonly version: number;
  readonly calculated: string;
  readonly head: string | null;
  readonly entries: string;
}

/** The wallets a suite touched, collected as it goes and swept in its `afterAll`. */
export class TouchedWallets {
  private readonly ids = new Set<string>();

  add(walletId: string): string {
    this.ids.add(walletId);

    return walletId;
  }

  /**
   * Drops a wallet from the sweep. The one legitimate caller is a fixture that corrupts a wallet on
   * purpose, to prove that reconciliation reports the divergence (RECON-003, RECON-005): the
   * invariant the sweep asserts is exactly the one such a case breaks, so leaving the wallet in
   * would fail the test that demonstrates the breakage is seen.
   */
  forget(walletId: string): void {
    this.ids.delete(walletId);
  }

  /** Reconciles every wallet the suite touched and forgets them, so a later sweep is independent. */
  async expectReconciled(orm: MikroORM): Promise<void> {
    const walletIds = [...this.ids];
    this.ids.clear();

    for (const walletId of walletIds) {
      await expectWalletMatchesLedger(orm, walletId);
    }
  }
}

/**
 * The invariant for one wallet. A wallet with no entries is consistent only at `0.00` and version
 * 1, the state `wallet.zero-opening` leaves behind.
 */
export async function expectWalletMatchesLedger(orm: MikroORM, walletId: string): Promise<void> {
  const [reconciliation] = await orm.em.getConnection().execute<Reconciliation[]>(
    `select w.id,
            w.balance::text as stored,
            w.version,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end),
                     0)::numeric(20,2)::text as calculated,
            max(case when e.wallet_version = w.version then e.balance_after end)::text as head,
            count(e.id)::text as entries
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  );

  if (reconciliation === undefined) {
    throw new Error(`wallet ${walletId} was touched by the suite but does not exist`);
  }

  expect({
    walletId,
    stored: reconciliation.stored,
    rebuiltFromTheLedger: reconciliation.calculated,
  }).toEqual({
    walletId,
    stored: reconciliation.stored,
    rebuiltFromTheLedger: reconciliation.stored,
  });

  expect({
    walletId,
    head: reconciliation.head,
  }).toEqual({
    walletId,
    head: reconciliation.entries === '0' ? null : reconciliation.stored,
  });

  if (reconciliation.entries === '0') {
    expect({ walletId, stored: reconciliation.stored, version: reconciliation.version }).toEqual({
      walletId,
      stored: '0.00',
      version: 1,
    });
  }
}
