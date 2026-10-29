/**
 * Domain errors. The domain throws them; adapters translate them into the failure codes of
 * docs/system-contract.md. They never carry transport or framework concerns.
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An input the domain refuses: a malformed amount or currency code
 * (`money.decimal-string`, `money.rejected-inputs`, `money.currency-iso`).
 */
export class MoneyValidationError extends DomainError {}

/**
 * An arithmetic result outside `money.bound`. Checked in the domain so the database never reports
 * a numeric overflow; a credit that would cross the bound becomes a persisted rejection
 * (`wallet.balance-limit`).
 */
export class MoneyOverflowError extends DomainError {}

/** Arithmetic or comparison between two currencies (`money.same-currency`). */
export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`money operations require one currency, got ${left} and ${right}`);
  }
}

/**
 * A ledger entry that does not hold as a record of one balance change: an amount that is not
 * strictly positive (`ledger.positive-amount`), arithmetic that does not balance
 * (`ledger.balanced-arithmetic`) or a wallet version outside the sequence
 * (`ledger.wallet-version-sequence`).
 *
 * It is a programming error, not a business outcome: the aggregate decides every refusal a
 * provider can cause before it builds an entry, so an unbalanced entry means the code that
 * computed the new balance and the code that records it disagree.
 */
export class InvalidLedgerEntryError extends DomainError {}

/**
 * A transition a `WagerTransaction` does not have: one that leaves a terminal status
 * (`tx.terminal-immutable`) or that is not in the table of `tx.transitions`.
 *
 * It is a programming error, not a business outcome (`model.explicit-transitions`): a provider
 * resending a terminal operation is a replay, answered from the stored outcome without touching
 * the row, so a transition that reaches a terminal transaction means the use case acted on state
 * it had already closed. A trigger refuses the same write whatever issued it (ADR 0003).
 */
export class InvalidTransactionStateError extends DomainError {}

/**
 * A transaction that does not hold as a record of what a provider submitted: a reference its kind
 * forbids, a missing one its kind requires (`tx.reference-matrix`), or an outcome that waits for
 * or resolves a reference the submission never carried.
 *
 * It is a programming error, like `InvalidLedgerEntryError`: the reference matrix is request
 * validation first (`400 VALIDATION_FAILED`), decided by the adapters before a transaction is
 * built, and the schema repeats it on the submitted reference (SCHEMA-006). This is the domain's
 * own line, and the only one that covers the resolved service id the schema cannot check.
 */
export class InvalidWagerTransactionError extends DomainError {}

/**
 * A transition called on a message record that already completed: an inbox row processed twice, a
 * published outbox row published or rescheduled again (`model.explicit-transitions`).
 *
 * It is a programming error, not a business outcome. A redelivery is absorbed by asking the inbox
 * row whether it is processed (`msg.redelivery-safe`), and a published outbox row is never claimed
 * again (`outbox.publish-after-commit`), so a transition reaching a completed row means the caller
 * skipped the question instead of a duplicate arriving.
 */
export class InvalidMessageStateError extends DomainError {}

/**
 * A value that cannot be hashed into one canonical form: data JSON has no form for reaching the
 * canonical serializer, or a digest that is not the lowercase hex SHA-256 the contract stores
 * (`idem.payload-hash`).
 *
 * It is a programming error, not a business outcome: the payload is validated before it is
 * hashed, so a refusal here means the code that assembled the payload, or the code that digested
 * it, departed from the form every instance has to agree on.
 */
export class CanonicalHashError extends DomainError {}
