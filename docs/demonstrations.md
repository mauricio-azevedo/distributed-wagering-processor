# Demonstrations

Seven guarantees, watched happening against the deployed stack: an HTTP submission, a queue
submission, a rejection, a replay, a reversal, a reconciliation and a recovery from a kill. Each
one is a section below, and all seven run in one pass with

```sh
make demo
```

which starts `compose.yaml` — PostgreSQL, LocalStack with the three queues, the migration step, one
`api` and two `worker` instances — and then walks
[demo/walkthrough.ts](../demo/walkthrough.ts) through them, printing every claim it checks. It needs
Docker and the Bun of `.bun-version`, nothing else; the queue is reached with the SQS client the
service itself uses, so there is no AWS CLI to install.

Two things to know before running it:

- **The demonstrations and the suites must not share the stack.** `make demo` needs the `api` and
  `worker` instances running; `make test` drives the same queues itself and expects no worker
  competing for them. Run `make down` (or `docker compose stop api worker`) between the two.
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

## 5. Queue submission

A `WagerTransactionRequested` for a `WIN` of `25.00` is sent to `wager-transactions.fifo`. A worker
picks it up, runs the same use case the controller runs, and the transaction becomes readable at
`GET /providers/{providerId}/wagering/transactions/{externalTransactionId}` — the only path a
provider reaches its own transaction by.

The same `messageId` is then sent again under a deduplication id the broker has never seen, which
is the only way to see the inbox do the absorbing rather than SQS's five-minute window. Nothing
changes: no second debit, no new wallet version.

- Rules: `msg.same-use-case`, `msg.inbox-identity`, `msg.redelivery-safe`, `msg.broker-features-optional`
- In the gate: `consumer-uses-same-use-case`, `inbox-keyed-by-body-message-id`, `correct-without-fifo`

## 6. Reconciliation

`POST /wallets/{id}/reconciliation` compares the stored balance with the balance rebuilt from the
ledger and answers `200` either way, with the signed difference. Here the two agree and the
difference is `0.00`.

The walkthrough then drains `wager-integration-events.fifo` and finds what the four processed
operations and the two refusals announced: four `WagerTransactionProcessed`, four
`WalletBalanceChanged` and two `WagerTransactionRejected`, each on the wallet as its aggregate,
caused by its own transaction and carrying the correlation id of the arrival that asked for it.

- Rules: `recon.calculation`, `recon.report-shape`, `recon.divergence-handling`, `event.processed-when`, `event.rejected-when`, `outbox.destination`
- In the gate: `reconciliation-calculation`, `events-fire-when-specified`, `final-invariant-every-suite`

## 7. Recovery

Sixty bets are queued; once some are applied and some are not, both workers are killed with
`SIGKILL`, which allows no cleanup, and restarted. Nothing is driven after that. Every one of the
sixty ends `PROCESSED`, the wallet took exactly sixty versions, and it still equals the balance
rebuilt from its own ledger: each bet was paid once, with the kills costing duplicate deliveries and
nothing else. That the kill landed mid-drain is asserted and not assumed — a run where the drain had
already finished would prove nothing about recovery, so it fails instead of passing.

Which failure window a kill lands in is the broker's business, so this shows the property rather
than the mechanism. The mechanism is proven deterministically by the drill in the gate, which kills
a worker that has committed a delivery and not acknowledged its message, and a publisher whose
publication reached the broker and whose commit never happened — each at a barrier it asserts the
pre-kill state at, so a window that never opened fails the run instead of passing it:

```sh
make down                                           # the suites need the dependencies alone
bun test test/concurrency/crash-recovery.test.ts
```

- Rules: `msg.ack-after-commit`, `outbox.publish-after-commit`, `conc.multi-instance`, `recon.final-invariant`
- In the gate: `crash-recovery-drill`, `crash-recovery-barriers`

## Reaching the stack by hand

`make` gives each checkout its own Compose project and its own published ports, so a `curl` or
`psql` typed by hand needs to know which:

```sh
make stack                       # COMPOSE_PROJECT_NAME, STACK_IMAGE and the three ports
eval "$(make -s stack)"          # export them into this shell
curl -s "http://localhost:$HTTP_PORT/health/ready"
curl -s "http://localhost:$HTTP_PORT/docs-json"   # docs/openapi.yaml, byte for byte
curl -s "http://localhost:$HTTP_PORT/metrics"
docker compose logs --follow worker
```

A single clone keeps `3000`, `5433` and `4566`. The request and message shapes to send are in
[openapi.yaml](openapi.yaml) and [asyncapi.yaml](asyncapi.yaml), each with examples per operation;
`/docs` renders the first one.
