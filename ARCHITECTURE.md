# Architecture

A wallet and wagering transaction service for game providers.

This document explains the current design, database guarantees, failure recovery, and verification. The [system contract](docs/system-contract.md) defines the required behaviour. [Architecture decision records](docs/decisions/README.md) explain the consequential decisions.

**Implementation status:** Every required entry in [docs/acceptance.yaml](docs/acceptance.yaml) is `implemented` and `passing`. `make check` runs the full verification suite. [Verification and delivery status](#13-verification-and-delivery-status) lists the optional extensions this version leaves out.

## Contents

1. [Service overview](#1-service-overview)
2. [Design principles](#2-design-principles)
3. [Components and boundaries](#3-components-and-boundaries)
4. [Runtime and local stack](#4-runtime-and-local-stack)
5. [Money and domain model](#5-money-and-domain-model)
6. [Transaction processing](#6-transaction-processing)
7. [Wallets and read operations](#7-wallets-and-read-operations)
8. [Messaging](#8-messaging)
9. [Database enforcement](#9-database-enforcement)
10. [Transport and authentication](#10-transport-and-authentication)
11. [Operations](#11-operations)
12. [Failure recovery](#12-failure-recovery)
13. [Verification and delivery status](#13-verification-and-delivery-status)
14. [Decisions and limits](#14-decisions-and-limits)

---

## 1. Service overview

Providers open player wallets and submit `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK` operations over HTTP or a queue.

The service maintains:

- One materialized balance per wallet.
- An immutable ledger of every balance change.
- Persistent idempotency for every operation.
- A transactional outbox for integration events.

Providers settle in BRL. The model supports currencies and rejects currency conflicts; other currencies are not operated in this version.

### System flow

| Path               | Route                                                                     | Responsibility                                                                               |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| HTTP               | Providers → API instances                                                 | Wallets, `POST /wagering/transactions`, transaction reads, ledger reads, and reconciliation. |
| Queue input        | Providers → `wager-transactions.fifo` → worker consumer                   | Submit the same wagering commands as HTTP.                                                   |
| Dead letters       | Input queue or consumer → `wager-transactions-dlq.fifo`                   | Retain permanent failures and messages that exhaust their receives.                          |
| Reference recovery | Worker scheduler → PostgreSQL                                             | Retry transactions waiting for a reference.                                                  |
| Event publication  | Worker publisher → `wager-integration-events.fifo` → downstream consumers | Publish committed integration events.                                                        |

Both entry points call the same submission use case. Every financial change commits in one PostgreSQL transaction. Queue acknowledgements and event publication act only on committed financial state.

PostgreSQL stores `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`, and `pending_reference_schedule`.

---

## 2. Design principles

1. **Choose the simplest design that meets the guarantees.** If two designs are equally simple, choose the one that costs less to change.
2. **Enforce guarantees in the schema.** Constraints, triggers, and privileges enforce uniqueness, immutability, non-negative balances, and the balance-to-ledger link. Code expresses the rules; PostgreSQL prevents invalid commits.
3. **Keep the domain independent.** Entities and value objects do not depend on NestJS, MikroORM, HTTP, or SQS. The application defines ports; infrastructure implements them.
4. **Keep instances stateless.** Any instance of a role can handle any work assigned to that role. PostgreSQL coordinates requests, messages, and outbox claims.
5. **Keep network I/O outside financial transactions.** A financial transaction holds a wallet lock. Publish events, acknowledge messages, and wait on other systems after it commits.
6. **Define transport behaviour in documents.** `docs/openapi.yaml` and `docs/asyncapi.yaml` define requests, responses, messages, and events. Validated DTOs and message classes implement them.
7. **Test first, with real dependencies.** Use unit tests for the domain and use cases, PostgreSQL and LocalStack containers for adapters, and real parallel processes for concurrency. `make check` is the only definition of green, locally and in CI. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 3. Components and boundaries

Dependencies point inward: **infrastructure → application → domain**. The domain has no dependencies on the other layers.

### Layer responsibilities

| Layer          | Owns                                                                                                          | Must not depend on                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Domain         | Money, aggregates, records, events, operation identity, transitions, and business failure codes.              | Frameworks, ORM, transport, or a clock.                      |
| Application    | Use cases, ports, commands, results, request errors, and the SHA-256 primitive used by domain identity rules. | NestJS, MikroORM, SQS, or HTTP.                              |
| Infrastructure | Controllers, validation, persistence, messaging, runtime, configuration, logging, metrics, and health.        | No additional restriction; this layer wires the application. |

### Domain inventory

| Area                      | Types and functions                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Money and financial state | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`.                                                                     |
| Messaging                 | `InboxMessage`, `OutboxMessage`, `IntegrationEvent`, and its subclasses.                                                        |
| Operation identity        | `canonicalJson`, `payloadHashOf`, `classifyReservationConflict`, `openingCreditSubmission`.                                     |
| Errors                    | Domain errors such as `InvalidTransactionStateError` and `CurrencyMismatchError`; the failure-code and error-code enumerations. |

### Application inventory

| Area                    | Types and functions                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wallet use cases        | `OpenWallet`, `GetWallet`, `PageWalletLedger`, `ReconcileWallet`.                                                                                                                    |
| Transaction use cases   | `SubmitWagerTransaction`, `GetWagerTransaction`, `ReprocessPendingReference`.                                                                                                        |
| Shared financial step   | `ApplyWagerOperation`, used by submission and pending-reference recovery.                                                                                                            |
| Outbox use cases        | `PublishOutbox`, `ObserveOutboxBacklog`.                                                                                                                                             |
| Persistence ports       | `WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`.                                                           |
| Other ports             | `Clock`, `IdGenerator`, `EventPublisher`, `ProviderIdentityPort`, `Logger`, `Metrics`.                                                                                               |
| Request errors          | `WalletAlreadyExistsError`, `WalletNotFoundError`, `TransactionNotFoundError`, `IdempotencyPayloadMismatchError`, `ExternalTransactionAlreadyBoundError`, `ServiceUnavailableError`. |
| Delivery error          | `InboxPayloadConflictError`: a delivery refusal with no synchronous caller to answer.                                                                                                |
| Plain types and hashing | DTO-free commands and results; `sha256Hex`.                                                                                                                                          |

Infrastructure contains NestJS modules and controllers, validated DTOs, row classes and `EntitySchema` mappings, mappers, repositories, the unit of work, SQS consumers and publishers, schedulers, `WorkerLoop`, `WorkerRuntime`, signal handling, and HTTP draining.

### Transaction boundary

- Use cases receive plain commands and return plain results.
- Controllers and consumers translate transport payloads into commands, then results into responses or acknowledgements.
- `UnitOfWork` opens a transaction and supplies repositories bound to it. Use cases never receive a database connection.
- The five persistence ports are available inside `UnitOfWork.transactional`. It commits when the operation resolves and rolls back when it rejects.
- Each unit of work forks its own `EntityManager`, preventing one operation from reusing another operation's loaded rows.

### Persistence with MikroORM

| Concern           | Implementation                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction       | `UnitOfWork` uses `em.transactional`. The boundary remains visible in the use case.                                                                                                            |
| Wallet lock       | The repository issues `SELECT ... FOR NO KEY UPDATE` explicitly. `LockMode.PESSIMISTIC_WRITE` emits `FOR UPDATE`, which deadlocks against the reservation's foreign key (ADR 0002).            |
| Mapping           | One row class per table, mapped with `EntitySchema`. Mappers translate rows and aggregates (ADR 0008). Domain classes have no decorators and retain frozen state and private transitions.      |
| Money             | A custom `MoneyType` reads and writes `NUMERIC(20,2)` as exact decimal strings. Mappers pass each string and its currency to `Money.from`; only the domain parses amounts.                     |
| Write timing      | Repositories write when called. They do not defer writes until commit, so the ORM cannot reorder statements around the lock order.                                                             |
| Migrations        | Handwritten MikroORM classes with `up` and `down`. `src/infrastructure/persistence/migrate.ts` runs them as the migrator role; Compose's `migrate` service and `make migrate` use that script. |
| Database creation | `ensureDatabase` is off. Neither database role may create a database. Migration snapshots are also off because migrations are handwritten.                                                     |

---

## 4. Runtime and local stack

### One image, three roles

| Setting           | Runs                                                               | HTTP surface                                                  |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `APP_ROLE=api`    | API only. This is the default.                                     | Application routes, documentation, and operational endpoints. |
| `APP_ROLE=worker` | Queue consumer, outbox publisher, and pending-reference scheduler. | Health routes only.                                           |
| `APP_ROLE=all`    | API and all worker processes, for local development.               | The API surface.                                              |

Roles share code, configuration, and PostgreSQL. A process with no role setting serves traffic and claims no financial work (ADR 0013).

Run any number of instances per role. Concurrency suites use at least three processes against one database and one queue.

### Database roles

| Role                | Access                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wagering_migrator` | Owns the schema and runs deployment migrations.                                                                                                             |
| `wagering_app`      | Runs the service. No DDL; no ledger `UPDATE` or `DELETE`. The full privilege restrictions are listed under [database enforcement](#9-database-enforcement). |

### Compose stack and suite isolation

Docker Compose starts PostgreSQL, LocalStack and its queues, a migration step, one `api`, and two `worker` instances.

Tests share those containers with demonstrations, but use separate data:

| Resource | Demonstration stack            | Test suites                  |
| -------- | ------------------------------ | ---------------------------- |
| Database | `wagering`                     | `wagering_test`              |
| Queues   | The three contract queue names | A second trio under a prefix |

`SQS_QUEUE_PREFIX` selects the queue namespace. It defaults to empty so deployments use the names fixed by the transport contract. `make check` and `make demo` can run together without touching each other's rows or messages (ADR 0014).

### One stack per checkout

`docker/stack.sh` names the stack, derives its slot, and prints its three ports. The `Makefile` exports the project, image, and ports; `.env` builds the service URLs from them.

| Slot        | Published ports                    |
| ----------- | ---------------------------------- |
| `0`         | `3000`, `5433`, `4566`.            |
| Other slots | A block of ten ports from `24000`. |

- The slot is the checkout's position in `git worktree list`. It is derived directly, without scanning host ports, so checkouts do not select the same slot.
- `STACK_SLOT` pins a slot and is used as supplied.
- An occupied port makes `docker compose` fail with its own error.
- Two checkouts can run the gate at once. `make down` in one leaves the other running.

---

## 5. Money and domain model

### Money

| Boundary                       | Representation                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Domain                         | `bigint` minor units.                                                             |
| PostgreSQL                     | `NUMERIC(20,2)`, with a currency column beside each amount.                       |
| Between layers and on the wire | Exact decimal strings. Integration events serialize money through `Money.toJSON`. |

`Money` uses strict two-decimal parsing and has no rounding path. Inputs, arithmetic, and storage share the bound in ADR 0001. The maximum balance is `999999999999999999.99`; a credit above it is rejected with `BALANCE_LIMIT_EXCEEDED`.

### Wallet and ledger entry

`Wallet` opens at version 1, with or without an `OPENING` credit. It refuses:

- A debit the balance cannot cover.
- A different currency.
- A different owner.
- A credit beyond the money bound.

Each refusal returns its failure code. An applied operation returns a new wallet and its single `WalletLedgerEntry`; it does not mutate the existing wallet (ADR 0006). A refusal returns no wallet to write, so the balance, version, and ledger stay unchanged.

The entry derives its direction from the operation kind. For `ROLLBACK`, it reverses the target kind's direction. An entry can exist only if its arithmetic balances.

Both types are framework-free and unit-tested without a database, clock, or port.

### Wager transaction

`WagerTransaction` is the submission audit record and the source of every replayed outcome.

| State or action        | Rule                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Creation               | Starts `PENDING`; validates the reference requirement for its kind.                                |
| `markProcessed`        | Moves to `PROCESSED`.                                                                              |
| `markPendingReference` | Moves to `PENDING_REFERENCE`.                                                                      |
| `reject`               | Moves to `REJECTED`.                                                                               |
| `fail`                 | Moves to `FAILED`. Only this transition uses `PROCESSING_FAILED`.                                  |
| Every outcome          | Records the balance observed at that outcome.                                                      |
| Terminal state         | Refuses every transition and preserves status, failure code, processed time, and observed balance. |

One transition table defines legal transitions and terminality (ADR 0007). Database triggers enforce the same restrictions for every writer (SCHEMA-024, SCHEMA-025).

### Messaging records

| Type                                   | Responsibility                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `InboxMessage`                         | Uses `(consumer_name, message_id)` from the message body, independent of receipt ID. `markProcessed` completes it in the same transaction as the financial outcome.                              |
| `OutboxMessage`                        | Stores the event's original envelope. Every publication of the row sends the same message. `scheduleRetry` counts failures and sets the capped backoff from ADR 0005; no state abandons retries. |
| `IntegrationEvent` and four subclasses | Fix `eventType` and `version` in each class. Derive `aggregateId` and `causationId` from the recorded fact, rather than call-site arguments. Serialize amounts through `Money.toJSON`.           |

### Service IDs and ordering

Service IDs are UUIDv7, generated with `Bun.randomUUIDv7` for index locality. They identify records; they do not establish order across instances because UUIDv7 is not monotonic across instances.

- Order ledger entries by `walletVersion`.
- Order outbox records by occurrence time and ID (`occurred_at, id`). The publisher's claim query uses `(occurred_at, event_id)`.

---

## 6. Transaction processing

### Operation identity and replay

Every operation has provider-scoped idempotency keys and an external transaction ID bound to its first key (ADR 0004).

`payloadHash` is SHA-256 over RFC 8785 canonical JSON of the validated business fields. The same operation hashes identically across HTTP and queue submissions, field orders, and envelopes.

| Responsibility                             | Owner                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Select business fields and canonical bytes | Domain functions `canonicalJson` and `payloadHashOf`. Property names sort by UTF-16 code unit, as RFC 8785 requires.            |
| Normalize money                            | The domain money parser ensures one spelling per value before hashing. The result does not depend on which validator ran first. |
| Compute the digest                         | Application function `sha256Hex`, using `node:crypto`. The domain imports no runtime module; a pure digest needs no adapter.    |
| Verify identical results                   | Fixed vectors, including RFC vectors and the transport contracts' examples.                                                     |

`WagerTransactionRepository.reserve` claims both unique keys with one `INSERT ... ON CONFLICT DO NOTHING`. It then reads the row holding the submitted key.

`WagerTransaction.matchesPayload` and `classifyReservationConflict` use only that stored row and the submitted hash to return one of three results:

| Conflict result                              | Behaviour                                                        |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Same operation                               | Replay the persisted outcome, including the balance it observed. |
| Same key, different payload                  | Refuse with an idempotency payload conflict (`409`).             |
| External transaction ID bound to another key | Refuse with an external-ID conflict (`409`).                     |

The reservation commits with the financial effect. Concurrent copies, and copies received after the reserving process exits, resolve from the database alone.

### Submission sequence

Both entry points use `SubmitWagerTransaction`. The financial transaction follows this order (ADR 0002):

1. **Set the lock timeout.** Run `SET LOCAL lock_timeout` using `LOCK_TIMEOUT_MS`.
2. **Reserve the transaction.** Insert the transaction row so its unique keys decide the race. For queue delivery, claim the inbox row before this reservation.
3. **Lock the wallet.** Issue `SELECT ... FOR NO KEY UPDATE`.
4. **Decide the outcome.** Resolve any reference and apply the domain rules.
5. **Write the result.** Persist the outcome, the balance guarded by the version read under the lock, the ledger entry, and the outbox rows.
6. **Commit together.** Queue delivery also completes its inbox row in this commit.

The reservation's foreign key holds `KEY SHARE`. `FOR NO KEY UPDATE` is compatible with that lock; `FOR UPDATE` can deadlock against it.

A losing reservation returns a replay or one of the two `409` conflicts before taking the wallet lock. Fifty copies of one bet therefore require one wallet-lock acquisition.

| Situation                      | Recorded result                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Wallet applies the operation   | New wallet state, ledger movement, outcome, and events commit together.                                                |
| Wallet refuses a business rule | A `REJECTED` transaction with the observed balance and one rejected event. No balance, ledger, or version change.      |
| Wallet does not exist          | The reservation's foreign key prevents insertion. The repository maps that violation to `WalletNotFoundError` (`404`). |

There is no wallet lookup before reservation: it would describe an earlier moment and move the reservation away from the start of the financial work.

### Database failures and uncertain commits

The unit of work maps a closed list of database failures to `ServiceUnavailableError`:

- Lock timeout.
- Serialization failure.
- Deadlock.
- Cancelled statement.
- Unreachable or shutting-down server.

HTTP returns `503 SERVICE_UNAVAILABLE` with `Retry-After` (`api.transient-failure`). Other errors retain their classification, so a defect is not presented as a dependency to wait for.

Classification includes commit. If the connection disappears after `COMMIT` is sent, the service cannot know whether the commit landed and returns `503`. Resending with the same key resolves either case: replay if it committed; apply once if it did not.

`POST /wagering/transactions` uses one outcome body for `200`, `202`, `422`, and `500`. The recorded outcome determines the status.

### References, reversals, and `LOSS`

After locking the wallet, resolve a reference by `(providerId, referenceExternalTransactionId)` (ADR 0009). A reference must share the wallet, so reversals of one target serialize behind that wallet's lock. Each lookup sees reversals that have already committed.

`WagerTransaction.refuseReference` checks eligibility in this order:

1. **Kind:** refuse a target that cannot be reversed, regardless of its context.
2. **Context, including currency:** never compare amounts across currencies.
3. **Status.**
4. **Amount:** a reversal must match the required target amount.

`movement` supplies the operation's direction. A `ROLLBACK` uses the inverse direction of the target kind.

Before applying a reversal, count processed `REFUND` or `ROLLBACK` rows using the partial unique index's predicate under the same wallet lock. This permits a persisted `REFERENCE_ALREADY_REVERSED` rejection. Waiting for the unique index to fail would abort the transaction that must record that rejection.

| Case                              | Behaviour                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Two instances refund one bet      | One credit and one `422`.                                                                         |
| `LOSS`                            | Check owner and currency, but produce no movement. Balance, version, and ledger remain unchanged. |
| Credit exceeds `money.bound`      | Persist the rejection specified by ADR 0001.                                                      |
| Reference missing or not terminal | Park as `PENDING_REFERENCE`.                                                                      |

### Pending-reference recovery

Parking a transaction commits:

- `PENDING_REFERENCE` and its observed balance.
- A `pending_reference_schedule` row containing attempts, next attempt, expiry, and the original correlation ID.
- An initial attempt time one second after receipt and an expiry one hour after receipt.
- One `WagerTransactionPendingReference` event.

The submission returns `202` with `Location`.

`ReprocessPendingReference` handles one oldest due row per database transaction:

1. Claim it with `SELECT ... FOR UPDATE SKIP LOCKED`.
2. Lock its wallet.
3. Run `ApplyWagerOperation`, the same financial step used by submission.
4. Record the result and commit.

| Attempt result                               | Action                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference arrived and is eligible            | Apply it under all reference rules.                                                                                                                               |
| Reference arrived but is ineligible          | Persist the same `REJECTED` outcome as an initial submission.                                                                                                     |
| Reference still missing, window open         | Keep it pending, increment attempts, and schedule `min(1s × 2^attempts, 5m)`. Emit no new pending event.                                                          |
| Reference still missing, window expired      | Reject with `REFERENCE_NOT_FOUND` and emit the rejection event.                                                                                                   |
| Transient or unclassified error              | Leave the transaction unchanged. Reschedule with backoff and keep the original expiry. Transient retries have no limit.                                           |
| Other `ApplicationError`, or a `DomainError` | Mark `FAILED` with `PROCESSING_FAILED`, log it, emit no event, and replay as `500`. Examples include an unknown wallet or stored state the domain cannot rebuild. |

Check expiry **after an attempt runs and finds the reference missing**. A reference that arrived before an overdue attempt can still be applied; expiry alone does not reject it.

The row lock is the claim. A crash releases it with the connection and leaves the uncommitted attempt unchanged and due. Other workers skip locked rows. Tests cover a held claim in a separate process and three processes draining one backlog with one attempt per transaction.

`PendingReferenceScheduler` runs in the `worker` role on `PENDING_REFERENCE_SWEEP_INTERVAL_MS`. During shutdown it stops claiming between attempts and finishes its current attempt, or exits without committing it so another instance can retry immediately (ADRs 0011 and 0013).

---

## 7. Wallets and read operations

### Endpoints

| Endpoint                                                                    | Use case                                    |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| `POST /wallets`                                                             | `OpenWallet`                                |
| `GET /wallets/{walletId}`                                                   | `GetWallet`                                 |
| `GET /wagering/transactions/{transactionId}`                                | `GetWagerTransaction`, by service ID        |
| `GET /providers/{providerId}/wagering/transactions/{externalTransactionId}` | `GetWagerTransaction`, by provider identity |
| `GET /wallets/{walletId}/ledger`                                            | `PageWalletLedger`                          |
| `POST /wallets/{walletId}/reconciliation`                                   | `ReconcileWallet`                           |

### Open a wallet

`OpenWallet` creates a wallet in the initial balance's currency. The aggregate prepares the state before the database transaction opens, producing the balance and its explaining entry together.

| Initial balance     | Commit                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greater than `0.00` | Wallet; a `PROCESSED` `OPENING` transaction under reserved provider `system`; a `CREDIT` entry at `walletVersion` 1; processed and balance-changed outbox events. |
| `0.00`              | Wallet only. There is no movement to record.                                                                                                                      |

A failure anywhere rolls back all rows. The unique `(player_id, currency)` key detects duplicate wallets; there is no preliminary duplicate lookup. Concurrent opens produce one wallet and one `409`, mapped by the repository to `WalletAlreadyExistsError`.

`GetWallet` returns a wallet or raises `WalletNotFoundError`; the use case, rather than the controller, decides what absence means. `Clock` and `IdGenerator` are ports so tests can fix every timestamp and row ID.

Request refusals use RFC 9457 problem details with an `ErrorCode` and the same correlation ID as the response header.

### Read a transaction

`GetWagerTransaction` exposes one read model through two identities (`tx.identity`): service ID or provider ID plus external transaction ID.

- The provider lookup has no service-ID field. It cannot use a guessed service ID to reach another provider's row.
- Provider `system` is accepted so callers can read internal `OPENING` credits. Their `externalTransactionId` is the wallet ID.
- The result is the full transaction view. Conditional members appear exactly when the stored row contains them.

The separate service-ID route is not provider-scoped. Its access limitation is documented under [authentication and read access](#authentication-and-read-access).

### Page a wallet's ledger

`PageWalletLedger` reads entries in ascending `walletVersion` and returns `items` plus `nextCursor`.

| Rule                                                | Reason                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The cursor names the last returned version.         | Appended entries fall after it; each entry appears on exactly one page.                      |
| Use the unique `(wallet_id, wallet_version)` index. | A range scan avoids offset scanning. Page depth does not add skipped-row work.               |
| Read one entry beyond the page.                     | `nextCursor` is `null` exactly on the last page; every issued cursor points to a real entry. |
| Read the wallet before its entries.                 | An unknown wallet must differ from a wallet opened at `0.00` with an empty ledger.           |
| Use a read-only snapshot.                           | Reads take no wallet lock and cannot write or block financial processing with that lock.     |

Offset pagination adds skipped-row cost and does not provide the same append-stable boundary. The hundredth cursor page uses the same indexed access pattern as the first.

The HTTP adapter owns the cursor format: `base64url("v1:" + walletVersion)`. Clients treat it as opaque. The use case receives and returns a wallet version, so no internal query parses a cursor. The `v1` prefix allows future format changes without migrating stored values.

The decoder re-encodes the decoded value and requires an exact match. This prevents lenient base64 decoding from accepting a crafted position the service never issued.

- Invalid or out-of-bounds `limit`: `VALIDATION_FAILED` at `/query/limit`.
- A cursor the service did not issue: `INVALID_CURSOR`. It never silently restarts at page one.

Transaction lookup and ledger paging both use the read-only snapshot.

### Reconcile a wallet

The ledger is the source of truth; the stored balance is materialized. `ReconcileWallet` compares:

1. The stored wallet balance.
2. Credits minus debits, summed in one database aggregate over `NUMERIC(20,2)`.
3. The `balanceAfter` of the ledger entry at the wallet's own version.
4. The signed `difference` between the compared balances.

`difference` is the only place the service serializes a negative amount.

`UnitOfWork.snapshot` uses `REPEATABLE READ` and `READ ONLY`, without locks. The wallet and ledger come from one committed state, even if another transaction commits during the report. PostgreSQL also prevents reconciliation from changing a balance.

| Result                                | Response and operational effect                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consistent                            | `200` with the report.                                                                                                                             |
| Divergent                             | `200` with `consistent: false`; an error log with wallet, difference, and the entries examined; increment `wager_reconciliation_divergence_total`. |
| Stored data cannot be parsed as money | No report. The domain parser rehydrates both sides of the comparison and rejects unparseable money, including `NaN` (RECON-005).                   |

A divergence describes the wallet; it is not a refused request, so it does not return `422`. Logging and metrics pass through the application ports and behave the same wherever reconciliation is invoked.

Reconciliation reports and never repairs. Automatic correction would destroy evidence of the defect. It is available only through `POST /wallets/{walletId}/reconciliation`; no role schedules a sweep of all wallets. Deployments that need continuous checks schedule calls and leave divergence handling to operators (`recon.divergence-handling`).

Every suite that moves money ends with an independent SQL comparison of each touched wallet and its ledger (RECON-004, `recon.final-invariant`).

---

## 8. Messaging

### Queue delivery and inbox identity

`WagerTransactionsConsumer` validates `WagerTransactionRequested`, builds the same command as the controller, and calls the same `SubmitWagerTransaction` instance supplied by the composition root. Queue delivery adds identity and acknowledgement handling, not another financial implementation.

The use case's `deliver` method wraps the shared financial body:

1. Claim `(consumer_name, message_id)` with `INSERT ... ON CONFLICT DO NOTHING` as the first delivery statement, before transaction reservation.
2. Compare an existing row's content hash, if the claim conflicts.
3. Run the shared financial work.
4. Complete the inbox row last, in the same commit as the outcome.
5. Delete the queue message only after commit returns.

| Inbox result                      | Action                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| New identity                      | Process and complete it with the financial transaction.                           |
| Existing identity, same hash      | Count a redelivery, write nothing, and delete the message.                        |
| Existing identity, different hash | Raise `InboxPayloadConflictError`. The first delivery's effects remain unchanged. |

The primary key decides concurrent claims; there is no look-then-write race (ADR 0010). The hash covers message `data`, including the idempotency key, and excludes envelope timestamps.

A worker killed after commit and before delete costs one redelivery and no second financial effect. An operation first submitted over HTTP is replayed when it arrives on the queue. The correlation ID comes from the message, falling back to its `messageId`, and is carried into every event it produces.

### Classify before acting

Delivery classification precedes any acknowledgement, retry, or forwarding (`msg.classification`).

| Delivery class                    | Includes                                                                                | Action                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Business outcome                  | Any recorded business outcome.                                                          | Acknowledge; the message is complete.                                                                                       |
| Transient or unclassified failure | Unreachable database, lock wait, serialization failure, or an error no rule classifies. | Use `ChangeMessageVisibility` to retry. Unknown errors remain retryable so a defect cannot be acknowledged as applied work. |
| Permanent failure                 | Invalid body, reused message ID, or unknown wallet.                                     | Forward to `wager-transactions-dlq.fifo`, then delete from the input queue.                                                 |

Retry delay doubles per receive and is capped by `SQS_RETRY_BACKOFF_MAX_SECONDS`. The broker's receive count drives it; the consumer stores no retry state. The queue's redrive policy ends retries after five receives.

Dead-letter forwarding preserves the body, group, and deduplication ID. Forwarding must succeed before deletion. If the broker refuses the forward, the message remains for the redrive policy to dead-letter.

Every message-level broker call follows the same rule: a refusal retains the message, reports the actual result, and does not fail the rest of the batch. Delivery reports describe the resulting message state, not the intended action.

### Receive failures and shutdown

- A failed `ReceiveMessage` has no message to retain and no delivery result. `poll` raises the error; `WorkerLoop` logs `wager.poll-failed`, treats the cycle as empty, and waits the idle interval before receiving again.
- Continued receive failures follow that same idle delay. No message has been taken, so this path needs no message-level retry state.
- A receive aborted by shutdown returns no messages and no error.
- During shutdown, the consumer abandons the receive in flight and returns any messages in its batch that it has not started.

FIFO ordering and broker deduplication are optimizations, not correctness requirements. A reversal arriving before its target is parked. A duplicate the broker lets through is absorbed by the inbox.

### Outbox publication

`PublishOutbox` publishes events left by committed operations (ADR 0005). Its database transaction is separate from the financial transaction.

One publication cycle:

1. Claim up to `OUTBOX_BATCH_SIZE` due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, ordered by `(occurred_at, event_id)`.
2. Send each stored envelope to `wager-integration-events.fifo`, bounded by `OUTBOX_PUBLISH_TIMEOUT_MS`.
3. Use the wallet as `MessageGroupId` and the event ID as `MessageDeduplicationId`.
4. Set `published_at` for accepted sends. Record capped retry backoff for refused sends.
5. Commit.

| Property                                    | Guarantee                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent publishers                       | Row locks give them disjoint batches.                                                                                                                                  |
| Publisher crash                             | PostgreSQL releases the locks when its connection closes; another publisher can claim the rows.                                                                        |
| Financial commit boundary                   | A claim for `published_at is null` cannot see an uncommitted inserted row. Events are published only after the financial commit.                                       |
| Crash after send, before publication commit | The row stays pending and is sent again with the same `eventId` and envelope. Consumers deduplicate by `eventId`.                                                      |
| Continued broker failure                    | Rows are never deleted or abandoned. Retries continue indefinitely.                                                                                                    |
| Stalled publication                         | From the tenth attempt, log `outbox.publication-stalled` at error level while continuing retries. Scrape-time backlog gauges provide the alert condition (OUTBOX-008). |

Sending before recording publication can produce another copy after a crash. Recording publication before sending could lose an event, so that order is rejected.

The publisher holds a database connection while sending. Batch size and timeout bound the hold. Leases would release the connection sooner but require lease tuning and a reaper.

### Publisher loop

`OutboxPublisher` starts with the `worker` role.

| Cycle result   | Next step                                                          |
| -------------- | ------------------------------------------------------------------ |
| Claimed work   | Start the next cycle immediately.                                  |
| No work        | Wait `OUTBOX_POLL_INTERVAL_MS`.                                    |
| Cycle failed   | Log the failure and run another cycle.                             |
| Stop requested | Resolve `stop` only after the current batch commits or rolls back. |

A successful drain records sent publications before exit. Tests cover two processes draining 5,000 rows with exactly that many claims, a publisher killed while holding a batch, identical-message republication after a lost commit, a reference consumer applying that event once, and capped retry attempts against an unreachable broker without losing rows.

---

## 9. Database enforcement

### Tables and money columns

| Table                        | Notable data                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `wallets`                    | Materialized balance, currency, and version.                                                                    |
| `wager_transactions`         | Submission identity, state, and `observed_balance`.                                                             |
| `wallet_ledger_entries`      | Immutable movements and their wallet versions.                                                                  |
| `inbox_messages`             | Delivery claims and completion.                                                                                 |
| `outbox_messages`            | Stable event envelopes and publication attempts.                                                                |
| `pending_reference_schedule` | `transaction_id` as primary and foreign key; `attempts`, `next_attempt_at`, `expires_at`, and `correlation_id`. |

Every money column uses `NUMERIC(20,2)` with a currency column beside it. The composite ledger foreign key binds the entry's currency to the wallet's currency.

`wager_transactions` needs two currency fields:

- `currency` describes the submitted amount.
- `observed_balance_currency` describes the balance observed at the outcome.

A `CURRENCY_MISMATCH` rejection can carry different currencies. Sharing one column would mislabel either the amount or the balance (`tx.observed-balance`).

### Wallet and transaction constraints

| Guarantee                                | Mechanism                                                                                                                                    | Evidence   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| One wallet per player and currency       | `UNIQUE (player_id, currency)` on `wallets`.                                                                                                 | SCHEMA-001 |
| Non-negative wallet balance              | `CHECK (balance >= 0)`.                                                                                                                      | SCHEMA-002 |
| Wallet version starts at 1               | `CHECK (version >= 1)`.                                                                                                                      | SCHEMA-003 |
| One row per provider transaction         | `UNIQUE (provider_id, external_transaction_id)`.                                                                                             | SCHEMA-004 |
| One row per provider idempotency key     | `UNIQUE (provider_id, idempotency_key)`.                                                                                                     | SCHEMA-005 |
| Closed vocabularies and valid references | One `CHECK` per kind, status, failure-code, direction, and event-type column; a `CHECK` relates kind to `reference_external_transaction_id`. | SCHEMA-006 |
| Consistent terminal fields               | A `CHECK` ties `status` to `processed_at` and `failure_code`.                                                                                | SCHEMA-007 |
| Frozen terminal outcome                  | A `BEFORE UPDATE OR DELETE` trigger prevents updates to terminal transactions and deletion of any transaction.                               | SCHEMA-024 |
| Frozen transaction identity and amount   | The same trigger compares frozen columns with `IS DISTINCT FROM`. Identity, context, kind, amount, and currency cannot change.               | SCHEMA-025 |
| Valid amount ranges                      | Ledger: `CHECK (amount > 0)`. Transactions: `amount >= 0`, and `amount > 0` unless `kind = 'LOSS'`.                                          | SCHEMA-008 |
| One processed reversal per target        | Partial `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.                                    | SCHEMA-015 |
| One opening credit per wallet            | Partial `UNIQUE (wallet_id) WHERE kind = 'OPENING'`.                                                                                         | SCHEMA-016 |

### Ledger constraints and privileges

| Guarantee                                | Mechanism                                                                                                                     | Evidence   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| One entry per transaction                | `UNIQUE (transaction_id)`.                                                                                                    | SCHEMA-009 |
| Unique wallet sequence                   | `UNIQUE (wallet_id, wallet_version)`.                                                                                         | SCHEMA-010 |
| Balanced, non-negative entries           | Arithmetic `CHECK` over `balance_before`, `amount`, `direction`, and `balance_after`; `CHECK (balance_after >= 0)`.           | SCHEMA-011 |
| Entry currency matches wallet            | Composite `FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency)`.                                              | SCHEMA-012 |
| Immutable ledger                         | `BEFORE UPDATE OR DELETE` trigger rejects every change for every role.                                                        | SCHEMA-013 |
| Privileges also protect the ledger       | `wagering_app` has only `SELECT, INSERT` on the ledger, no `DELETE` on any table, no access to the migration log, and no DDL. | SCHEMA-014 |
| Wallet mirrors its ledger head at commit | Deferred constraint trigger on `wallets`, comparing it with the greatest `wallet_version`.                                    | SCHEMA-017 |
| Every entry is mirrored or continued     | Deferred constraint trigger on `wallet_ledger_entries`: an entry without a successor must be mirrored by the wallet.          | SCHEMA-021 |
| Continuous chain, no version gaps        | The same trigger checks predecessor and successor versions, minus or plus one, with matching balances.                        | SCHEMA-022 |
| Wallet balance equals the ledger sum     | Follows from continuity, arithmetic, and immutability; direct-SQL sequences assert it.                                        | SCHEMA-023 |

### Messaging and money constraints

| Guarantee                                  | Mechanism                                                                                    | Evidence   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------- |
| Inbox identity                             | Primary key `(consumer_name, message_id)`.                                                   | SCHEMA-018 |
| Stable event identity and efficient claims | Primary key `event_id`; pending-row index on `(published_at, next_attempt_at, occurred_at)`. | SCHEMA-019 |
| Exact money                                | `NUMERIC(20,2)` for all money, matching the domain bound; ORM round-trip test.               | SCHEMA-020 |
| No monetary `NaN`                          | A separate `<> 'NaN'::numeric` check beside each money column's range check.                 | SCHEMA-026 |

### Balance-to-ledger link

Two deferred constraint triggers enforce the final state at commit (ADR 0003):

1. A wallet mirrors its ledger head: the entry with the greatest `wallet_version`. A wallet without entries must have version 1 and balance `0.00`.
2. Each entry links to its predecessor and successor, if present. An entry without a successor is the head and must match the wallet.

Together with entry arithmetic, unique `(wallet_id, wallet_version)`, and ledger immutability, this creates one continuous chain from `0.00` to the wallet balance.

The database refuses commits containing:

- A balance change without its entry.
- An entry without its balance change.
- An entry inserted between existing entries.
- A version gap.

The triggers are deferred so a transaction can write the wallet and entry in either order and can make several movements before its final state is checked (SCHEMA-017, SCHEMA-021–SCHEMA-023, WALLET-005).

`NaN` needs its own checks. In PostgreSQL, `NaN = NaN`, and addition propagates it, so a `NaN` chain can satisfy both link triggers. Only the per-column exclusion prevents that commit (SCHEMA-026). The reconciliation parser also rejects unparseable money rather than reporting it as consistent.

### Claim retention

The runtime role cannot delete from any table. Claim lists retain their rows.

A pending-reference claim joins `wager_transactions` and selects only `PENDING_REFERENCE` transactions. Once a transaction reaches an outcome, later sweeps ignore its schedule row. The retained row records its attempt count (ADR 0011).

### Migration verification

| Migration stage      | Adds                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First migration      | Six tables, columns, and primary keys.                                                                                                                    |
| Next five migrations | Unique keys and partial indexes; vocabulary, range, consistency, arithmetic, and `NaN` checks; foreign keys; immutability triggers; per-table privileges. |
| Seventh migration    | The deferred balance-to-ledger constraint triggers.                                                                                                       |

Ledger and transaction immutability triggers raise SQLSTATE `23000`, so trigger refusals classify like constraint refusals.

Every migration is reversible. Tests remove the schema, rebuild it, and compare the catalogue of columns, constraints, indexes, triggers, functions, and grants. Money mapping also round-trips the maximum value to the cent.

---

## 10. Transport and authentication

### Authoritative contracts

| Document             | Version      | Defines                                                       |
| -------------------- | ------------ | ------------------------------------------------------------- |
| `docs/openapi.yaml`  | OpenAPI 3.1  | Paths, parameters, headers, statuses, bodies, and pagination. |
| `docs/asyncapi.yaml` | AsyncAPI 3.0 | Queues, messages, event envelopes, and delivery semantics.    |

Both documents cite the system-contract rules they implement and add no independent business rules. Each describes its transport's operation shape in full.

Change the contract first, then update DTOs, message classes, event classes, and adapter validation. Shared transport code in `src/infrastructure/transport` implements the operation shape once: the HTTP body and message `data` apply the same rules (`msg.same-use-case`).

The `api` role serves `docs/openapi.yaml` byte for byte at `/docs-json` and renders that route at `/docs`. Neither contract nor code is generated from the other. Acceptance tests enforce conformance (MODEL-006, API-011, API-012).

### Request validation

Zod validates requests at the edge and configuration at startup.

| Rule                           | Behaviour                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| One pipe per request part      | Parse each part against its contract schema.                                                           |
| Report all violations together | Providers can fix the payload in one round trip.                                                       |
| Use JSON Pointers              | The first segment names the part, for example `/body/initialBalance/amount` or `/path/walletId`.       |
| Reject unknown members         | All object schemas are strict.                                                                         |
| Reuse domain money patterns    | Any accepted amount is parseable by `Money.from`. Malformed amounts return `400` with the member path. |

### Problem details and correlation IDs

One exception filter converts recognized request refusals into RFC 9457 problem details. A complete table maps each `ErrorCode` to its HTTP status and title. Use cases name codes, never statuses; new codes cannot reach callers without a mapping.

The filter handles validation violations, use-case conflicts and missing resources, and bodies the framework cannot parse. Unknown errors remain defects or dependency failures rather than being treated as request refusals. Classified transient failures return `503 SERVICE_UNAVAILABLE` with `Retry-After` (API-006).

The correlation ID is bound on first need, early enough for malformed bodies rejected before route handling. The first binding fixes the ID and writes the response header, so the body and header cannot disagree.

Two deliberate exceptions apply:

| Input                              | Behaviour                                                                    | Reason                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed `X-Correlation-Id`       | Generate a replacement and return the ID actually used. Do not return `400`. | An operational label must not prevent a financial operation. API-001 treats this as the sole strict-input exception.                                                                                      |
| Unknown path or unsupported method | Return the framework's own body, not problem details.                        | `ErrorCode` is the closed set of actionable request refusals (`failure.request-errors`); it has no code for a request outside the documented operations. API-011 prevents undocumented registered routes. |

### Authentication and read access

**Current behaviour:** HTTP callers are not authenticated. Providers access the service inside the platform's network boundary. The HTTP guard calls `ProviderIdentityPort`, but the shipped binding returns no identity and admits every request.

**Planned identity integration:** An external OpenID Connect provider, Keycloak, issues client-credentials tokens with one client per provider and a `providerId` claim. The guard validates the token; the port returns the claim; the use case rejects payloads naming another provider.

The application already supports replacing the port binding at the composition root. Tests build the same application with both bindings and verify that an identified caller's mismatched provider is refused before any wallet read, while a matching submission applies.

| Boundary                             | Behaviour                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard coverage                       | New routes are covered unless they declare an exemption.                                                                                                                                                                            |
| Operational and documentation routes | The three operator endpoints and two documentation routes declare exemptions. Health and metrics remain open.                                                                                                                       |
| Queue                                | No credentials and no HTTP guard. Every domain rule still applies; a wallet owned by another player is rejected with `WALLET_PLAYER_MISMATCH`.                                                                                      |
| Authentication status and codes      | No authentication-failure status or code is published in this version. `401`, `403`, and their codes arrive with the identity-provider integration (#29). A test identity binding currently refuses with the framework's own `403`. |

AUTH-001 limits an identified caller to the provider named in a payload or path. This covers submissions and provider transaction lookup. These three reads name no provider and are not scoped to one:

- `GET /wallets/{walletId}`
- `GET /wallets/{walletId}/ledger`
- `GET /wagering/transactions/{transactionId}`

A caller with one of those IDs can read the row regardless of who created it. An authenticated deployment must scope these reads to the caller or restrict them to operators. The runtime PostgreSQL role sees every row; there is no row-level security.

---

## 11. Operations

### Startup configuration

Read environment variables and validate them with a zod schema before listening. An invalid value exits the process and names the variable.

The service schema contains no migrator credentials. The migration step reads its own variable.

### Structured logs

Every service log is one JSON line written through the `Logger` port to the process sink (ADR 0012).

| Field group    | Contents                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| Record         | `time`, `level`, `component`, `event`.                                     |
| Bound identity | Correlation ID and other known identity fields; message ID for queue work. |
| Event fields   | The caller's permitted fields.                                             |

`AsyncLocalStorage` binds identity per unit of work. The adapter merges it into every line, so financial methods need no logging argument. HTTP binds it before handlers and early enough for body-parser failures; the consumer binds it for the full handling of one message.

Work that continues later keeps its original correlation ID:

- Publication reads it from the stored event envelope.
- Pending-reference recovery reads `correlation_id` from the schedule claim row.

The single logging adapter redacts bodies, amounts, and balances, both by field name and by money-shaped values. Reconciliation divergence is the one documented exception and uses a dedicated logger method, making it enforceable by type and auditable in source searches.

Suites capture the running service's actual sink and assert JSON structure, identity fields, and redaction. They do not test only an injected logger.

### Metrics

`prom-client` exposes an instance-local registry at `GET /metrics`. All documented metrics are declared at startup, including their types, so an idle instance exposes them.

Metric names and allowed labels are part of the operational contract. The `Metrics` port declares them as a mapped type; an unknown name or label fails compilation (`obs.metrics`).

| Owner                   | Records                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Submission use case     | Recorded outcomes and replays.                                                                                                  |
| Inbox claim             | Absorbed redeliveries and reused message IDs.                                                                                   |
| Consumer                | Visibility changes accepted by the broker and completed dead-letter forwards.                                                   |
| Publisher and scheduler | Their retry backoffs.                                                                                                           |
| Unit of work            | Lock waits, including `wager_lock_conflicts_total` when `LOCK_TIMEOUT_MS` is exceeded. HTTP and queue paths share this counter. |
| Reconciliation          | Divergences through `wager_reconciliation_divergence_total`.                                                                    |

Every scrape measures `wager_outbox_pending` and `wager_outbox_lag_seconds` from the outbox table through `ObserveOutboxBacklog`. They remain accurate on an instance with no running publisher (`outbox.lag-metrics`).

### Health

Health uses `@nestjs/terminus`.

| Probe     | Checks                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Liveness  | No dependency checks.                                                                                                |
| Readiness | PostgreSQL `SELECT 1` through the pool as the runtime role; SQS `GetQueueUrl` for the input queue, which must exist. |

Responses use Terminus's shape: `status` and one `details` entry per probe.

### Shutdown

One signal handler per process handles `SIGTERM` and `SIGINT`. It closes the application, including the hooks that `enableShutdownHooks` would run, within `SHUTDOWN_GRACE_PERIOD_MS` (ADR 0013).

| Component       | Drain behaviour                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP            | Stop accepting work, drain requests in flight, and release idle connections so keep-alive pools cannot hold shutdown open. Requests arriving during the drain receive `503` with `Connection: close`. |
| Consumer        | Abort the receive in flight, finish or return the current message, and return batch messages not yet started.                                                                                         |
| Publisher       | Finish the batch, committing or rolling back.                                                                                                                                                         |
| Scheduler       | Stop claiming between attempts; finish or release the current attempt.                                                                                                                                |
| `WorkerRuntime` | Drain all three background loops in parallel. Shared `WorkerLoop` behaviour resolves each stop only when its current cycle commits or rolls back.                                                     |

A completed drain exits `0`. A drain that exceeds the grace period exits `75`. Unfinished financial work has not committed, so messages can redeliver and connection-held claims release. The container's stop grace period is longer than the application's, leaving the process to decide when it is done.

---

## 12. Failure recovery

Each failure window has its own suite, opened with the rest of the system quiet. The combined crash drill also opens both duplicate-producing windows in one running system; see [crash recovery verification](#crash-recovery-verification).

### Financial commit and delivery

| Failure window                                  | Durable state                                            | Recovery and duplicate behaviour                                                                                                        | Evidence   |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Crash before financial commit                   | Nothing from the operation.                              | Caller resends with the same key or the queue redelivers. No duplicate effect.                                                          | OUTBOX-001 |
| Commit succeeded; response did not reach caller | Transaction, wallet, ledger, and outbox rows.            | Resend with the same key. The committed reservation replays the stored outcome and its observed balance. No duplicate effect.           | API-013    |
| Commit succeeded; queue acknowledgement did not | Transaction, wallet, ledger, inbox row, and outbox rows. | Inbox absorbs the redelivery and the consumer acknowledges it. Increment `wager_duplicates_detected_total`; no second financial effect. | MSG-006    |

### Outbox publication

| Failure window                                                     | Durable state                                          | Recovery and duplicate behaviour                                                                                                                    | Evidence   |
| ------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Financial commit succeeded; publication not started                | Pending outbox rows.                                   | Any publisher claims and publishes. No duplicate from this window.                                                                                  | OUTBOX-005 |
| Publisher claimed rows but did not publish                         | Pending rows; PostgreSQL releases locks on disconnect. | The next publisher claims them. No duplicate from this window.                                                                                      | OUTBOX-005 |
| Broker accepted publication; `published_at` commit did not succeed | Outbox rows still pending.                             | Republish the same `eventId`. Each crash can add one copy; consumers deduplicate. FIFO deduplication IDs help but are not required for correctness. | OUTBOX-006 |

### Dependencies and shutdown

| Failure                | Durable state                                     | Recovery and duplicate behaviour                                                                                                                                                                                                                                   | Evidence                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| PostgreSQL unavailable | Unchanged.                                        | HTTP returns `503` with `Retry-After`. Consumers increase message visibility backoff until redrive dead-letters exhausted receives. Publishers back off; readiness fails. No duplicate effect.                                                                     | API-006, MSG-008, OBS-004 |
| SQS unavailable        | Financial commits continue; outbox backlog grows. | Publishers retry with backoff. Consumers delay after receive errors. Readiness fails and `wager_outbox_lag_seconds` rises. No financial duplicate.                                                                                                                 | OUTBOX-007, OUTBOX-008    |
| `SIGTERM`              | Whatever already committed.                       | HTTP drains; consumer finishes or returns held messages; publisher finishes its batch; scheduler finishes or releases its attempt. Exceeding the grace period exits `75`. Uncommitted work redelivers or releases its claim, without a duplicate financial effect. | MSG-010, OPS-007          |

### Pending references

| Failure                                                | Durable state                                      | Recovery and duplicate behaviour                                                                                    | Evidence        |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------- |
| Scheduler crashes during an attempt                    | Pending state unchanged; claim released.           | Next scheduler takes the due row. Only one worker claims a row at a time.                                           | REF-002         |
| Transient reprocessing failure                         | Transaction unchanged; schedule due after backoff. | Retry without a retry limit. No duplicate effect.                                                                   | REF-006         |
| Positively classified permanent infrastructure failure | `FAILED` with `PROCESSING_FAILED`.                 | Operations investigates using the transaction ID. Replays return `500`; no duplicate effect.                        | TX-009, REF-006 |
| Reference never resolves                               | `PENDING_REFERENCE` until the expiry check.        | After an attempt still finds it missing, reject with `REFERENCE_NOT_FOUND` and emit the event. No duplicate effect. | REF-004         |

---

## 13. Verification and delivery status

### Shipped scope

All required entries in [docs/acceptance.yaml](docs/acceptance.yaml) are `implemented` and `passing`, with the responsible suite named for each entry. `make check` runs them all.

The foundation is verified by integration tests: NestJS on Bun, startup configuration validation, PostgreSQL with both roles, LocalStack with three queues and dead-letter redrive, migrations, and both health endpoints. Compose runs one API and two workers from one image.

[docs/demonstrations.md](docs/demonstrations.md) demonstrates the same guarantees against a running stack. [docs/implementation-plan.md](docs/implementation-plan.md) records the build order; it is now an implementation record, not future work.

Three entries are marked `optional`. The load-test report was built afterwards as an extension: `bun run test:load` drives three `api` instances and the two workers, and [docs/load-experiment.md](docs/load-experiment.md) is its report. The other two are deliberately unimplemented, and the acceptance file records what each would add.

| Optional extension       | Acceptance ID | Status                                                    |
| ------------------------ | ------------- | --------------------------------------------------------- |
| Load-test report         | OPS-008       | Built: [docs/load-experiment.md](docs/load-experiment.md) |
| Double-entry bookkeeping | LEDGER-010    | Not built                                                 |
| OpenTelemetry tracing    | OPS-009       | Not built                                                 |

### Concurrency verification

Three separate processes run with independent heaps, entity managers, and connection pools. The scenario arms them, then releases them at an agreed instant. PostgreSQL coordinates them; promise races inside one runtime do not establish the multi-instance guarantee.

| Scenario                                                              | Observed result                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two `80.00` bets against `100.00`, repeated for 20 rounds             | One `PROCESSED`; one `REJECTED INSUFFICIENT_BALANCE`; balance `20.00`; one `DEBIT` alongside the opening credit. Retrying either outcome replays it without another debit.                                                       |
| Fifty copies of one bet                                               | One debit and 49 replays, all with the applied transaction's ID. One instance applies it while other instances replay it.                                                                                                        |
| 200 wallets, 20 bets each                                             | Every bet applies; each wallet has exactly its own 20 debits.                                                                                                                                                                    |
| Hold one wallet's bet before commit; submit to another wallet         | The second wallet commits while the first waits, from both another process and the same instance. This detects a lock broader than one row and an application mutex, without relying on runner timing (`conc.parallel-wallets`). |
| Mixed bets, duplicates, refunds, and rollbacks against shared targets | PostgreSQL's `deadlocks` counter stays unchanged. This also detects deadlocks that a retry might otherwise hide.                                                                                                                 |
| Continuous reconciliation while three instances bet on one wallet     | Every report is consistent. The tested load shows no extra cost compared with the unobserved load; reconciliation takes no wallet lock.                                                                                          |

These tests do not establish a throughput or latency target for one wallet. Its financial transaction duration bounds its throughput.

### Version and lock controls

| Control       | Verification                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version guard | Two sessions read a wallet without locking, then submit their computed balances. One update matches no row and is refused instead of overwriting the other.                                     |
| Lock mode     | Ten pairs reserve, then request the wallet. `FOR NO KEY UPDATE` serializes them with consecutive versions. The rejected `FOR UPDATE` alternative deadlocks in every pair with SQLSTATE `40P01`. |
| Lock timeout  | The unit of work classifies waits beyond `LOCK_TIMEOUT_MS` and increments `wager_lock_conflicts_total` for both HTTP and queue work.                                                            |

Source checks enforce what a race test cannot prove:

1. No advisory locks or table locks anywhere.
2. Every row lock is one of the three reviewed locks, in its reviewed mode: wallet, outbox claim, or scheduler claim.
3. The wallet repository is the table's only writer. Only the two wagering operation paths take its lock, and their shared financial step issues its guarded update.

### Contract conformance

The gate compares implementation and documentation in three ways:

| Check                              | Failure condition                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Route inventory in both directions | A registered route has no documented operation, or a documented operation has no route.                                                                      |
| Payload schemas                    | Any operation response, outbox event, or document example violates its declared schema. A recursive walk also rejects numeric amounts anywhere in a payload. |
| Code enumerations                  | Domain codes, adapter status mappings, both transport contracts, and both system-contract tables differ. Every code must include a caller action.            |

The running-service status matrix covers each operation's malformed, unknown, conflicting, and transient refusals. A second instance with an unavailable database drives the transient cases. The suite checks `422` against the business rejection that produces it and reconciliation, which deliberately returns `200` for divergence.

The conformance sweep confirmed the existing surface without changing it. Other suites verify that `/docs-json` serves the authoritative file unchanged, that logs satisfy the actual output contract, and that replacing `ProviderIdentityPort` enforces the provider boundary.

### Crash recovery verification

`test/concurrency/crash-recovery.test.ts` runs three workers and uses `SIGKILL` at two barriers:

1. **Delivery committed, acknowledgement pending.** The drill verifies the committed financial state and completed inbox row before killing the worker. The missing action is acknowledgement; inbox completion already committed with the money (ADR 0010).
2. **Publication accepted, publication commit pending.** The drill verifies that the broker received the event before killing the publisher whose database commit has not recorded it.

Workers announce each barrier. The drill checks the durable state, then kills the process. An unreached barrier fails the run, so a window that never opened cannot count as a survived crash.

Recovery then uses only surviving and restarted instances. No manual recovery step drives it. They:

- Absorb the queue redelivery.
- Republish the pending outbox row with the same event ID.
- Apply a parked reversal whose referenced operation arrived during the kills.

The final assertions require one debit, one entry for that debit, one downstream application per event after `eventId` deduplication, terminal states for every transaction, and every touched wallet matching its balance rebuilt from its own ledger in SQL.

Duplicates use deduplication IDs the broker has never seen. The database and downstream event-ID deduplication therefore absorb them, independently of the broker's deduplication window.

Evidence: MSG-006, MSG-011, OUTBOX-005, OUTBOX-006, REF-002, REF-005, CONC-005, RECON-004.

---

## 14. Decisions and limits

### Accepted architecture decisions

Every ADR is `accepted` and shipped as recorded. None was superseded, deprecated, or amended during implementation. [docs/acceptance.yaml](docs/acceptance.yaml) tracks verification by acceptance ID.

| ADR                                                                                                | Decision                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001 — Money](docs/decisions/0001-money-representation-and-persistence.md)                        | `bigint` minor units, `NUMERIC(20,2)` storage, exact strings between layers, no rounding, and one bound for inputs, arithmetic, and storage.                                                                                                                                                            |
| [0002 — Concurrency](docs/decisions/0002-wallet-concurrency-strategy.md)                           | Pessimistic `FOR NO KEY UPDATE` wallet lock, version guard, check constraint, and fixed lock order.                                                                                                                                                                                                     |
| [0003 — Schema enforcement](docs/decisions/0003-database-enforcement-of-financial-consistency.md)  | Unique keys, checks, ledger and transaction immutability triggers, two database roles, and deferred balance-to-ledger triggers on both tables.                                                                                                                                                          |
| [0004 — Idempotency](docs/decisions/0004-persistent-idempotency-and-replay.md)                     | Provider-scoped keys, bound external IDs, canonical payload hash, and replay reconstructed from persisted facts.                                                                                                                                                                                        |
| [0005 — Outbox](docs/decisions/0005-outbox-publication-protocol.md)                                | `FOR UPDATE SKIP LOCKED` claims within one publisher transaction, bounded sends, and retry backoff without loss.                                                                                                                                                                                        |
| [0006 — Wallet outcomes](docs/decisions/0006-wallet-operation-outcomes.md)                         | Provider-caused business refusals return failure codes. Applied operations return a new wallet and ledger entry.                                                                                                                                                                                        |
| [0007 — Transaction states](docs/decisions/0007-wager-transaction-state-machine.md)                | Named transitions update the transaction in place. One table defines transitions and terminality; terminal transitions throw.                                                                                                                                                                           |
| [0008 — Persistence mapping](docs/decisions/0008-persistence-model-for-the-domain-mapping.md)      | `EntitySchema` row classes and mappers keep ORM-owned instances separate from frozen aggregates and private transitions.                                                                                                                                                                                |
| [0009 — References](docs/decisions/0009-reference-resolution-and-reversal-eligibility.md)          | Resolve provider references under the wallet lock, decide pair eligibility in the domain, and query the reversal-index predicate before applying.                                                                                                                                                       |
| [0010 — Inbox identity](docs/decisions/0010-queue-delivery-identity-and-the-inbox-claim.md)        | Insert the inbox claim first and complete it with the financial commit. Hash message `data`. A second submission method wraps the shared financial body.                                                                                                                                                |
| [0011 — Pending references](docs/decisions/0011-pending-reference-recovery.md)                     | Claim one schedule row per attempt with `FOR UPDATE SKIP LOCKED`, reuse the submission financial step, check expiry after an attempt, and fail only on positively identified permanent failures.                                                                                                        |
| [0012 — Logs and metrics](docs/decisions/0012-structured-logs-and-operational-metrics.md)          | JSON lines through `Logger`, unit-of-work identity in `AsyncLocalStorage`, one redaction adapter, and typed metric names and labels in `Metrics`.                                                                                                                                                       |
| [0013 — Runtime and shutdown](docs/decisions/0013-runtime-roles-and-the-shutdown-protocol.md)      | `APP_ROLE` selects controllers and background processes. One signal handler bounds draining; HTTP releases idle connections; `WorkerLoop` gives all background processes the same stop behaviour.                                                                                                       |
| [0014 — Suite isolation](docs/decisions/0014-isolating-the-suites-from-the-demonstration-stack.md) | Tests and demonstrations share containers but each use their own database and queue trio. A queue prefix provides the queue isolation.                                                                                                                                                                  |
| [0015 — Load measurement](docs/decisions/0015-measuring-the-service-under-load.md)                 | A scenario of this repository's own, on an overlay that adds three `api` instances and changes nothing else. It counts completed unique operations apart from replays and rejections, reads the counters and gauges the service already exports, and drains before reconciling every wallet it touched. |

### Deliberate limits

| Area                          | Limit or trade-off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher connections         | A publication transaction holds a connection during broker I/O, bounded by batch size and timeout. Leases would add tuning and a reaper (ADR 0005).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Publication throughput        | Event publication, not financial processing, is this stack's ceiling. The publishers moved 500–570 outbox rows per second against the roughly 2,200 per second that about 1,200 operations per second produce. The backlog peaked above 84,000 rows and the oldest unpublished row reached minutes of age; both gauges returned to zero once load stopped. It costs no correctness, because a row publishes at least once whatever the backlog (ADR 0005), and it shows in the metric an operator alerts on. The levers are the publisher's batch size, its poll interval, and the number of `worker` instances, none of which this version tunes ([docs/load-experiment.md](docs/load-experiment.md)). |
| Event order                   | Publisher instances do not establish global event order. Consumers order by `walletVersion` or `occurredAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Reversal depth                | A `REFUND` can be rolled back. A `ROLLBACK` cannot be reversed. A refunded bet cannot be refunded again after its refund is rolled back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Compatibility                 | One reversal per transaction, positive `LOSS` amounts, and binding a provider transaction ID to its first key are deliberate tightenings. System contract section 20.2 records their compatibility consequences.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Wallet concurrency            | An explicit repository SQL lock is required; the ORM lock mode is unsuitable. One wallet's throughput is bounded by its financial transaction duration. Concurrency evidence establishes independent wallets, not a latency target (ADR 0002). What the bound costs was measured: with half the traffic aimed at four of sixty wallets, those four answered at about twice the median and eleven to thirteen times the 99th percentile of the rest, and `wager_lock_conflicts_total` stayed at zero.                                                                                                                                                                                                    |
| Money and currency            | Maximum balance is `999999999999999999.99`; excess credits return `BALANCE_LIMIT_EXCEEDED`. BRL is the only operated settlement currency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Failed transactions           | Replays return `500` with the outcome body. A generic provider retry policy may keep resending until it reads that body; retries are harmless. `FAILED` emits no event in this version and remains visible through reads and metrics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reference latency             | Recovery polls with backoff instead of being triggered by target arrival. After arrival, the worst-case wait is one backoff step, at most five minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reconciliation                | Per-wallet, on demand, report-only. The schema enforces the invariant at commit; every money-moving suite checks it. A deployment must schedule calls if it wants continuous assurance and decide how operators handle divergence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Authentication and read scope | Identity-provider integration is deferred. An authenticated deployment must also scope the three provider-free reads or reserve them for operators; PostgreSQL has no row-level security. See [authentication and read access](#authentication-and-read-access).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Input and error boundaries    | Malformed correlation IDs are replaced. Paths or methods outside the documented operations use framework errors. See [problem details and correlation IDs](#problem-details-and-correlation-ids).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
