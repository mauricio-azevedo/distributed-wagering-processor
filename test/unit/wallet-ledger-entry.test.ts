import { describe, expect, test } from 'bun:test';

import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import {
  type LedgerDirection,
  type LedgerOperation,
  WalletLedgerEntry,
  ledgerDirectionFor,
} from '../../src/domain/wallet-ledger-entry';

const WALLET_ID = '0193f0c0-0000-7000-8000-00000000000a';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000b';
const ENTRY_ID = '0193f0c0-0000-7000-8000-00000000000c';
const CREATED_AT = new Date('2026-10-28T12:00:00.000Z');

const brl = (amount: string): Money => Money.from(amount, 'BRL');

/** A credit of 40.00 taking a wallet at version 3 from 100.00 to 140.00. */
const creditOf = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
): WalletLedgerEntry =>
  WalletLedgerEntry.create({
    id: ENTRY_ID,
    walletId: WALLET_ID,
    transactionId: TRANSACTION_ID,
    operation: { kind: 'WIN' },
    money: brl('40.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('140.00'),
    walletVersion: 4,
    createdAt: CREATED_AT,
    ...overrides,
  });

describe('ledger-direction-by-kind', () => {
  test.each<[LedgerOperation, LedgerDirection]>([
    [{ kind: 'BET' }, 'DEBIT'],
    [{ kind: 'WIN' }, 'CREDIT'],
    [{ kind: 'REFUND' }, 'CREDIT'],
    [{ kind: 'OPENING' }, 'CREDIT'],
    [{ kind: 'ROLLBACK', reverses: 'BET' }, 'CREDIT'],
    [{ kind: 'ROLLBACK', reverses: 'WIN' }, 'DEBIT'],
    [{ kind: 'ROLLBACK', reverses: 'REFUND' }, 'DEBIT'],
  ])('%o is a %s', (operation, direction) => {
    expect(ledgerDirectionFor(operation)).toBe(direction);
  });

  test('a ROLLBACK takes the direction opposite to the entry it reverses', () => {
    expect(ledgerDirectionFor({ kind: 'ROLLBACK', reverses: 'BET' })).not.toBe(
      ledgerDirectionFor({ kind: 'BET' }),
    );
    expect(ledgerDirectionFor({ kind: 'ROLLBACK', reverses: 'WIN' })).not.toBe(
      ledgerDirectionFor({ kind: 'WIN' }),
    );
    expect(ledgerDirectionFor({ kind: 'ROLLBACK', reverses: 'REFUND' })).not.toBe(
      ledgerDirectionFor({ kind: 'REFUND' }),
    );
  });

  test('the entry carries the direction its kind implies, never one it was handed', () => {
    const debit = WalletLedgerEntry.create({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      operation: { kind: 'BET' },
      money: brl('40.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('60.00'),
      walletVersion: 4,
      createdAt: CREATED_AT,
    });

    expect(debit.kind).toBe('BET');
    expect(debit.direction).toBe('DEBIT');
    expect(creditOf({ operation: { kind: 'ROLLBACK', reverses: 'BET' } }).direction).toBe('CREDIT');
  });
});

describe('ledger-entry-arithmetic-validated', () => {
  test('a CREDIT of 40.00 from 100.00 to 140.00 is created and balanced', () => {
    const entry = creditOf();

    expect(entry.isBalanced()).toBe(true);
    expect(entry.money.toString()).toBe('40.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('140.00');
    expect(entry.walletVersion).toBe(4);
    expect(entry.walletId).toBe(WALLET_ID);
    expect(entry.transactionId).toBe(TRANSACTION_ID);
    expect(entry.createdAt).toEqual(CREATED_AT);
  });

  test('a CREDIT of 40.00 from 100.00 to 150.00 is refused', () => {
    expect(() => creditOf({ balanceAfter: brl('150.00') })).toThrow(InvalidLedgerEntryError);
  });

  test('a DEBIT is balanced by subtraction, not by addition', () => {
    expect(
      creditOf({
        operation: { kind: 'BET' },
        balanceAfter: brl('60.00'),
      }).isBalanced(),
    ).toBe(true);
    expect(() => creditOf({ operation: { kind: 'BET' } })).toThrow(InvalidLedgerEntryError);
  });

  test('the message names the arithmetic it refused', () => {
    expect(() => creditOf({ balanceAfter: brl('150.00') })).toThrow(/100\.00.*40\.00.*150\.00/);
  });

  test('an amount of 0.00 is refused: an entry records a movement', () => {
    expect(() => creditOf({ money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test.each([0, -1, 1.5, Number.NaN])('a walletVersion of %p is refused', (walletVersion) => {
    expect(() => creditOf({ walletVersion })).toThrow(InvalidLedgerEntryError);
  });

  test('an entry cannot mix currencies', () => {
    expect(() => creditOf({ money: Money.from('40.00', 'USD') })).toThrow(CurrencyMismatchError);
    expect(() => creditOf({ balanceBefore: Money.from('100.00', 'USD') })).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('domain-factories-are-the-only-entry', () => {
  test('the WalletLedgerEntry constructor is not reachable', () => {
    const construct = (): void => {
      // @ts-expect-error - the constructor is private (model.private-constructors).
      new WalletLedgerEntry();
    };

    expect(construct).toThrow(TypeError);
  });

  test('create returns an entry in its initial state', () => {
    expect(creditOf()).toBeInstanceOf(WalletLedgerEntry);
  });
});

describe('rehydrate-trusts-stored-state', () => {
  test('a stored entry is rebuilt without re-validating its arithmetic', () => {
    const stored = WalletLedgerEntry.rehydrate({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      kind: 'WIN',
      direction: 'CREDIT',
      money: brl('40.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('150.00'),
      walletVersion: 4,
      createdAt: CREATED_AT,
    });

    expect(stored.balanceAfter.toString()).toBe('150.00');
    expect(stored.isBalanced()).toBe(false);
  });

  test('a stored OPENING credit keeps the direction the database holds', () => {
    const stored = WalletLedgerEntry.rehydrate({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
      kind: 'OPENING',
      direction: 'CREDIT',
      money: brl('500.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('500.00'),
      walletVersion: 1,
      createdAt: CREATED_AT,
    });

    expect(stored.kind).toBe('OPENING');
    expect(stored.direction).toBe('CREDIT');
    expect(stored.isBalanced()).toBe(true);
  });
});

describe('money-and-ledger-entry-are-immutable', () => {
  test('an entry field cannot be assigned, at compile time or at runtime', () => {
    const entry = creditOf();
    const assignBalanceAfter = (): void => {
      // @ts-expect-error - balanceAfter is readonly (model.structural-immutability).
      entry.balanceAfter = brl('1000000.00');
    };

    expect(assignBalanceAfter).toThrow(TypeError);
    expect(entry.balanceAfter.toString()).toBe('140.00');
  });

  test('an entry exposes no method that changes it', () => {
    const mutators = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => !['constructor', 'isBalanced'].includes(name),
    );

    expect(mutators).toEqual([]);
  });
});
