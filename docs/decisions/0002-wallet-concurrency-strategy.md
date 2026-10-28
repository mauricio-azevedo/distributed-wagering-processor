---
status: accepted
date: 2026-10-28
---

# Serialize wallet operations with a pessimistic row lock backed by a version guard

## Context and Problem Statement

Several instances process operations on the same wallet at the same time: two bets racing for one balance, a
worker and an HTTP request touching one wallet, dozens of duplicates of one request. The invariants are
absolute: no lost update, no negative balance, exactly one ledger entry per balance change, and a bet that cannot
be afforded must end as a persisted rejection rather than an error. The unit of concurrency is the wallet;
different wallets must never wait for each other and no lock may be shared by all wallets. How are concurrent
operations on one wallet made correct?

## Decision Drivers

- Correctness under hot wallets: one player, many rapid operations, fifty duplicates of one request.
- Deterministic business rejections, decided against the true balance and persisted in the same transaction.
- A short financial transaction: outbox publication and queue acknowledgement wait for its commit.
- Fairness and predictability under contention, without retry logic in the application.
- No cross-wallet contention and no global lock.

## Considered Options

- Optimistic locking: `version` check with bounded retries
- Conditional atomic update: `UPDATE ... WHERE balance >= :amount`
- Pessimistic row lock on the wallet, backed by a version guard and a check constraint

## Decision Outcome

Chosen option: "Pessimistic row lock on the wallet, backed by a version guard and a check constraint", because
the database's lock queue gives fair serialization with no retry logic, the insufficient-balance decision is
made under the lock against the true balance and persisted as `REJECTED` in the same transaction, and the two
guards behind it turn any bypass into a detected failure.

1. Row lock: the use case locks the wallet row with `SELECT ... FOR NO KEY UPDATE` inside one short
   transaction. The statement is explicit in the wallet repository; the ORM's `LockMode.PESSIMISTIC_WRITE`
   emits `FOR UPDATE`, which deadlocks against the reservation step (see "Lock mode" below).
2. Version guard: the update is written as
   `UPDATE ... SET version = version + 1 WHERE id = :id AND version = :expected`; under the lock it always
   matches, and it exists so a write that bypassed the lock fails instead of losing an update.
3. Schema check: `CHECK (balance >= 0)` makes a negative balance impossible to commit whatever the code does.

A `lock_timeout` of about three seconds bounds waiting; exceeding it is a transient failure (`503` with
`Retry-After` over HTTP, a retry with backoff on the queue) and increments `wager_lock_conflicts_total`. The lock
order inside the transaction is fixed: idempotency reservation (insert of the transaction row), wallet lock,
reference lookup, ledger insert, outbox insert, inbox completion. The reservation comes first so that a
duplicate request blocks on the unique index of the first request's uncommitted row, then sees it committed and
replays without ever taking the wallet lock. No network call happens while the lock is held.

Lock mode. The reservation insert carries the foreign key `wager_transactions.wallet_id` to `wallets.id`, and
PostgreSQL's foreign-key check takes `FOR KEY SHARE` on the wallet row until the transaction ends. `FOR UPDATE`
conflicts with `FOR KEY SHARE`; `FOR NO KEY UPDATE` does not. Two concurrent reservations on one wallet
therefore both hold `KEY SHARE`, and if each then asks for `FOR UPDATE`, each waits for the other: a deadlock,
which PostgreSQL resolves after `deadlock_timeout` by aborting one of them. With `FOR NO KEY UPDATE` the second
request queues behind the first and proceeds when it commits. The balance update changes `balance`, `version`
and `updated_at`, none of them in a unique index, so the `UPDATE` itself also takes `NO KEY UPDATE`, and nothing
in the service needs `FOR UPDATE` on a wallet: wallet keys never change and wallets are never deleted. Checked
against PostgreSQL 18 with two sessions on one wallet: `FOR UPDATE NOWAIT` fails while another reservation is
open and `FOR NO KEY UPDATE NOWAIT` succeeds; ten concurrent reservation pairs deadlocked ten times with
`FOR UPDATE` and zero times with `FOR NO KEY UPDATE`, every pair serializing with consecutive versions. Two
other ways out were rejected: locking the wallet before reserving makes every duplicate queue on the wallet
lock (fifty copies, fifty acquisitions) and lengthens the time the lock is held; a `DEFERRABLE` foreign key
moves the unknown-wallet failure to commit time and weakens a reference the ledger's composite key builds on.

### Consequences

- Good, because contention is handled by PostgreSQL's lock queue, fairly and without application retries.
- Good, because rejections for insufficient funds are deterministic and auditable.
- Good, because duplicates never reach the wallet lock; fifty copies of a bet cost one lock acquisition.
- Bad, because throughput per wallet is bounded by the duration of the financial transaction; it stays in the
  low milliseconds only while the transaction holds no network I/O and runs indexed statements only.
- Bad, because the strategy depends on PostgreSQL row locks and is not portable to a store without them.
- Bad, because the lock is one explicit SQL statement in the wallet repository instead of an ORM lock mode; it
  is a single method, and CONC-009 fails if its mode regresses to `FOR UPDATE`.
- Worth revisiting if measured lock waits on hot wallets exceed the latency budget of providers (per-wallet
  batching or single-writer partitioning), if the transaction must include work that cannot be made short, or if
  a store without row locks must be supported.

### Confirmation

Acceptance entries CONC-001 to CONC-009, WALLET-004, SCHEMA-002 and SCHEMA-003 in
[acceptance.yaml](../acceptance.yaml): the concurrency suite with real parallelism and three processes, the
lock-timeout test, the version-guard test, the reservation-then-lock test against the deadlock, and the schema
tests on the check constraints.

## Pros and Cons of the Options

### Optimistic locking: `version` check with bounded retries

Read the wallet, compute, `UPDATE ... WHERE version = :expected`, retry on zero rows.

- Good, because simple to reason about and lock-free in the database.
- Bad, because a hot wallet becomes a retry storm: most attempts lose the race, each retry recomputes and rolls
  back the ledger and outbox rows, and latency becomes unpredictable.
- Bad, because the retry budget becomes a correctness parameter.

### Conditional atomic update

`UPDATE wallets SET balance = balance - :amount, version = version + 1 WHERE id = :id AND balance >= :amount`,
then branch on the row count.

- Good, because a single debit is one atomic statement.
- Bad, because the use case must also insert the transaction row, the ledger entry with `balanceBefore` and
  `balanceAfter`, the outbox events and the inbox completion, all consistent with the balance the update saw;
  reconstructing `balanceBefore` afterwards splits the invariant across two places.
- Bad, because the reference rules of reversals do not fit a single conditional statement without moving
  business logic into SQL.

### Pessimistic row lock on the wallet, backed by a version guard and a check constraint

- Good, because every operation on a wallet computes against the locked, true state.
- Good, because different wallets lock different rows and never interfere.
- Neutral, because a `lock_timeout` must be chosen and mapped to a transient failure.
- Neutral, because the lock mode has to be `FOR NO KEY UPDATE`; the reason fits in a paragraph but must be
  known by whoever touches the repository.
- Bad, because a long statement on a wallet delays every operation on that wallet; lookups are covered by
  indexes to keep the window short.

## More Information

Rules carried: `conc.unit-wallet`, `conc.row-lock`, `conc.version-guard`, `conc.no-global-lock`,
`conc.no-unguarded-rmw`, `conc.lock-order`, `conc.canonical-scenario` in
[system-contract.md](../system-contract.md). ADR 0004 explains the reservation-first step; ADR 0003 the check
constraint. Reconciliation deliberately takes no lock (`recon.snapshot`).
