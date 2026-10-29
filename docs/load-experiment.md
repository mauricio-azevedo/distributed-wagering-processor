# Load experiment

What the service costs under sustained load, measured rather than argued (OPS-008). The suites prove
the guarantees hold; none of them says what they cost, and the concurrency design — a row lock per
wallet (ADR 0002), an outbox drained by a claim protocol (ADR 0005), an inbox absorbing redeliveries
— is the kind of argument that is only worth what a measurement says it is.

This document is the report of two recorded runs, with the environment they ran in, the method, the
definitions every number depends on, and the reconciliation that ends them. It is an optional
extension and not part of `make check`: a throughput is whatever the machine did, so there is
nothing here for a suite to assert. The arithmetic behind the numbers is asserted —
[`test/unit/load-measure.test.ts`](../test/unit/load-measure.test.ts) — and so is the topology
([`compose-load-stack`](../test/integration/compose-stack.test.ts)); the numbers themselves are
evidence, read off the exported metrics and the generator's own timers.

## Running it

```sh
bun run test:load
```

It brings up the three-instance topology of [`compose.load.yaml`](../compose.load.yaml) itself and
waits for every container to be healthy, so Docker and a `.env` copied from `.env.example` are the
only prerequisites. `make stack` decides the ports — including `LOAD_API_PORTS`, the three the load
topology publishes — so a linked worktree needs nothing exported. A checkout whose slot was
renumbered while its stack was running pins the old one: `STACK_SLOT=8 bun run test:load`.

Every input has a default, documented in [`test/load/config.ts`](../test/load/config.ts), and the
resolved configuration is carried in the report; the runs below used the defaults. The scenario
writes a JSON report to `LOAD_REPORT_PATH` when it is set and to stdout when it is not, and exits
non-zero when a wallet diverges from its ledger, an operation was recorded `FAILED`, the service
refused to read one of the generator's requests, or the drain timed out with work still pending.

## Environment

Both runs, 2026-10-29, on one machine with the stack and the generator sharing it.

|                  |                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Host             | Linux 6.2.0-32-generic, 20 vCPU, 31 GiB                                                                                                       |
| Docker           | 29.8.1, 20 CPUs and 31 GiB visible to the engine                                                                                              |
| Container limits | none declared; `compose.yaml` sets no `cpus`, `memory` or `deploy.resources`                                                                  |
| Runtime          | Bun 1.4.4 (`.bun-version`), one image for every role                                                                                          |
| Instances        | 3 × `api`, 2 × `worker`, 1 × `migrate` (completed), PostgreSQL, LocalStack                                                                    |
| PostgreSQL       | 18.4; `shared_buffers` 128 MB, `work_mem` 4 MB, `effective_cache_size` 4 GB, `max_connections` 100, `synchronous_commit` on, `read committed` |
| Broker           | LocalStack 4.14.0, SQS FIFO; `SQS_WAIT_TIME_SECONDS` 20, visibility 30 s                                                                      |
| Service settings | `LOCK_TIMEOUT_MS` 3000, `OUTBOX_BATCH_SIZE` 50, `OUTBOX_POLL_INTERVAL_MS` 1000                                                                |
| Generator        | one Bun process on the same host, 32 HTTP submitters and 4 queue producers                                                                    |

The generator competing with the containers for the same 20 cores is a property of this experiment,
not of the service: the ceilings below are what this machine does with both on it.

## Method

**Topology.** `compose.load.yaml` overlays `compose.yaml` with three `api` replicas and a published
port range for them, and changes nothing else — same image, same environment, same two workers, same
probes. The overlay is compared field by field against the base stack by `compose-load-stack`, so the
numbers describe the configuration this repository deploys rather than one tuned for the occasion.
HTTP submitters are pinned round-robin to the three instances; the ports Compose assigned are asked
for, never computed.

**Phases.** A 10 s warm-up, then a 30 s measured window, then load stops and the drain begins.
Windows are half-open, so no attempt is counted in two of them, and every counter in the report is
the difference between a scrape taken at the start of the window and one taken at its end — never a
total, which would carry the warm-up and the wallet pool inside it.

