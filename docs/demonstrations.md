# Demonstrations

Eight guarantees, watched happening against the deployed stack: an HTTP submission, a replay, a
rejection, a reversal, a reversal that arrives before its bet, a queue submission, a reconciliation
and a recovery from a kill. Each one is a section below, and all eight run in one pass with

```sh
make demo
```

which installs the dependencies, writes `.env` if it is missing, starts `compose.yaml` — PostgreSQL,
LocalStack with the three queues, the migration step, one `api` and two `worker` instances — and
then walks [demo/walkthrough.ts](../demo/walkthrough.ts) through them, printing every claim it
checks. It needs Docker and the Bun of `.bun-version`, nothing else; the queue is reached with the
SQS client the service itself uses, so there is no AWS CLI to install.

Two things to know before running it:

- **The demonstrations and the suites do not share a namespace.** `make demo` needs the `api` and
  `worker` instances running and writes to the stack's database and queues; the suites address
  `wagering_test` and a prefixed trio of their own on the same containers. Running the gate while
  the stack is up takes nothing from it, and nothing has to be stopped between the two
  (`ops.suite-isolation`).
- **It writes and cleans nothing up.** Every wallet, provider id and transaction id is minted for
  the run, so a second run shares nothing with the first, and `make down` discards all of it.

What this is not is a second test suite. Every claim below is also an acceptance entry proven by
`make check`, and [acceptance.yaml](acceptance.yaml) names the suite that carries each one; the
column below points at it. What the walkthrough adds is the topology: the suites boot an
application in-process and prove one guarantee with the rest of the system quiet, while this drives
the containers a reviewer runs, with two workers, a publisher and a scheduler all live.

## 1. HTTP submission

`POST /wallets` opens a wallet at `500.00`, and `POST /wagering/transactions` applies a `BET` of
`40.00`. The answer is `200` with the new balance; `GET /wallets/{id}/ledger` then shows the two
entries that explain it, the `OPENING` credit at wallet version 1 and the `BET` debit at version 2,
in the only order the ledger has.

- Rules: `api.wallet-create`, `wallet.opening-credit`, `api.outcome-shape`, `ledger.wallet-version-sequence`
- In the gate: `opening-credit-is-atomic`, `bet-debits-once`, `ledger-cursor-pagination`

## 2. Replay

The same operation is submitted again, with the same `Idempotency-Key` and the same body. The
answer is the stored outcome with `idempotentReplay: true`, carrying the transaction id of the
arrival that applied and the balance that arrival observed — not the balance now. The same key with
a different amount is `409 IDEMPOTENCY_PAYLOAD_MISMATCH` and stores nothing.

- Rules: `idem.replay-same-outcome`, `idem.replay-follows-persisted-outcome`, `idem.payload-mismatch-conflict`
- In the gate: `replay-returns-stored-outcome`, `idempotency-survives-restart`

## 3. Rejection

A `BET` of `10000.00` against a balance of `460.00` is `422 INSUFFICIENT_BALANCE`. It is not an
error but a recorded outcome: the transaction row exists as `REJECTED`, is readable through
`GET /wagering/transactions/{id}`, and the balance, the version and the ledger are where they were.

- Rules: `rule.bet.insufficient-balance`, `rule.rejected.no-effect`, `api.status-classes`
- In the gate: `bet-insufficient-balance-rejected`, `rejection-has-no-side-effects`, `no-ledger-entry-without-effect`

## 4. Reversal

A `REFUND` of `40.00` referencing the bet credits the stake back, and the balance returns to
`500.00`. A `ROLLBACK` of that same bet is then `422 REFERENCE_ALREADY_REVERSED`: one reversal per
target, whatever kind the second one is (additional policy 20.2 A).

- Rules: `rule.refund.credit`, `rule.refund.bet-only`, `rule.reference.reversed-once`, `rule.reversal.chain-limits`
- In the gate: `refund-credits-bet-once`, `reference-reversed-once`

## 5. A reversal before its bet

A `ROLLBACK` of `30.00` naming a bet the service has never seen is neither applied nor refused:
`202` with `PENDING_REFERENCE` and a `Location` to poll, persisted with a window it may wait in.
The bet it names is then submitted and applied, and a worker's scheduler — nothing in the
walkthrough — attempts the parked reversal again, applies it, and credits the stake back. Out of
order on arrival, correct once settled (ADR 0011).

- Rules: `ref.parked-state`, `api.location-on-pending`, `ref.scheduler`, `ref.resolution-on-arrival`
- In the gate: `rollback-before-bet-resolves`, `missing-reference-is-parked`

## 6. Queue submission

A `WagerTransactionRequested` for a `WIN` of `25.00` is sent to `wager-transactions.fifo`. A worker
picks it up, runs the same use case the controller runs, and the transaction becomes readable at
`GET /providers/{providerId}/wagering/transactions/{externalTransactionId}` — the only path a
provider reaches its own transaction by.

