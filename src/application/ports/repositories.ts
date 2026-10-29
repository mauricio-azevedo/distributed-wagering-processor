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
import type { PendingReferenceSchedule } from '../../domain/pending-reference-schedule';
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

/** `rule.reference.resolution`: how a reference names a transaction, which is never a service id. */
export interface ProviderTransactionIdentity {
  readonly providerId: string;
  readonly externalTransactionId: string;
}

/**
 * `api.transaction-read`: the two ways a read names a transaction — the service id, or the provider
 * identity of `tx.identity`. The union is what makes the two read endpoints one decision: whichever
 * identity a caller used, the answer is the transaction or `TransactionNotFoundError`, and the
 * lookup a path admits is settled by its type rather than by the endpoint that happens to serve it.
 */
export type WagerTransactionLookup =
  { readonly transactionId: string } | ProviderTransactionIdentity;

export interface WagerTransactionRepository {
  /** Records a submission (`tx.born-pending`) or the outcome it was created with. */
  insert(transaction: WagerTransaction): Promise<void>;

  /**
   * The transaction a reference names (`rule.reference.resolution`): the lookup is on
   * `(providerId, referenceExternalTransactionId)` and never on the service id, so two providers
   * can share an external id without reaching each other's transactions, and the service's own
   * `OPENING` credits, which carry the reserved provider id, are unreachable from any submission
   * (`tx.opening-internal`).
   *
   * `null` means no transaction of that provider carries the id yet. That is a wait and not a
   * refusal: the reversal may simply have arrived before the operation it applies to
   * (`rule.reference.missing-is-pending`).
   */
  findByProviderTransaction(
    identity: ProviderTransactionIdentity,
  ): Promise<WagerTransaction | null>;

  /**
   * Whether a `PROCESSED` `REFUND` or `ROLLBACK` already reverses this transaction
   * (`rule.reference.reversed-once`). It is a question about rows rather than about the pair of
   * transactions, which is why it is a port call and not part of the domain decision (RULE-020),
   * and the partial unique index over processed reversals is what holds the answer whatever writes
   * (SCHEMA-015).
   */
  hasProcessedReversal(transactionId: string): Promise<boolean>;

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

/**
 * One page of a wallet's ledger (`api.ledger-read`). `afterWalletVersion` is an exclusive lower
 * bound — the version the previous page ended at, `null` for the first page — because the cursor of
 * `ledger.cursor` is a position in the version sequence and not an offset: entries committed while
 * a caller holds a cursor land beyond it, so no page repeats or skips one.
 */
export interface LedgerPageQuery {
  readonly walletId: string;
  readonly afterWalletVersion: number | null;
  readonly limit: number;
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
   * The entries of one wallet after `afterWalletVersion`, in ascending `walletVersion`, at most
   * `limit` of them.
   *
   * `walletVersion` is the only ordering key a wallet's ledger has
   * (`ledger.wallet-version-sequence`): it is unique per wallet, monotonic and backed by the index
   * the chain triggers already need, so a page is a range scan whose cost does not grow with how
   * far into the ledger it sits. Ordering by id would be wrong rather than slow — UUIDv7 is not
   * monotonic across instances, so two entries committed at once by two of them can come back in
   * either order and a page boundary would then skip or repeat one.
   */
  page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;

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

export interface PendingReferenceScheduleRepository {
  /** Adds a parked transaction to the claim list, in the transaction that parked it. */
  insert(schedule: PendingReferenceSchedule): Promise<void>;

  /**
   * The next transaction whose attempt is due, claimed exclusively for the rest of the
   * transaction, or `null` when none is (`ref.scheduler`).
   *
   * One row per call and one transaction per row: the claim is held while the attempt runs, so a
   * worker that crashes mid-attempt releases it with its connection and the next sweep picks the
   * row up, and several workers never pick the same one. A batch claimed in one transaction would
   * couple the attempts instead — one failure would roll back every row in it, and one wallet lock
   * would be held while another wallet's operation ran.
   */
  claimNextDue(at: Date): Promise<PendingReferenceSchedule | null>;

  /** Writes what an attempt changed: how many have run and when the next one is due. */
  update(schedule: PendingReferenceSchedule): Promise<void>;
}

/** `msg.inbox-identity`: the body message id, scoped to the consumer that received it. */
export interface InboxMessageIdentity {
  readonly consumerName: string;
  readonly messageId: string;
}

/**
 * The outcome of claiming a delivery (ADR 0010). A lost claim reports the row that holds the
 * identity, which is what decides between a redelivery and a reused message id: the port carries
 * the fact, `InboxMessage.matchesPayload` the decision.
 */
export type InboxClaim =
  { readonly claimed: true } | { readonly claimed: false; readonly stored: InboxMessage };

export interface InboxRepository {
  /**
   * Claims a delivery: the first statement of a message's financial transaction
   * (`conc.lock-order`). The row either exists afterwards because this call wrote it, or it existed
   * already, and the primary key of the table decides which for every instance at once
   * (`msg.inbox-identity`).
   *
   * A redelivery arriving while the first attempt is still open waits on the primary key and then
   * reads what that attempt committed, so the claim is also what absorbs a redelivery that a crash
   * between commit and acknowledgement caused (`msg.ack-after-commit`, `msg.redelivery-safe`).
   */
  claim(message: InboxMessage): Promise<InboxClaim>;

  /**
   * Writes the completion of a claimed row, last in the transaction that applied the message
   * (`conc.lock-order`), so a committed inbox row always carries a `processedAt` and an
   * uncompleted one can only belong to a transaction that never committed.
   */
  complete(message: InboxMessage): Promise<void>;

  /** The row of a delivery identity, which is what a reader asks about one (`msg.inbox-identity`). */
  findByIdentity(identity: InboxMessageIdentity): Promise<InboxMessage | null>;
}

/** How much of the outbox one publisher cycle takes on: the rows due at `dueAt`, at most `limit`. */
export interface OutboxClaim {
  readonly dueAt: Date;
  readonly limit: number;
}

export interface OutboxRepository {
  /** Enqueues a committed fact, in the transaction that produced it (`outbox.single-transaction`). */
  insert(message: OutboxMessage): Promise<void>;

  /** The row of an event id, the identity every publication of it carries (`outbox.stable-event-id`). */
  findByEventId(eventId: string): Promise<OutboxMessage | null>;

  /**
   * Takes exclusive hold of the pending rows that are due, for the rest of the transaction
   * (ADR 0005, `outbox.concurrent-publishers`): the claim is the lock, so two publishers never
   * receive the same row and a publisher that dies releases its rows without a reaper
   * (`outbox.crash-recovery`).
   *
   * Only committed rows can be claimed, which is `outbox.publish-after-commit` as a property of
   * the database rather than a rule the publisher follows, and a row whose next attempt is still
   * in the future is left alone (`outbox.retry-backoff`).
   */
  claimPending(claim: OutboxClaim): Promise<OutboxMessage[]>;

  /**
   * Writes what a publication attempt decided about a claimed row: its publication, or its new
   * attempt count and schedule. Nothing else of the row is writable — the envelope, the event id
   * and the aggregate are what every publication of it repeats (`outbox.duplicate-safe`).
   */
  recordAttempt(message: OutboxMessage): Promise<void>;
}
