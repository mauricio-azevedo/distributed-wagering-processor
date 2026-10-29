# Distributed Wagering Processor

A wallet and wagering transaction service for game providers. Providers open wallets for players and submit bets, payouts, losses, refunds and rollbacks over HTTP or through an SQS queue. The service keeps one exact balance per wallet, an immutable ledger of every balance change, persistent idempotency for every operation, and publishes integration events through a transactional outbox. It stays correct when the same operation arrives several times, when dependent operations arrive out of order, and when several instances process the same wallet at once.

## Status

| Area                                        | State                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System contract, decisions, acceptance plan | Complete; `make check` passing                                                                                                                                                                                              |
| Infrastructure foundation                   | Runs: the NestJS service on Bun, PostgreSQL with both roles, LocalStack with the three queues, the migration step, liveness and readiness endpoints                                                                         |
| Domain model                                | `Money`, the `Wallet` aggregate with its immutable ledger entries, the `WagerTransaction` state machine, the inbox and outbox records and the typed integration events                                                      |
| Persistence mapping                         | Tables, row mappings and transactional repositories behind one unit of work                                                                                                                                                 |
| Schema enforcement                          | Every guarantee of ADR 0003, in reversible migrations: uniqueness, validity, referential integrity, the append-only triggers, the per-table privileges and the deferred triggers that tie a balance to its ledger at commit |
| Operation identity                          | The canonical payload hash and the PostgreSQL reservation that decides a replay, a payload mismatch or a bound provider transaction id; the entry points that answer them follow                                            |
| Wallet opening and reads                    | Runs: `POST /wallets` with its atomic opening credit, `GET /wallets/{walletId}`, and RFC 9457 problem details for every refused request                                                                                     |
| Reconciliation                              | Runs: `POST /wallets/{walletId}/reconciliation` compares the stored balance with the ledger in one read-only snapshot, and reports a divergence without ever repairing it                                                   |
| Bet submission                              | Runs: `POST /wagering/transactions` applies a `BET` under the wallet lock, persists its rejection when a rule refuses it, replays a stored outcome, and answers `503` with `Retry-After` on a transient failure             |
| Outbox publication                          | Runs: concurrent publishers claim committed outbox rows with `FOR UPDATE SKIP LOCKED`, publish them to `wager-integration-events.fifo` and record the publication; the runtime role that starts one in a deployment follows |
| Queue entry point and inbox                 | Runs: a message on `wager-transactions.fifo` runs the same use case as the controller, its inbox row commits with the financial effect, and it is deleted only after that commit; retries and dead letters follow           |
| Remaining wagering behaviour                | Planned; see the [implementation plan](docs/implementation-plan.md)                                                                                                                                                         |

The service starts, reports its readiness and applies migrations against the Compose dependencies. The domain layer holds the `Money` value object and the `Wallet` aggregate: a wallet opens at version 1, refuses an uncovered debit, a foreign currency, a foreign owner and a credit past the money bound with the failure code each one carries, and answers every applied operation with the new balance, the next version and the one immutable ledger entry that mirrors them. Beside it, a `WagerTransaction` is born pending with the reference requirement of its kind validated, records every outcome with the balance observed at that moment, and once processed, rejected or failed refuses every further transition and keeps what it recorded. Beside them are the inbox row that makes a redelivery a no-op, the outbox row that carries a committed event with its fixed event id and capped retry backoff, and the four integration events, each fixing its type and version in its class and serializing every amount as a string. The first migration creates the tables and the mappings carry a row into the aggregate its factory would have produced and back, with every amount exact to the cent; the repositories reach a use case only inside a transaction, on an entity manager forked for that operation alone. The schema refuses what no invariant allows whatever issued the write: duplicate wallets, provider transactions, idempotency keys, reversals and opening credits; unknown kinds, statuses, directions and failure codes; a negative balance, an unbalanced entry, a non-finite amount, an entry in a currency other than its wallet's; any update or delete of a ledger entry, any delete of a transaction row and any change to one that already reached its outcome. The runtime role holds `select` and `insert` on the ledger, no `delete` anywhere and no DDL. Two more triggers, deferred to commit, tie a balance to the ledger that explains it: a wallet row mirrors the head of its ledger or carries version 1 and `0.00` with no ledger at all, and every entry continues the one before it and is continued by the one after it, so a balance change without its entry, an entry without its balance change, an entry squeezed between two others and a version gap cannot be committed, whatever issued the write. On top of all of it sits operation identity: a submission is hashed over the canonical JSON of its business fields alone, so the same operation is one hash through either entry point whatever order or envelope it arrives in, and the first statement of a financial transaction inserts that row with its two unique keys, which is how fifty copies of one bet become one row, how a key reused for different content becomes a conflict rather than a replay, and how a process that exited still leaves the decision behind.

