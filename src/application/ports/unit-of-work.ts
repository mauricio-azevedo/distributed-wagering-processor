import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories';

/** The repositories of one operation, every one of them bound to its open transaction. */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

/**
 * The transaction boundary of a financial operation (`outbox.single-transaction`): the transaction
 * row, the wallet update, the ledger entry, the inbox row and the outbox rows commit together or
 * not at all.
 *
 * It is the only way to a repository, so no use case can write outside a transaction, and a use
 * case never sees a connection or an entity manager. Each operation runs on its own isolated
 * persistence context, so concurrent operations on the same wallet never serve each other state
 * one of them loaded first (ADR 0002 decides what happens when they contend for the row itself).
 */
export interface UnitOfWork {
  /**
   * Runs `work` in one database transaction. It commits when `work` resolves and rolls back when
   * it rejects, so nothing a failed operation wrote survives, and the rejection reaches the
   * caller unchanged.
   */
  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
