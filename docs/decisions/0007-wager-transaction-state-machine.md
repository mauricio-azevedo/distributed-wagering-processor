---
status: accepted
date: 2026-10-28
---

# Record a transaction outcome by transition in place, guarded by a table

## Context and Problem Statement

A `wager_transactions` row is the audit log of what a provider submitted and the carrier of the outcome every
replay returns (`tx.read-shape`, `idem.replay-follows-persisted-outcome`). Its status machine decides what can
still be written: while the transaction is not terminal, an outcome writes `status`, `processedAt`,
`failureCode`, `observedBalance` and `referenceTransactionId`; once it is `PROCESSED`, `REJECTED` or `FAILED`,
nothing writes anything again (`tx.transitions`, `tx.terminal-immutable`, `tx.row-append-only`). ADR 0006
decided the opposite shape one aggregate over: `Wallet` operations return a new instance and report a
provider's refusal as a value. How does a transaction record an outcome, and what does a transition on a
closed one do?

## Decision Drivers

- A terminal outcome is final: a second debit or a second reversal is exactly what a re-opened row allows
  (`tx.terminal-immutable`).
- The same outcome has to be reachable by the HTTP use case, the queue consumer and the scheduler, which
  reprocess the same row after a reference arrives (`ref.resolution-on-arrival`).
- The row is written as an `UPDATE` of the five mutable columns, inside the financial transaction that also
  moved the balance; the wallet's own write is the version-guarded `UPDATE` of ADR 0002.
- A provider resending a closed operation is a replay answered from the stored outcome (`idem.replay-same-outcome`),
  so no provider input can reach a transition on a terminal transaction.
- Unit-testable with no database and no clock, as the status machine is the first place the rules hold.

## Considered Options

- Named transitions that change the instance, refusing a terminal one with an exception
- Named transitions that return a new instance, as `Wallet` does (ADR 0006)
- A single `applyOutcome(status, …)` driven by a transition table, with no named methods

## Decision Outcome

Chosen option: "Named transitions that change the instance, refusing a terminal one with an exception",
because the transaction is one row with one outcome rather than two artifacts that must be produced together,
and a transition on a terminal row is a defect with nothing for a caller to branch on.

`markProcessed`, `markPendingReference`, `reject` and `fail` are the only mutators. Each one hands a complete
outcome to one private writer, which checks every precondition before writing anything: the transition table,
then the two reference rules. A refused transition therefore leaves status, failure code, processed time,
observed balance and resolved reference exactly as they stood, which is what makes `tx.terminal-immutable`
true by construction and not by inspection.

The table is the single definition of two rules. `tx.transitions` is its rows; `tx.terminal-immutable` is the
rows with no exit, which `isTerminal()` reads, so the statuses the contract calls terminal cannot drift from
the transitions that exist. `PENDING` appears only as a source: the downgrade that would re-open a recorded
outcome is unreachable here and refused by the trigger of ADR 0003 whatever else issues it.

Immutability is kept where the contract freezes state, structurally. Identity, context, kind, amount and the
submitted reference are `readonly` fields, the half of `tx.row-append-only` that never changes after
insertion. The five columns an outcome writes are `#`-private with read-only accessors, so they have no
writable property at all: no caller can set a status without a transition, and the refusal is a `TypeError`
at runtime as well as a type error. The class exposes nothing else, so a new mutator is a visible change to
its surface.

A transition on a terminal transaction throws `InvalidTransactionStateError`, keeping the split ADR 0006 drew:
what a payload can provoke is a value, what only a defect can provoke is thrown. `PROCESSING_FAILED` belongs
to `fail` alone, so `reject` takes `RejectionCode`, the failure codes minus that one, and `fail` takes no code
at all; "each code is reachable only from the transition that owns it" is then checked by the compiler rather
than by review.

### Consequences

- Good, because one object matches one row: the use case loads a transaction, records an outcome and the
  financial transaction writes the five columns that changed.
- Good, because the guard lives in the single writer, so a transition added later cannot forget it.
- Good, because the whole machine is proven by unit tests over every (status, transition) pair, with no
  database, clock or port, before the trigger that re-enforces it exists.
- Neutral, because the shape differs from `Wallet`: this aggregate is a row with a status, that one is a
  balance that must be produced together with its ledger entry.
- Bad, because the instance is not frozen: a defect inside the domain could reach `#record` on a path that
  skips a rule the private writer does not know about. The trigger of ADR 0003 refuses the same write in the
  database, which is the backstop the contract already requires.
- Bad, because a caller that kept a reference to a transaction sees it change under them; the use case treats
  the transaction as the row it is about to write, not as a value to pass around.
- Worth revisiting if a transition has to produce a second artifact atomically with the outcome, such as the
  integration event that accompanies it, in which case returning an outcome object as `Wallet` does would keep
  the two inseparable.

### Confirmation

Acceptance entries TX-003, TX-005, TX-006, TX-008 and MODEL-003 in [acceptance.yaml](../acceptance.yaml): the
unit suite walks every (status, transition) pair, asserting that the allowed ones record their status and that
every other throws `InvalidTransactionStateError` and leaves the status where it was; attempts each transition
on each terminal status and asserts status, failure code, processed time and observed balance are unchanged;
covers every reference-requirement combination per kind; and asserts that the class exposes no setter and no
mutator beyond the four transitions. SCHEMA-007 and SCHEMA-024 repeat the terminal guarantee against the
database once the schema exists.

## Pros and Cons of the Options

### Named transitions that change the instance, refusing a terminal one with an exception

- Good, because one object is one row, and the outcome the use case records is the `UPDATE` the transaction
  writes.
- Good, because the terminal guard sits in the single writer and is unavoidable for every transition.
- Neutral, because the instance is mutable where `Wallet` is not; the five writable columns are exactly the
  five `tx.row-append-only` allows, and nothing else on the class can be written.
- Bad, because a frozen object would refuse even a defect inside the domain, and this one cannot.

### Named transitions that return a new instance, as `Wallet` does (ADR 0006)

- Good, because it is uniform with the other aggregate and every instance stays frozen.
- Bad, because there is no second artifact to keep inseparable from the outcome, which is the reason ADR 0006
  returns a new wallet; the copy buys immutability and nothing else.
- Bad, because the use case would thread a new instance through the reference-resolution path and the
  scheduler, where the row it must write is the one it loaded; two objects for one row invite writing the
  stale one.

### A single `applyOutcome(status, …)` driven by a transition table, with no named methods

- Good, because the table is consulted in exactly one place, which the chosen option also achieves with its
  private writer.
- Bad, because the caller names a status instead of an intent, so the outcome fields that belong together are
  assembled at the call site: a rejection without its failure code, or a processed outcome without its
  processed time, becomes a runtime check instead of a signature.
- Bad, because `PROCESSING_FAILED` could then be passed to any outcome, and the contract's "one code per
  transition" would be review, not types.

## More Information

Rules carried: `tx.born-pending`, `tx.reference-matrix`, `tx.transitions`, `tx.terminal-immutable`,
`tx.row-append-only`, `tx.observed-balance`, `tx.affects-balance`, `tx.failed-semantics`,
`model.explicit-transitions`, `model.private-constructors`, `model.rehydrate-no-revalidation`,
`failure.stable-codes` in [system-contract.md](../system-contract.md). ADR 0006 decided the opposite shape for
`Wallet` and draws the same line between a refusal and a defect; ADR 0003 re-enforces terminality in the
database; ADR 0004 replays the frozen outcome; ADR 0002 writes the balance the outcome observed.
