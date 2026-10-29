---
status: accepted
date: 2026-10-29
---

# Measure the service with a scenario of its own, on an overlay of the deployed stack

## Context and Problem Statement

Every guarantee this service makes is proven by a suite, and none of them says what the guarantees
cost. The concurrency design is an argument — a row lock per wallet (ADR 0002), an outbox drained by
a claim protocol with no lease (ADR 0005), an inbox that absorbs redeliveries (ADR 0010) — and an
argument about throughput is worth whatever a measurement says it is worth. OPS-008 asked for that
measurement: throughput, latency percentiles, error rate, lock conflicts and outbox lag, against the
Compose stack with three `api` instances.

A load number is easy to produce and easy to make meaningless. Three questions decide whether this
one is worth keeping: what configuration was measured, what the numbers count, and what was true of
the money afterwards. A report that measured a stack tuned for the occasion describes something
nobody runs; one that folds persisted business rejections into an error rate, or counts idempotent
replays as completed work, reports a system other than this one; and one that stops at the
throughput leaves the only question a financial service is actually judged on unanswered.

## Decision Drivers

- The numbers have to describe the configuration this repository deploys, not a variant of it.
- Attempts, completed unique operations and replays are three different things here
  (`idem.persistent`), and a persisted `REJECTED` is the service working (`rule.rejected.no-effect`),
  so the accounting has to keep them apart or it is not describing this service.
- Both entry points reach the same financial use case (`msg.same-use-case`); measuring only HTTP
  would leave the half with a broker in it unmeasured.
- The service already exports what an operator alerts on (`obs.metrics`, `outbox.lag-metrics`); a
  measurement that invented its own counters instead would be measuring the harness.
- Whatever the load, stored balance must equal ledger-derived balance for every wallet touched
  (RECON-004), and that has to be part of the experiment rather than an afterthought.
- `make check` must stay a gate: a throughput is not an assertion, and a suite that failed because a
  laptop was busy would be a check nobody trusts.
- Two runs of one command have to be comparable, or the report is an anecdote.

## Considered Options

- No experiment: the suites prove correctness and the design argument stands on its own
- An off-the-shelf load tool against the HTTP endpoint
- A scenario in this repository, driving both entry points, measuring from the service's own metrics

## Decision Outcome

Chosen option: "A scenario in this repository", because what has to be measured is not request
throughput but _completed financial operations_, and nothing outside this repository can tell a
completed operation from a replay of one, a persisted rejection from a failure, or a drained outbox
from a backlog. `bun run test:load` ([test/load](../../test/load)) is that scenario, and
[docs/load-experiment.md](../load-experiment.md) is its report.

**The topology is an overlay, not a stack.** [compose.load.yaml](../../compose.load.yaml) gives the
`api` service three replicas and a published port range for them, with `!override` because Compose
merges port lists by appending, and changes nothing else: same image, same environment, same two
`worker` instances, same probes. `compose-load-stack` compares every other resolved field of both
roles against the base stack, so a knob tuned for the experiment fails a test rather than quietly
becoming the thing measured. The range is one variable, `LOAD_API_PORTS`, decided by the `Makefile`
beside the other per-checkout ports and reported by `make stack`; which instance got which port is
asked of Compose, never computed.

**The definitions are the deliverable.** Throughput is completed unique operations per second over a
measured window that excludes a warm-up, with the attempt rate and the enqueue rate reported beside
it and never folded into it. The error rate is infrastructure errors — `503`, any other `5xx`, a
transport failure — over _every_ attempt in the window, per entry point; business rejections and
replays are counted apart, and a request the service refused to read is a defect in the generator
with a category of its own. Percentiles are nearest-rank, so a reported percentile is a measurement
that happened, and `wager_processing_duration_seconds` is read back as a second, independent source.
Counters are deltas between a scrape of all five instances at each end of the window, summed across
instances because a counter is per instance; the two outbox gauges are taken as the highest reading,
because a gauge is one level several instances read from the same database.

**Queue latency names both of its ends and claims nothing in between.** It starts at the broker's
acknowledgement and ends at the operation's recorded timestamp, which is the service's _receipt_:
the use case reads its clock once per submission, so `created_at` and `processed_at` carry the same
instant and the row cannot decompose further. What that measures is the hand-off, and the processing
it excludes is the queue entrypoint's own histogram, reported next to it rather than added into one
number that would look measured and not be.

**Nothing is counted until the work in hand is finished.** When load stops, the input queue, the
run's non-terminal rows and the outbox are drained within a documented timeout; work still pending
is reported as pending and never counted as completed. Then every wallet the run touched is
reconciled twice: a SQL rebuild of its balance from its ledger, independent of the service's
arithmetic and compared as decimal strings (ADR 0001), and the
`POST /wallets/{walletId}/reconciliation` endpoint an operator would use.

