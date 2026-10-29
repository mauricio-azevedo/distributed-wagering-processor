# Architecture

Financial changes commit atomically in PostgreSQL. HTTP and SQS share the same use cases; workers recover from persisted state.

The [README](README.md) covers setup, operations, and examples. The [technical reference](docs/architecture-reference.md) preserves the full design, constraint catalogue, operational details, and test evidence.

## Contents

- [Boundaries](#boundaries)
- [Money and persistence](#money-and-persistence)
- [Financial transaction and concurrency](#financial-transaction-and-concurrency)
- [Persistent idempotency](#persistent-idempotency)
- [Database guarantees](#database-guarantees)
- [Failure recovery](#failure-recovery)
- [Scope and trade-offs](#scope-and-trade-offs)
- [Verification](#verification)

---

## Boundaries

Dependencies point inward: **infrastructure → application → domain**.

| Layer          | Responsibility                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Domain         | Money, financial invariants, operation eligibility, and explicit state transitions. No framework, ORM, transport, or clock dependencies. |
| Application    | Use cases and ports. Commands and results are plain types. `UnitOfWork` supplies transaction-bound repositories.                         |
| Infrastructure | NestJS, MikroORM, HTTP, SQS, scheduling, and operational adapters.                                                                       |

Both transports call `SubmitWagerTransaction`. Submission and pending-reference recovery share `ApplyWagerOperation`, keeping financial decisions on one path.

OpenAPI and AsyncAPI define transport shapes. Shared adapter validation implements them; the domain owns business rules. Change contracts before code.

## Money and persistence

| Boundary                   | Representation                                 | Reason                                          |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Domain                     | Immutable `Money`, using `bigint` minor units. | Exact arithmetic without floating-point errors. |
| PostgreSQL                 | `NUMERIC(20,2)` plus currency.                 | Exact storage with database-enforced ranges.    |
| Transport and ORM boundary | Fixed two-decimal strings.                     | Preserve values through JSON and persistence.   |

Inputs, arithmetic, and storage share one bound: `999999999999999999.99`. Invalid precision is rejected; there is no rounding path. Credits beyond the bound return `BALANCE_LIMIT_EXCEEDED`.

MikroORM provides transaction and entity-manager boundaries. Separate `EntitySchema` row classes and mappers preserve the domain's frozen objects and private transitions. A custom `MoneyType` keeps decimal strings exact; `Money.from` reconstructs them with their currency.

Each unit of work forks an `EntityManager`. Repositories write immediately, preserving statement order. Handwritten migrations are versioned and reversible.

Details: [money](docs/decisions/0001-money-representation-and-persistence.md), [mapping](docs/decisions/0008-persistence-model-for-the-domain-mapping.md).

---

## Financial transaction and concurrency

The wallet is the concurrency boundary. One SQL transaction:

1. Claims the inbox identity for queue deliveries, then reserves the transaction's provider key and external ID.
2. Locks the wallet with `SELECT ... FOR NO KEY UPDATE`.
3. Resolves references and evaluates the operation under that lock.
4. Writes the outcome, version-guarded balance, ledger entry, outbox events, and inbox completion; then commits.

The reservation's foreign key holds `KEY SHARE`. `FOR NO KEY UPDATE` permits that lock while serializing wallet changes. `FOR UPDATE`, including MikroORM's pessimistic write mode, can deadlock against it.

The version guard also refuses stale updates. Different wallets retain independent locks. Replays leave before the wallet lock, avoiding contention from duplicate submissions.

`LOCK_TIMEOUT_MS` bounds lock waits. No broker call occurs inside the financial transaction. Domain refusals return failure codes and no wallet movement; the application persists the rejection without changing balance, version, or ledger.

Decision: [wallet concurrency](docs/decisions/0002-wallet-concurrency-strategy.md).

## Persistent idempotency

Operation identity and delivery identity solve separate problems:

| Identity  | Persistent guarantee                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Operation | Unique `(provider_id, idempotency_key)` and `(provider_id, external_transaction_id)`. The external ID stays bound to its first key. |
| Delivery  | Unique `(consumer_name, message_id)` in the inbox. Reusing that ID with different content is a permanent delivery failure.          |

Both claims use `INSERT ... ON CONFLICT DO NOTHING` inside the financial transaction, so concurrent copies resolve through database uniqueness.

The operation hash is SHA-256 over RFC 8785 canonical business fields. Money is normalized before hashing; transport metadata is excluded. The inbox hash covers message `data`, including its idempotency key, and excludes envelope timestamps.

The same key and payload replay the stored outcome, including its original observed balance. A changed payload or an external ID bound to another key returns `409`.

Decision: [persistent idempotency](docs/decisions/0004-persistent-idempotency-and-replay.md).

---

## Database guarantees

Application checks are backed by schema enforcement:

| Guarantee                                          | Enforcement                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unique wallets, operations, entries, and reversals | Unique keys and partial indexes.                                                                                         |
| Valid money and states                             | Range, arithmetic, vocabulary, reference, and terminal-consistency checks. Every money column explicitly excludes `NaN`. |
| Immutable audit history                            | Triggers freeze ledger entries and terminal outcomes; transaction identity and amount cannot change.                     |
| Balance matches ledger                             | Deferred triggers enforce a continuous ledger chain and require the wallet to mirror its head.                           |
| Restricted runtime writes                          | A separate migrator owns the schema. The application has no DDL, no ledger updates, and no deletes.                      |

Deferring the balance checks permits wallet and ledger writes in either order and several movements in one transaction. Commit validates the final state. A movement without its matching balance, a balance without its entry, or a ledger gap cannot commit.

Explicit `NaN` checks matter because PostgreSQL treats `NaN = NaN`; chain arithmetic alone would accept it.

Design: [schema enforcement](docs/decisions/0003-database-enforcement-of-financial-consistency.md). Complete constraints: [technical reference](docs/architecture-reference.md#9-database-enforcement).

## Failure recovery

### Delivery and publication

Publishers claim due outbox rows with `FOR UPDATE SKIP LOCKED` in a separate transaction. Each sends the stored envelope, then records publication. Concurrent publishers claim disjoint rows; disconnecting releases claims.

| Failure window                                | Recovery                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Before financial commit                       | Roll back. Retry with the same key.                                                                                 |
| Commit outcome uncertain                      | Return `503` with `Retry-After`. The same key replays a successful commit or applies an uncommitted operation once. |
| Financial commit before queue acknowledgement | The completed inbox absorbs redelivery.                                                                             |
| Financial commit before publication           | Another publisher claims the pending event.                                                                         |
| Publication before its recording commit       | Republish the same `eventId`. Consumers deduplicate by that ID.                                                     |

Publication is at least once. FIFO deduplication and ordering are optimizations. Events have no global publisher order; balance consumers use `walletVersion`.

Queue business outcomes are acknowledged. Transient and unclassified failures retry with capped visibility backoff; redrive sends exhausted messages to the DLQ after five receives. Permanent failures are forwarded before deletion. Outbox rows retry indefinitely with capped backoff.

During shutdown, each role drains within a configured grace period. Unfinished transactions roll back, messages redeliver, and claims release. Exceeding the period exits `75`.

### Pending references

Missing or unfinished references produce `PENDING_REFERENCE` without moving money. A scheduler claims one due row per transaction and runs the shared financial step.

Retries start after one second, double up to five minutes, and use a one-hour window from receipt. Expiry is checked after an attempt still finds the reference missing, so an available reference can apply even after the window closes.

Transient or unclassified errors reschedule without extending expiry. Positively classified permanent failures become `FAILED` with `PROCESSING_FAILED`: audit-visible, no event, and replayed as `500`.

Details: [outbox](docs/decisions/0005-outbox-publication-protocol.md), [inbox](docs/decisions/0010-queue-delivery-identity-and-the-inbox-claim.md), [reference recovery](docs/decisions/0011-pending-reference-recovery.md).

---

## Scope and trade-offs

### Deliberate choices

- **Reversals:** one processed reversal per target across `REFUND` and `ROLLBACK`, stronger than one per type. Full amounts only. A rollback cannot be reversed; rolling back a refund does not make the original bet refundable again. Compatibility choices are recorded in [system contract section 20.2](docs/system-contract.md).
- **Reconciliation:** on demand, using a lock-free `REPEATABLE READ`, `READ ONLY` snapshot. Report, log, and count divergence without repairing balances; automatic repair would erase evidence.
- **Currency:** BRL operates on a currency-aware model.
- **Optional extensions:** Double-entry bookkeeping and OpenTelemetry remain unimplemented.

### Authentication

Authentication is deferred by design. The guard calls `ProviderIdentityPort`; its shipped binding admits every request. The intended integration is external OIDC through Keycloak, using provider-specific client credentials and a `providerId` claim.

Health stays open. Queue messages carry no credentials but still undergo domain validation. An authenticated deployment must also authorize wallet and service-ID reads: those routes name no provider, and PostgreSQL has no row-level security.

### Measured costs

The [load experiment](docs/load-experiment.md) used three API instances and two workers:

| Cost                 | Observation and implication                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publication capacity | Publishers handled about 500–570 events/s against roughly 2,200 produced/s. Backlog exceeded 84,000 rows, then drained after load stopped. Batch size, poll interval, and worker count remain untuned.       |
| Busy wallets         | Half the traffic targeted four of sixty wallets. Their median latency was about 2× and p99 11–13× that of other wallets, with zero lock timeouts. Serialization preserves correctness but increases waiting. |

The publisher holds a database connection during bounded broker I/O. Leases could release it sooner but would add lease tuning and a reaper. These measurements describe this stack and workload, not a production capacity guarantee.

## Verification

Run `make check`. Independent processes exercise duplicate submissions, competing bets, parallel wallets, concurrent publishers, and kills at verified commit/acknowledgement and publication/commit barriers. Suites that move money finish by comparing wallets with independently reconstructed SQL ledger balances.

The [acceptance map](docs/acceptance.yaml) links requirements to suites. The [technical reference](docs/architecture-reference.md#13-verification-and-delivery-status) retains detailed evidence; [ADRs](docs/decisions/README.md) record individual decisions.
