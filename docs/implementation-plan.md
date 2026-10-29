# Implementation plan

Delivery slices ordered by risk and dependency. Each slice names the acceptance entries it had to turn green (ids from [acceptance.yaml](acceptance.yaml)) and the evidence that closed it. A slice was done when its entries were `implemented` and `passing`, `make check` was green, and the ledger-reconstruction invariant (RECON-004) held in every suite it added.

Every slice below has shipped, in this order; this file is now the record of how the service was built, and [acceptance.yaml](acceptance.yaml) is the scoreboard it kept.

Development is test-first throughout: a failing unit test for domain behaviour before the production code, integration tests against PostgreSQL and LocalStack in containers for adapters, real parallelism and several processes for concurrency.

## 0. foundation — Contract, decisions and plan

Scope: this repository state. System contract, glossary, the transport contracts (`docs/openapi.yaml`, `docs/asyncapi.yaml`), ADRs 0001 to 0005, architecture, acceptance plan, the `make check` gate and the CI workflows that run it.

Acceptance: OPS-001.

Exit evidence: `make check` passes locally and in CI.

## 1. infrastructure — Runnable service and dependencies

Scope: the NestJS application on Bun with its validated environment; MikroORM configuration and the migration step, run as the migrator role; Docker Compose with PostgreSQL (both roles bootstrapped at init), LocalStack with the three queues and the dead-letter redrive, the image and one `api` instance; `GET /health/live` and `GET /health/ready` with the PostgreSQL and SQS probes; the integration suite against the containers; `make dev`, `make up`, `make migrate`, `make test` and `make build` in the gate.

Acceptance: OBS-004. Groundwork recorded as `in-progress`: OPS-004 (both roles exist and the runtime role cannot change the schema; table ownership is proven once tables exist), OPS-005 (the loader refuses a missing or invalid variable by name; the remaining variables arrive with their features), OPS-006 (the stack has no `worker` instances yet).

Exit evidence: `make up` answers `200` on `/health/ready` with both entries up; the infrastructure suite is green in `make check`.

## 2. domain-money-transitions — Domain model and persistence mapping

Scope: `Money` over `bigint` minor units; `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` with private constructors, factories and `rehydrate`; the status machine; `IntegrationEvent` and its four subclasses; the row mappings of ADR 0008 with the `MoneyType`; the persistence ports and their MikroORM adapters, reachable only through a `UnitOfWork` that forks an entity manager per operation; the first migration creating the tables.

Acceptance: MODEL-001, MODEL-002, MODEL-003, MODEL-004, MODEL-005, MONEY-001, MONEY-002, MONEY-003, MONEY-004, MONEY-005, MONEY-008, MONEY-009, MONEY-010, MONEY-012, WALLET-011, WALLET-012, TX-003, TX-005, TX-006, TX-008, LEDGER-003, LEDGER-004, SCHEMA-020, OUTBOX-010.

Exit evidence: unit suites green without any I/O; a round-trip test per entity against PostgreSQL proves exact money persistence and rehydration into the state the factories produced.

## 3. schema-wallet-opening — Schema enforcement, wallet opening, reconciliation

Scope: constraints, indexes, triggers and the per-table privileges of ADR 0003, on the two roles the stack bootstraps; reversible migrations; `OpenWallet` use case with the opening credit; `GET /wallets/{walletId}`; `ReconcileWallet` and its endpoint; problem details for request errors.

Acceptance: SCHEMA-001 through SCHEMA-019, SCHEMA-021 through SCHEMA-026, OPS-002, OPS-004, WALLET-001, WALLET-002, WALLET-003, WALLET-005, WALLET-008, WALLET-009, WALLET-010, LEDGER-001, LEDGER-002, LEDGER-006, LEDGER-009, MONEY-007, API-002, API-007, API-008, RECON-002, RECON-003, RECON-004, RECON-005.

Exit evidence: one direct-SQL violation test per schema guarantee, executed as the runtime role; migrations applied up, down and up again on a clean database.

