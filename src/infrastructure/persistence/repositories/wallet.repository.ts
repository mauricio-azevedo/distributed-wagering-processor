import { type EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';

import { WalletAlreadyExistsError } from '../../../application/errors';
import type { WalletRepository } from '../../../application/ports/repositories';
import type { Wallet } from '../../../domain/wallet';
import { WalletRow, toWallet, toWalletRow } from '../mappings/wallet.mapping';

/**
 * `wallet.unique-player-currency`: the key that decides a duplicate. It is named rather than
 * inferred from the exception class, because `wallets` carries a second unique key, `(id,
 * currency)`, which exists for the composite foreign key of the ledger: a violation of that one, or
 * of the primary key, would mean the service minted an id it had already used, which is a defect
 * and not a provider's duplicate.
 */
const PLAYER_CURRENCY_KEY = 'wallets_player_id_currency_unique';

/** `WalletRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Writes the wallet and lets the unique key decide a duplicate
   * (`wallet.duplicate-is-conflict`). Nothing is read first: a `SELECT` before the `INSERT` would
   * answer for the moment it ran and two instances opening the same wallet at once would both pass
   * it, so the key is the only check that holds for every instance (WALLET-001). Its violation
   * aborts the database transaction, which is exactly right here — the opening has nothing left to
   * do and the existing wallet must stay untouched.
   */
  async insert(wallet: Wallet): Promise<void> {
    try {
      this.em.persist(toWalletRow(wallet));
      await this.em.flush();
    } catch (error) {
      if (isPlayerCurrencyConflict(error)) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.balance.currency);
      }

      throw error;
    }
  }

  async findById(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id: walletId });

    return row === null ? null : toWallet(row);
  }
}

function isPlayerCurrencyConflict(error: unknown): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as { constraint?: string }).constraint === PLAYER_CURRENCY_KEY
  );
}