The service now has its first behaviour. `POST /wallets` commits, in one transaction, the wallet row, the `OPENING` transaction already `PROCESSED` under the reserved `system` provider, the `CREDIT` entry that mirrors the balance at `walletVersion` 1 and the two outbox rows that announce it; an initial balance of `0.00` commits the wallet alone, because a ledger entry records a movement and there is none. A failure anywhere inside leaves no row in any table, and a duplicate is nothing the use case looks for: the unique key on the player and the currency is the only check, so two instances opening the same wallet at the same moment end at one wallet and one `409 WALLET_ALREADY_EXISTS` with the first wallet untouched. `GET /wallets/{walletId}` returns the current balance and version, and every refused request leaves as RFC 9457 problem details carrying its stable error code and the correlation id of the response header, whether a schema, a use case or the body parser refused it.

`POST /wallets/{walletId}/reconciliation` proves the balance the service produced. It compares the stored balance with the ledger that explains it — credits minus debits summed by the database, and the balance the entry at the wallet's own version left behind — and answers `200` whether or not the two agree, with the signed difference between them. Both readings come from one `REPEATABLE READ`, read-only snapshot taken without locking the wallet, so they cannot straddle a balance change and reconciling a busy wallet costs its processing nothing. A divergence is reported, logged and counted, and never corrected: a service that quietly fixed a balance would destroy the only evidence of the defect behind it. The same comparison, written independently in SQL, is the invariant every test that moves money ends with.

`POST /wagering/transactions` is the financial core. One submission claims its idempotency key by inserting the transaction row, locks the wallet with `SELECT ... FOR NO KEY UPDATE`, and commits — together or not at all — the outcome on that row, the new balance under the version it read, the single `DEBIT` entry that mirrors it and the outbox rows that announce it. A bet the balance cannot cover, one in another currency and one naming another player are not errors but outcomes: each is a `422` with its stable failure code, persisted and auditable, leaving balance, ledger and version untouched. A repetition of the same operation returns the stored outcome with `idempotentReplay: true` and the balance observed when it was recorded, however far the balance has moved since; the same key with another payload is a `409`, and so is a second key for a provider transaction id that already exists. A wait for the wallet lock longer than `LOCK_TIMEOUT_MS` is a `503` with `Retry-After` that persists nothing, so the resend is a new operation — and if instead the connection drops after the commit was confirmed, the resend finds the stored outcome and replays it, because the key was committed by the same transaction as the money. Only `BET` is accepted for now: the four kinds that apply to a transaction they reference arrive with reference resolution.

The outbox publisher delivers what those commits left behind. One cycle is one transaction: it claims the due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, sends each row's stored envelope to `wager-integration-events.fifo` with the wallet as the message group and the event id as the deduplication id, marks what the broker took, schedules what it refused, and commits. The claim is the only coordination between instances: any number of publishers work on one table and receive disjoint batches, a publisher that dies hands its rows back the moment PostgreSQL closes its connection, and a row is claimable only once it is committed. The send happens before the commit that records it, which is the choice that makes a crash in that window a duplicate instead of a loss — every publication of a row carries the event id and the envelope it was enqueued with, so a consumer deduplicating by `eventId` applies it once. No row is ever dropped: a failed publication is counted and retried with exponential backoff capped at five minutes, and from the tenth attempt the publisher records the row for an operator while the retries continue. Ordering across publishers is not promised; consumers order a wallet's balance events by `walletVersion` and everything else by `occurredAt`.

The queue is the second entry point and not a second implementation. A `WagerTransactionRequested` message is validated against the messaging contract, becomes the very command the controller builds, and runs the same use case; what it adds is a delivery identity. The inbox row for `(consumerName, messageId)` — the id the producer assigned, never the broker's receipt id — is claimed as the first statement of the financial transaction and completed by the same commit, so a redelivery is absorbed without a second effect, a message id reused for other content is refused with the first delivery untouched, and the message is deleted only after the commit returned: a worker killed in that window costs one redelivery and nothing else. The same operation submitted over HTTP and then through the queue is one debit and a replay, and the message's correlation id, or its message id when it carries none, reaches every event the operation produced. A message the consumer cannot apply is classified, counted and logged, and waits in the queue; the visibility backoff and the dead-letter queue arrive with the next slice.

What the service still owes is the rest of the behaviour: the recovery of a transaction parked waiting for its reference, the read endpoints, the queue's failure handling and the runtime roles, so nothing yet retries a pending reference, pages the ledger, backs a message off, nor runs the consumer and the publisher outside their own suites. The contract, the decisions and the acceptance plan fix what the service guarantees, how it is built and how each guarantee is proven, so that implementation proceeds slice by slice with the acceptance plan as its scoreboard.

## Stack

Bun (version in `.bun-version`), TypeScript (strict), NestJS, PostgreSQL, MikroORM, AWS SQS through LocalStack, Docker Compose. The HTTP and queue shapes are defined in `docs/openapi.yaml` and `docs/asyncapi.yaml`; DTOs and message classes implement them.

