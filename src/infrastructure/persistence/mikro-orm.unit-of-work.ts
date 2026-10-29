import { type EntityManager, IsolationLevel } from '@mikro-orm/postgresql';

import type { Repositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroOrmInboxRepository } from './repositories/inbox.repository';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/outbox.repository';
import { MikroOrmPendingReferenceScheduleRepository } from './repositories/pending-reference-schedule.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';
import { transientDatabaseFailure } from './transient-failure';

/**
 * ADR 0002's "about three seconds": long enough that a wallet under ordinary contention waits its
 * turn, short enough that a caller is told to retry instead of holding a connection open. It is the
 * fallback for a unit of work built without the environment — a test helper or a probe — so that
 * such a caller still cannot wait without bound; the service passes `LOCK_TIMEOUT_MS`.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 3000;

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
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ) {}

  /**
   * `SET LOCAL lock_timeout` opens the transaction, so every lock wait inside it is bounded and the
   * wallet lock of ADR 0002 gives up instead of queueing without end. `LOCAL` scopes the setting to
   * this transaction, which is what keeps it a property of a financial operation rather than of
   * whatever connection the pool handed over. The value is interpolated because `SET` takes no
   * bound parameter; it is an integer the environment loader validated (`ops.config-env`).
   */
  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.classifying(() =>
      this.em.fork({ clear: true }).transactional(async (transactional) => {
        await transactional.execute(`set local lock_timeout = ${this.lockTimeoutMs.toString()}`);

        return work(repositoriesOf(transactional));
      }),
    );
  }

  /**
   * `START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, which is `recon.snapshot` spelt
   * in SQL: PostgreSQL fixes the snapshot at the first statement and serves every later one from
   * it, and refuses any write with SQLSTATE `25006` instead of trusting the caller not to try.
   * Neither property is weakened by a second instance reconciling the same wallet, because both
   * belong to the transaction and not to the process.
   */
  snapshot<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.classifying(() =>
      this.em
        .fork({ clear: true })
        .transactional((transactional) => work(repositoriesOf(transactional)), {
          isolationLevel: IsolationLevel.REPEATABLE_READ,
          readOnly: true,
        }),
    );
  }

  /**
   * The one place a database failure becomes the transient refusal of `api.transient-failure`. It
   * wraps the whole transaction, commit included, because the commit is where an unknown outcome
   * arises: a connection lost after `COMMIT` is sent and before its confirmation arrives is
   * indistinguishable from one lost before, and both answer the same (`api.indeterminate-commit`).
   *
   * Only a classified failure is translated, so a constraint violation, a defect or an application
   * error still reaches the caller as itself.
   */
  private async classifying<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw transientDatabaseFailure(error, { lockTimeoutMs: this.lockTimeoutMs }) ?? error;
    }
  }
}

/** The repositories of one operation, all bound to the manager that holds its transaction. */
function repositoriesOf(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    pendingReferences: new MikroOrmPendingReferenceScheduleRepository(em),
  };
}
