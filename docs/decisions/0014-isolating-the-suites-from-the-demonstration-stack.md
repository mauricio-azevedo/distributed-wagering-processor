---
status: accepted
date: 2026-10-29
---

# Give the suites their own database and queues on the one set of containers

## Context and Problem Statement

One checkout runs two things against its containers. `make up` and `make demo` run the topology of
`compose.yaml` — one `api`, two `worker` instances — and the demonstrations drive it. `make test`
needs no instance of the service: the suites boot the applications they assert about, drive a
consumer of their own, claim outbox rows themselves and truncate the tables between cases.

Until now both used the `wagering` database and the three queues of `msg.queues`, so they could not
run at the same time: a `worker` left running took messages the suites had sent, claimed the outbox
rows they were about to publish and swept the schedule they were asserting about, and the suites
truncated the tables that `worker` was writing to. The repository handled it by asking for a
`make down` in between, in `README.md`, `CONTRIBUTING.md` and `docs/demonstrations.md`.

That is a prerequisite held in prose. A reader who misses it sees the suite that proves determinism
fail for a reason that has nothing to do with the code, and loses the data of the walkthrough they
were reading. The question is where the boundary between the two belongs, given that the ports and
the Compose project are already per checkout (`ops.compose`) and that nothing may change about what
the service guarantees.

## Decision Drivers

- A green gate must not depend on remembering a command; whatever the state of the stack, `make
test` has to be correct.
- The demonstrations are what a reviewer watches; a test run must not empty the tables behind them.
- The three queue names are the transport contract (`docs/asyncapi.yaml`), so whatever is done, a
  deployment that is told nothing must address exactly those names.
- The suites must keep running against real PostgreSQL and real SQS, with the same migrations, the
  same constraints and the same redrive policy as the stack.
- A reviewer runs this on a laptop: a second PostgreSQL and a second LocalStack cost memory and
  startup time on every `make check`.
- Isolation is already per checkout; a second mechanism that numbered things differently would be
  two ideas where one would do.

## Considered Options

- Keep one namespace and document the turn-taking
- A second Compose stack for the suites, with its own PostgreSQL and LocalStack
- One set of containers, two namespaces: a database and a queue prefix of the suites' own

## Decision Outcome

Chosen option: "One set of containers, two namespaces", because the collision is about names and
not about processes: two databases in one PostgreSQL and two trios of queues in one LocalStack
separate the two completely, at the cost of one `CREATE DATABASE` and three more queues, while a
second stack would double what a reviewer's machine runs to solve the same naming problem.

`docker/postgres/01-roles.sql` creates `wagering_test` beside `wagering`, owned by
`wagering_migrator`, with the same grants and the same default privileges — stated once and applied
in each database, because default privileges are per database. The two roles of ADR 0003 are
unchanged and shared: the suites exercise the privilege separation they assert about.

`docker/localstack/queues.sh` creates the three queues twice, each trio with its own dead-letter
queue and its own redrive policy after five receives: the names the contract fixes, and the same
names under `test-`.

`SQS_QUEUE_PREFIX` is what the service addresses them by. It is a validated setting that defaults
to empty, so a deployment that sets nothing addresses the contract names, and `wagerQueues(prefix)`
is the one place a name is composed: the consumer, the dead-letter hand-off, the publisher and the
readiness probe all read the trio the composition root resolved once, so no component can disagree
with another about which trio it means. The pattern the setting accepts is what SQS accepts in a
queue name, bounded so that the longest name under it stays inside the eighty characters SQS
allows — an unusable prefix is refused at startup rather than at the first `GetQueueUrl`.

`make test` passes the suites `DATABASE_URL`, `MIGRATION_DATABASE_URL` and `SQS_QUEUE_PREFIX` on the
command line. An exported variable wins over `.env`, so the stack's database and the stack's queues
are out of reach of a truncation or a receive even when `.env` names them, and the addresses are
built from the same `POSTGRES_PORT` the Compose project publishes, so the per-checkout isolation
keeps working unchanged. `make stack` reports all three.

### Consequences

- Good, because `make check` and `make demo` are independent: either runs with the other's state in
  place, and the gate no longer has a prerequisite that lives in prose.
- Good, because the suites keep their truncation between cases, which is what makes a case
  independent, without it being destructive to anything a reader is looking at.
- Good, because the isolation is proven rather than described: the suites compare what they address
  to what Compose resolves for the `api`, `worker` and `migrate` services, so the two namespaces
  cannot quietly become one again.
- Good, because the queue prefix is a setting a deployment has a use for on its own — several
  environments of this service on one broker account — and not a hook that exists for the tests.
- Neutral, because the suites' database is migrated by the suites, as it already was: every suite
  that needs the schema runs `migrator.up()` in its `beforeAll`.
- Bad, because two things now have to be created for a checkout to be usable, so an existing
  PostgreSQL volume has to be dropped once (`make down`) for the init script to run again. The
  init scripts run only on an empty data directory.
- Bad, because the prefix is stated in two places that have to agree: `TEST_QUEUE_PREFIX` in the
  `Makefile` and the prefix `docker/localstack/queues.sh` creates. The queue bootstrap assertions
  of INFRA-002 fail if they drift.
- Bad, because `bun test` run directly, outside `make test`, now addresses the stack's namespace and
  fails the isolation cases. That is the correct answer to the question those cases ask, but it is a
  worse error message than the one a reader deserves; `make test TESTS=…` is the way to run a
  subset.
- Worth revisiting if the suites ever need a topology the stack does not have — a different
  PostgreSQL version, or a broker the stack does not run — which is the point where a second set of
  containers stops being a duplicate of this one.

### Confirmation

Acceptance entry OPS-010 in [acceptance.yaml](../acceptance.yaml). The suites compare the database
and the queue names they address to the ones `docker compose config` resolves for the service roles;
INFRA-002 asserts both trios exist in LocalStack and that both input queues redrive after five
receives. The whole gate was run with `make up` in place — one `api` and two `worker` instances
healthy — and with the demonstrations' data in the stack's database.

## Pros and Cons of the Options

### Keep one namespace and document the turn-taking

- Good, because nothing is built.
- Bad, because the correctness of the gate depends on a reader following a note in three documents.
- Bad, because the failure it produces is a flaky financial suite, which is the worst possible
  disguise for a configuration problem.
- Bad, because a test run destroys the state of a running demonstration.

### A second Compose stack for the suites, with its own PostgreSQL and LocalStack

- Good, because no setting is added to the service: the suites would address the contract names on
  containers of their own.
- Good, because the suites could run a different version of a dependency than the stack.
- Bad, because every `make check` starts and waits for a second PostgreSQL and a second LocalStack,
  on a machine that is already running the stack.
- Bad, because the per-checkout numbering would have to be extended to a second project per
  checkout, which is a second isolation mechanism beside the one that already works.

### One set of containers, two namespaces: a database and a queue prefix of the suites' own

- Good, because it separates exactly what collided — names — and nothing else.
- Good, because the setting it adds is one a deployment outside this repository has a use for.
- Neutral, because the suites' database is created by the same init script as the stack's, so the
  two cannot be configured differently by accident.
- Bad, because the prefix is stated in the `Makefile` and in the LocalStack bootstrap, and the two
  have to agree.

## More Information

Rules carried: `ops.suite-isolation`, and `ops.compose`, `msg.queues` and `ops.two-db-roles` as it
amends them, in [system-contract.md](../system-contract.md). ADR 0003 owns the two database roles
this shares, ADR 0005 owns the publisher that reads the events queue and ADR 0010 owns the consumer
that reads the input queue.
