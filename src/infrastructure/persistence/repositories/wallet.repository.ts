import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletRepository } from '../../../application/ports/repositories';
import type { Wallet } from '../../../domain/wallet';
import { WalletRow, toWallet, toWalletRow } from '../mappings/wallet.mapping';

/** `WalletRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    this.em.persist(toWalletRow(wallet));
    await this.em.flush();
  }

  async findById(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id: walletId });

    return row === null ? null : toWallet(row);
  }
}
