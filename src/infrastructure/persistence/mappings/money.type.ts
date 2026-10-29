import { Type } from '@mikro-orm/core';

/**
 * The type of a money column: `NUMERIC(20,2)` in PostgreSQL, the exact decimal string in
 * JavaScript (`money.exact-persistence`, ADR 0001). It is the one place that fixes the column
 * type, so the capacity of every money column and the `money.bound` the domain enforces cannot
 * drift apart, and the one place a `number` could sneak into an amount, which is why both
 * directions refuse anything but a string instead of coercing it.
 *
 * The currency is not part of it: a row carries its amounts in one currency, held in a column of
 * its own, and the mapping pairs the two into a `Money` with the domain's own parser, which is
 * what refuses a stored value the domain cannot represent on the way back out.
 */
export class MoneyType extends Type<string | null, string | null> {
  override convertToDatabaseValue(value: unknown): string | null {
    return exactAmount(value, 'written to');
  }

  override convertToJSValue(value: unknown): string | null {
    return exactAmount(value, 'read from');
  }

  override getColumnType(): string {
    return 'numeric(20,2)';
  }

  override compareAsType(): string {
    return 'string';
  }
}

function exactAmount(value: unknown, direction: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new TypeError(
      `an amount ${direction} a money column is the exact decimal string of ADR 0001, got a ${typeof value}, which cannot hold it exactly`,
    );
  }

  return value;
}
