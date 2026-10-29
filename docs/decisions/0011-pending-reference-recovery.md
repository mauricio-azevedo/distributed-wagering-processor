---
status: accepted
date: 2026-10-29
---

# Recover a parked transaction by claiming one schedule row per attempt

## Context and Problem Statement

Provider systems reorder: a `ROLLBACK` can arrive before the `BET` it reverses. ADR 0009 decided what happens
at that moment — the transaction is persisted as `PENDING_REFERENCE` with the balance it observed, answered
`202`, and nothing else is written (`rule.reference.missing-is-pending`, `ref.parked-state`). What it left open
is the recovery: a parked transaction has to be attempted again until its reference resolves, be applied under
exactly the rules a first arrival would have faced (`ref.resolution-on-arrival`), be rejected with
`REFERENCE_NOT_FOUND` when the sixty-minute window closes (`ref.ttl`, `ref.expiry`), and reach one of those
outcomes while several workers sweep the same backlog and any of them may die mid-attempt (`ref.scheduler`).

The questions this decides: how a worker claims work exclusively, what one database transaction covers, where
the expiry decision is taken, and which failures are allowed to make a transaction terminal
(`ref.transient-failure`, `ref.permanent-failure`, `tx.failed-semantics`).

## Decision Drivers

- A reversal applied twice is money lost, so a claim has to be exclusive across instances and not per process.
- A worker that dies must cost nothing: no lease to expire, no row left owned by a process that is gone.
- The reprocessing must be the same financial step a submission takes, or the rules would exist twice.
- `FAILED` is the one outcome a provider cannot act on, so it must never be reached by mistake.
- The waiting window belongs to the reference, not to the service's own health: an outage must not end a wait.
- The runtime role has no `DELETE` on any table (ADR 0003), so nothing can be removed from a claim list.

## Considered Options

- One transaction claiming a batch of due rows and reprocessing all of them
- One transaction per claimed row, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`
- Reprocessing triggered by the arrival of the referenced transaction instead of by a schedule

## Decision Outcome

Chosen option: "One transaction per claimed row, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`", because the
claim is then the same lock the financial transaction already needs, PostgreSQL releases it when a worker dies,
and one parked transaction's outcome cannot be rolled back by another's failure.

`ReprocessPendingReference.execute` is one sweep. It claims the oldest due transaction, attempts it, commits,
and claims the next, up to a bounded number of claims per sweep; `pending_reference_schedule` carries
`attempts`, `next_attempt_at` and `expires_at`, and the claim is

```sql
select ... from "pending_reference_schedule" as "s"
  join "wager_transactions" as "t" on "t"."id" = "s"."transaction_id"
 where "s"."next_attempt_at" <= ? and "t"."status" = 'PENDING_REFERENCE'
 order by "s"."next_attempt_at" limit 1 for update of "s" skip locked
```

`SKIP LOCKED` is what makes several workers disjoint without any of them waiting, and the locking clause names
the schedule row alone: the transaction row is read here and locked, if at all, by the operation itself. The
join is what retires a row — no role may delete one — so what takes a transaction out of the claim list is
reaching a terminal outcome, read from the transaction row in the same statement that takes the lock. The
schedule row then stays as the audit of how many attempts that transaction took.

Inside the claim the attempt is an ordinary financial operation in the order ADR 0002 fixes: the wallet is
locked with `SELECT ... FOR NO KEY UPDATE`, and the decision and its rows are `ApplyWagerOperation`, the step
extracted from `SubmitWagerTransaction` so that both entry points record outcomes through one code path. A
reference that resolves is therefore applied under every rule of ADR 0009, including the reversed-once check,
and a reference rule that refuses it produces the same `REJECTED` row it would have produced on arrival.

What an attempt that cannot resolve the reference does is this use case's own decision:

- The window is open: `PENDING_REFERENCE` is recorded again against the balance now observed, the attempt is
  counted and the next one is scheduled at `min(1s × 2^attempts, 5m)` from this attempt (`ref.backoff`). No
  event is emitted; the arrival that parked the transaction already announced the wait
  (`event.pending-reference-when`).
- The window has closed: the transaction is `REJECTED` with `REFERENCE_NOT_FOUND` and the rejection is
  announced (`ref.expiry`).

The expiry is consulted only after an attempt that ran and found nothing, which settles a case the contract
leaves open: a reference that did arrive is applied even by an attempt that runs after the window closed,
because `ref.expiry` is a decision about a missing reference and nothing is missing. The window is still an
upper bound on waiting — the first attempt after it closes ends the transaction either way.

Failures are classified rather than retried blindly. The unit of work already turns every database failure a
retry can clear into `ServiceUnavailableError` (`api.transient-failure`), so the classification the scheduler
needs is in the application layer: a transient failure changes nothing on the transaction and only reschedules
the attempt, in a transaction of its own since the attempt's own has rolled back; a permanent one — any other
`ApplicationError`, such as the unknown wallet `msg.classification` names, or a `DomainError`, which means
stored state the domain cannot rebuild — marks the transaction `FAILED` with `PROCESSING_FAILED`, logged at
error level and emitting nothing. Anything else counts as transient. The window is never consulted on a failure
and never extended, so an outage spends the time a reference had left instead of ending the wait on the wrong
reason.

