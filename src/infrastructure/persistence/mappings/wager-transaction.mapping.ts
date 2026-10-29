import { EntitySchema } from '@mikro-orm/postgresql';

import type { FailureCode } from '../../../domain/failure-code';
import { Money } from '../../../domain/money';
import type { TransactionKind } from '../../../domain/transaction-kind';
import { type TransactionStatus, WagerTransaction } from '../../../domain/wager-transaction';
import { MoneyType } from './money.type';

/**
 * The `wager_transactions` row (ADR 0008): the audit log of a submission and the outcome recorded
 * against it (`tx.row-append-only`).
 *
 * The observed balance carries a currency column of its own. It is the wallet balance observed
 * when the outcome was recorded (`tx.observed-balance`), and a `CURRENCY_MISMATCH` rejection is
 * precisely the case where the submitted amount and the wallet balance are in different
 * currencies, so one shared column would relabel one of the two.
 */
export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  currency!: string;
  amount!: string;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedBalanceCurrency!: string | null;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  processedAt!: Date | null;
  createdAt!: Date;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 120 },
    externalTransactionId: { type: 'string', length: 120 },
    idempotencyKey: { type: 'string', length: 255 },
    payloadHash: { type: 'string', length: 71 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', length: 120 },
    gameId: { type: 'string', length: 120 },
    kind: { type: 'string', columnType: 'text' },
    currency: { type: 'string', length: 3 },
    amount: { type: new MoneyType() },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    observedBalance: { type: new MoneyType(), nullable: true },
    observedBalanceCurrency: { type: 'string', length: 3, nullable: true },
    referenceExternalTransactionId: { type: 'string', length: 120, nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    processedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
  },
});

/**
 * `model.rehydrate-no-revalidation`: the stored row, including an outcome, rebuilt without
 * replaying a transition. The vocabulary columns are read back as what the schema admits
 * (`tx.read-shape`).
 */
export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as TransactionKind,
    money: Money.from(row.amount, row.currency),
    status: row.status as TransactionStatus,
    failureCode: row.failureCode as FailureCode | null,
    observedBalance:
      row.observedBalance === null || row.observedBalanceCurrency === null
        ? null
        : Money.from(row.observedBalance, row.observedBalanceCurrency),
    referenceExternalTransactionId: row.referenceExternalTransactionId,
    referenceTransactionId: row.referenceTransactionId,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  });
}

export function toWagerTransactionRow(transaction: WagerTransaction): WagerTransactionRow {
  const row = new WagerTransactionRow();
  row.id = transaction.id;
  row.providerId = transaction.providerId;
  row.externalTransactionId = transaction.externalTransactionId;
  row.idempotencyKey = transaction.idempotencyKey;
  row.payloadHash = transaction.payloadHash;
  row.walletId = transaction.walletId;
  row.playerId = transaction.playerId;
  row.roundId = transaction.roundId;
  row.gameId = transaction.gameId;
  row.kind = transaction.kind;
  row.currency = transaction.money.currency;
  row.amount = transaction.money.toString();
  row.status = transaction.status;
  row.failureCode = transaction.failureCode;
  row.observedBalance = transaction.observedBalance?.toString() ?? null;
  row.observedBalanceCurrency = transaction.observedBalance?.currency ?? null;
  row.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  row.referenceTransactionId = transaction.referenceTransactionId;
  row.processedAt = transaction.processedAt;
  row.createdAt = transaction.createdAt;

  return row;
}
