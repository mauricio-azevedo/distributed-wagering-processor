---
status: accepted
date: 2026-10-28
---

# Enforce financial invariants in the schema while the application owns the writes

## Context and Problem Statement

The financial invariants (one wallet per player and currency, non-negative balance, one ledger entry per
balance change and vice versa, immutable ledger, frozen terminal outcomes, one reversal per transaction,
unique provider transaction ids and idempotency keys) must hold even if application code has a bug, a
migration is run by hand, or a second application is pointed at the same database. Code review and tests
reduce the odds of a violation; only the schema makes one impossible to commit. Which layer owns the
financial writes, and how does the schema prevent inconsistency without pulling business rules out of the
domain?

## Decision Drivers

- Guarantees that survive application bugs, manual SQL and second writers.
- Business rules stated and unit-tested in one place, the domain.
- Readable tables for auditors and reconciliation.
- Reversible, reviewable migrations.

## Considered Options

- Application-owned writes, schema-enforced invariants
- Ledger-driven balance through a trigger
- Stored procedures own every financial write

## Decision Outcome

Chosen option: "Application-owned writes, schema-enforced invariants", because the domain keeps stating and
testing the rules while constraints, indexes, triggers and privileges refuse anything inconsistent, whatever
wrote it.

Uniqueness:

- `wallets`: `UNIQUE (player_id, currency)`; `UNIQUE (id, currency)` as the target of the composite foreign key
  below.
- `wager_transactions`: `UNIQUE (provider_id, external_transaction_id)`;
  `UNIQUE (provider_id, idempotency_key)`; partial
  `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'` (one
  reversal per target); partial `UNIQUE (wallet_id) WHERE kind = 'OPENING'`.
- `wallet_ledger_entries`: `UNIQUE (transaction_id)`; `UNIQUE (wallet_id, wallet_version)`.
- `inbox_messages`: primary key `(consumer_name, message_id)`. `outbox_messages`: primary key `event_id`.

Checks:

- `wallets`: `balance >= 0`, `version >= 1`.
- `wager_transactions`: `amount >= 0`, and `amount > 0` unless `kind = 'LOSS'`, the one kind that writes no
  ledger entry; enumerated kind and status; the reference matrix (`REFUND` and
  `ROLLBACK` require a reference, `BET` and `OPENING` forbid one); `status = 'PROCESSED'` if and only if
  `processed_at IS NOT NULL`; `status IN ('REJECTED', 'FAILED')` if and only if `failure_code IS NOT NULL`.
- `wallet_ledger_entries`: `amount > 0`; `wallet_version >= 1`; `balance_after >= 0`;
  `(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)`;
  composite foreign key `(wallet_id, currency) REFERENCES wallets (id, currency)`, so an entry can never carry
  a currency other than its wallet's.

Immutability:

- A `BEFORE UPDATE OR DELETE` trigger on `wallet_ledger_entries` raises an exception.
- A `BEFORE UPDATE OR DELETE` trigger on `wager_transactions` refuses every delete; refuses every update of a
  row already in `PROCESSED`, `REJECTED` or `FAILED`; and, on a row that may still change, refuses any update
  that touches the identity, context, kind, amount, currency, reference target or creation time, comparing the
  two row images with `IS DISTINCT FROM`. What stays writable is the outcome of a non-terminal row: `status`,
  `processed_at`, `failure_code`, `observed_balance` and `reference_transaction_id`. The checks alone cannot
  carry this: `status = 'PROCESSED'` if and only if `processed_at IS NOT NULL` holds just as well for a row set
  back to `PENDING` with `processed_at` cleared, and that downgrade re-opens the idempotency key for a second
  debit and frees the partial unique index for a second reversal. The valid transition graph stays in the
  domain (`tx.transitions`); the trigger freezes only what has already been decided, so the rule is stated once
  and the schema refuses what contradicts it.
- Every trigger raises `integrity_constraint_violation` (SQLSTATE `23000`), so a refusal by a trigger is
  classified like a refusal by a constraint and the persistence adapter needs no special case to call it
  permanent.
- Two database roles: `wagering_migrator` owns the schema and runs migrations; `wagering_app` runs the service
  with `SELECT` and `INSERT` on the ledger, `SELECT`, `INSERT` and `UPDATE` elsewhere, and no DDL. The trigger
  protects against mistakes; the privileges protect against bypassing the trigger.

The transaction trigger was checked against PostgreSQL 18 with direct SQL, the updates as `wagering_app` and
the deletes as the schema owner: a `PROCESSED` row set back to `PENDING` with `processed_at` cleared, a
rewritten `observed_balance` on a terminal row, a `PROCESSED` row turned into a `REJECTED` one, a changed
`amount`, a changed `idempotency_key`, a changed reference target on a parked row, and the delete of a terminal
and of a non-terminal row are all refused; `PENDING` to `PROCESSED` carrying its outcome, `PENDING` to
`PENDING_REFERENCE`, and a parked row resolving its reference into `PROCESSED` are accepted. The same table
with the same checks and no trigger accepts the downgrade, which is the reason the trigger exists. `TRUNCATE`
by the owner is unaffected, so integration suites still reset their tables between cases.

Balance-to-ledger link, enforced from both sides by two constraint triggers, `DEFERRABLE INITIALLY DEFERRED`
so that they judge the state of the whole transaction at commit:

