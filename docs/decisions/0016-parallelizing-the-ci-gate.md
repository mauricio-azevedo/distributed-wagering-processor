---
status: accepted
date: 2026-10-29
---

# Split the CI gate into parallel jobs instead of one serial job

## Context and Problem Statement

`ci` runs `make check` as one job on one runner. Its wall-clock time roughly doubled over six
slices while the gate itself only got stronger: 272s (#17) to 451s (#59), measured on the PR #60
run as 374s of `bun test` inside 451s total. Inside `bun test`, `test/integration` (420 tests)
takes 264.6s and `test/concurrency` (13 tests) takes 80.0s; `test/unit` (505 tests) and
`test/contract` (16 tests) together take under two seconds. The slow cases wait on real things — a
broker redrive sequence, two publishers draining one outbox, a crash-recovery drill that SIGKILLs a
process and waits for recovery, PostgreSQL detecting a deadlock — and caught real defects in #18,
#19 and #59 (`conc.row-lock`, `outbox.recovery`, `msg.redrive`). None of that is waste; trimming it
is out of scope.

The waste is serialization: 1010 tests that take under two seconds together wait behind 433 that
take 345s, `tsc`, `eslint`, `audit` and the image build contribute nothing to the test run but sit
in the same critical path, and one PostgreSQL and one LocalStack serve every stage in turn. With
#26–#29 still open, the trend continues.

## Decision Drivers

- `make check` must stay a single command for local use (`ops.repository-gate`); CI composing the
  same targets differently is fine, CI having its own private notion of the gate is not.
- The required status checks are `ci` and `pr-title` (`main` ruleset, strict). A job rename or a
  bare matrix job becomes the required context, and every PR blocks until the ruleset is edited to
  match — a change the workflow and the ruleset would then have to land together, in the window
  where neither is true yet.
- Every job that touches PostgreSQL or LocalStack needs its own stack: two jobs on one database or
  one queue fight each other exactly as a local `make up` beside `make test` already does without
  the isolation of ADR 0014, and that isolation is a namespace inside one set of containers, not a
  second set — nothing here reaches for a second Compose stack per job on purpose.
- No test is deleted, retried, skipped or given a longer timeout to fit the new layout.
- A flaky shard should be re-runnable without re-running the whole gate.

## Considered Options

- Keep one job, speed up what runs inside it
- Split by kind into separate jobs, integration left as one job
- Split by kind, and shard `test/integration` across several jobs

## Decision Outcome

Chosen option: "Split by kind, and shard `test/integration` across several jobs", because the two
cuts are independent and additive. By kind alone turns the critical path from the sum of every
stage into the longest one (`test/integration` at ~265s plus its own startup), which is the ~33%
the issue measured against the 451s baseline. Sharding `test/integration` on top brings the longest
leg down to near `test/concurrency` (~80s) or one shard, because nothing but file count bounds how
finely 420 tests across 25 files divide.

Four jobs: `static` (`fmt-check`, `lint`, `typecheck`, `audit`, `build` — none of it needs a
container), `fast` (`test/unit` and `test/contract` together, under a second of test time plus one
`make infra`), `integration` (`test/integration`, sharded), and `concurrency`
(`test/concurrency`, alone, because three files and real wall-clock waits give a time-based split
nothing to divide). Each of the four runs on its own GitHub Actions runner, which is already an
isolated VM with its own Docker daemon — the per-checkout slot numbering of ADR 0014/`docker/stack.sh`
exists for two worktrees on one developer's machine, and a fresh runner is always slot 0, so no
second isolation mechanism is added for CI.

`test/integration` is sharded with Bun's own `--shard=N/M`, balanced by a committed
`test/integration.timings.json` (`--timings`, measured with `--update-timings` against this
repository's suite) rather than by file count, so three jobs land close to equal instead of one
drawing the three slowest files. Every job still runs through `make test TESTS=…`, so the
container addresses, the database and the queue prefix are exactly what `ops.suite-isolation`
already resolves — nothing about how a suite finds its dependencies changes, only which subset of
`$(TESTS)` one job passes.

A fifth job, `ci`, depends on all four and runs nothing itself. It is the one required status
check the `main` ruleset names, so splitting the gate into four jobs costs no ruleset edit now and
none the next time a shard count changes — only `ci`'s `needs:` list changes, which is a workflow
file and not a branch protection setting.

### Consequences

- Good, because the longest leg of the gate drops from the sum of every stage (451s) toward the
  longest one of them, and sharding narrows that further without touching what any test asserts.
- Good, because a shard that flakes is re-run as that one GitHub Actions job, not as the whole
  workflow — the flake re-run story the issue asked for, with nothing built to provide it.
- Good, because `make check` is unchanged: a developer still runs one command, and CI running
  `make fmt-check`, `make test TESTS=…` and the rest as separate steps is the same targets the
  Makefile already names, addressed individually instead of through `check`.
- Good, because the required context stays `ci`; the ruleset is never in a state where it is
  waiting on a job name the workflow no longer produces.
- Neutral, because `test/contract` needs PostgreSQL (`http-contract.test.ts` migrates and boots the
  application against it) and so `fast` still waits on `make infra`, same as `integration` and
  `concurrency`; what moved it out of the slow path is that its own tests cost under a second, not
  that it runs container-free.
- Bad, because the gate now reports four or five check runs instead of one, which is more for a
  reviewer to read on a red PR — mitigated by each job's own `docker compose logs` on failure,
  unchanged from today.
- Bad, because `test/integration.timings.json` can drift as files are added, moved or grow slower;
  a shard still runs correctly on stale timings, only less evenly, and `--update-timings` is one
  command to refresh.
- Worth revisiting if a slice adds enough to `test/integration` that three shards no longer land
  near `test/concurrency`'s ~80s, or if `test/concurrency` itself grows enough cases that one job
  stops being the right granularity for it.

### Confirmation

Acceptance entry OPS-014 in [acceptance.yaml](../acceptance.yaml). Measured on PR #68's own
[Actions run](https://github.com/mauricio-azevedo/distributed-wagering-processor/actions/runs/40947075523):
451s → 164s, a 64% reduction against the PR #60 baseline, with the longest individual job
(`integration (3)`) at 154s. One test deliberately broken in each of the four kinds, confirming the
gate fails and names which job; a PR merged through the four-job workflow, confirming the `main`
ruleset still gates on `ci` alone.

## Pros and Cons of the Options

### Keep one job, speed up what runs inside it

- Good, because nothing about the ruleset or the workflow's shape changes.
- Bad, because the slow cases are slow for reasons the issue rules out touching — a broker's
  redrive timing, a crash-recovery drill, a real deadlock — so there is nothing left inside one
  job to speed up without weakening what it proves.

### Split by kind into separate jobs, integration left as one job

- Good, because every job maps to a directory that already exists, with no new file to balance or
  keep in step with the suite.
- Bad, because the longest leg stays `test/integration` at ~265s plus its startup — the ~33% the
  issue priced this option at, not the ~60% the second cut adds.

### Split by kind, and shard `test/integration` across several jobs

- Good, because it is the only option that gets the longest leg near `test/concurrency`'s ~80s,
  which is where the 150-180s the issue asked for comes from.
- Good, because Bun's `--shard` and `--timings` are the tool already in the gate, not a new one:
  nothing is built, only invoked with different arguments per job.
- Neutral, because a shard's split is a committed JSON file that needs an occasional refresh, which
  the other options do not have.

## More Information

Rules carried: `ops.repository-gate`, amended, and `ops.parallel-gate`, new, in
[system-contract.md](../system-contract.md). ADR 0014 owns the suite/stack namespace isolation
this reuses unchanged per job; `docker/stack.sh`'s per-checkout slot numbering (OPS-011) is the
mechanism this explicitly does not extend to CI, because a GitHub Actions runner is already its own
isolated host. The baseline measurement is issue #61, PR #60's run (`ci` 451s, `bun test` 374s,
1064 tests across 57 files).
