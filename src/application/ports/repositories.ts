/**
 * The persistence ports of the application layer. Each one speaks in domain objects and in the
 * identities the system contract gives its table, never in rows, connections or SQL: the MikroORM
 * adapters in the infrastructure layer translate (ADR 0008).
 *
 * A repository is reachable only through the `UnitOfWork` that holds the open transaction
 * (`outbox.single-transaction`), so a use case cannot write outside one. Every write reaches
 * PostgreSQL when it is issued rather than at commit, so the statements of one operation arrive in
 * the order the use case wrote them, which is what fixes the lock order of ADR 0002.
 */
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Writes a wallet that does not exist yet (`wallet.opening-credit`, `wallet.zero-opening`). */
  insert(wallet: Wallet): Promise<void>;

  /** The wallet as the database holds it, or `null` when the id names none. */
  findById(walletId: string): Promise<Wallet | null>;
}

/**
 * The outcome of reserving a submission's two unique keys (`idem.persistent`, `conc.lock-order`).
 *
 * A lost reservation reports the transaction holding `(providerId, idempotencyKey)`, and `null`
 * when that key was free, which leaves `(providerId, externalTransactionId)` as the key that
 * collided. `classifyReservationConflict` in the domain turns either case into a replay or one of
 * the two conflicts; the port carries the fact, not the decision.
 */
export type Reservation =
  | { readonly reserved: true }
  | { readonly reserved: false; readonly keyHolder: WagerTransaction | null };

export interface WagerTransactionRepository {
  /** Records a submission (`tx.born-pending`) or the outcome it was created with. */
  insert(transaction: WagerTransaction): Promise<void>;

  /**
   * Claims the operation's identity: the first statement of a financial transaction, before the
   * wallet is locked (`conc.lock-order`). The row either exists afterwards because this call
   * wrote it, or it existed already, and the unique keys of the table decide which
   * (`idem.provider-scoped`, `idem.external-id-bound`) for every instance at once.
   *
   * A duplicate arriving while the first attempt is still open waits on the unique index and then
   * reads what that attempt committed, so the reservation is also the recovery from an unknown
   * commit outcome: it commits exactly when the financial effect does (`api.indeterminate-commit`).
   */
  reserve(transaction: WagerTransaction): Promise<Reservation>;

  /** The transaction row of a service id, the identity the read endpoints use (`tx.read-shape`). */
  findById(transactionId: string): Promise<WagerTransaction | null>;
}

export interface LedgerRepository {
  /** Appends one entry; the ledger is never updated or deleted (`ledger.immutable`). */
  insert(entry: WalletLedgerEntry): Promise<void>;

  /**
   * The entry a transaction produced, at most one (`ledger.one-entry-per-transaction`); `null`
   * when the transaction moved no money (`ledger.no-entry-without-effect`).
   */
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
}

/** `msg.inbox-identity`: the body message id, scoped to the consumer that received it. */
export interface InboxMessageIdentity {
  readonly consumerName: string;
  readonly messageId: string;
}

export interface InboxRepository {
  /** Records a message accepted for processing, in the transaction that applies it. */
  insert(message: InboxMessage): Promise<void>;

  /** What a consumer asks before acting, to absorb a redelivery (`msg.redelivery-safe`). */
  findByIdentity(identity: InboxMessageIdentity): Promise<InboxMessage | null>;
}

export interface OutboxRepository {
  /** Enqueues a committed fact, in the transaction that produced it (`outbox.single-transaction`). */
  insert(message: OutboxMessage): Promise<void>;

  /** The row of an event id, the identity every publication of it carries (`outbox.stable-event-id`). */
  findByEventId(eventId: string): Promise<OutboxMessage | null>;
}
