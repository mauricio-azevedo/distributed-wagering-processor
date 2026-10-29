---
status: accepted
date: 2026-10-29
---

# Select the role at the composition root and bound every drain by one grace period

## Context and Problem Statement

Every component of the service exists: the HTTP surface, the queue consumer, the outbox publisher and the
pending-reference scheduler. None of them was started by a deployment — each ran only in its own suites — so
what was missing is the process: which components a container runs, and what happens to the work in hand when
an orchestrator stops it.

The contract fixes the shape. `ops.single-image-roles` asks for one image that runs as `api`, `worker` or
`all`; `ops.compose` asks for a stack with one `api` and two `worker` instances; `ops.config-env` asks for a
process that refuses an invalid configuration before it serves traffic; `ops.graceful-shutdown` and
`msg.sigterm` ask that `SIGTERM` lose nothing — requests drained, the message in flight finished or its
visibility returned, the publication batch completed, the scheduler's claim released.

The questions this decides: how a role is selected, who handles the signal, what bounds the drain, and what the
process does when the drain does not finish in time.

## Decision Drivers

- An orchestrator sends `SIGTERM` and then `SIGKILL`: the drain has to be the one that gives up first, or the
  thing that ends every stop is the kill a graceful shutdown exists to avoid.
- No financial work may be lost or duplicated by a stop, whatever moment it arrives at.
- A keep-alive connection belongs to the caller, so a drain may not wait on one; the work in flight is the only
  thing it may wait for.
- Two roles that differ in more than one variable drift: a setting fixed for the role that answers providers
  and forgotten for the role that works is a defect nothing would notice.
- A process that was told nothing must not start claiming financial work on its own.
- Three loops with the same stop semantics must have one implementation of them, or two of the three will be
  subtly different.

## Considered Options

- One image with `APP_ROLE` at the composition root, against one image per role or one entry point per process
- The service's own signal handler with a deadline, against NestJS `enableShutdownHooks`
- Releasing the connections nobody is using during the drain, against NestJS `forceCloseConnections`
- Draining the worker processes together, against draining them in sequence

## Decision Outcome

Chosen option: one image, `APP_ROLE` read by the validated environment and applied in `AppModule.create`, and
one signal handler per process that closes the application within `SHUTDOWN_GRACE_PERIOD_MS`.

**The role is a composition, not a build.** `APP_ROLE` decides two things and nothing else: which controllers
the application serves — `worker` serves the health routes alone, so a worker cannot be sent a request the
balancer never meant for it — and whether `WorkerRuntime` is registered, which is what starts the consumer, the
publisher and the scheduler on boot. Every provider is constructed for every role, because a provider costs
nothing until something calls it; what differs is who runs. `api` is the default, because an unasked-for role is
the costly one: a process that was told nothing and started consuming would compete for financial work no
deployment meant to give it, whereas one that only serves traffic adds nothing to the claims already in flight.
Compose gives the two roles one image and one environment and overrides `APP_ROLE` alone.

**The drain is the process's own, with a deadline.** NestJS's shutdown hooks re-raise the signal once the hooks
have run, which exits with no bound on how long they took; `onShutdownSignal` instead races `app.close()` —
exactly the hooks `enableShutdownHooks` would run — against the grace period. A drain that finishes exits `0`. A
drain that does not exits `75` (`EX_TEMPFAIL`) after logging that it ran out of time, because an operator has to
be able to tell a clean stop from a deployment whose grace period is too short for its own work.

**Nothing is lost by the deadline, and that is a property of the storage rather than of the shutdown.** Work the
drain did not finish is work no transaction committed: PostgreSQL rolls back the transaction and releases the
locks and the `FOR UPDATE SKIP LOCKED` claims of the connection that dies with the process, and a message that
was not acknowledged is redelivered and absorbed by its inbox row. So the scheduler has nothing to release
explicitly — a claim exists only inside the transaction attempting it, so a row the dying instance held is due
the moment another instance sweeps, with no backoff it never got to record — and the publisher's rows are
pending again for the next claim.