- On `wallets`, for every inserted or updated row: the row must mirror the head of its ledger, the entry with
  the greatest `wallet_version` for that wallet, with `version = head.wallet_version` and
  `balance = head.balance_after`; a wallet with no entries must have `version = 1` and `balance = 0`. The
  function re-reads the wallet row by id, so several updates of one wallet in one transaction all judge the
  final state.
- On `wallet_ledger_entries`, for every inserted row: its predecessor, the entry with the greatest lower
  `wallet_version`, must carry `wallet_version - 1` and a `balance_after` equal to the new row's
  `balance_before`; when there is none, the row is the wallet's first entry, which starts at `0.00` and carries
  version 1 (opening credit) or 2 (first operation on a wallet opened with `0.00`). Its successor, the entry
  with the smallest higher `wallet_version`, when present, must carry `wallet_version + 1` and a
  `balance_before` equal to the new row's `balance_after`; when there is none, the row is the head and the
  wallet row must mirror it.

A trigger on `wallets` alone would miss an entry inserted without touching the wallet, and comparing only the
head would accept a chain with a broken link or a gap. Together with the arithmetic check on each entry, the
unique `(wallet_id, wallet_version)` and the immutability trigger, the two triggers make the ledger of a wallet
one contiguous chain from `0.00` to the head, and the head's `balance_after` equals the sum of credits minus
debits by induction; the sum is not recomputed at commit because it is implied, and reconciliation recomputes
it independently on demand. The cost per balance change at commit is four probes of existing indexes: the head,
the predecessor, the successor and the wallet row. The triggers were checked against PostgreSQL 18 with direct
SQL: an orphan entry on a wallet with entries and on an empty wallet, a wallet update without an entry (balance
only, version only, both), a mismatched pair, a broken predecessor link with a matching wallet, a version gap
with a matching wallet, an entry inserted into the version-1 gap of a wallet opened with `0.00`, a first entry
at version 3 and a wallet created with a balance and no entry are all refused at commit; well-formed single
operations, a wallet opened with `0.00` followed by its first credit, and two operations in one transaction
commit, with balance, ledger sum and head equal afterwards.

### Consequences

- Good, because every invariant has a mechanism that application code cannot bypass.
- Good, because the domain stays the single statement of the rules and remains unit-testable without a database.
- Bad, because migrations carry logic (triggers, partial indexes) that must be reviewed like code, and `down`
  migrations must remove it in the right order.
- Bad, because the deferred triggers cost four indexed probes per balance change at commit, and the chain rule
  makes the ledger-side function the most intricate piece of the schema; SCHEMA-021 to SCHEMA-023 pin each
  branch.
- Bad, because two roles mean two connection configurations and a bootstrap step in Docker Compose; integration
  tests run migrations as one role and the service as the other.
- Bad, because a corrective migration that must touch a transaction row has to disable the append-only trigger
  explicitly, in the migration, under review. That visibility is the point: an audit log that bends silently is
  not one.
- Worth revisiting if write throughput makes the deferred triggers or the partial indexes a measured cost, if the
  ledger must be partitioned (which changes how uniqueness and the composite foreign key are expressed), or if a
  second writer to the schema appears and calls for row-level security.

### Confirmation

Acceptance entries SCHEMA-001 to SCHEMA-025, WALLET-005, LEDGER-001 and OPS-004 in
[acceptance.yaml](../acceptance.yaml): one direct-SQL violation test per guarantee, executed as `wagering_app`,
asserting that the database refuses the write.

## Pros and Cons of the Options

### Application-owned writes, schema-enforced invariants

The domain computes the new wallet state, the ledger entry and the events; the application writes them in one
transaction; the schema refuses anything inconsistent.

- Good, because business logic stays in one place and the schema is a safety net nothing bypasses.
- Good, because the domain computes `balanceAfter` itself and the schema confirms it.
- Bad, because rules that reach the schema (checks, partial indexes) exist in two statements, code and
  migration; this is intended, both are the same rule.

### Ledger-driven balance through a trigger

The application inserts only ledger entries; an `AFTER INSERT` trigger updates the wallet balance and version.

- Good, because the link between ledger and balance becomes mechanical.
- Bad, because the rules deciding whether an entry may exist (insufficient balance, currency, reversal
  eligibility) still live in the application, so the invariant is split across two layers.
- Bad, because the domain can no longer compute `balanceAfter` without duplicating the trigger's arithmetic.

### Stored procedures own every financial write

All rules in PL/pgSQL; the application calls procedures.

- Good, because enforcement is the strongest possible.
- Bad, because the domain layer becomes a thin client and unit tests need a database.
- Bad, because every rule change is a migration.

## More Information

Rules carried: `wallet.unique-player-currency`, `wallet.non-negative`, `wallet.ledger-mirror`,
`ledger.immutable`, `ledger.one-entry-per-transaction`, `ledger.balanced-arithmetic`, `ledger.chain`,
`ledger.currency-matches-wallet`, `rule.reference.reversed-once`, `tx.identity`, `tx.terminal-immutable`,
`tx.row-append-only`, `idem.provider-scoped`,
`ops.two-db-roles` in [system-contract.md](../system-contract.md). The enforcement table in
[ARCHITECTURE.md](../../ARCHITECTURE.md) maps each guarantee to its acceptance entry.
