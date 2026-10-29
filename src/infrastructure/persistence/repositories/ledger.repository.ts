import type { EntityManager } from '@mikro-orm/postgresql';

import type { LedgerRepository } from '../../../application/ports/repositories';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import {
  WalletLedgerEntryRow,
  toWalletLedgerEntry,
  toWalletLedgerEntryRow,
} from '../mappings/wallet-ledger-entry.mapping';

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
}
