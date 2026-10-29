import {
  type EntityManager,
  type QueryResult,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

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

/**
 * `conc.row-lock`: the wallet lock, as one explicit statement.
 *
 * The mode is `FOR NO KEY UPDATE` and not `FOR UPDATE`, which is why the ORM's
 * `LockMode.PESSIMISTIC_WRITE` cannot be used here (ADR 0002): the reservation that precedes the
 * lock holds `FOR KEY SHARE` on this row through its foreign key, `FOR UPDATE` conflicts with that
 * mode, and two concurrent submissions on one wallet would each wait for the other's reservation —
 * a deadlock PostgreSQL resolves by aborting one of them. `FOR NO KEY UPDATE` queues instead, which
 * is what the balance update needs and all it needs: wallet keys never change and wallets are never
 * deleted (CONC-009).
 *
 * The balance comes back as `text` so that the exact decimal string reaches the domain parser
 * rather than a `numeric` the driver could hand over as a JavaScript `number` (ADR 0001).
 */
const LOCK_WALLET = `select "player_id" as "playerId",
                            "currency",
                            "balance"::text as "balance",
                            "version",
                            "created_at" as "createdAt",
                            "updated_at" as "updatedAt"
                       from "wallets"
                      where "id" = ?
                        for no key update`;

/** The columns `LOCK_WALLET` reads, which are the wallet row without the id it was asked for. */
type LockedWalletColumns = Omit<WalletRow, 'id'>;

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

  /**
   * The lock is taken through the entity manager, so it runs in the transaction the unit of work
   * opened and is held until that transaction ends, and the row is read in the same statement that
   * locks it: a lock followed by a separate read would be two statements for one fact, and the
   * second would be the one the decision trusts.
   *
   * The result is rebuilt through the row mapping rather than loaded as a managed entity, so the
   * balance passes the domain parser (`money.exact-persistence`) and nothing in the identity map
   * can serve a later statement of this transaction a stale copy of it.
   */
  async lockById(walletId: string): Promise<Wallet | null> {
    const [columns] = await this.em.execute<LockedWalletColumns[]>(LOCK_WALLET, [walletId]);

    return columns === undefined ? null : toWallet({ id: walletId, ...columns });
  }

  /**
   * `conc.version-guard`: the update matches the row only while it still carries the version the
   * lock read. Under the lock it always matches; it exists so that a write which bypassed the lock
   * fails loudly instead of overwriting a balance someone else computed.
   *
   * Zero rows updated is therefore not a business outcome but a broken assumption, and it is raised
   * as one: the balance in hand was computed against state that has since moved, and the
   * transaction must roll back rather than carry on with a ledger entry nothing mirrors.
   */
  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const result = await this.em
      .createQueryBuilder(WalletRow)
      .update({
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      })
      .where({ id: wallet.id, version: expectedVersion })
      .execute<QueryResult<WalletRow>>('run');

    if (result.affectedRows !== 1) {
      throw new Error(
        `updating wallet ${wallet.id} to version ${wallet.version.toString()} matched no row at version ${expectedVersion.toString()}, so the balance it carries was computed against state that moved`,
      );
    }
  }
}

function isPlayerCurrencyConflict(error: unknown): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as { constraint?: string }).constraint === PLAYER_CURRENCY_KEY
  );
}
