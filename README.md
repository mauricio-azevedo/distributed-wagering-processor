# Distributed Wagering Processor

A wallet and wagering transaction service for game providers. Providers open wallets for players and submit bets, payouts, losses, refunds and rollbacks over HTTP or through an SQS queue. The service keeps one exact balance per wallet, an immutable ledger of every balance change, persistent idempotency for every operation, and publishes integration events through a transactional outbox. It stays correct when the same operation arrives several times, when dependent operations arrive out of order, and when several instances process the same wallet at once.

## Status

| Area                                        | State                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| System contract, decisions, acceptance plan | Complete; `make check` passing                                                                                                                      |
| Infrastructure foundation                   | Runs: the NestJS service on Bun, PostgreSQL with both roles, LocalStack with the three queues, the migration step, liveness and readiness endpoints |
| Domain model                                | `Money`, the `Wallet` aggregate with its immutable ledger entries, and the `WagerTransaction` state machine; messaging and the ORM mapping follow   |
| Financial behaviour                         | Planned; see the [implementation plan](docs/implementation-plan.md)                                                                                 |

The service starts, reports its readiness and applies migrations against the Compose dependencies. The domain layer holds the `Money` value object and the `Wallet` aggregate: a wallet opens at version 1, refuses an uncovered debit, a foreign currency, a foreign owner and a credit past the money bound with the failure code each one carries, and answers every applied operation with the new balance, the next version and the one immutable ledger entry that mirrors them. Beside it, a `WagerTransaction` is born pending with the reference requirement of its kind validated, records every outcome with the balance observed at that moment, and once processed, rejected or failed refuses every further transition and keeps what it recorded. No persistence, HTTP or messaging behaviour exists yet, so nothing writes a wallet or a transaction to PostgreSQL. The contract, the decisions and the acceptance plan fix what the service guarantees, how it is built and how each guarantee is proven, so that implementation proceeds slice by slice with the acceptance plan as its scoreboard.

## Stack

Bun (version in `.bun-version`), TypeScript (strict), NestJS, PostgreSQL, MikroORM, AWS SQS through LocalStack, Docker Compose. The HTTP and queue shapes are defined in `docs/openapi.yaml` and `docs/asyncapi.yaml`; DTOs and message classes implement them.

## Commands

Docker is required: the dependencies run in Compose and the image is part of the gate.

```sh
bun install --frozen-lockfile   # install the toolchain
cp .env.example .env            # addresses of the Compose dependencies, read by Bun and by Compose
make                            # list the targets
make dev                        # start PostgreSQL and LocalStack, apply migrations, run the service with reload
make up                         # the whole stack in containers: dependencies, migrations, the service on :3000
make down                       # stop the stack and drop its data
make migrate                    # apply pending migrations as the migrator role
make test                       # the test suites, against the Compose dependencies
make check                      # the whole quality gate; CI runs the same target
make fmt                        # rewrite files with Prettier
```

`GET /health/live` answers while the process serves HTTP; `GET /health/ready` answers `200` only when PostgreSQL and SQS are reachable, with one entry per dependency.

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
src/domain/                  framework-free domain model: Money, Wallet, WagerTransaction, WalletLedgerEntry, kinds, failure codes, domain errors
src/infrastructure/          configuration, persistence (MikroORM, migrations), messaging (SQS), health
test/                        unit and integration suites, run by bun test
compose.yaml, Dockerfile     the stack and the image
docker/                      PostgreSQL roles and LocalStack queues, applied once at container init
.env.example                 the variables the service, the migration step and the suites read
Makefile                     check, fmt, fmt-check, lint, typecheck, test, audit, build, dev, infra, migrate, up, down
.bun-version                 the Bun version CI installs
.github/                     ci and pr-title workflows, issue forms, PR template
package.json, bun.lock       toolchain dependencies
eslint.config.js, tsconfig.json, .prettierrc.json
```
