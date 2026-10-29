import { EntitySchema } from '@mikro-orm/postgresql';

import { Money } from '../../../domain/money';
import type { BalanceChangingKind } from '../../../domain/transaction-kind';
import { type LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { MoneyType } from './money.type';

/**
 * The `wallet_ledger_entries` row (ADR 0008). One currency column serves the amount and both
 * balances: an entry carries the currency of its wallet and nothing else
 * (`ledger.currency-matches-wallet`).
 */
export class WalletLedgerEntryRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  kind!: string;
  direction!: string;
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    kind: { type: 'string', columnType: 'text' },
    direction: { type: 'string', columnType: 'text' },
    currency: { type: 'string', length: 3 },
    amount: { type: new MoneyType() },
    balanceBefore: { type: new MoneyType() },
    balanceAfter: { type: new MoneyType() },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime' },
  },
});

/**
 * `model.rehydrate-no-revalidation`: a stored entry is rebuilt without re-deriving its direction
 * or re-checking its arithmetic, both of which the aggregate and the schema settled when it was
 * written. The vocabulary columns are read back as what the schema admits (`ledger.read-shape`).
 */
export function toWalletLedgerEntry(row: WalletLedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    kind: row.kind as BalanceChangingKind,
    direction: row.direction as LedgerDirection,
    money: Money.from(row.amount, row.currency),
    balanceBefore: Money.from(row.balanceBefore, row.currency),
    balanceAfter: Money.from(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

export function toWalletLedgerEntryRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  const row = new WalletLedgerEntryRow();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.kind = entry.kind;
  row.direction = entry.direction;
  row.currency = entry.money.currency;
  row.amount = entry.money.toString();
  row.balanceBefore = entry.balanceBefore.toString();
  row.balanceAfter = entry.balanceAfter.toString();
  row.walletVersion = entry.walletVersion;
  row.createdAt = entry.createdAt;

  return row;
}
