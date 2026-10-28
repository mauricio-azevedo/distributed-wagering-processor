import { describe, expect, test } from 'bun:test';

import {
  CurrencyMismatchError,
  MoneyOverflowError,
  MoneyValidationError,
} from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

/** `money.bound`: the largest magnitude NUMERIC(20,2) stores. */
const BOUND = '999999999999999999.99';

/** 2^53 + 1: the first integer a JavaScript number cannot hold. */
const BEYOND_SAFE_INTEGER = '9007199254740993.00';

const brl = (amount: string): Money => Money.from(amount, 'BRL');

describe('money-accepts-two-decimal-strings', () => {
  test.each(['0.00', '0.05', '460.00', BEYOND_SAFE_INTEGER, BOUND])(
    'parses %p and prints it back unchanged',
    (amount) => {
      const money = brl(amount);

      expect(money.toString()).toBe(amount);
      expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  test('zero is the two-decimal zero of its currency', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});

describe('money-rejects-malformed-input', () => {
  test.each([
    'NaN',
    'Infinity',
    '1e3',
    '',
    '-1.00',
    '+1.00',
    ' 1.00',
    '1.00 ',
    '1,00',
    '01.00',
    '0.5',
    '1.0',
    '1.000',
    '1.',
    '.00',
    '1',
    '1000000000000000000.00',
    '0x10',
  ])('rejects %p as a domain validation error', (amount) => {
    expect(() => brl(amount)).toThrow(MoneyValidationError);
  });

  test('the error names the offending value', () => {
    expect(() => brl('1,00')).toThrow(/1,00/);
  });

  test.each([1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the JSON number %p instead of coercing it',
    (amount) => {
      expect(() => Money.from(amount as unknown as string, 'BRL')).toThrow(MoneyValidationError);
    },
  );

  test('rejects a missing amount', () => {
    expect(() => Money.from(undefined as unknown as string, 'BRL')).toThrow(MoneyValidationError);
    expect(() => Money.from(null as unknown as string, 'BRL')).toThrow(MoneyValidationError);
  });
});

describe('money-never-rounds', () => {
  test('a third decimal is rejected, never adjusted', () => {
    expect(() => brl('1.005')).toThrow(MoneyValidationError);
  });

  test('a decimal sum that binary floating point cannot represent is exact', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  test('a hundred cents sum to exactly one unit', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 100; i += 1) {
      total = total.add(brl('0.01'));
    }

    expect(total.toString()).toBe('1.00');
  });

  test('Money exposes no rounding operation to misuse', () => {
    const operations = Object.getOwnPropertyNames(Money.prototype);

    expect(operations.filter((name) => /round|ceil|floor|trunc/i.test(name))).toEqual([]);
  });
});

describe('money-currency-code-format', () => {
  test.each(['BRL', 'USD'])('accepts the ISO 4217 alphabetic code %p', (currency) => {
    expect(Money.from('1.00', currency).currency).toBe(currency);
  });

  test.each(['brl', 'BRl', 'BR', 'BRLX', 'BR1', '', ' BRL', '986'])(
    'rejects the currency %p',
    (currency) => {
      expect(() => Money.from('1.00', currency)).toThrow(MoneyValidationError);
      expect(() => Money.zero(currency)).toThrow(MoneyValidationError);
    },
  );

  test('rejects a missing currency', () => {
    expect(() => Money.from('1.00', undefined as unknown as string)).toThrow(MoneyValidationError);
  });
});

describe('money-rejects-currency-mismatch', () => {
  const tenBrl = Money.from('10.00', 'BRL');
  const tenUsd = Money.from('10.00', 'USD');

  test.each([
    ['add', (left: Money, right: Money) => left.add(right)],
    ['subtract', (left: Money, right: Money) => left.subtract(right)],
    ['isLessThan', (left: Money, right: Money) => left.isLessThan(right)],
    ['equals', (left: Money, right: Money) => left.equals(right)],
  ] as const)('%s across currencies throws CurrencyMismatchError', (_name, operation) => {
    expect(() => operation(tenBrl, tenUsd)).toThrow(CurrencyMismatchError);
    expect(() => operation(tenUsd, tenBrl)).toThrow(CurrencyMismatchError);
  });

  test('the error names both currencies', () => {
    expect(() => tenBrl.add(tenUsd)).toThrow(/BRL.*USD/);
  });

  test('equal amounts in the same currency compare and never throw', () => {
    expect(tenBrl.equals(Money.from('10.00', 'BRL'))).toBe(true);
    expect(tenBrl.equals(brl('9.99'))).toBe(false);
    expect(brl('9.99').isLessThan(tenBrl)).toBe(true);
    expect(tenBrl.isLessThan(brl('9.99'))).toBe(false);
    expect(tenBrl.isLessThan(tenBrl)).toBe(false);
  });
});

describe('signed-difference-formatting', () => {
  test('a difference below zero carries its sign', () => {
    expect(brl('10.00').subtract(brl('12.50')).toString()).toBe('-2.50');
    expect(brl('0.00').subtract(brl('0.01')).toString()).toBe('-0.01');
  });

  test('a difference of zero is 0.00, never -0.00', () => {
    expect(brl('10.00').subtract(brl('10.00')).toString()).toBe('0.00');
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
    expect(brl('0.01').subtract(brl('0.01')).negate().toString()).toBe('0.00');
  });

  test('negate flips the sign and is its own inverse', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().negate().toString()).toBe('5.00');
  });

  test('a negative amount is serialized as a signed string, not as a number', () => {
    expect(brl('10.00').subtract(brl('12.50')).toJSON()).toEqual({
      amount: '-2.50',
      currency: 'BRL',
    });
  });

  test('a signed amount is never accepted back as an input', () => {
    expect(() => brl('-2.50')).toThrow(MoneyValidationError);
  });
});

describe('money-uses-bigint-not-number', () => {
  test('a value past the safe integer range survives exactly, where a number would not', () => {
    expect(brl(BEYOND_SAFE_INTEGER).toString()).toBe(BEYOND_SAFE_INTEGER);
    expect(Number(BEYOND_SAFE_INTEGER).toFixed(2)).not.toBe(BEYOND_SAFE_INTEGER);
  });

  test('no field of a Money holds a number', () => {
    const fields = Object.values(brl('460.00')).map((value) => typeof value);

    expect(fields).not.toContain('number');
    expect(fields.toSorted()).toEqual(['bigint', 'string']);
  });

  test('JSON serialization emits MoneyProps strings', () => {
    expect(JSON.stringify({ money: brl('460.00') })).toBe(
      '{"money":{"amount":"460.00","currency":"BRL"}}',
    );
  });
});

describe('money-is-bounded-by-storage', () => {
  test('the bound parses and prints unchanged', () => {
    expect(brl(BOUND).toString()).toBe(BOUND);
  });

  test('one unit past the bound is a validation error, not an overflow', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(MoneyValidationError);
  });

  test('a sum that would cross the bound throws MoneyOverflowError', () => {
    expect(() => brl(BOUND).add(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(BOUND).add(brl(BOUND))).toThrow(MoneyOverflowError);
  });

  test('a sum that lands exactly on the bound is allowed', () => {
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(BOUND);
    expect(brl(BOUND).add(Money.zero('BRL')).toString()).toBe(BOUND);
  });

  test('the bound is symmetric: the negative bound is reachable and reversible', () => {
    const negativeBound = Money.zero('BRL').subtract(brl(BOUND));

    expect(negativeBound.toString()).toBe(`-${BOUND}`);
    expect(negativeBound.negate().toString()).toBe(BOUND);
  });

  test('a difference that would cross the negative bound throws MoneyOverflowError', () => {
    const negativeBound = Money.zero('BRL').subtract(brl(BOUND));

    expect(() => negativeBound.subtract(brl('0.01'))).toThrow(MoneyOverflowError);
  });
});

describe('money-and-ledger-entry-are-immutable', () => {
  test('an operation returns a new instance and leaves both operands unchanged', () => {
    const left = brl('10.00');
    const right = brl('2.50');

    const sum = left.add(right);
    const difference = left.subtract(right);
    const negated = left.negate();

    expect(sum).not.toBe(left);
    expect(difference).not.toBe(left);
    expect(negated).not.toBe(left);
    expect(sum.toString()).toBe('12.50');
    expect(difference.toString()).toBe('7.50');
    expect(negated.toString()).toBe('-10.00');
    expect(left.toString()).toBe('10.00');
    expect(right.toString()).toBe('2.50');
  });

  test('a field cannot be assigned, at compile time or at runtime', () => {
    const money = brl('10.00');
    const assignCurrency = (): void => {
      // @ts-expect-error - currency is readonly (model.structural-immutability).
      money.currency = 'USD';
    };

    expect(assignCurrency).toThrow(TypeError);
    expect(money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });
});
