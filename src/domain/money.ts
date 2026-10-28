import { CurrencyMismatchError, MoneyOverflowError, MoneyValidationError } from './errors';

/**
 * The only money shape that crosses a boundary: a request, a response, an event, a log line or a
 * database column (`model.money-props-in-contracts`). The amount is always a string.
 */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** `money.decimal-string`: two decimals, no sign, no leading zeros, at most 18 integer digits. */
const AMOUNT = /^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/;

/** `money.currency-iso`: an ISO 4217 alphabetic code. */
const CURRENCY = /^[A-Z]{3}$/;

const MINOR_UNITS_PER_UNIT = 100n;

/** `money.bound`: 999999999999999999.99, the capacity of NUMERIC(20,2), in minor units. */
const MAX_MINOR_UNITS = 99_999_999_999_999_999_999n;

/**
 * An exact amount in a currency, held as `bigint` minor units (ADR 0001). No JavaScript `number`
 * ever holds money and there is no rounding operation: a wrong scale is rejected by `from`, never
 * adjusted (`money.no-rounding`).
 *
 * Instances are immutable (`money.immutable`, `model.structural-immutability`): every operation
 * returns a new `Money`. A result may be negative, which is an ordinary intermediate value inside
 * the domain (a debit decides insufficient balance with it, reconciliation computes a difference
 * with it); the places that require a non-negative amount check it themselves.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses the two-decimal string form. Anything else is a `MoneyValidationError`. */
  static from(amount: string, currency: string): Money {
    return new Money(parseAmount(amount), parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return this.withMinorUnits(this.minorUnits + other.minorUnits);
  }

  /** May yield a negative amount: the signed difference (`money.signed-difference-only`). */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return this.withMinorUnits(this.minorUnits - other.minorUnits);
  }

  negate(): Money {
    return this.withMinorUnits(-this.minorUnits);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.minorUnits === other.minorUnits;
  }

  /** The decimal string form; the sign appears only on a negative amount, never as `-0.00`. */
  toString(): string {
    return formatMinorUnits(this.minorUnits);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private withMinorUnits(minorUnits: bigint): Money {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new MoneyOverflowError(
        `${formatMinorUnits(minorUnits)} ${this.currency} is outside the maximum magnitude the service stores, ${formatMinorUnits(MAX_MINOR_UNITS)}`,
      );
    }

    return new Money(minorUnits, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** The decimal string form of signed minor units; `-0.00` is unreachable because `-0n` is `0n`. */
function formatMinorUnits(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const units = magnitude / MINOR_UNITS_PER_UNIT;
  const remainder = magnitude % MINOR_UNITS_PER_UNIT;

  return `${negative ? '-' : ''}${units.toString()}.${remainder.toString().padStart(2, '0')}`;
}

function parseAmount(amount: unknown): bigint {
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new MoneyValidationError(
      `amount must be a decimal string matching ${AMOUNT.source}, got ${describeValue(amount)}`,
    );
  }

  return BigInt(amount.replace('.', ''));
}

function parseCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new MoneyValidationError(
      `currency must be an ISO 4217 alphabetic code matching ${CURRENCY.source}, got ${describeValue(currency)}`,
    );
  }

  return currency;
}

/** Names the offending value in a validation message without stringifying an arbitrary object. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return `${value.toString()} (${typeof value})`;
  }

  return `a value of type ${typeof value}`;
}
