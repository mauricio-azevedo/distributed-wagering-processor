---
status: accepted
date: 2026-10-28
---

# Scope idempotency keys per provider, bind provider transaction ids, rebuild replays from persisted facts

## Context and Problem Statement

Providers deliver at least once: the same operation arrives again after a timeout, through a different channel,
or fifty times in parallel. The service must apply it once, answer every repetition with the original outcome
including the balance observed at the time, and refuse a key reused with different content. Deduplication must
survive restarts and be correct across instances, so process memory cannot decide. HTTP and the queue must share
one identity model. Three questions shape the design: the scope of a key, what happens when a provider's own
transaction id reappears under another key, and how the original outcome is reproduced.

## Decision Drivers

- Exactly one application of an operation, under duplicates, parallelism, restarts and multiple instances.
- Replays that reproduce the original outcome, including the observed balance.
- Isolation between providers.
- One identity model for both entry points.
- No second copy of state that can drift.

## Considered Options

- Key scope: global keys, or keys scoped per provider
- Provider transaction id reuse: allowed under several keys, or bound to the first key
- Replay source: a stored response snapshot, or persisted facts plus an observed-balance column

## Decision Outcome

Chosen options: "keys scoped per provider", "provider transaction id bound to the first key", "persisted facts
plus an observed-balance column", because together they keep one row per provider transaction, isolate
providers from each other's key choices, and reproduce outcomes from the same row the rest of the system reads.

- `UNIQUE (provider_id, idempotency_key)`: two providers may use the same string.
- `UNIQUE (provider_id, external_transaction_id)`: a second key for an existing provider transaction is a
  `409 EXTERNAL_TRANSACTION_ALREADY_BOUND`.
- `payloadHash` is `sha256:` plus the hex SHA-256 of the RFC 8785 canonical JSON of the validated business
  fields, `referenceExternalTransactionId` omitted when absent; transport metadata never enters it. Same key
  with another hash is a `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Reservation first: the transaction row is inserted before the wallet lock is taken
  (`INSERT ... ON CONFLICT DO NOTHING`). A concurrent duplicate waits on the unique index until the first
  request commits, then reads the committed row and replays without touching the wallet. The wallet lock that
  follows is `FOR NO KEY UPDATE` (ADR 0002): the reservation's foreign key holds `KEY SHARE` on the wallet row,
  which `FOR UPDATE` would deadlock against.
- Replay from facts: the outcome is rebuilt from the row's `status`, `failure_code` and `observed_balance`
  with `idempotentReplay: true`; the persisted status decides the HTTP code, so a pending transaction replays as
  `202` until terminal and a terminal one replays frozen.
- The inbox stays a separate layer: it deduplicates message identity `(consumerName, messageId)`; idempotency
  deduplicates operation identity.

### Consequences

- Good, because fifty parallel copies of one bet produce one debit with no coordination beyond the unique index.
- Good, because the lookup endpoint and reference resolution always find one row per provider transaction.
- Good, because there is no response cache to keep in sync with the transaction row or with response shape
  changes.
- Bad, because `observed_balance` is one more column kept consistent with the ledger; the integration tests
  assert it equals the entry's `balance_after` for processed transactions.
- Bad, because providers cannot amend a payload under the same key, even to fix a typo; they need a new key and a
  new external transaction id.
- Bad, because the canonical JSON implementation must be exact and tested against fixed vectors; a divergence
  between instances would turn replays into conflicts.
- Worth revisiting if providers need to amend submitted operations (an explicit amendment operation rather
  than key reuse), or if keys must expire, which needs a retention policy that keeps terminal outcomes
  queryable for as long as providers may replay.

### Confirmation

Acceptance entries IDEM-001 to IDEM-011, SCHEMA-004, SCHEMA-005, TX-007 and MSG-004 in
[acceptance.yaml](../acceptance.yaml): unit tests on the hash against fixed vectors, integration tests on
replay, conflict and binding, a restart test, and schema tests on both unique constraints.

## Pros and Cons of the Options

### Key scope: global keys

- Good, because one index and one lookup.
- Bad, because one provider's key choice can collide with another's, and a misbehaving provider can block keys
  others would naturally use.

### Key scope: keys scoped per provider

- Good, because providers are isolated and the recommended key `{providerId}:{externalTransactionId}` stays
  natural.
- Neutral, because the composite index is slightly larger.

### Provider transaction id reuse: allowed under several keys

- Good, because nothing extra to check.
- Bad, because a provider transaction becomes ambiguous for reference resolution and for the lookup endpoint.

### Provider transaction id reuse: bound to the first key

- Good, because exactly one row per provider transaction, and integration bugs surface immediately as `409`.
- Bad, because a provider that legitimately rotates keys for one transaction is refused; the contract says not
  to.

### Replay source: stored response snapshot

- Good, because the response is reproduced byte for byte.
- Bad, because it duplicates state that exists in the transaction row, drifts when the response shape evolves,
  and says nothing to the queue entry point.

### Replay source: persisted facts plus an observed-balance column

- Good, because one source of truth serves HTTP, queue and the read endpoints.
- Neutral, because one additional fact, the balance observed when the outcome was recorded, must be stored.

## More Information

Rules carried: `idem.key-required`, `idem.provider-scoped`, `idem.payload-hash`, `idem.replay-same-outcome`,
`idem.replay-follows-persisted-outcome`, `idem.payload-mismatch-conflict`, `idem.external-id-bound`,
`idem.persistent`, `tx.observed-balance` in [system-contract.md](../system-contract.md). ADR 0002 relies on the
reservation-first step for its lock order.
