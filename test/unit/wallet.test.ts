import { describe, expect, test } from 'bun:test';

import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import {
  Wallet,
  type WalletOperationOutcome,
  type WalletRefusalCode,
} from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const WALLET_ID = '0193f0c0-0000-7000-8000-000000000001';
const PLAYER_ID = '0193f0c0-0000-7000-8000-000000000002';
const OTHER_PLAYER_ID = '0193f0c0-0000-7000-8000-000000000003';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-000000000004';
const ENTRY_ID = '0193f0c0-0000-7000-8000-000000000005';
const OPENED_AT = new Date('2026-10-28T12:00:00.000Z');
const OCCURRED_AT = new Date('2026-10-28T13:00:00.000Z');

/** `money.bound`: the largest magnitude a money column stores. */
const BOUND = '999999999999999999.99';

const brl = (amount: string): Money => Money.from(amount, 'BRL');

/** A wallet at `version` holding `balance`, as the database would hand it back. */
const walletHolding = (balance: string, version = 3): Wallet =>
  Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balance: brl(balance),
    version,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
  });

const refusalOf = (outcome: WalletOperationOutcome): WalletRefusalCode | undefined =>
  outcome.applied ? undefined : outcome.failureCode;

const appliedOf = (
  outcome: WalletOperationOutcome,
): { wallet: Wallet; entry: WalletLedgerEntry } => {
  if (!outcome.applied) {
    throw new Error(`expected the operation to apply, it was refused with ${outcome.failureCode}`);
  }

  return { wallet: outcome.wallet, entry: outcome.entry };
};

const bet = (
  amount: string,
  overrides: { playerId?: string; currency?: string } = {},
): Parameters<Wallet['debit']>[0] => ({
  transactionId: TRANSACTION_ID,
  entryId: ENTRY_ID,
  playerId: overrides.playerId ?? PLAYER_ID,
  operation: { kind: 'BET' },
  money: Money.from(amount, overrides.currency ?? 'BRL'),
  occurredAt: OCCURRED_AT,
});

const win = (
  amount: string,
  overrides: { playerId?: string; currency?: string } = {},
): Parameters<Wallet['credit']>[0] => ({
  transactionId: TRANSACTION_ID,
  entryId: ENTRY_ID,
  playerId: overrides.playerId ?? PLAYER_ID,
  operation: { kind: 'WIN' },
  money: Money.from(amount, overrides.currency ?? 'BRL'),
  occurredAt: OCCURRED_AT,
});