**Wallet pool.** 60 wallets opened before the clock starts, each with a `100000.00 BRL` opening
credit large enough that the random walk of debits and credits cannot exhaust it. Four of them are
contended: half of all attempts are aimed at those four rows, which is what makes contention a
measurement instead of an assumption.

**Mix**, drawn from a seeded generator so two runs draw the same one. HTTP: 55 % `BET`, 25 % `WIN`,
10 % `LOSS`, 10 % `REFUND` of a `BET` the service already processed, plus 5 % of `BET`s aimed above
any balance, and 8 % of all attempts resubmitting the previous operation unchanged. Queue: 60 %
`BET`, 30 % `WIN`, 10 % `LOSS`, with 8 % resending a message id already sent. No reference is ever
sent to the queue and every `REFUND` carries its target's round, wallet, player and amount, so
nothing is parked: a pending reference waits sixty minutes by contract (`ref.ttl`) and would be work
no drain could finish.

**Pacing.** The HTTP path runs as fast as its 32 submitters can go, because a provider waiting on an
answer is what that path is for. The queue path is paced to 100 messages per second across its
producers: a producer waits on nothing, so an unbounded one would simply outrun the two workers and
the latency reported would be the growth of a backlog rather than the cost of a message. Whether the
workers kept up with the offered rate is one of the findings.

**How the numbers were collected.** HTTP and enqueue latencies from the generator's own monotonic
clock around each call. Counters, gauges and the service's own duration histogram from the five
`/metrics` expositions, scraped inside each container (a `worker` publishes no port) and merged:
counters are summed across instances, gauges are taken as the highest reading, because a gauge is
one level several instances read from the same database. The two outbox gauges are also sampled
every 2 s from one `api` instance throughout. Outcomes, queue timestamps and the ledger rebuild come
from SQL against the stack's database.

### Definitions

- **Attempt** — one submission: an HTTP request, or one `SendMessage`.
- **Unique operation** — one idempotency key, `providerId:externalTransactionId`. The mix resubmits
  deliberately, so attempts exceed unique operations.
- **Completed** — an attempt the service answered with a recorded outcome that was not a replay.
  For the queue path, a row whose recorded timestamp falls inside the measured window.
- **Replay** — an answer carrying `idempotentReplay` (HTTP), or a resent message id (queue). Work
  done once, counted once.
- **Business rejection** — `422` with a persisted `REJECTED` row, or `409` against stored state. The
  service working as specified; never an error.
- **Infrastructure error** — `503`, any other `5xx`, or a transport failure. These are the only
  numerator of the error rate, and **the denominator is every attempt in the measured window**,
  business rejections and replays included, per entry point.
- **Throughput** — completed operations per second over the measured window. Attempt rate and
  enqueue rate are reported beside it, never folded into it.
- **Percentile** — nearest-rank: the sample at `ceil(q × n)`, so a reported percentile is a
  measurement that happened and not an interpolation between two that did. The service's own
  histogram is read the way Prometheus reads one, interpolated inside the bucket, and reported
  separately as a second source.
- **Queue hand-off** — from the broker acknowledging the send to the operation's recorded timestamp.
  That timestamp is the service's **receipt**: `SubmitWagerTransaction` reads its clock once per
  submission, before its first statement, so `created_at` and `processed_at` carry the same instant
  and the row cannot decompose further. The hand-off is therefore broker storage plus the consumer's
  long poll, and the processing it excludes is `wager_processing_duration_seconds{entrypoint="queue"}`,
  reported next to it. A hand-off a millisecond below zero is the ordering of two timestamps — the
  producer stamps its clock after the SDK call returns — and not a message received before it was
  sent.
- **Drain** — after load stops, the input queue, the non-terminal rows of this run and the outbox are
  polled until all three are empty or `LOAD_DRAIN_TIMEOUT_MS` (300 s) expires. Work still pending
  then is reported as pending and never counted as completed.

## Results

Run A on a freshly created volume; run B immediately after it, against the database run A had
filled. Identical command and inputs.

