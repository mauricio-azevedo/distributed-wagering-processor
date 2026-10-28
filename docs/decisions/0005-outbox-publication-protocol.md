---
status: accepted
date: 2026-10-28
---

# Claim outbox rows with FOR UPDATE SKIP LOCKED inside one publisher transaction

## Context and Problem Statement

Integration events are written to an outbox table in the same transaction as the financial change, so nothing is
published before commit and nothing committed is lost. A publisher then relays rows to the broker. Several
publisher instances run at once, any of them may die at any point, and the broker may be unavailable for a
while. Every row must be published at least once, a dead publisher's work must be taken over without a human,
and duplicates must stay bounded and harmless. Consumers deduplicate by `eventId`, fixed when the row is written.
How do publishers claim rows, recover from crashes and retry?

## Decision Drivers

- At-least-once publication with no lost row.
- Automatic recovery from a publisher crash at any point.
- Correctness with several concurrent publishers.
- A bounded, harmless duplicate window.
- As little protocol state as possible to tune and to get wrong.

## Considered Options

- Lease columns with an ownership token and expiry
- `FOR UPDATE SKIP LOCKED` held through a bounded publish attempt

## Decision Outcome

Chosen option: "`FOR UPDATE SKIP LOCKED` held through a bounded publish attempt", because the lock is the claim
and PostgreSQL releases it when a publisher dies, so recovery needs no code, no lease duration and no reaper.

The publisher opens a transaction, claims a batch of at most 50 pending rows ordered by `occurred_at, id` with
`SELECT ... FOR UPDATE SKIP LOCKED`, publishes each row with a five-second timeout, sets `published_at` on the
successes, and commits. A failed publish increments `attempts` and sets `next_attempt_at` to
`now + min(2^attempts seconds, 5 minutes)`; the row stays pending and is skipped until due. Rows are never deleted
or marked dead: after ten attempts `wager_outbox_pending` and `wager_outbox_lag_seconds` make the backlog visible
and an alert condition fires while retries continue. The queue's `MessageDeduplicationId` is set to the event id
as an additional best-effort filter.

### Consequences

- Good, because concurrent publishers receive disjoint batches by construction.
- Good, because duplicates arise only in the gap between a successful publish and the commit that records
  it; each crash in that gap adds one more publication of the same row with the same `eventId`, so the number
  of copies is bounded by the number of crashes, and consumers deduplicate.
- Good, because there is no lease to tune, no reaper and no ownership token to check on every write.
- Bad, because one database connection per publisher is held during network I/O to the broker; small batches and
  the timeout bound it, and the publisher pool is sized accordingly.
- Bad, because per-aggregate ordering is not guaranteed across publishers: two publishers can hold consecutive
  events of one wallet and publish them in either order. Events carry `walletVersion` and `occurredAt` so
  consumers can order them; the FIFO message group per wallet is best effort.
- Bad, because a broker outage leaves rows pending and connections cycling through timeouts; backoff keeps the
  load low and readiness reports the broker as down.
- Worth revisiting if a consumer requires strict per-wallet ordering (claim all pending rows of an aggregate
  together, or one publisher per partition), if broker latency makes holding a connection through the batch a
  measured constraint (when leases pay for their complexity), or if the outbox must be shared with a second
  service or moved to change-data-capture.

### Confirmation

Acceptance entries OUTBOX-001 to OUTBOX-009, OUTBOX-012 and SCHEMA-019 in
[acceptance.yaml](../acceptance.yaml): two publishers draining one outbox, a publisher killed after sending and
before committing, a broker outage with backoff, the pending and lag metrics, and the schema test on the outbox
identity and claim index.

## Pros and Cons of the Options

### Lease columns with an ownership token and expiry

The publisher claims rows by setting `claimed_by` and `lease_until` in a short transaction, publishes outside any
transaction, then marks them published in another short transaction; expired leases become claimable again.

- Good, because database transactions stay tiny and no connection is held during network I/O.
- Bad, because a lease duration must be tuned: too short and two publishers publish the same row, too long and
  recovery waits.
- Bad, because expired leases need a reaper, and every write needs an ownership check so a zombie publisher does
  not overwrite its successor's state.

### `FOR UPDATE SKIP LOCKED` held through a bounded publish attempt

- Good, because crash recovery is automatic: locks vanish with the connection.
- Good, because the protocol has no state beyond the rows themselves.
- Neutral, because batch size and publish timeout must be chosen; both are configuration, not correctness.
- Bad, because a connection is held during the publish calls.

## More Information

Rules carried: `outbox.single-transaction`, `outbox.publish-after-commit`, `outbox.concurrent-publishers`,
`outbox.stable-event-id`, `outbox.crash-recovery`, `outbox.duplicate-safe`, `outbox.retry-backoff`,
`outbox.lag-metrics`, `outbox.destination`, `event.ordering` in [system-contract.md](../system-contract.md). The
failure-window table in [ARCHITECTURE.md](../../ARCHITECTURE.md) traces each crash point to its evidence.
