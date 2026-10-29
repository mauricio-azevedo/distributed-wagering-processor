---
status: accepted
date: 2026-10-29
---

# Resolve a reference under the wallet lock and decide its eligibility in the domain

## Context and Problem Statement

Four of the five kinds a provider submits may name another transaction: a `WIN` and a `LOSS` optionally, a
`REFUND` and a `ROLLBACK` always (`tx.reference-matrix`). The rules about that reference are where a wagering
service leaks money. The target must be resolved by `(providerId, referenceExternalTransactionId)` and never
by a service id; it must be of a kind this one may reference; it must share provider, player, wallet,
currency and round; it must have been processed; a reversal must carry its exact amount; and it must be
reversed at most once in total, whatever the reversal kind (`rule.reference.*`). A target that has not
arrived, or has not finished, is not a refusal at all: the transaction waits
(`rule.reference.missing-is-pending`).

Each of those is a persisted outcome with a distinct failure code, so the question is not whether to check
them but where each decision lives, when the reference is read relative to the wallet lock of ADR 0002, and
what makes "reversed at most once" true when several instances apply reversals at the same time.

## Decision Drivers

- A credit applied twice is money lost; the reversed-once rule has to hold across instances, not per process.
- Every refusal is a `REJECTED` row with its own code (ADR 0006), so a refusal must be reachable in the same
  database transaction that recorded the reservation — a rule that aborts the transaction cannot persist it.
- The decisions that depend on nothing but the two transactions should be testable with no database (RULE-020).
- The lock order of ADR 0002 is fixed: reservation, then wallet lock, then the decision; no network call and
  no clock reading may happen while the lock is held.
- One use case serves HTTP and the queue (`msg.same-use-case`), so no rule may live in an adapter.
- The scheduler that retries a parked transaction arrives in the next slice, so parking must be correct on
  its own.

## Considered Options

- Resolve the reference before the wallet lock and validate every rule in the use case
- Resolve it under the lock, decide eligibility in the domain, and read the reversed-once rule from the index
  predicate under that same lock
- Let the partial unique index decide the reversed-once rule and map its violation to the failure code

## Decision Outcome

Chosen option: "Resolve it under the lock, decide eligibility in the domain, and read the reversed-once rule
from the index predicate under that same lock", because the lock is what serializes the reversals of one
target, the pair of transactions is all the eligibility rules read, and a rule that is read rather than
violated can still be persisted as the outcome the contract promises.

`WagerTransactionRepository.findByProviderTransaction` resolves the reference on the unique key of a provider
transaction (`tx.identity`), issued after the wallet is locked. The order matters for correctness and not for
tidiness: a reference has to share the wallet (`rule.reference.same-context`), so every reversal of one
target queues behind one lock, and the read therefore sees every reversal that committed anywhere rather
than a state another instance is still about to change. It is a database read, so it adds no network call to
the critical section.

Resolution by provider ids has a consequence worth naming: a submission cannot reach the service's own
`OPENING` credit, which carries the reserved `system` provider id (`tx.opening-internal`). The `OPENING`
target that `rule.rollback.allowed-kinds` refuses is therefore unreachable over both entry points — naming
the wallet id resolves nothing and waits — and the refusal itself is proven where it can be reached, in the
domain decision below.

`WagerTransaction.refuseReference(reference)` is that decision: it takes the resolved transaction and returns
the failure code that refuses it, or `null`. It reads the two instances and nothing else, so every reference
rule but the reversed-once one is a pure function of the pair. The order of its checks is part of the
decision, because each refusal has to be the most specific one available: the kind matrix first, so a target
nothing may reference is refused for what it is rather than for the context it happens to carry — the
`OPENING` credit is the case that shows why; then the context, which includes the currency, so the amounts
are compared only once both are known to be in one currency and `Money.equals` cannot throw; then the
status; then the amount, for the kinds the contract binds to it.

The reversed-once rule is the one rule that is not about the pair, so it stays out of the domain: whether
another reversal exists is a question about rows that may not exist yet. The use case asks
`hasProcessedReversal`, which counts exactly what the partial unique index of ADR 0003 admits —
`(reference_transaction_id)` where the kind is a reversal and the status is `PROCESSED`. The index remains
the invariant: it is what no code path can bypass. It is not, however, what decides the outcome, because a
unique violation aborts the transaction that was about to persist the `REJECTED` row, and the contract
promises a persisted, replayable rejection with `REFERENCE_ALREADY_REVERSED`. Reading the predicate under
the lock produces that outcome; the index is left as the last line of defence it was designed to be.

The direction of the movement is the domain's too. `WagerTransaction.movement(reference)` answers with the
`LedgerOperation` the kind applies, which for a `ROLLBACK` is the inverse of the kind it reverses
(`rule.rollback.inverse`) and for a `LOSS` is nothing at all. A `LOSS` is then answered by
`Wallet.refuseUnmoved`, which applies the refusals that do not depend on a movement — the wrong owner, the
wrong currency — and returns no new wallet and no entry, so "balance, ledger and version are untouched"
holds by construction rather than by assertion, exactly as a refusal does in ADR 0006.

