import type { EntityManager } from '@mikro-orm/postgresql';

import type { Repositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroOrmInboxRepository } from './repositories/inbox.repository';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/outbox.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';

/**
 * `UnitOfWork` over MikroORM: one database transaction per operation, on an entity manager forked
 * for it alone.
 *
 * The fork is what keeps instances isolated. The manager injected into an application is a
 * long-lived context, and an operation that worked on it would publish the rows it loaded to
 * every other operation through the shared identity map, so one operation could decide against a
 * balance another one read minutes earlier. A fork starts with an empty identity map and is
 * discarded with the transaction, which is also why it is created here rather than taken from the
 * caller: the only way to a repository is through a transaction, and every transaction brings its
 * own manager.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.em
      .fork({ clear: true })
      .transactional((transactional) => work(repositoriesOf(transactional)));
  }
}

/** The five repositories of one operation, all bound to the manager that holds its transaction. */
function repositoriesOf(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