## Commands

Docker is required: the dependencies run in Compose and the image is part of the gate.

```sh
bun install --frozen-lockfile   # install the toolchain
cp .env.example .env            # addresses of the Compose dependencies, read by Bun and by Compose
make                            # list the targets
make stack                      # this checkout's Compose project, image and published ports
make dev                        # start PostgreSQL and LocalStack, apply migrations, run the service with reload
make up                         # the whole stack in containers: dependencies, migrations, the service on HTTP_PORT
make down                       # stop the stack and drop its data
make migrate                    # apply pending migrations as the migrator role
make test                       # the test suites, against the Compose dependencies
make check                      # the whole quality gate; CI runs the same target
make fmt                        # rewrite files with Prettier
```

`GET /health/live` answers while the process serves HTTP; `GET /health/ready` answers `200` only when PostgreSQL and SQS are reachable, with one entry per dependency.

A single clone publishes the service on `3000`, PostgreSQL on `5433` and LocalStack on `4566`. Each `git worktree` of this repository gets its own Compose project, image and block of ports instead, so two checkouts run `make check` at the same time and `make down` in one leaves the other running. `make stack` prints what a checkout uses; `make` passes it to Compose, so a `docker compose` or `psql` command typed by hand needs `eval "$(make -s stack)"` first, or it addresses the wrong stack.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the gate, the pull request rules, CI, the board and the issue forms.

## Documents

| Document                                                   | Read it for                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [docs/system-contract.md](docs/system-contract.md)         | Every rule the service guarantees, with stable ids, failure codes and adopted interpretations           |
| [docs/openapi.yaml](docs/openapi.yaml)                     | The HTTP contract: every endpoint, request, response, header, status code and the pagination rule       |
| [docs/asyncapi.yaml](docs/asyncapi.yaml)                   | The messaging contract: queues, the input message, integration events, envelopes and delivery semantics |
| [docs/glossary.md](docs/glossary.md)                       | The vocabulary used by the rules and the code                                                           |
| [ARCHITECTURE.md](ARCHITECTURE.md)                         | Layers, runtime topology, decisions, database enforcement, failure windows, limitations                 |
| [docs/decisions](docs/decisions/README.md)                 | Architecture decision records in MADR 4.0.0 and the templates for new ones                              |
| [docs/acceptance.yaml](docs/acceptance.yaml)               | Every obligation mapped to rules, enforcement, scenario, expected outcome and planned evidence          |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Delivery slices with the acceptance ids each one must turn green                                        |
| [CONTRIBUTING.md](CONTRIBUTING.md)                         | Quality gate, pull requests, CI, repository settings, ADRs, board and issue conventions                 |
| [AGENTS.md](AGENTS.md)                                     | The rules a coding agent follows in this repository; `CLAUDE.md` is a symlink to it                     |

## Repository map

```
AGENTS.md                    rules for coding agents; CLAUDE.md symlinks to it
ARCHITECTURE.md              current design and decisions
CONTRIBUTING.md              gate, pull requests, CI, settings, ADRs, board, issues
docs/system-contract.md      behavioural rules (area.name ids)
docs/openapi.yaml            HTTP contract (OpenAPI 3.1)
docs/asyncapi.yaml           messaging contract (AsyncAPI 3.0)
docs/glossary.md             terms
docs/decisions/              architecture decision records (MADR 4.0.0) and templates
docs/acceptance.yaml         acceptance plan and verification status
docs/implementation-plan.md  delivery slices
src/main.ts                  bootstrap: validated environment, NestJS application, shutdown hooks
src/app.module.ts            composition root
src/domain/                  framework-free domain model: Money, Wallet, WagerTransaction, WalletLedgerEntry, inbox and outbox records, integration events, operation and opening-credit identity, kinds, failure and error codes, domain errors
src/application/             use cases (OpenWallet, GetWallet, ReconcileWallet, SubmitWagerTransaction, PublishOutbox), the ports they depend on (persistence repositories, unit of work, event publisher, clock, id generator, logger, metrics), the request-level errors they answer with
src/infrastructure/          configuration, HTTP (controllers, DTOs, validation, problem details, correlation id), persistence (row mappings, repositories, unit of work, migrations), messaging (SQS client, the events publisher and the publisher loop), health, clock and id generator
test/                        unit, integration and concurrency suites, run by bun test
compose.yaml, Dockerfile     the stack and the image
docker/                      PostgreSQL roles and LocalStack queues, applied once at container init, and stack.sh, which names this checkout's stack
.env.example                 the variables the service, the migration step and the suites read
Makefile                     stack, check, fmt, fmt-check, lint, typecheck, test, audit, build, dev, infra, migrate, up, down
.bun-version                 the Bun version CI installs
.github/                     ci and pr-title workflows, issue forms, PR template
package.json, bun.lock       toolchain dependencies
eslint.config.js, tsconfig.json, .prettierrc.json
```
