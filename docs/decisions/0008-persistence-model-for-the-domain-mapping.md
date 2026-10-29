---
status: accepted
date: 2026-10-28
---

# Map rows to the domain through a persistence model, not the domain classes themselves

## Context and Problem Statement

The domain classes are built to make illegal states unrepresentable: `Money`, `Wallet` and `WalletLedgerEntry`
freeze themselves in their constructors (`model.structural-immutability`), a `Wallet` operation answers with a
new instance instead of mutating (ADR 0006), and a `WagerTransaction` keeps the five columns an outcome writes
in `#private` fields behind getters, so `markProcessed`, `reject` and `fail` are the only writers (ADR 0007).
None of them can be constructed from outside (`model.private-constructors`).

MikroORM, like every data mapper of its kind, owns the instances it manages: it creates them without calling
the constructor, assigns every mapped property during hydration, and attaches its own tracking state to each
one. The two designs meet in the mapping. Does the ORM map the domain classes directly, or does the
infrastructure layer keep rows of its own and translate?

## Decision Drivers

- A domain that owes nothing to the ORM (`model.framework-free-domain`): no decorator, no writable field added
  for a hydrator, no constructor shape chosen by a library.
- Instances that are what the factories produced: an outcome reachable only through its transition, a frozen
  value that no layer can edit.
- Exact money, with one currency column serving the amounts of a row (`money.exact-persistence`).
- The statements of one operation in the order the use case issued them, because that order is the lock order of
  ADR 0002.
- A mapping a reader can check against the migration column by column.

## Considered Options

- MikroORM `EntitySchema` over the domain classes
- Relax the domain so the ORM can own its instances
- A persistence model in the infrastructure layer, translated by mappers

## Decision Outcome

Chosen option: "A persistence model in the infrastructure layer, translated by mappers", because it is the only
one that leaves both sides intact: the ORM manages plain row classes it fully owns, and the domain keeps the
immutability and the private transitions the contract rests on.

One `*Row` class per table carries the columns, mapped by an `EntitySchema` beside it, with a pair of functions
that translate: a `to<Aggregate>` that rehydrates through the domain's own factory
(`model.rehydrate-no-revalidation`) and a `to<Aggregate>Row` that reads the state back out. A money column pairs
with the currency column of its row: `MoneyType` keeps the `NUMERIC(20,2)` value an exact decimal string in
both directions and refuses anything that is not a string, and the mapper hands that string to `Money.from`
with the row's currency, so the only parser of an amount is the domain's, in the database direction too. This
refines the sketch in ADR 0001, where the custom type was described as converting the column to `Money` on its
own; a type sees one column and never the currency beside it, so the conversion finishes in the mapper.

The repositories of the application ports are thin: they translate, write through the entity manager of the open
transaction and read back through the mappers. They write when the use case calls them rather than at the
commit, so a flush cannot reorder the statements of an operation behind the lock order of ADR 0002, and the
transaction, not the ORM change set, is the unit of atomicity (`outbox.single-transaction`). A repository is
reachable only through `UnitOfWork.transactional`, which forks an entity manager per operation: the manager an
application injects is long-lived, and an operation working on it would publish the rows it loaded to every
later operation through the shared identity map.

The direct mapping was measured, not assumed, against PostgreSQL 18 and MikroORM 7: `em.persist` of a frozen
aggregate fails with `Attempting to define property on object that is not extensible`, because the ORM attaches
its tracking state to the instance; and a class shaped like `WagerTransaction` loads with its `status` getter
shadowed by an own property holding the stored value while `#status` stays unset, so the loaded object answers
`PROCESSED` to a property read and throws `Cannot access invalid private field` from `isTerminal()`. A mapping
that produces instances whose methods throw is worse than no mapping at all.

### Consequences

- Good, because the domain layer has no reason to know an ORM exists, and the import rule that says so
  (MODEL-005) stays provable.
- Good, because a rehydrated aggregate is indistinguishable from one the factories produced: the round trip of
  every entity is asserted field by field.
- Good, because the row classes are the one place the schema and the code meet, so a column rename is a
  compile error in the mapper rather than a silent `undefined`.
- Good, because the `Wallet` that answers an operation with a new instance needs no managed counterpart: the
  repository writes the state it is given.
- Bad, because every entity costs a row class and two functions, and a new column has to be added in the
  migration, the row, the schema and both mappers.
- Bad, because nothing in the type system forces a mapper to cover a column it does not mention; the
  field-by-field round-trip tests are what catch an omission.
- Bad, because the ORM's identity map no longer returns the aggregate a use case already loaded, so a use case
  that reads the same wallet twice in one transaction rehydrates it twice. Operations read a wallet once, under
  its lock.
- Worth revisiting if MikroORM gains a hydration path that calls a factory instead of writing properties, if the
  row classes start to drift from the tables they mirror, or if the duplication of a column across the migration
  and the mapping becomes a recurring source of defects.

### Confirmation

Acceptance entries MONEY-010, SCHEMA-020 and MODEL-005 in [acceptance.yaml](../acceptance.yaml): an integration
round trip per entity against the PostgreSQL container, asserting that what comes back equals what the factory
produced; a money round trip at `0.00`, a mid value and the bound `999999999999999999.99`, with the column
inspected in `information_schema`; and a test over the import graph of `src/domain`. Two more tests hold the
unit of work to its half: a failed operation leaves nothing committed, and an operation never serves a wallet
that another operation loaded before it.

## Pros and Cons of the Options

### MikroORM `EntitySchema` over the domain classes

The schema names the domain class; the ORM hydrates and tracks aggregates directly.

- Good, because there is one class per concept and no translation to write or test.
- Good, because the identity map and the change set work on the aggregates themselves.
- Bad, because it does not work on this domain: a frozen aggregate cannot be persisted and a transaction loaded
  this way carries a shadowed status with its private field unset, so its own methods throw.
- Bad, because it would make the ORM a constraint on every future domain class.

### Relax the domain so the ORM can own its instances

Drop the `Object.freeze` calls, replace the `#private` outcome fields with writable properties, give every class
a no-argument constructor.

- Good, because the mapping becomes trivial and the identity map works on aggregates.
- Bad, because `model.structural-immutability` and `model.explicit-transitions` stop being structural: a
  terminal outcome and a frozen ledger entry become conventions, enforced by review.
- Bad, because the reason the domain holds those guarantees is that the financial rules depend on them; trading
  them for a shorter mapping inverts the dependency direction the architecture is built on.

### A persistence model in the infrastructure layer, translated by mappers

Row classes mapped by `EntitySchema`, with mappers to and from the domain.

- Good, because each layer keeps the shape its own rules need.
- Good, because the translation is explicit, readable next to the migration and testable without a use case.
- Neutral, because the row classes duplicate the column list; they are flat and have no behaviour.
- Bad, because the duplication is real and a forgotten column is caught by a test rather than by the compiler.

## More Information

Rules carried: `model.framework-free-domain`, `model.rehydrate-no-revalidation`,
`model.structural-immutability`, `money.exact-persistence`, `outbox.single-transaction` in
[system-contract.md](../system-contract.md). ADR 0001 decides the money representation this mapping preserves,
ADR 0002 the lock order the write path keeps, ADR 0003 the guarantees the migrations add on top of these tables,
and ADRs 0006 and 0007 the domain shapes that make the persistence model necessary. The layer table in
[ARCHITECTURE.md](../../ARCHITECTURE.md) places the rows, the mappers and the repositories.