The same `messageId` is then sent again under a deduplication id the broker has never seen, which
is the only way to see the inbox do the absorbing rather than SQS's five-minute window. Nothing
changes: no second debit, no new wallet version.

- Rules: `msg.same-use-case`, `msg.inbox-identity`, `msg.redelivery-safe`, `msg.broker-features-optional`
- In the gate: `consumer-uses-same-use-case`, `inbox-keyed-by-body-message-id`, `correct-without-fifo`

## 7. Reconciliation

The walkthrough prints the wallet's six ledger entries — version, direction, amount, balance after
— and adds them up itself, so the balance under the entries is arithmetic the reader can check
against the balance stored on the wallet row.
`POST /wallets/{id}/reconciliation` then does the same sum inside one snapshot and answers `200`
either way, with the signed difference. Here the three agree and the difference is `0.00`.

The walkthrough then drains `wager-integration-events.fifo` and finds what the six processed
operations, the two refusals and the parked reversal announced: six `WagerTransactionProcessed`,
six `WalletBalanceChanged`, two `WagerTransactionRejected` and one
`WagerTransactionPendingReference`, each on the wallet as its aggregate, caused by its own
transaction and carrying the correlation id of the arrival that asked for it.

- Rules: `recon.calculation`, `recon.report-shape`, `recon.divergence-handling`, `event.processed-when`, `event.rejected-when`, `outbox.destination`
- In the gate: `reconciliation-calculation`, `events-fire-when-specified`, `final-invariant-every-suite`

## 8. Recovery

Sixty bets are queued; once some are applied and some are not, both workers are killed with
`SIGKILL`, which allows no cleanup, and restarted. Nothing is driven after that. Every one of the
sixty ends `PROCESSED`, the wallet took exactly sixty versions, and it still equals the balance
rebuilt from its own ledger: each bet was paid once, with the kills costing duplicate deliveries and
nothing else. That the kill landed mid-drain is asserted and not assumed — a run where the drain had
already finished would prove nothing about recovery, so it fails instead of passing.

Which failure window a kill lands in is the broker's business, so this shows the property rather
than the mechanism. The mechanism is proven deterministically in the gate, by cases that kill
a worker that has committed a delivery and not acknowledged its message, and a publisher whose
publication reached the broker and whose commit never happened — each at a barrier it asserts the
pre-kill state at, so a window that never opened fails the run instead of passing it:

```sh
make test TESTS=test/concurrency/crash-recovery.test.ts
```

- Rules: `msg.ack-after-commit`, `outbox.publish-after-commit`, `conc.multi-instance`, `recon.final-invariant`
- In the gate: `crash-recovery-drill`, `crash-recovery-barriers`

## Breaking it on purpose

The demonstrations show the guarantees holding. What a passing suite cannot show is that it would
notice them stop: a concurrency case that never meets the race it names passes exactly like one
that does. One command breaks an invariant, runs only the cases that name it, and puts the file
back:

```sh
make drill
```

It refuses to start unless the three files it edits are as committed, restores each one in a trap
so an interrupt cannot leave a mutated file behind, and verifies the restore against the index
before moving on. The three mutations are the three mistakes ADR 0002 was written against, and
each one is caught by a different kind of case:

| Mutation                                                            | What it proves                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `for no key update` dropped from the wallet lock                    | The structural check reads the source and refuses the missing clause without running anything, and two concurrent bets on one balance stop ending as a single debit.                                   |
| A process-local mutex around every transaction, in the unit of work | The same-instance case of `conc.parallel-wallets` fails and the cross-process one still passes, which is why both exist: a mutex is invisible to a case that runs its two operations in two processes. |
| The wallet lock taken `FOR UPDATE`                                  | The mode is pinned, not just the clause, and two submissions on one wallet deadlock instead of queueing — the outcome ADR 0002 chose `FOR NO KEY UPDATE` to avoid.                                     |

It is not part of `make check`: it edits the source, so it is a command a reviewer runs, not a gate
step.

## Reaching the stack by hand

`make` gives each checkout its own Compose project and its own published ports, so a `curl` or
`psql` typed by hand needs to know which:

```sh
make stack                       # COMPOSE_PROJECT_NAME, STACK_IMAGE and the three ports
eval "$(make -s stack)"          # export them into this shell
curl -s "http://localhost:$HTTP_PORT/health/ready"
curl -s "http://localhost:$HTTP_PORT/docs-json"   # docs/openapi.yaml, byte for byte
curl -s "http://localhost:$HTTP_PORT/metrics"
make logs SERVICES=worker
```

The request and message shapes to send are in [openapi.yaml](openapi.yaml) and
[asyncapi.yaml](asyncapi.yaml), each with examples per operation; `/docs` renders the first one.