|                                               | Run A                                     | Run B                                                          |
| --------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Database before the run                       | empty                                     | 51,805 transactions, 44,298 ledger entries, 96,103 outbox rows |
| HTTP attempts in window                       | 37,969                                    | 45,504                                                         |
| Completed (HTTP)                              | 33,142                                    | 39,607                                                         |
| Idempotent replays answered (HTTP)            | 3,001                                     | 3,632                                                          |
| Business rejections (HTTP)                    | 1,826                                     | 2,265                                                          |
| Infrastructure errors / error rate            | 0 / 0.000 %                               | 0 / 0.000 %                                                    |
| HTTP attempts per second                      | 1,265.6                                   | 1,516.8                                                        |
| Completed per second (HTTP)                   | 1,104.7                                   | 1,320.2                                                        |
| **Completed per second (both paths)**         | **1,167.4**                               | **1,403.1**                                                    |
| HTTP latency p50 / p95 / p99 (ms)             | 11.53 / 94.35 / 209.57                    | 9.47 / 78.64 / 191.77                                          |
| Service histogram, HTTP p50 / p95 / p99 (ms)  | 11.30 / 96.15 / 233.32                    | 9.10 / 85.01 / 222.94                                          |
| Contended wallets p50 / p95 / p99 (ms)        | 21.12 / 140.67 / 257.60                   | 16.69 / 121.85 / 246.12                                        |
| Uncontended wallets p50 / p95 / p99 (ms)      | 8.77 / 16.84 / 22.53                      | 7.14 / 14.28 / 18.82                                           |
| Lock conflicts                                | 0                                         | 0                                                              |
| Enqueues in window (offered 100/s)            | 3,000                                     | 3,000                                                          |
| Enqueue acknowledgement p50 / p95 / p99 (ms)  | 11.39 / 17.01 / 20.77                     | 9.17 / 13.70 / 16.03                                           |
| Queue completions in window                   | 1,879 (62.6/s)                            | 2,486 (82.9/s)                                                 |
| Queue hand-off p50 / p95 / p99 (ms)           | 8,173 / 12,110 / 12,400                   | 4,300 / 5,670 / 5,779                                          |
| Hand-off p50, first tenth → last tenth (ms)   | 1,365 → 5,510                             | 1,215 → 3,281                                                  |
| Service histogram, queue p50 / p95 / p99 (ms) | 11.42 / 76.36 / 217.39                    | 10.65 / 76.83 / 205.58                                         |
| Outbox peak pending / peak lag                | 84,033 rows / 144.7 s                     | 96,064 rows / 186.8 s                                          |
| Drain                                         | 148.3 s, nothing left pending             | 188.6 s, nothing left pending                                  |
| Outbox after the drain                        | 0 rows, 0 s lag                           | 0 rows, 0 s lag                                                |
| Dead letters / parked / `FAILED`              | 0 / 0 / 0                                 | 0 / 0 / 0                                                      |
| Recorded outcomes, whole run                  | 49,254 processed, 2,491 rejected          | 55,408 processed, 2,920 rejected                               |
| Reconciliation                                | 60 wallets, 44,298 entries, 0 divergences | 60 wallets, 49,862 entries, 0 divergences                      |

Duplicates, counted apart because the counter deltas cover the measured window while the generator
counted its duplicate sends across the whole load phase: 3,001 and 3,632 HTTP replays answered from
the stored outcome (`idem.persistent`), and of 328 and 304 duplicate sends, 270 and 252 absorbed by
the inbox inside the window (`msg.redelivery-safe`). `wager_duplicates_detected_total{source="inbox-conflict"}`
stayed at zero, as it must: a resent message id carried the same payload.

## What the numbers say

**The HTTP path sustains about 1,100–1,320 completed operations per second** across three instances,
with a median under 12 ms and a 99th percentile around 200 ms, and **not one infrastructure error in
83,473 attempts** across both runs. The generator's round-trip percentiles and the service's own
histogram agree within 2 ms at the median and about 25 ms at the 99th, which is the request overhead
the generator sees and the service does not.

