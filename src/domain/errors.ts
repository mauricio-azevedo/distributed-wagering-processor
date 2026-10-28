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
