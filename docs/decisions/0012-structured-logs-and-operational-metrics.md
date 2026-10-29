---
status: accepted
date: 2026-10-29
---

# Bind the correlation id per unit of work, redact in one log adapter, and expose metrics with prom-client

## Context and Problem Statement

An operator debugging a duplicate debit has to follow one operation across an HTTP request, a queue message and
a scheduled retry minutes later, and has to see retries, dead letters, lock conflicts and outbox lag without
reading the database (`obs.structured-logs`, `obs.metrics`, `obs.correlation-propagation`,
`outbox.lag-metrics`). Three things stood in the way of simply writing the lines.

The identity fields are not where the lines are written. A correlation id belongs to the request or the message;
the transaction id, the wallet and the provider identity belong to the outcome a use case recorded. Threading
both through every call would put a transport concern into the signature of every financial method, and the
application layer names no framework (`model.framework-free-domain`).

A log line is a financial record the moment it carries an amount. `obs.no-sensitive-data` admits exactly one
exception, the reconciliation divergence record, and an exception that lives in the discipline of every caller
is not an exception a reviewer can audit.

Some work outlives the arrival that created it. A publication happens in another process, in another cycle; an
attempt at a parked transaction happens up to an hour later (ADR 0011). Both must still be findable under the
id of the operation that caused them, and neither has a request or a message in flight to read it from.

## Decision Drivers

- An identity field must reach every line of a unit of work without being an argument of every method.
- "No log line carries an amount" has to be a property of the output, not of each call site's care.
- The exception that may carry one has to be auditable: nameable in a type and findable by grep.
- The metric names and label values are the operational contract, so a typo must be a compile error.
- A scrape must answer the outbox backlog on any instance, including one running no publisher at all.
- Two applications started in one process — which is what an integration suite does — must not share totals.

## Considered Options

- `pino` through `nestjs-pino`, with its redaction list and its request-scoped child logger
- A hand-written JSON-lines adapter behind the existing `Logger` port, with `AsyncLocalStorage` for the context
- Passing a context object explicitly from every entry point through every use case

For the metrics surface, separately:

- `prom-client` with a `Registry` per application instance
- Extending the hand-rolled `CounterRegistry` with gauges, a histogram and a text exposition of its own

## Decision Outcome

Chosen options: "A hand-written JSON-lines adapter behind the existing `Logger` port, with `AsyncLocalStorage`
for the context" for logging, and "`prom-client` with a `Registry` per application instance" for metrics.

The log port gains `info` beside `error`, and one method more: `divergence`. That is the whole of the
`obs.no-sensitive-data` exception — the one method whose fields are written unredacted, with a type of its own
naming the amount it may carry. Every other line passes through `redacted`, which replaces both a field named
for money or a payload and any value shaped like a `MoneyProps` amount. So the guarantee holds for a caller who
never thought about it, and "which lines may carry an amount" is answered by the type and by one grep.

`AsyncLocalStorage` holds the two fields an entry point knows and a use case does not: the correlation id and,
on the queue, the message id. The HTTP middleware binds them before any handler runs — before the body parser
can refuse a payload, so a problem response carries an id like every other (`api.correlation-header`) — and the
consumer binds them for the whole handling of one message, from the parsed body to the acknowledgement. The
adapter merges the bound context under the fields the caller named, so a caller that knows a correlation id
itself still wins: the publisher reads it off the stored envelope, which is the id of the operation that
produced the fact and not of the cycle that relayed it.

Work that outlives its arrival carries that arrival's id rather than a fresh one. `pending_reference_schedule`
gains a `correlation_id` column, written when the transaction is parked and never rewritten, so every attempt
and every event of a recovery is searchable under the request or message that created the work. A column, not a
derivation: the correlation id of an arrival is recorded nowhere else, and an attempt an hour later has nothing
to derive it from.

The metrics port spells each counter with the labels one occurrence of it carries, as a mapped type, so a name
or a label value that is not in the contract does not compile, and a counter with no labels cannot be given
any. `MetricsRegistry` declares every documented metric when it is constructed — a scrape of an idle instance
carries each name with its type, so an operator's panel reads zero rather than nothing — and holds a
`prom-client` `Registry` of its own rather than the library's global default.