describe('wallet-opens-at-version-one', () => {
  test('a wallet opened with a positive initial balance holds it at version 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      openedAt: OPENED_AT,
      openingCredit: {
        transactionId: TRANSACTION_ID,
        entryId: ENTRY_ID,
        money: brl('500.00'),
      },
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('500.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(OPENED_AT);
    expect(openingEntry?.kind).toBe('OPENING');
    expect(openingEntry?.direction).toBe('CREDIT');
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('500.00');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe(TRANSACTION_ID);
  });

  test('a wallet opened without a credit is version 1, 0.00 and has no entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      openedAt: OPENED_AT,
      openingCredit: null,
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(openingEntry).toBeNull();
  });

  test('an opening credit of 0.00 is refused: zero opens the wallet alone', () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        currency: 'BRL',
        openedAt: OPENED_AT,
        openingCredit: { transactionId: TRANSACTION_ID, entryId: ENTRY_ID, money: brl('0.00') },
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('an opening credit in another currency cannot open the wallet', () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        currency: 'BRL',
        openedAt: OPENED_AT,
        openingCredit: {
          transactionId: TRANSACTION_ID,
          entryId: ENTRY_ID,
          money: Money.from('500.00', 'USD'),
        },
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('wallet-aggregate-invariants', () => {
  test('a debit the balance does not cover is refused and changes nothing', () => {
    const wallet = walletHolding('100.00');

    expect(refusalOf(wallet.debit(bet('100.01')))).toBe('INSUFFICIENT_BALANCE');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(3);
  });

  test('an uncovered ROLLBACK debit carries its own failure code', () => {
    const wallet = walletHolding('100.00');

    const outcome = wallet.debit({
      ...bet('100.01'),
      operation: { kind: 'ROLLBACK', reverses: 'WIN' },
    });

    expect(refusalOf(outcome)).toBe('REVERSAL_INSUFFICIENT_BALANCE');
  });

  test('an operation in another currency is refused on both directions', () => {
    const wallet = walletHolding('100.00');

    expect(refusalOf(wallet.debit(bet('50.00', { currency: 'USD' })))).toBe('CURRENCY_MISMATCH');
    expect(refusalOf(wallet.credit(win('50.00', { currency: 'USD' })))).toBe('CURRENCY_MISMATCH');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(3);
  });

  test('an operation naming another owner is refused on both directions', () => {
    const wallet = walletHolding('100.00');

    expect(refusalOf(wallet.debit(bet('10.00', { playerId: OTHER_PLAYER_ID })))).toBe(
      'WALLET_PLAYER_MISMATCH',
    );
    expect(refusalOf(wallet.credit(win('10.00', { playerId: OTHER_PLAYER_ID })))).toBe(
      'WALLET_PLAYER_MISMATCH',
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(3);
  });

  test('the owner is checked before the amount', () => {
    const wallet = walletHolding('100.00');

    expect(refusalOf(wallet.debit(bet('100.01', { playerId: OTHER_PLAYER_ID })))).toBe(
      'WALLET_PLAYER_MISMATCH',
    );
  });

  test('a credit that would take the balance past the money bound is refused', () => {
    const wallet = walletHolding(BOUND);

    expect(refusalOf(wallet.credit(win('0.01')))).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(wallet.balance.toString()).toBe(BOUND);
    expect(wallet.version).toBe(3);
  });

  test('a credit that lands exactly on the money bound is applied', () => {
    const wallet = walletHolding('999999999999999998.99');

    const { wallet: credited } = appliedOf(wallet.credit(win('1.00')));

    expect(credited.balance.toString()).toBe(BOUND);
  });

  test('a debit the balance covers exactly is applied, down to 0.00', () => {
    const wallet = walletHolding('100.00');

    const { wallet: debited, entry } = appliedOf(wallet.debit(bet('100.00')));

    expect(debited.balance.toString()).toBe('0.00');
    expect(debited.version).toBe(4);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceAfter.toString()).toBe('0.00');
  });

  test('a credit on a fresh instance of the same wallet is applied', () => {
    const wallet = walletHolding('100.00');

    const { wallet: credited } = appliedOf(wallet.credit(win('1.00')));

    expect(credited.balance.toString()).toBe('101.00');
    expect(credited.version).toBe(4);
  });

  test('the aggregate exposes no setter', () => {
    const wallet = walletHolding('100.00');
    const assignBalance = (): void => {
      // @ts-expect-error - balance is readonly; only an operation produces a new state.
      wallet.balance = brl('1000000.00');
    };

    expect(assignBalance).toThrow(TypeError);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('balance-and-version-move-with-one-entry', () => {
  test('each balance change increments the version once and writes one mirroring entry', () => {
    const opened = walletHolding('100.00');

    const debited = appliedOf(opened.debit(bet('40.00')));
    const credited = appliedOf(debited.wallet.credit(win('10.00')));
    const refused = debited.wallet.debit(bet('1000.00'));

    expect(debited.wallet.version).toBe(4);
    expect(debited.wallet.balance.toString()).toBe('60.00');
    expect(debited.entry.direction).toBe('DEBIT');
    expect(debited.entry.money.toString()).toBe('40.00');
    expect(debited.entry.balanceBefore.toString()).toBe('100.00');
    expect(debited.entry.balanceAfter.toString()).toBe('60.00');
    expect(debited.entry.walletVersion).toBe(4);

    expect(credited.wallet.version).toBe(5);
    expect(credited.wallet.balance.toString()).toBe('70.00');
    expect(credited.entry.direction).toBe('CREDIT');
    expect(credited.entry.money.toString()).toBe('10.00');
    expect(credited.entry.balanceBefore.toString()).toBe('60.00');
    expect(credited.entry.balanceAfter.toString()).toBe('70.00');
    expect(credited.entry.walletVersion).toBe(5);

    expect(refusalOf(refused)).toBe('INSUFFICIENT_BALANCE');
  });

  test('a refused operation yields no entry', () => {
    const outcome = walletHolding('100.00').debit(bet('1000.00'));

    expect(outcome.applied).toBe(false);
    expect('entry' in outcome).toBe(false);
  });

  test('every entry mirrors the state its operation produced', () => {
    const { wallet, entry } = appliedOf(walletHolding('100.00').debit(bet('40.00')));

    expect(entry.walletId).toBe(wallet.id);
    expect(entry.walletVersion).toBe(wallet.version);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.createdAt).toEqual(wallet.updatedAt);
  });

  test('an applied operation leaves the instance it was called on untouched', () => {
    const wallet = walletHolding('100.00');

    const { wallet: debited } = appliedOf(wallet.debit(bet('40.00')));

    expect(debited).not.toBe(wallet);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(OPENED_AT);
  });

  test('the time of the change becomes updatedAt, createdAt stays the opening time', () => {
    const { wallet } = appliedOf(walletHolding('100.00').debit(bet('40.00')));

    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(OCCURRED_AT);
  });
});

describe('domain-factories-are-the-only-entry', () => {
  test('the Wallet constructor is not reachable', () => {
    const construct = (): void => {
      // @ts-expect-error - the constructor is private (model.private-constructors).
      new Wallet();
    };

    expect(construct).toThrow(TypeError);
  });

  test('open returns a wallet in its initial state', () => {
    const { wallet } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      openedAt: OPENED_AT,
      openingCredit: null,
    });

    expect(wallet).toBeInstanceOf(Wallet);
    expect(wallet.version).toBe(1);
  });
});

describe('rehydrate-trusts-stored-state', () => {
  test('a wallet at version 7 with a non-zero balance is rebuilt as stored', () => {
    const updatedAt = new Date('2026-10-28T14:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      balance: brl('460.00'),
      version: 7,
      createdAt: OPENED_AT,
      updatedAt,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('460.00');
    expect(wallet.playerId).toBe(PLAYER_ID);
    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  test('rehydration applies no rule the database already holds', () => {
    const rehydrateAtVersionZero = (): Wallet =>
      Wallet.rehydrate({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        balance: brl('0.00'),
        version: 0,
        createdAt: OPENED_AT,
        updatedAt: OPENED_AT,
      });

    expect(rehydrateAtVersionZero().version).toBe(0);
  });
});