The periodic driver is not part of this decision: the `worker` role sweeps on a timer through
`PendingReferenceScheduler` (ADR 0013), which also decides what a shutdown does with the attempt in flight.
What this decision owns is the sweep itself, which any driver — a role, a test, an operator's script — can run
on any instance; `execute` takes the predicate a driver stops claiming with and nothing else.

### Consequences

- Good, because the claim needs no lease, no ownership token and no reaper: a worker killed mid-attempt
  releases its claim with its connection and the attempt rolls back, so the row is due again, unchanged, and
  the backlog is drained by whoever sweeps next (REF-002).
- Good, because one transaction per row keeps the attempts independent: a failure, a lock wait or a crash on
  one parked transaction cannot roll back another's outcome, and one wallet lock is never held while another
  wallet's operation runs.
- Good, because reprocessing is the same step a submission takes, so the reference rules, the ledger entry, the
  observed balance and the events exist once and cannot drift between the two entry points.
- Good, because the claim list is retired by the transaction status rather than by a delete, which keeps the
  append-only privileges of ADR 0003 intact and leaves the attempt count of every recovered transaction
  readable afterwards.
- Neutral, because a parked transaction is recovered by polling and not by the arrival of its reference, so the
  latency after the arrival is one backoff step, at most five minutes (`ref.backoff`).
- Neutral, because a sweep claims one row at a time, which costs one extra round trip per transaction compared
  with a batch; the backlog this drains is bounded by how often references arrive out of order.
- Bad, because an attempt that fails transiently is rescheduled by a second transaction, which can lose a race
  with another worker that claimed the row meanwhile: both would count an attempt on it. That costs at most one
  backoff step of precision, because the counter spaces attempts and decides no outcome.
- Bad, because a permanently broken dependency that nothing classifies keeps a transaction pending until its
  window closes instead of failing it. That is the deliberate trade of `ref.permanent-failure`: the provider
  then receives `REFERENCE_NOT_FOUND`, which it can act on, rather than a `PROCESSING_FAILED` it cannot, and
  `FAILED` stays reachable only from a failure the service positively recognises.
- Worth revisiting if the latency after an arrival has to be shorter than a backoff step, which would call for
  the arrival to wake its waiters — a notification, or a claim query keyed on the reference — or if references
  are ever allowed to cross wallets, which would break the serialization the wallet lock provides and make a
  sweep of one wallet's parked transactions no longer independent of another's.

### Confirmation

Acceptance entries RULE-014, REF-001 to REF-006, TX-009, API-005 and OUTBOX-011 in
[acceptance.yaml](../acceptance.yaml). The backoff and the window are proven over the domain object with no
database; the integration suite parks a `ROLLBACK` delivered before its `BET` and applies it on the attempt
after the `BET`, expires one with a clock past the window, injects a transient and a permanent failure to
separate a reschedule from `FAILED`, holds a claim in a worker of its own to show another worker skipping it and
recovering it after that worker is killed, drains one backlog with three worker processes, and reconciles every
wallet it touched against its ledger (RECON-004).

## Pros and Cons of the Options

### One transaction claiming a batch of due rows and reprocessing all of them

- Good, because one claim statement serves many transactions, so the sweep costs fewer round trips.
- Bad, because the attempts are then coupled: a transient failure on the last row rolls back the outcomes of
  every row before it, and a permanent failure would have to be recorded outside the transaction that failed.
- Bad, because the batch holds a wallet lock for every wallet it touched until the whole batch commits, so one
  slow operation delays unrelated wallets and widens every lock window in the batch.

### One transaction per claimed row, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`

- Good, because the claim is a lock PostgreSQL releases on disconnect, so crash recovery needs no code.
- Good, because an attempt is exactly one financial operation, with the lock order and the atomicity the rest
  of the service already has.
- Neutral, because draining a backlog costs one claim per transaction.

### Reprocessing triggered by the arrival of the referenced transaction instead of by a schedule

- Good, because a parked transaction would resolve as soon as its reference committed, with no polling latency.
- Bad, because the arrival would have to apply another transaction inside its own financial transaction, which
  makes one provider's request do another's work and couples two outcomes that have to be independently
  replayable.
- Bad, because it leaves the expiry unsolved: a reference that never arrives triggers nothing, so a schedule
  would still be needed for the window to close.

## More Information

Rules carried: `ref.parked-state`, `ref.scheduler`, `ref.backoff`, `ref.ttl`, `ref.expiry`,
`ref.resolution-on-arrival`, `ref.transient-failure`, `ref.permanent-failure`,
`rule.reference.missing-is-pending`, `tx.failed-semantics`, `api.location-on-pending`,
`event.pending-reference-when`, `idem.replay-follows-persisted-outcome` in
[system-contract.md](../system-contract.md). ADR 0002 owns the lock order an attempt takes, ADR 0003 owns the
privileges that leave the claim list append-only, ADR 0005 claims the outbox with the same statement for the
same reasons, ADR 0007 owns the transitions an attempt records, ADR 0009 owns the reference rules it applies
and ADR 0010 owns the delivery identity of the queue entry point a parked submission can arrive through.