**The HTTP drain releases what nobody is using.** Closing the server stops the listener and then waits for every
connection to end, and an idle keep-alive connection — a balancer's, typically — would hold that wait open for
as long as the caller feels like, turning every ordinary stop into one that hits the deadline. `drainHttp`
therefore closes the connections that are not serving a request, and closes them again as requests in flight
finish and release theirs. NestJS's `forceCloseConnections` was rejected for destroying every socket at
`close()`, the one serving a request included. `return503OnClosing` covers the other side of the same window: a
request that arrives on a connection the caller already held is refused with `503` and `Connection: close`
rather than accepted by a process that is leaving.

**The three loops are one loop.** `WorkerLoop` is the pacing, the failure handling and the drain of every
background process: a cycle that found work is followed at once, an idle or failed cycle waits the interval, a
failed cycle is logged and the loop carries on, and `stop` stops the loop from claiming and resolves when the
cycle in flight has committed or rolled back. `claiming()` is the same signal inside a cycle that claims item by
item, which is how a scheduler sweep stops between attempts instead of after fifty of them. The publisher and
the scheduler are this loop around a use case; the consumer adds to it the two halves of `msg.sigterm` — the
receive in flight is abandoned rather than waited out, and every message of the batch it had not reached is
handed back with its visibility cleared, so another instance takes them at once.

`WorkerRuntime` drains the three together rather than in sequence, because they share nothing but PostgreSQL and
the grace period is wall-clock: a message the consumer is finishing has no stake in the batch the publisher is
sending. It hangs off `beforeApplicationShutdown` and not `onApplicationShutdown`, and the difference is
load-bearing: MikroORM closes the connection pool on the latter, so a loop stopped there could be finishing a
transaction on a connection being taken away.

### Consequences

- Good, because a role is one variable over one image: the code, the configuration, the migrations and the
  health probe of a worker are the api's, so nothing can be true of one role and false of the other by accident.
- Good, because the process decides when it is done. A deployment sets the container's stop grace period above
  `SHUTDOWN_GRACE_PERIOD_MS` and never has to kill a service that is still committing.
- Good, because the drain is bounded by work and not by callers: an idle connection pool cannot hold a stop
  open, and a long poll is abandoned instead of waited out.
- Good, because the three background processes have one implementation of "stop after the cycle in flight",
  tested once, and a fourth would inherit it.
- Good, because a worker serves no financial route, so a misrouted request is a `404` rather than an operation
  applied by an instance nothing was meant to send one to.
- Neutral, because `all` exists only for a local run; a deployment that used it would run its HTTP surface and
  its claims in one process, which is a scaling choice and not a correctness one.
- Neutral, because the default role is `api`: a `worker` is never started by omission, and a deployment that
  wants one says so.
- Bad, because a receive the broker had already answered when the drain abandoned it leaves those messages
  invisible for the rest of their visibility timeout. They are redelivered and absorbed by the inbox, so the
  cost is latency on a few messages per stop, and the alternative — waiting out every long poll — is twenty
  seconds added to every shutdown.
- Bad, because the grace period is one number for every drain of a process, so a deployment whose financial
  operations are slower than its publications has to size it for the slowest. Per-process periods would be
  three numbers to get wrong for one that is already bounded by the work itself.
- Worth revisiting if a role has to drain in a fixed order — a publisher that should flush after the consumer
  stops producing events, say — which the parallel drain deliberately does not promise, or if roles ever need
  their own images, which would replace `APP_ROLE` with an entry point per role and the shared environment with
  one per image.

### Confirmation

Acceptance entries OPS-003, OPS-005, OPS-006, OPS-007 and MSG-010 in [acceptance.yaml](../acceptance.yaml).
`test/unit/worker-loop.test.ts` holds the loop to its stop semantics without any I/O; `environment-schema`
holds the role and the periods to validation by name; `app-roles` runs `src/main.ts` as each role against the
stack and asserts both the surface it serves and the queue work it does or leaves alone; `config-validation`
runs it with a missing, an unreadable and an unknown value and asserts the exit and the port nothing answers on;
`compose-stack` reads the topology Compose resolves, including the two worker replicas and the stop grace
periods; `graceful-shutdown-all-roles` signals a real process per role and asserts what it finished, what it
left behind and the code it exited with; `sigterm-drains-or-releases` signals a consumer holding a batch and
asserts the message in flight was acknowledged, the rest came back at once and each was applied exactly once.