An unresolved or non-terminal target records `PENDING_REFERENCE` with the balance it observed and writes
nothing else, which HTTP answers as `202` with `Location`. The schedule row, the backoff, the sixty-minute
window, the expiry as `REFERENCE_NOT_FOUND` and `WagerTransactionPendingReference` belong to the scheduler
and arrive with it; until then a parked transaction is persisted and auditable but waits for an attempt
nothing triggers.

### Consequences

- Good, because every reversal of one target is serialized by the wallet lock the decision already holds, so
  the reversed-once rule needs no second lock, no advisory lock and no retry loop.
- Good, because the second reversal of a target is the persisted `REJECTED` row the contract promises, rather
  than an aborted transaction mapped to a code after the fact.
- Good, because the whole eligibility matrix is a pure function of two instances: the kind matrix, the
  context, the status and the amount are unit-tested with no database (RULE-020).
- Good, because the partial unique index keeps its meaning as an invariant no path can bypass, including a
  future writer that never calls this use case.
- Neutral, because the reference read sits between the lock and the decision, which lengthens the critical
  section by one indexed lookup and, for a reversal, one indexed count.
- Bad, because the reversed-once rule is stated twice: once as the index predicate in a migration and once as
  the query that reads it. They have to be changed together, and the index test of SCHEMA-015 is what holds
  the pair honest.
- Bad, because a reference that resolves to a transaction of another wallet is refused with
  `REFERENCE_MISMATCH` only after a lock on the submission's own wallet was taken, so a provider aiming at
  the wrong context still costs a lock acquisition.
- Worth revisiting if partial reversals are ever admitted, which would replace the equal-amount rule and the
  reversed-once rule with a remaining-amount ledger the domain cannot compute from one pair of transactions,
  or if a reference is allowed to cross wallets, which would break the serialization the wallet lock provides
  and call for an explicit lock on the target.

### Confirmation

Acceptance entries RULE-003 to RULE-013, RULE-015 to RULE-017, RULE-019, RULE-020, LEDGER-005 and MONEY-013 in
[acceptance.yaml](../acceptance.yaml). The domain decision is proven over two in-memory transactions with no
database; the integration suite applies each kind against PostgreSQL, drives every failure code, races two
`REFUND`s of one `BET` to assert a single credit and one `REFERENCE_ALREADY_REVERSED`, and reconciles every
wallet it touched against its ledger. SCHEMA-015 proves the index behind the reversed-once query.

## Pros and Cons of the Options

### Resolve the reference before the wallet lock and validate every rule in the use case

- Good, because a reference that refuses the submission is answered without ever locking a wallet.
- Bad, because the reversed-once check would then read a state nothing holds: two instances reversing one
  target would both see no reversal, and only the index would stop the second — by aborting the transaction
  that was supposed to persist its rejection.
- Bad, because it displaces the decision from the state it is taken against: the balance under the lock and
  the reference read before it belong to two different moments.
- Bad, because the eligibility rules spread across the use case, where they need a database to be tested.

### Resolve it under the lock, decide eligibility in the domain, and read the reversed-once rule from the index predicate under that same lock

- Good, because the lock the decision already needs is exactly the lock the reversed-once rule needs.
- Good, because the pure rules are in the aggregate and the row question is in a port, each tested where it
  belongs.
- Neutral, because the critical section grows by two indexed statements.
- Bad, because the index predicate is restated as a query that has to stay aligned with it.

### Let the partial unique index decide the reversed-once rule and map its violation to the failure code

- Good, because the rule is stated once, in the schema, and cannot be bypassed.
- Bad, because a unique violation aborts the whole database transaction in PostgreSQL, so the rejection the
  contract requires cannot be written in it; recovering would mean a second transaction, which is a retry
  loop around a financial operation.
- Bad, because the outcome a provider receives would depend on a race rather than on a decision: the same
  second reversal would be a `422` when it lost to a committed row and a `503` when it lost to the index.

## More Information

Rules carried: `rule.win.credit`, `rule.win.optional-reference`, `rule.loss.no-effect`,
`rule.loss.optional-reference`, `rule.refund.credit`, `rule.refund.bet-only`, `rule.rollback.inverse`,
`rule.rollback.allowed-kinds`, `rule.reference.resolution`, `rule.reference.same-context`,
`rule.reference.must-be-processed`, `rule.reference.missing-is-pending`, `rule.reference.equal-amount`,
`rule.reference.reversed-once`, `rule.reversal.insufficient-balance`, `rule.reversal.chain-limits`,
`wallet.balance-limit`, `ledger.direction-by-kind`, `ledger.no-entry-without-effect`,
`failure.distinct-insufficient` in [system-contract.md](../system-contract.md). ADR 0002 owns the lock order
this decision reads under, ADR 0003 owns the index it reads from, ADR 0006 owns the shape of a refusal and
ADR 0007 owns the transitions that record one.
