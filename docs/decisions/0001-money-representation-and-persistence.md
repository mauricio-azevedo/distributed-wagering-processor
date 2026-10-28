---
status: accepted
date: 2026-10-28
---

# Represent money as bigint minor units and persist it as NUMERIC(20,2)

## Context and Problem Statement

Every amount in the system is money: stakes, payouts, balances, ledger entries, reconciliation differences.
Amounts enter and leave as decimal strings (`"40.00"`) with a fixed scale of two, must be stored exactly, are
summed in SQL by reconciliation, and are read directly by auditors. A JavaScript `number` is excluded: binary
floating point cannot represent most decimal fractions and rounds silently. How should the domain hold money,
and how should the database store it?

## Decision Drivers

- Exactness: no amount is ever approximated; a wrong scale is rejected at the boundary, never adjusted.
- A framework-free domain: no ORM or library type inside `Money`.
- Readable tables: auditors and reconciliation queries work on the stored values as money.
- Currency safety: the model stays multi-currency even though providers settle in BRL.
- Simplicity: the system needs addition, subtraction and comparison, nothing else.

## Considered Options

- Decimal library in the domain, `NUMERIC(20,2)` in the database
- Integer minor units end to end: `bigint` in the domain, `BIGINT` in the database
- Integer minor units in the domain, `NUMERIC(20,2)` in the database, strings in between

## Decision Outcome

Chosen option: "Integer minor units in the domain, `NUMERIC(20,2)` in the database, strings in between", because
it is the only option with no rounding path at all, no dependency in the domain, and tables that read as money.
`Money.from` parses with the strict two-decimal pattern of `money.decimal-string` and stores minor units in a
`bigint`; a custom MikroORM type converts between the `NUMERIC` text form and `Money`; PostgreSQL returns
`NUMERIC` as text, so no `number` appears anywhere. Scale is fixed at two for every currency the service handles
today; the currency travels with every amount and cross-currency arithmetic throws.

`Money` is bounded by the column: the largest magnitude is `999999999999999999.99`, eighteen integer digits, the
capacity of `NUMERIC(20,2)`. `Money.from` rejects a larger magnitude and `add` throws `MoneyOverflowError` when
a sum would exceed it, so the database never reports a numeric overflow. Inputs, arithmetic results and stored
values share this one bound; a smaller input limit would only move the question of what happens at the edge
from the domain to the column, because repeated credits can grow a balance past any input limit. A credit that
would take a balance past the bound is a persisted rejection, `BALANCE_LIMIT_EXCEEDED`, so the limit is
explicit, auditable and tested rather than an error surfacing from the driver. Values read from the database
are inside the bound by construction and are rehydrated through the same parser. Subtraction may yield a
negative value; that is an ordinary intermediate result (a debit decides insufficient balance with it,
reconciliation computes its difference with it) and the places that require a non-negative amount check it
themselves.

### Consequences

- Good, because `money.no-rounding` is structural: there is no rounding function to misuse.
- Good, because reconciliation uses `SUM` over `NUMERIC(20,2)` exactly and audit SQL reads `460.00`, not
  `46000`.
- Good, because `CHECK (>= 0)` on balances and `CHECK (> 0)` on amounts sit next to the columns.
- Bad, because `NUMERIC(20,2)` rounds a value with more than two decimals instead of rejecting it. The domain is
  the only writer and never produces such a value, the mapping test asserts the exact round trip, and direct
  SQL writes are a privilege question handled by ADR 0003.
- Bad, because a currency with a minor unit other than two cannot be represented without a per-currency scale.
- Bad, because a bound and a failure code exist for a balance no wallet will reach; the alternative was a
  database error with no defined outcome.
- Worth revisiting if a currency with another minor unit must be supported, if sub-cent amounts appear in the
  business (bonus accrual, fees), or if `NUMERIC` aggregation over very large ledgers becomes a measured
  bottleneck.

### Confirmation

Acceptance entries MONEY-001 to MONEY-005, MONEY-008, MONEY-009, MONEY-010, MONEY-012, MONEY-013 and SCHEMA-020
in [acceptance.yaml](../acceptance.yaml): unit tests on parsing, rejection, arithmetic and the bound, an
integration test that round-trips the bound through PostgreSQL, an integration test on the credit that would
cross it, and a schema test over every money column.

## Pros and Cons of the Options

### Decimal library in the domain, `NUMERIC(20,2)` in the database

A library such as `decimal.js` or `big.js` holds the value; the ORM maps the column to and from the library type.

- Good, because exact and expressive.
- Bad, because it brings a dependency into the domain for operations the system never needs (division,
  exponents, rounding modes).
- Bad, because rounding modes exist, so a future call site can round where the contract forbids it.

### Integer minor units end to end

Cents as integers in the domain and `BIGINT` columns.

- Good, because exact, dependency-free and trivially checked.
- Bad, because an auditor sees `46000` where the business says `460.00`, and every SQL report divides by 100.
- Bad, because a future currency with a different minor unit needs a per-currency scale column.

### Integer minor units in the domain, `NUMERIC(20,2)` in the database, strings in between

- Good, because domain arithmetic is `bigint` addition, subtraction and comparison, with no rounding path.
- Good, because tables stay readable and `SUM` is exact.
- Neutral, because a custom ORM type is needed; it is small and lives in the infrastructure layer.
- Bad, because the column type rounds extra decimals silently, which only the domain's strictness prevents.

## More Information

Rules carried: `money.decimal-string`, `money.rejected-inputs`, `money.no-rounding`, `money.same-currency`,
`money.exact-persistence`, `money.bound`, `money.immutable`, `wallet.balance-limit` in
[system-contract.md](../system-contract.md). ADR 0003 covers the privileges that
keep direct SQL writes away from the ledger.