The two outbox gauges are measured by a use case on every scrape, in the read-only snapshot
(`recon.snapshot`'s boundary), and not written by a publisher cycle. The backlog of an instance whose publisher
is stopped is exactly the backlog an operator needs; a measurement taken on a cycle would go quiet when
publication stopped. A database that cannot be reached fails the measurement and not the scrape: the counters
this instance holds are still the truth about it, and losing the whole exposition would lose the metrics that
say why.

### Consequences

- Good, because every line of a request or a delivery carries the identity fields without a single financial
  method taking a logging argument, so the application layer stays free of transport concerns.
- Good, because redaction is one function on the one path every line takes, which is what makes OBS-002
  assertable over the real output of the running service rather than over a mock's arguments.
- Good, because the one record that may carry an amount is a method and a type, so an amount cannot reach a log
  line by a caller's oversight and the exception survives review.
- Good, because a scheduled attempt and a publication are searchable under the operation that caused them,
  which is the question an operator actually asks of a duplicate debit.
- Good, because the metric names and their labels are a compile-time contract, and the registry is per
  instance, so a suite and `/metrics` read what the use cases raised and two applications in one process do not
  share totals.
- Neutral, because `prom-client` is the one dependency this slice adds; the exposition format, the histogram
  arithmetic and the escaping are a specification worth not reimplementing, while a JSON line is not.
- Neutral, because a scrape costs one indexed aggregate over `outbox_messages`, taken without locking, so it
  never waits on a publisher holding a batch.
- Bad, because `AsyncLocalStorage` is invisible in a signature: a context lost across an API that breaks async
  propagation would silently drop the correlation id from a line rather than fail. The suites that assert the
  id on every captured line of a request and of a delivery are what keeps that honest.
- Bad, because the redaction is shape-based, so a legitimately amount-shaped value — some future ratio or
  version rendered as `1.00` — would be replaced on a line that meant no harm.
- Worth revisiting when tracing arrives (#27): a span context has to travel the same path as the correlation
  id, and an OpenTelemetry context would subsume this `AsyncLocalStorage` rather than sit beside it.

### Confirmation

Acceptance entries OBS-001, OBS-002, OBS-003, OBS-005 and OUTBOX-008 in [acceptance.yaml](../acceptance.yaml).
The redaction, the context and the exposition are proven over the adapters with no database; the integration
suite captures the sink the running service writes to and asserts that every line of an HTTP submission and of
a delivery is JSON carrying the identity fields, that no line of a bet carries its amount or either balance
while the divergence record carries the difference, that the id of a request reaches the response header, every
line and every stored event, that a parked transaction's claim row and its later attempt and publication carry
the arrival's id, and that the backlog gauges rise with the publisher stopped and fall to zero once it ran.
Each counter is asserted by a suite that drives the path owning it: the two queue dispositions in the
retry-and-dead-letter suite, the two backoffs in the publisher and scheduler suites, the duplicates and the
lock conflict in the entry-point suites, the divergence in the reconciliation suite.

## Pros and Cons of the Options

### `pino` through `nestjs-pino`

- Good, because the request-scoped logger, the JSON encoding and a redaction list arrive ready-made, and pino's
  throughput is far beyond anything this service needs.
- Neutral, because its redaction is a list of paths: it protects the fields someone remembered, which is the
  property this slice deliberately moved away from the call site.
- Bad, because its request logging describes HTTP rather than operations, so the default output is a second
  vocabulary beside `event` and the identity fields, and turning it off is most of what it brings.
- Bad, because three dependencies for what the `Logger` port already abstracts buys no guarantee the port does
  not already give: the service writes one line per operation, not a million.

### A hand-written JSON-lines adapter with `AsyncLocalStorage`

- Good, because the sink is an argument, so a suite reads the real lines and the production path is the one
  under test.
- Good, because redaction and the single documented exception live in the adapter every line passes through.
- Bad, because the ordering, the levels and the encoding are now this repository's to maintain.

### Passing a context object explicitly through every use case

- Good, because the propagation is visible in every signature and cannot be lost by an async boundary.
- Bad, because a transport identity would then be a parameter of every financial method, including the ones a
  scheduled sweep calls with nothing to put in it.

### Extending the hand-rolled `CounterRegistry`

- Good, because it adds no dependency and the existing counters already work.
- Bad, because the Prometheus text format is a specification — label escaping, cumulative histogram buckets,
  `_sum` and `_count`, the content type a scraper negotiates — and a subtle mistake in it is a dashboard that
  reads wrong rather than one that fails loudly.

## More Information

Rules carried: `obs.structured-logs`, `obs.no-sensitive-data`, `obs.metrics`, `obs.correlation-propagation`,
`outbox.lag-metrics`, `api.correlation-header`, `msg.correlation`, `recon.divergence-handling`,
`ref.scheduler` in [system-contract.md](../system-contract.md). `/metrics` is defined in
[openapi.yaml](../openapi.yaml). ADR 0005 owns the publication the publisher reports, ADR 0011 owns the claim
row the correlation id was added to, and the dashboards and tracing that consume this surface are tracked as
v2 work (#28, #27).
