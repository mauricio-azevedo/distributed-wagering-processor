import type { EntityManager } from '@mikro-orm/postgresql';

import type { WagerTransactionRepository } from '../../../application/ports/repositories';
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

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, { id: transactionId });

    return row === null ? null : toWagerTransaction(row);
  }
}
