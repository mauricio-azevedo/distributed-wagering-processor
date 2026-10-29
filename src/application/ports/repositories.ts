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
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /**
   * Writes a wallet that does not exist yet (`wallet.opening-credit`, `wallet.zero-opening`).
   *
   * Rejects with `WalletAlreadyExistsError` when the player already has a wallet in that currency
   * (`wallet.duplicate-is-conflict`). The adapter translates the violation of the unique key, so
   * the decision is the database's and holds for every instance at once, and the use case takes no
   * look-then-write that two concurrent openings would both pass (WALLET-001).
   */
  insert(wallet: Wallet): Promise<void>;

  /** The wallet as the database holds it, or `null` when the id names none. */
  findById(walletId: string): Promise<Wallet | null>;

  /**
   * The wallet, locked for the rest of the transaction (`conc.row-lock`): the second statement of
   * a financial operation, after the reservation and before any decision (`conc.lock-order`). Every
   * other operation on that wallet queues behind it in PostgreSQL's lock queue, so the balance this
   * returns is the true one for as long as the transaction lives (`conc.no-unguarded-rmw`).
   *
   * `null` means no wallet has the id. A submission cannot reach it: the reservation's foreign key
   * fails first and the adapter reports the absence there (`msg.unknown-wallet-permanent`), so the
   * case exists for the port to be answerable rather than for a path the database leaves open.
   */
  lockById(walletId: string): Promise<Wallet | null>;

  /**
   * Writes a balance change, guarded by the version the wallet carried when it was locked
   * (`conc.version-guard`): the statement updates the row only while it still holds
   * `expectedVersion`, so a write that bypassed the lock cannot lose an update, it fails.
   *
   * Taking the expected version as an argument rather than deriving it from the new wallet is what
   * makes the guard the version the operation actually read; a derived one would guard against
   * whatever the aggregate produced and agree with itself.
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
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

  /**
   * Writes the outcome a transition recorded onto the row the reservation claimed: the five columns
   * of `tx.row-append-only` and nothing else. The row is already there, so this never inserts, and
   * what it may write is what the trigger of ADR 0003 admits on a row that is not terminal yet.
   */
  recordOutcome(transaction: WagerTransaction): Promise<void>;

  /** The transaction row of a service id, the identity the read endpoints use (`tx.read-shape`). */
  findById(transactionId: string): Promise<WagerTransaction | null>;
}

/** Which wallet's ledger to account for, and the version whose entry the head is (`atVersion`). */
export interface LedgerSummaryQuery {
  readonly walletId: string;
  /** The wallet's currency: the ledger of a wallet is in it alone (`ledger.currency-matches-wallet`). */
  readonly currency: string;
  readonly atVersion: number;
}

/**
 * What the ledger says a wallet holds, independently of the wallet row (`recon.calculation`): the
 * sum of credits minus debits, how many entries it was taken over, and the balance the entry at
 * `atVersion` left behind — `null` when no entry carries that version, which is itself a divergence
 * for a wallet that has a ledger.
 */
export interface LedgerSummary {
  readonly calculatedBalance: Money;
  readonly checkedEntries: number;
  readonly headBalance: Money | null;
}

export interface LedgerRepository {
  /** Appends one entry; the ledger is never updated or deleted (`ledger.immutable`). */
  insert(entry: WalletLedgerEntry): Promise<void>;

  /**
   * The entry a transaction produced, at most one (`ledger.one-entry-per-transaction`); `null`
   * when the transaction moved no money (`ledger.no-entry-without-effect`).
   */
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;

  /**
   * The ledger's own account of a wallet, which is what reconciliation compares the stored balance
   * with (`recon.calculation`).
   *
   * The sum is the database's, over `NUMERIC(20,2)`, so it is exact however long the ledger is and
   * nothing materializes it (ADR 0001); the adapter rebuilds the result with the domain parser,
   * which is what refuses a stored `NaN` instead of letting it compare equal to itself
   * (`money.finite-in-database`, RECON-005). It takes no lock, so the ledger of a wallet can be
   * accounted for while that wallet is being written (`recon.snapshot`).
   */
  summarize(query: LedgerSummaryQuery): Promise<LedgerSummary>;
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