## 4. atomic-bet — BET processing, idempotency, outbox insertion

Scope: `SubmitWagerTransaction` for `BET` with the lock order of ADR 0002; idempotency reservation, payload hash and replay from ADR 0004; observed balance; ledger entry with `walletVersion`; outbox rows written in the same transaction; `GET /wallets/{walletId}/ledger` with cursor pagination; the transaction read endpoints; `503` with `Retry-After` on transient failures.

Acceptance: RULE-001, RULE-002, RULE-018, WALLET-004, WALLET-006, WALLET-007, TX-001, TX-002, TX-004, TX-007, TX-010, LEDGER-007, LEDGER-008, IDEM-001 through IDEM-009, IDEM-011, IDEM-012, API-003, API-004, API-006, API-010, MONEY-006, MONEY-011, OUTBOX-001, OUTBOX-002, OUTBOX-004.

Exit evidence: atomicity test with an injected failure after the ledger insert leaves no row anywhere; replay after a wallet change and a restart returns the original observed balance.

## 5. concurrent-debits — Competing debits and duplicate storms

Scope: the concurrency suite with real parallelism: two bets against one balance, fifty copies of one bet, distinct wallets in parallel, three processes against one database; `lock_timeout` handling; reconciliation under load.

Acceptance: CONC-001 through CONC-009, RECON-001, RECON-004.

Exit evidence: the canonical scenario (opening 100.00, two bets of 80.00) ends with one `PROCESSED`, one `REJECTED`, balance 20.00 and one `DEBIT` entry, repeatedly and across three processes.

## 6. reversals-references — Remaining kinds and reference recovery

Scope: `WIN`, `LOSS`, `REFUND`, `ROLLBACK`; the balance bound on credits; reference resolution and every reference rule; pending references with the scheduler, backoff, expiry, transient retries and `FAILED` on permanent errors; `202` with `Location`; all four events emitted at the right moments.

Acceptance: RULE-003 through RULE-017, RULE-019, RULE-020, REF-001 through REF-006, TX-009, LEDGER-005, MONEY-013, API-005, OUTBOX-011.

Exit evidence: a `ROLLBACK` delivered before its `BET` is parked, then applied once the `BET` arrives; a reversal that would go negative is rejected with its own code; a second reversal of one target is rejected.

## 7. sqs-inbox-dlq — Queue consumer, inbox, retry and dead letters

Scope: the SQS consumer calling the same use case; persistent inbox; classification of outcomes; visibility backoff and redrive; permanent failures to the dead-letter queue; `SIGTERM` behaviour; two `worker` instances in Docker Compose.

Acceptance: MSG-001 through MSG-012, IDEM-010, OPS-006.

Exit evidence: a worker killed after commit and before acknowledgement leads to a redelivery with no second effect; a malformed message lands in the dead-letter queue immediately; a transient failure is retried and succeeds.

## 8. outbox-publisher — Concurrent publication and recovery

Scope: the outbox publisher of ADR 0005; two publishers on one outbox; a publisher killed while holding a claim; a lost commit after a send; backoff on broker failure; the integration events queue with its group and deduplication ids; the consumer-facing ordering contract. The pending and lag metrics move to slice 9 with the rest of the observability surface, so this slice reports a stalled row through the log and OUTBOX-008 is green there.

Acceptance: OUTBOX-002, OUTBOX-003, OUTBOX-004, OUTBOX-005, OUTBOX-006, OUTBOX-007, OUTBOX-009, OUTBOX-012.

Exit evidence: two publishers drain one outbox without losing a row; a publisher killed while holding a claimed batch leaves its rows to the next instance; a publication whose commit is lost is published again with the same `eventId` and applied once by a reference consumer.

