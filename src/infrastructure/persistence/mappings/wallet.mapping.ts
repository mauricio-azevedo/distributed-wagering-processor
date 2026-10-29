import { EntitySchema } from '@mikro-orm/postgresql';

import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet';
import { MoneyType } from './money.type';

/**
 * The `wallets` row (ADR 0008). The currency is a column of its own, shared by the balance and,
 * through the composite key of ADR 0003, by the currency of every ledger entry of the wallet.
 */
export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: { type: new MoneyType() },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

/** `model.rehydrate-no-revalidation`: the stored state, parsed back into money and trusted. */
export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    balance: Money.from(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function toWalletRow(wallet: Wallet): WalletRow {
  const row = new WalletRow();
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.balance.currency;
  row.balance = wallet.balance.toString();
  row.version = wallet.version;
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;

  return row;
}
