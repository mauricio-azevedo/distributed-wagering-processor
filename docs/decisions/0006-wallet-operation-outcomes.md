---
status: accepted
date: 2026-10-28
---

# Return a wallet operation's outcome instead of mutating the aggregate or throwing

## Context and Problem Statement

Most of what a provider can get wrong is not an error: a bet larger than the balance, an amount in the wrong
currency, a payload naming another player, a credit past the storage bound. Each one is a business outcome the
contract persists as a `REJECTED` transaction with a stable failure code, emits as
`WagerTransactionRejected`, and replays with that same code forever (`rule.rejected.no-effect`,
`idem.replay-follows-persisted-outcome`). The wallet aggregate decides all four, under the row lock, against
the true balance. It must also produce the ledger entry that mirrors every balance change, in the same step
that changes the balance (`wallet.ledger-mirror`). How does `Wallet.debit` and `Wallet.credit` report what
happened, and what does the aggregate look like afterwards?

## Decision Drivers

- A refusal is a persisted, auditable, replayable fact; it must not be indistinguishable from a bug.
- The use case must handle every refusal: a forgotten one would charge a player or lose a reversal.
- The balance and its ledger entry are one indivisible result (`wallet.ledger-mirror`); no intermediate state
  may exist in which one moved without the other.
- Unit-testable with no database, no clock and no port (WALLET-011, WALLET-012).
- The same aggregate serves HTTP and the queue, so its answer cannot carry transport meaning.

## Considered Options

- Throw a domain exception per refusal and catch it in the use case
- Mutate the aggregate and expose the refusal as state to read afterwards
- Return a discriminated outcome: the new wallet with its entry, or the failure code

## Decision Outcome

Chosen option: "Return a discriminated outcome: the new wallet with its entry, or the failure code", because a
refusal is a value the use case persists rather than an event it recovers from, the compiler refuses to read
the new state without first handling the refusal, and returning the new state keeps the balance and its entry
inseparable.

`debit` and `credit` return `WalletOperationOutcome`: either `{ applied: true, wallet, entry }` or
`{ applied: false, failureCode }`, where `failureCode` is the subset of `FailureCode` the aggregate can decide
on its own. TypeScript narrows the union on `applied`, so neither branch can read a field of the other: the
use case cannot persist a balance it was not given, nor ignore a code it must store.

A refused operation returns no wallet at all. The instance the caller holds is still current, which is what
makes "balance, ledger and version are unchanged" true by construction rather than by inspection.

An applied operation returns a new `Wallet`; operations never mutate. The new balance and the ledger entry
are built in one expression, so the entry's own arithmetic check (`ledger.balanced-arithmetic`) runs before
any state exists, and a disagreement between the two leaves nothing half-applied. Both classes are frozen.

Exceptions keep the cases no provider can cause, as programming errors: `CurrencyMismatchError` from
comparing two currencies, `MoneyOverflowError` from arithmetic past `money.bound`, `InvalidLedgerEntryError`
from an entry that does not balance, `InvalidTransactionStateError` from a transition on a terminal
transaction (`model.explicit-transitions`). The split is the rule: what a payload can provoke is a value,
what only a defect can provoke is thrown.

The bound is checked as headroom, `Money.bound(currency) - balance`, rather than by letting `add` throw and
catching it. `BALANCE_LIMIT_EXCEEDED` is then decided the same way as `INSUFFICIENT_BALANCE`, by one
comparison, and `MoneyOverflowError` keeps meaning "a defect reached the arithmetic".

### Consequences

- Good, because every refusal the contract persists is a value the compiler forces the use case to handle.
- Good, because a refusal cannot leave the aggregate changed: it hands back nothing to write.
- Good, because the balance and its entry are produced together or not at all, with no mutation to unwind.
- Good, because the aggregate's whole decision surface is unit-testable with no database, clock or port.
- Neutral, because use cases read `outcome.applied` instead of using `try`/`catch`; the branch is explicit at
  every call site.
- Bad, because an outcome type must grow a code whenever a new refusal belongs to the aggregate, and the
  subset in `WalletRefusalCode` has to stay aligned with the codes the use case maps to HTTP statuses.
- Bad, because a caller that holds the old instance after an applied operation keeps reading stale state; the
  use case assigns the returned wallet and the repository writes it under the version guard of ADR 0002.
- Worth revisiting if the aggregate has to be mapped by the ORM as a mutable managed entity with change
  tracking rather than written through the explicit, version-guarded `UPDATE` of ADR 0002, or if refusals
  grow data beyond a failure code, which would turn the union into a richer refusal object.

### Confirmation

Acceptance entries WALLET-011 and WALLET-012 in [acceptance.yaml](../acceptance.yaml): the unit suite refuses
an uncovered debit, a foreign currency, a foreign owner and a credit past the bound, each asserting the
failure code and that balance and version did not move, and the balance-change suite asserting one entry per
change, the version increment, and that the instance the operation was called on is untouched.

## Pros and Cons of the Options

### Throw a domain exception per refusal and catch it in the use case

- Good, because the refusal cannot be ignored: an uncaught one fails loudly.
- Bad, because the four most ordinary outcomes of the system travel the same path as defects, and the `catch`
  that maps them is one block for both; a new refusal silently joins the generic handler.
- Bad, because a `catch` is not a place to resume from: the use case still has to persist the transaction,
  the failure code and the observed balance, which needs the state the exception did not carry.
- Bad, because exceptions carry no type information to exhaust; the compiler cannot say a code is unhandled.

### Mutate the aggregate and expose the refusal as state to read afterwards

- Good, because the call site looks like the ubiquitous language: `wallet.debit(bet)`.
- Bad, because the aggregate gains a mode: "refused" is state that must be read before anything else is
  trusted, and nothing forces the read.
- Bad, because the balance mutates before the entry is built, so a failed entry construction leaves the
  aggregate changed with no entry to match it, exactly the state `wallet.ledger-mirror` forbids.
- Bad, because two operations on one instance interleave their results, and reuse after a refusal is unsafe.

### Return a discriminated outcome: the new wallet with its entry, or the failure code

- Good, because the type system makes handling the refusal a precondition for reading the new state.
- Good, because the operation is a pure function of state and request: trivially testable, no clock, no I/O.
- Neutral, because the caller must thread the returned wallet instead of reusing the one it had.
- Bad, because the shape is less familiar than a mutating method and reads as more ceremony for a reader who
  expects an exception.

## More Information

Rules carried: `wallet.non-negative`, `wallet.balance-limit`, `wallet.currency-match`, `wallet.owner-match`,
`wallet.ledger-mirror`, `wallet.version-increments-on-balance-change`, `rule.rejected.no-effect`,
`rule.reversal.insufficient-balance`, `model.structural-immutability` in
[system-contract.md](../system-contract.md). ADR 0002 writes the returned state under the version guard;
ADR 0003 re-checks the same arithmetic in the schema; ADR 0004 replays the persisted outcome.