**Contention costs what the lock order says it should, and `wager_lock_conflicts_total` cannot see
it.** Four wallets taking half the traffic answer with a median around twice that of the other
fifty-six and a 99th percentile eleven to thirteen times higher — queueing on one row, exactly as
ADR 0002 describes. The lock-conflict counter stayed at zero in both runs because it counts
operations that _gave up_ after `LOCK_TIMEOUT_MS`, three seconds, and nothing waited that long: the
worst single attempt observed was 1.06 s. The counter is an alert for a pathology, not a measure of
contention; the latency split is the measure.

**The queue path is bounded by message hand-off, not by the use case.** The service processes a
queued operation in the same 10–11 ms it processes an HTTP one, but the two workers completed only
63–83 operations per second against an offered 100, and the hand-off grew across each run — median
1.2–1.4 s for the first tenth of the messages, 3.3–5.5 s for the last — so the backlog never
stabilised and drained only after load stopped. The cost is in receiving: a 20 s long poll against
LocalStack's FIFO scheduling, with two consumers. Nothing was lost: every message was processed, the
input queue was empty at the end of the drain, and no message reached the dead-letter queue.

**Event publication, not financial processing, is this stack's throughput ceiling.** Each processed
operation commits one or two integration events in the same transaction, so a measured window
producing ~1,200 operations per second leaves ~2,200 outbox rows per second behind it, while the
publishers moved roughly 500–570 rows per second (84,033 rows drained in 148.3 s, 96,064 in 188.6 s).
The backlog peaked above 84,000 rows and the oldest unpublished row reached 145–187 seconds old, and
both gauges returned to zero once load stopped. This is the condition `outbox.lag-metrics` exists
for, and it is visible in exactly the metric an operator would alert on; it costs no correctness,
because a row is published at least once whatever the backlog (ADR 0005) and the ledger stayed exact
throughout.

**Reconciliation held under every bit of it.** For all 60 wallets of each run, the stored balance
equalled the balance rebuilt from the ledger in SQL — recomputed independently of the service's
arithmetic, compared as decimal strings — and the `POST /wallets/{walletId}/reconciliation` endpoint
answered `consistent` with a `0.00` difference for each of them. `wager_reconciliation_divergence_total`
did not move, and across 94,000 ledger entries written by three `api` instances and two `worker`
instances under contention, there was no divergence, no `FAILED` outcome and no parked transaction
(RECON-004, RECON-001).

## What this does not measure

- **Not a prediction for AWS.** LocalStack is not SQS, and the hand-off above is largely its FIFO
  receive scheduling. The financial numbers do not depend on the broker; the queue latency does.
- **Not an isolated service.** The generator, three `api` instances, two `worker` instances,
  PostgreSQL and LocalStack share 20 cores with no container limits. The ceiling is a property of
  that arrangement, and a generator on its own host would move it.
- **One host, one database.** No replica, no network between tiers, one PostgreSQL container with
  default-ish settings.
- **No tuning.** Out of scope by design: the experiment measures what the deployed configuration
  does. The three obvious levers it points at — publisher batch and poll interval, the number of
  workers, the consumer's receive concurrency — were left alone.
- **No lock conflicts observed.** Producing them would need either more contention than half the
  traffic on four rows at ~1,300 operations per second, or a lower `LOCK_TIMEOUT_MS`. The suites
  prove the behaviour when it happens (CONC-002); this experiment did not reach it.
- **No DB-side decomposition of queue latency**, for the reason given under the hand-off definition.
- **Two runs.** The spread between them is the only variance estimate here.

## Reproducibility

The same command and the same documented inputs produce comparable numbers: the mix is drawn from a
seeded generator, the pool and the pacing are inputs, and the resolved configuration travels in the
report. Between these two runs, median HTTP latency differed by 2 ms and throughput by about 20 %,
with every ordering and consistency result identical. The run against a database already holding
51,805 transactions and 96,103 outbox rows was the _faster_ of the two, so that spread is host
variance — the generator and the stack competing for the same cores — rather than data volume.

Comparing a new run to these: keep the defaults, note the environment table, and compare the
measured-window numbers rather than the whole-run counts, which include the warm-up.
