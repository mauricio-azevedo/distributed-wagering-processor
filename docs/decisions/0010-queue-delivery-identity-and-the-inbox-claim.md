---
status: accepted
date: 2026-10-29
---

# Claim the inbox row inside the financial transaction, hash the message data, reach the use case through one shared body

## Context and Problem Statement

The queue is the second entry point, and it adds one thing the HTTP entry point does not have: a delivery
identity. SQS delivers at least once, so the same body arrives again after a visibility timeout, after a
producer resend, and after a crash between the commit of the effect and the deletion of the message. The
inbox is what makes those arrivals harmless, and it only works if the row that records a delivery commits
with the effect it recorded: a row written in a transaction of its own would be either a promise the effect
never kept or an effect no row remembers.

Three questions shape the design. Where the inbox row is written, and therefore when a duplicate is decided.
What the hash stored beside it covers, since `msg.inbox-payload-conflict` compares a reused `messageId`
against "a different payload hash" and a message carries more than the operation. And how the consumer
reaches `SubmitWagerTransaction` without the inbox turning into a second implementation of the financial
path, which `msg.same-use-case` forbids.

## Decision Drivers

- The inbox row and the financial effect commit together or not at all (`outbox.single-transaction`).
- A redelivery is absorbed with no second effect, across instances and across restarts.
- A reused `messageId` with other content is a permanent error and leaves the original effects untouched.
- No business rule lives in only one entry point.
- No look-then-write a second delivery could pass at the same time.

## Considered Options

- Delivery record: a lookup before the transaction, a claim as the first statement inside it, or an inbox
  transaction of its own followed by the financial one
- Delivery hash: the whole envelope, the message's `data`, or the operation payload hash the transaction row
  already stores
- Reaching the use case: a second use case for the queue, a decorator around the HTTP one, or a second
  method on the one use case over a shared transactional body

## Decision Outcome

Chosen options: "a claim as the first statement inside the transaction", "the message's `data`", and "a
second method over a shared transactional body", because together they put delivery identity in the
database, decide a conflict by what would change the effect, and leave exactly one financial path.

- `InboxRepository.claim` inserts the row with `ON CONFLICT DO NOTHING` and reads the stored row back when it
  loses, the same shape the idempotency reservation uses (ADR 0004). It is the first statement of the
  transaction, before the reservation (`conc.lock-order`): the delivery is decided before the operation's
  own identity is claimed, so a reused `messageId` is reported as an inbox conflict and not as the
  idempotency conflict the changed payload would also raise. Two deliveries of one message id can both be
  in flight; the second waits on the primary key, reads what the first committed and absorbs.
- A delivery that loses the claim with an equal hash is absorbed: the lost claim wrote no row, so the
  transaction has nothing to commit, and the message is deleted (`msg.redelivery-safe`). With a different
  hash the transaction rejects with a permanent failure, and that rollback is what leaves the first
  delivery's effects untouched.
- The row is completed in the same transaction, after the outbox rows (`conc.lock-order`), so a committed
  inbox row always carries a `processed_at`: an uncompleted one can exist only inside a transaction that
  never committed. The message is deleted after the commit returns (`msg.ack-after-commit`).
- The stored hash is `sha256:` plus the hex SHA-256 of the RFC 8785 canonical JSON of `data`, the operation
  fields plus `idempotencyKey`. The envelope stamps stay out, so a resend that re-stamps `occurredAt` or
  `correlationId` is a redelivery and not a conflict.
- `SubmitWagerTransaction.deliver` opens the transaction, claims the row, runs the same private body
  `execute` runs, and completes the row. The financial rules therefore exist once as code, not once per
  entry point, and the only thing the queue adds is the inbox.

### Consequences

- Good, because a crash anywhere before the commit leaves nothing, and a crash between the commit and the
  delete leaves a redelivery the claim absorbs; both are the same code path.
- Good, because the inbox deduplicates delivery identity and the reservation deduplicates operation
  identity, so the same operation delivered under two message ids is still applied once, and one message id
  carrying two operations is refused.
- Good, because the queue cannot drift from HTTP: a rule added to the shared body reaches both, and a
  reviewer sees one financial path.
- Bad, because the inbox hash is a second hash over nearly the same bytes as the transaction's
  `payload_hash`; the two answer different questions and a reader has to know which is which.
- Bad, because the use case now has two public entry points, and `deliver` is the only one whose result can
  be "nothing happened"; a caller that passes a delivery has one more case to handle.
- Worth revisiting if a second consumer of the input queue appears, which would make `consumerName` a
  configuration rather than a constant, or if a delivery has to be recorded before its effect is decided —
  a metrics-only inbox, say — which the single transaction cannot express.

### Confirmation

Acceptance entries MSG-004, MSG-005, MSG-006 and IDEM-010 in [acceptance.yaml](../acceptance.yaml):
integration tests against LocalStack and PostgreSQL for the redelivery, the reused message id and the same
operation through both entry points, and a test that kills a worker process after the commit and before the
acknowledgement and asserts that the redelivery changes nothing. Unit tests hold the claim to its place in
the statement order.

## Pros and Cons of the Options

### Delivery record: a lookup before the transaction

- Good, because a redelivery is answered without opening a transaction at all.
- Bad, because two deliveries of one message id both read "absent" and both proceed; the effect is still
  applied once, by the reservation, but the inbox would then promise something it does not enforce.

### Delivery record: a claim as the first statement inside the transaction

- Good, because the primary key decides, for every instance at once, and the row commits with the effect.
- Neutral, because an absorbed redelivery costs one insert that writes nothing and one read.

### Delivery record: an inbox transaction of its own

- Good, because the consumer could record the receipt even when the effect fails.
- Bad, because the two transactions can disagree: a crash between them leaves a delivery marked processed
  with no effect, which no redelivery can repair.

### Delivery hash: the whole envelope

- Good, because nothing in the message can change unnoticed.
- Bad, because a resend that re-stamps `occurredAt` would be reported as a conflict, and
  `msg.inbox-identity` asks for a resend to be absorbed.

### Delivery hash: the message's `data`

- Good, because it covers everything that changes the effect, the idempotency key included, and nothing that
  does not.
- Neutral, because it is a second hash beside the operation payload hash.

### Delivery hash: the operation payload hash

- Good, because no new hash, and the transaction row already stores it.
- Bad, because `idempotencyKey` is outside it by construction (`idem.payload-hash`), so one message id
  resent with another key would be absorbed silently instead of refused.

### Reaching the use case: a second use case for the queue

- Good, because the inbox stays out of the HTTP path's types.
- Bad, because the financial rules would exist twice, which is exactly what `msg.same-use-case` forbids.

### Reaching the use case: a decorator around the HTTP one

- Good, because the submission code is untouched.
- Bad, because the inbox row would have to be written in a transaction the decorator does not hold; the
  `UnitOfWork` boundary belongs to the use case that opens it.

### Reaching the use case: a second method over a shared transactional body

- Good, because one body runs both entry points and the difference between them is visible in one place.
- Neutral, because the use case exposes two methods, and only the queue's can report an absorbed delivery.

## More Information

Rules carried: `msg.inbox-identity`, `msg.inbox-payload-conflict`, `msg.redelivery-safe`,
`msg.ack-after-commit`, `msg.same-use-case`, `msg.correlation`, `idem.cross-entry-point`,
`outbox.single-transaction`, `conc.lock-order` in [system-contract.md](../system-contract.md). ADR 0004
settles operation identity, which the inbox deliberately does not duplicate; the delivery semantics of the
input queue are stated in [asyncapi.yaml](../asyncapi.yaml).
