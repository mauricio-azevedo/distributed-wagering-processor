import { InvalidLedgerEntryError } from './errors';
import { Money } from './money';
import type { BalanceChangingKind } from './transaction-kind';

/** `ledger.direction-by-kind`: where the money went. The amount itself is always positive. */
export type LedgerDirection = 'DEBIT' | 'CREDIT';

/**
 * The operations that remove money from a wallet (`ledger.direction-by-kind`,
 * `rule.rollback.inverse`). A `ROLLBACK` debits only when it reverses a credit.
 */
export type DebitOperation =
  { readonly kind: 'BET' } | { readonly kind: 'ROLLBACK'; readonly reverses: 'WIN' | 'REFUND' };

/** The operations that add money to a wallet. A `ROLLBACK` credits only when it reverses a `BET`. */
export type CreditOperation =
  | { readonly kind: 'OPENING' | 'WIN' | 'REFUND' }
  | { readonly kind: 'ROLLBACK'; readonly reverses: 'BET' };

/**
 * What a balance change applies: the kind, and for a `ROLLBACK` the kind it reverses, because its
 * direction is the inverse of the entry it undoes. Splitting the union by direction makes a
 * contradiction between a kind and the method it is passed to a compile error: `Wallet.debit`
 * accepts only a `DebitOperation`, so no caller can credit a `BET`.
 */
export type LedgerOperation = DebitOperation | CreditOperation;

/** `ledger.direction-by-kind`, as the use cases read it to choose a debit or a credit. */
export function ledgerDirectionFor(operation: LedgerOperation): LedgerDirection {
  switch (operation.kind) {
    case 'BET':
      return 'DEBIT';
    case 'OPENING':
    case 'WIN':
    case 'REFUND':
      return 'CREDIT';
    case 'ROLLBACK':
      return operation.reverses === 'BET' ? 'CREDIT' : 'DEBIT';
  }
}

/** A ledger entry as the database holds it (`ledger.read-shape`). */
export interface WalletLedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly kind: BalanceChangingKind;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;
}

/** The balance change an entry is asked to record. `direction` is derived, never supplied. */
export interface NewWalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly operation: LedgerOperation;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;
}

/**
 * The immutable record of one balance change (`ledger.immutable`,
 * `model.structural-immutability`). Entries are the audit trail the stored balance is reconciled
 * against (`recon.calculation`), so an entry exists only when its own arithmetic holds: the
 * `Wallet` computes the new balance and `create` verifies it independently before the entry
 * records it, the first of the three places that check the same sum (the aggregate here, a `CHECK`
 * constraint and the chain triggers of ADR 0003 at commit).
 *
 * `walletVersion` is the version the change produced and the only ordering key of a wallet's
 * ledger (`ledger.wallet-version-sequence`); the UUID identifies, it never orders.
 */
export class WalletLedgerEntry implements WalletLedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly kind: BalanceChangingKind;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: WalletLedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.kind = state.kind;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  /**
   * Records a balance change. Refuses an amount that is not strictly positive
   * (`ledger.positive-amount`), a wallet version outside the sequence
   * (`ledger.wallet-version-sequence`) and arithmetic that does not balance
   * (`ledger.balanced-arithmetic`). A currency conflict between the amount and the balances is a
   * `CurrencyMismatchError` from `Money` (`ledger.currency-matches-wallet`).
   */
  static create(entry: NewWalletLedgerEntry): WalletLedgerEntry {
    const direction = ledgerDirectionFor(entry.operation);

    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        `a ledger entry records a movement, so its amount must be above zero, got ${entry.money.toString()} ${entry.money.currency}`,
      );
    }

    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        `walletVersion is the wallet version the entry produced, so it must be an integer of at least 1, got ${entry.walletVersion.toString()}`,
      );
    }

    if (!balances(direction, entry.balanceBefore, entry.money, entry.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `${entry.balanceBefore.toString()} ${direction === 'CREDIT' ? 'plus' : 'minus'} ${entry.money.toString()} is not ${entry.balanceAfter.toString()} ${entry.money.currency}, so the ${direction} does not balance`,
      );
    }

    return new WalletLedgerEntry({
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      kind: entry.operation.kind,
      direction,
      money: entry.money,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored entry, trusting the database. */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /**
   * `ledger.balanced-arithmetic`, as a question any entry can be asked. `create` has already
   * answered it for every entry it built; it stays reachable for entries that came from the
   * database, where reconciliation and the schema tests check the same sum.
   */
  isBalanced(): boolean {
    return balances(this.direction, this.balanceBefore, this.money, this.balanceAfter);
  }
}

/** `balanceBefore + money = balanceAfter` for a `CREDIT`, minus for a `DEBIT`. */
function balances(
  direction: LedgerDirection,
  balanceBefore: Money,
  money: Money,
  balanceAfter: Money,
): boolean {
  const applied = direction === 'CREDIT' ? balanceBefore.add(money) : balanceBefore.subtract(money);

  return applied.equals(balanceAfter);
}
