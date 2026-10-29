import type { EntityManager, QueryResult } from '@mikro-orm/postgresql';

import type {
  Reservation,
  WagerTransactionRepository,
} from '../../../application/ports/repositories';
import type { WagerTransaction } from '../../../domain/wager-transaction';
import {
  WagerTransactionRow,
  toWagerTransaction,
  toWagerTransactionRow,
} from '../mappings/wager-transaction.mapping';

/** `WagerTransactionRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    this.em.persist(toWagerTransactionRow(transaction));
    await this.em.flush();
  }

  /**
   * `INSERT ... ON CONFLICT DO NOTHING`, because a plain insert that violates a unique key aborts
   * the whole database transaction: the reservation has to be able to lose and then read, inside
   * the transaction that is about to do the financial work.
   *
   * The conflict target is left open, so either unique key of the submission can be the one that
   * loses, and the row that holds the submitted idempotency key is then read back. One statement
   * asks about both keys: the key holder answers the replay-or-conflict question
   * (`idem.payload-mismatch-conflict`), and its absence is what identifies the provider
   * transaction id as the key that collided (`idem.external-id-bound`). A conflict attributable to
   * neither is a defect rather than a provider error, so it is raised instead of being reported as
   * the conflict that happens to be left.
   */
  async reserve(transaction: WagerTransaction): Promise<Reservation> {
    const reservation = await this.em
      .createQueryBuilder(WagerTransactionRow)
      .insert(toWagerTransactionRow(transaction))
      .onConflict()
      .ignore()
      .execute<QueryResult<WagerTransactionRow>>('run');

    if (reservation.affectedRows === 1) {
      return { reserved: true };
    }

    const holders = await this.em.find(WagerTransactionRow, {
      providerId: transaction.providerId,
      $or: [
        { idempotencyKey: transaction.idempotencyKey },
        { externalTransactionId: transaction.externalTransactionId },
      ],
    });

    const keyHolder = holders.find((row) => row.idempotencyKey === transaction.idempotencyKey);

    if (keyHolder !== undefined) {
      return { reserved: false, keyHolder: toWagerTransaction(keyHolder) };
    }

    if (holders.some((row) => row.externalTransactionId === transaction.externalTransactionId)) {
      return { reserved: false, keyHolder: null };
    }

    throw new Error(
      `reserving transaction ${transaction.id} conflicted with a row holding neither its idempotency key nor its provider transaction id`,
    );
  }

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, { id: transactionId });

    return row === null ? null : toWagerTransaction(row);
  }
}
