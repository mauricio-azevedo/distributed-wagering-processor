import { Migration } from '@mikro-orm/migrations';

/**
 * The validity half of ADR 0003: what a single row has to satisfy to exist at all. The closed
 * vocabularies the previous migration left to a `CHECK` rather than to a column type arrive here
 * too, so one statement of each rule lives in the domain and one in the schema.
 *
 * Every monetary column carries `<> 'NaN'::numeric` as a check of its own
 * (`money.finite-in-database`). It is the only predicate that excludes the value: PostgreSQL
 * orders `NaN` above every number, so `amount > 0` and `balance_after >= 0` hold for it; `NaN =
 * NaN` is true, so the balanced arithmetic holds; and `NaN` propagates through addition, so a
 * stored one would satisfy the chain and reconciliation at the same time. Keeping the exclusion
 * apart from the range check is what lets a test drop one without the other and show that the rest
 * of the schema is blind to it (SCHEMA-026).
 */
export class Migration20261029010100_check_constraints extends Migration {
  override up(): void {
    this.addSql(`alter table "wallets"
      add constraint "wallets_balance_non_negative_check" check ("balance" >= 0)`);
    this.addSql(`alter table "wallets"
      add constraint "wallets_balance_is_finite_check" check ("balance" <> 'NaN'::numeric)`);
    this.addSql(`alter table "wallets"
      add constraint "wallets_version_at_least_one_check" check ("version" >= 1)`);

    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_kind_check"
      check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'))`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_status_check"
      check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_failure_code_check"
      check ("failure_code" in (
        'INSUFFICIENT_BALANCE', 'REVERSAL_INSUFFICIENT_BALANCE', 'BALANCE_LIMIT_EXCEEDED',
        'CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH', 'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'REFERENCE_KIND_NOT_ALLOWED',
        'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REVERSED', 'PROCESSING_FAILED'))`);

    /*
     * `tx.reference-matrix`, as one equivalence: a reversal has a target and `BET` and `OPENING`
     * have none, while `WIN` and `LOSS` may go either way.
     */
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_reference_matrix_check"
      check (
        "kind" in ('WIN', 'LOSS')
        or ("kind" in ('REFUND', 'ROLLBACK')) = ("reference_external_transaction_id" is not null)
      )`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_processed_at_presence_check"
      check (("status" = 'PROCESSED') = ("processed_at" is not null))`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_failure_code_presence_check"
      check (("status" in ('REJECTED', 'FAILED')) = ("failure_code" is not null))`);

    // `money.positive-in-operations`: a `LOSS` moves nothing and writes no entry, so `0.00` is
    // the one amount the schema admits beside a positive one.
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_amount_positive_check"
      check ("amount" >= 0 and ("amount" > 0 or "kind" = 'LOSS'))`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_amount_is_finite_check"
      check ("amount" <> 'NaN'::numeric)`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_observed_balance_non_negative_check"
      check ("observed_balance" >= 0)`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_observed_balance_is_finite_check"
      check ("observed_balance" <> 'NaN'::numeric)`);

    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_kind_check"
      check ("kind" in ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK'))`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_direction_check"
      check ("direction" in ('DEBIT', 'CREDIT'))`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_amount_positive_check" check ("amount" > 0)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_amount_is_finite_check"
      check ("amount" <> 'NaN'::numeric)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balance_before_is_finite_check"
      check ("balance_before" <> 'NaN'::numeric)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balance_after_non_negative_check"
      check ("balance_after" >= 0)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balance_after_is_finite_check"
      check ("balance_after" <> 'NaN'::numeric)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_version_at_least_one_check"
      check ("wallet_version" >= 1)`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_balanced_check"
      check (
        ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
        or ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
      )`);

    this.addSql(`alter table "outbox_messages"
      add constraint "outbox_messages_event_type_check"
      check ("event_type" in (
        'WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged',
        'WagerTransactionPendingReference'))`);
  }

  override down(): void {
    this.addSql(`alter table "outbox_messages" drop constraint "outbox_messages_event_type_check"`);

    for (const check of [
      'wallet_ledger_entries_balanced_check',
      'wallet_ledger_entries_wallet_version_at_least_one_check',
      'wallet_ledger_entries_balance_after_is_finite_check',
      'wallet_ledger_entries_balance_after_non_negative_check',
      'wallet_ledger_entries_balance_before_is_finite_check',
      'wallet_ledger_entries_amount_is_finite_check',
      'wallet_ledger_entries_amount_positive_check',
      'wallet_ledger_entries_direction_check',
      'wallet_ledger_entries_kind_check',
    ]) {
      this.addSql(`alter table "wallet_ledger_entries" drop constraint "${check}"`);
    }

    for (const check of [
      'wager_transactions_observed_balance_is_finite_check',
      'wager_transactions_observed_balance_non_negative_check',
      'wager_transactions_amount_is_finite_check',
      'wager_transactions_amount_positive_check',
      'wager_transactions_failure_code_presence_check',
      'wager_transactions_processed_at_presence_check',
      'wager_transactions_reference_matrix_check',
      'wager_transactions_failure_code_check',
      'wager_transactions_status_check',
      'wager_transactions_kind_check',
    ]) {
      this.addSql(`alter table "wager_transactions" drop constraint "${check}"`);
    }

    for (const check of [
      'wallets_version_at_least_one_check',
      'wallets_balance_is_finite_check',
      'wallets_balance_non_negative_check',
    ]) {
      this.addSql(`alter table "wallets" drop constraint "${check}"`);
    }
  }
}