**It measures and asserts almost nothing.** The scenario is not in `make check` and has no expected
throughput; the arithmetic behind it is unit-tested apart from the stack
([test/unit/load-measure.test.ts](../../test/unit/load-measure.test.ts)), which is the part a defect
could hide in, since a report nobody can recompute reads exactly like a correct one. The one thing
the run does assert is the invariant no load may break: it exits non-zero on a divergence, a
`FAILED` outcome, a request the service refused to read, or a drain that timed out.

### Consequences

- Good, because the numbers are attributable: the environment, the resolved inputs, the database size
  before the run and the per-instance topology all travel inside the report.
- Good, because the measurement reads the operational surface the service already has, so a number
  in the report is a number an operator sees — and the experiment found the condition
  `outbox.lag-metrics` exists for, a backlog above 84,000 rows and a lag of minutes, in exactly that
  metric.
- Good, because the accounting distinguishes what this service distinguishes, which turned a would-be
  error rate of several percent into what it is: zero infrastructure errors and ~5 % persisted
  business rejections the scenario asked for.
- Good, because the invariant is checked under the load rather than asserted away from it: 94,160
  ledger entries across the two runs, written by five instances, with no divergence.
- Neutral, because contention is reported as a latency split between contended and uncontended
  wallets. `wager_lock_conflicts_total` counts operations that gave up after `LOCK_TIMEOUT_MS` and
  stayed at zero, so it says nothing about contention below that ceiling; the split says what
  queueing on one row costs.
- Bad, because the generator shares the host with the stack and no container declares a limit, so
  the ceiling measured is a property of that arrangement and not of the service alone.
- Bad, because the queue hand-off is largely LocalStack's FIFO receive scheduling, so that number is
  honest about this stack and not a prediction for SQS.
- Bad, because the experiment takes minutes rather than seconds: a measured half-minute of HTTP load
  leaves the publisher minutes of publishing to do, and the drain waits for it instead of hiding it.
- Worth revisiting if the service gains a load-bearing tier this cannot drive — a second service, a
  cache, a read replica — or if the numbers are ever wanted as a release gate, at which point the
  thresholds, the host and the broker all have to stop being whatever the machine happened to be.

### Confirmation

Acceptance entries OPS-008 and RECON-004 in [acceptance.yaml](../acceptance.yaml). The arithmetic is
asserted by `load-measure-*` in [test/unit/load-measure.test.ts](../../test/unit/load-measure.test.ts)
and the topology by `compose-load-stack` in
[test/integration/compose-stack.test.ts](../../test/integration/compose-stack.test.ts), both inside
`make check`. The evidence itself is two recorded runs in [load-experiment.md](../load-experiment.md),
the second against the database the first had filled: ~1,100–1,320 completed operations per second,
a median under 12 ms, no infrastructure error in 83,473 attempts, and every one of the 120 wallets
reconciled by both methods.

## Pros and Cons of the Options

### No experiment: the suites prove correctness and the design argument stands on its own

- Good, because nothing is built and nothing new can rot.
- Bad, because the cost of the design stays an argument, and the first number anyone asks for is the
  one nobody has.
- Bad, because the outbox publisher being four times slower than the operations that fill it is
  invisible to every suite: each one proves a row is published, none asks how fast.

### An off-the-shelf load tool against the HTTP endpoint

- Good, because the generator is somebody else's code, with percentiles and pacing already solved.
- Good, because the output format is one reviewers may already know.
- Neutral, because it would still need this repository's topology and its warm-up and drain around
  it.
- Bad, because it counts HTTP responses: an idempotent replay is a `200` and a persisted rejection is
  a `422`, so completed work, duplicates and business refusals arrive as one number and the error
  rate it prints is wrong for this service.
- Bad, because it cannot reach the queue entry point, which is half of what the service is, nor read
  the outbox gauges, nor reconcile afterwards — so the report would need a second harness anyway.
- Bad, because it adds a dependency and a second way to configure a run, for the part of the problem
  that was never hard.

### A scenario in this repository, driving both entry points, measuring from the service's own metrics

- Good, because the accounting can be exactly this service's vocabulary, and the definitions live
  next to the code that produces the numbers.
- Good, because one process drives both entry points, scrapes the five instances, drains and
  reconciles, so a run is one command and one report.
- Neutral, because the percentile and histogram arithmetic has to be written, which is why it is
  unit-tested.
- Bad, because it is code in this repository that `make check` does not exercise end to end: the
  gate covers its arithmetic and its topology, and the scenario itself is only exercised when
  somebody runs it.

## More Information

Rules measured: `conc.multi-instance`, `conc.row-lock`, `obs.metrics`, `outbox.lag-metrics`,
`msg.same-use-case`, `idem.persistent` and `recon.final-invariant` in
[system-contract.md](../system-contract.md). ADR 0002 owns the lock the contention split measures,
ADR 0005 the publisher whose backlog the gauges report, ADR 0010 the inbox that absorbs the duplicate
sends, and ADR 0014 the per-checkout isolation the experiment's ports extend.