Cross-slice verification of this slice and `sqs-inbox-dlq`: the two windows that produce a duplicate are also opened together, in one run of the service with three instances, by the crash-recovery drill (`test/concurrency/crash-recovery.test.ts`). It kills a worker that has committed a delivery and not acknowledged its message and a publisher whose publication reached the broker and whose commit never happened, both at a barrier it asserts the pre-kill state at, and then leaves the recovery to the surviving and restarted instances (MSG-006, MSG-011, OUTBOX-005, OUTBOX-006, REF-002, REF-005, CONC-005, RECON-004). It is also the last suite to adopt the ledger-reconstruction sweep, which is what turns RECON-004 green.

## 9. http-observability-shutdown — Remaining surface and operations

Scope: consistent status classes across every endpoint; `docs/openapi.yaml` served at `/docs` and `/docs-json`; structured logs with redaction; metrics; the remaining configuration variables; graceful shutdown of every role; the authentication extension point; acceptance statuses updated with the evidence of every slice.

Acceptance: API-001, API-009, API-011, API-012, MODEL-006, OBS-001, OBS-002, OBS-003, OBS-005, OUTBOX-008, OPS-003, OPS-005, OPS-007, AUTH-001, AUTH-002. Optional extensions tracked but not scheduled: LEDGER-010, OPS-008, OPS-009.

Landed in three parts: the observability surface with ADR 0012; the runtime roles and the shutdown protocol with ADR 0013, and with them this slice's share of slice 7 — MSG-010 and OPS-006; then the HTTP conformance sweep and the authentication extension point.

The reviewer documentation closed it: the README setup path from a clean checkout, ARCHITECTURE.md describing what was built with its trade-offs and limitations, the seven demonstrations of [demonstrations.md](demonstrations.md) in `make demo`, and the evidence of the seven entries that had been held open for the crash-recovery drills — TX-001, TX-007, LEDGER-005, LEDGER-007, IDEM-001, IDEM-009 and REF-001.

Exit evidence: `make check` green with every required entry `implemented` and `passing`; the acceptance plan is the release report.

## 10. suite-isolation — The gate and the demonstrations side by side

Scope: `wagering_test` beside `wagering` and a second trio of queues under a prefix, both created by the init scripts the stack already runs; `SQS_QUEUE_PREFIX` as a validated setting composed in one place; `make test` addressing them, per checkout; ADR 0014; the three documents that used to ask for a `make down` between `make demo` and `make check`.

Acceptance: OPS-010. Amended with it: MSG-001 and OPS-006, which now cover both namespaces.

Exit evidence: `make up`, then the whole gate, then `make demo`, with no `make down` anywhere between them; the isolation cases compare what the suites address to what `docker compose config` resolves for the service roles.

## 11. reader-experience — One command, and the evidence within reach

Scope: `make demo` installing the dependencies and writing `.env` itself, as the default target; `make logs` and the failure paths that name it; `make drill`, which breaks an invariant on purpose and runs the cases that catch it; the demonstrations walking the refusals and printing the ledger the balance is rebuilt from; the paragraphs of `README.md` the tooling made unnecessary.

Acceptance: OPS-011, OPS-012, OPS-013.

Exit evidence: `make demo` in a fresh clone of this repository, from `git clone` to the eight demonstrations in one command; `make drill` catching all three mutations and leaving no file changed.

## 12. parallel-ci-gate — The gate as four jobs instead of one

Scope: `ci` split into `static` (`fmt-check`, `lint`, `typecheck`, `audit`, `build`), `fast`
(`test/unit` and `test/contract`), `integration` (`test/integration`, sharded three ways by
Bun's `--shard`, balanced with a committed `test/integration.timings.json`) and `concurrency`
(`test/concurrency`); a fifth job, `ci`, depending on all four with nothing of its own, so the
`main` ruleset's required context never changes; ADR 0016.

Acceptance: OPS-014.

Exit evidence: measured on PR #68's own Actions run — 451s → 164s (-64%), longest job
`integration (3)` at 154s; one test broken in each of the four kinds, confirming the gate fails and
names the job; a PR merged through the four-job workflow with the ruleset still gating on `ci`
alone.
