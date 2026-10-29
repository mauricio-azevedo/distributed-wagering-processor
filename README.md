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
| Wagering behaviour                          | Planned; see the [implementation plan](docs/implementation-plan.md)                                                                                                                                                         |

The service starts, reports its readiness and applies migrations against the Compose dependencies. The domain layer holds the `Money` value object and the `Wallet` aggregate: a wallet opens at version 1, refuses an uncovered debit, a foreign currency, a foreign owner and a credit past the money bound with the failure code each one carries, and answers every applied operation with the new balance, the next version and the one immutable ledger entry that mirrors them. Beside it, a `WagerTransaction` is born pending with the reference requirement of its kind validated, records every outcome with the balance observed at that moment, and once processed, rejected or failed refuses every further transition and keeps what it recorded. Beside them are the inbox row that makes a redelivery a no-op, the outbox row that carries a committed event with its fixed event id and capped retry backoff, and the four integration events, each fixing its type and version in its class and serializing every amount as a string. The first migration creates the tables and the mappings carry a row into the aggregate its factory would have produced and back, with every amount exact to the cent; the repositories reach a use case only inside a transaction, on an entity manager forked for that operation alone. The schema refuses what no invariant allows whatever issued the write: duplicate wallets, provider transactions, idempotency keys, reversals and opening credits; unknown kinds, statuses, directions and failure codes; a negative balance, an unbalanced entry, a non-finite amount, an entry in a currency other than its wallet's; any update or delete of a ledger entry, any delete of a transaction row and any change to one that already reached its outcome. The runtime role holds `select` and `insert` on the ledger, no `delete` anywhere and no DDL. Two more triggers, deferred to commit, tie a balance to the ledger that explains it: a wallet row mirrors the head of its ledger or carries version 1 and `0.00` with no ledger at all, and every entry continues the one before it and is continued by the one after it, so a balance change without its entry, an entry without its balance change, an entry squeezed between two others and a version gap cannot be committed, whatever issued the write. On top of all of it sits operation identity: a submission is hashed over the canonical JSON of its business fields alone, so the same operation is one hash through either entry point whatever order or envelope it arrives in, and the first statement of a financial transaction inserts that row with its two unique keys, which is how fifty copies of one bet become one row, how a key reused for different content becomes a conflict rather than a replay, and how a process that exited still leaves the decision behind.

The service now has its first behaviour. `POST /wallets` commits, in one transaction, the wallet row, the `OPENING` transaction already `PROCESSED` under the reserved `system` provider, the `CREDIT` entry that mirrors the balance at `walletVersion` 1 and the two outbox rows that announce it; an initial balance of `0.00` commits the wallet alone, because a ledger entry records a movement and there is none. A failure anywhere inside leaves no row in any table, and a duplicate is nothing the use case looks for: the unique key on the player and the currency is the only check, so two instances opening the same wallet at the same moment end at one wallet and one `409 WALLET_ALREADY_EXISTS` with the first wallet untouched. `GET /wallets/{walletId}` returns the current balance and version, and every refused request leaves as RFC 9457 problem details carrying its stable error code and the correlation id of the response header, whether a schema, a use case or the body parser refused it.

What the service still owes is the rest of the behaviour: nothing submits a transaction yet, there is no consumer and no publisher, so no arrival is answered with the replay or the `409` the reservation decides and nothing publishes the outbox rows an opening leaves behind. The contract, the decisions and the acceptance plan fix what the service guarantees, how it is built and how each guarantee is proven, so that implementation proceeds slice by slice with the acceptance plan as its scoreboard.

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
src/application/             use cases (OpenWallet, GetWallet), the ports they depend on (persistence repositories, unit of work, clock, id generator), the request-level errors they answer with
src/infrastructure/          configuration, HTTP (controllers, DTOs, validation, problem details, correlation id), persistence (row mappings, repositories, unit of work, migrations), messaging (SQS), health, clock and id generator
test/                        unit and integration suites, run by bun test
compose.yaml, Dockerfile     the stack and the image
docker/                      PostgreSQL roles and LocalStack queues, applied once at container init, and stack.sh, which names this checkout's stack
.env.example                 the variables the service, the migration step and the suites read
Makefile                     stack, check, fmt, fmt-check, lint, typecheck, test, audit, build, dev, infra, migrate, up, down
.bun-version                 the Bun version CI installs
.github/                     ci and pr-title workflows, issue forms, PR template
package.json, bun.lock       toolchain dependencies
eslint.config.js, tsconfig.json, .prettierrc.json
```
