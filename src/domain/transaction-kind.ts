/**
 * The vocabulary of transaction kinds. It belongs to neither the transaction nor the ledger: both
 * are written in it. The enumerations mirror `TransactionKind` and `BalanceChangingKind` of
 * [docs/openapi.yaml](../../docs/openapi.yaml), which is their authoritative definition
 * (`model.contract-first`).
 */

/** `tx.kinds`: what a provider submits, plus the internal `OPENING` credit. */
export type TransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

/** `tx.affects-balance`: the kinds that move money and so write a ledger entry. */
export type BalanceChangingKind = Exclude<TransactionKind, 'LOSS'>;
