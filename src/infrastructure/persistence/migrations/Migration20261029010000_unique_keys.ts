import { Migration } from '@mikro-orm/migrations';

/**
 * The uniqueness half of ADR 0003: the keys that make a duplicate impossible to commit, and the
 * indexes the claim queries depend on.
 *
 * Two of the keys are partial, because they constrain a subset of the table rather than every row:
 * one processed reversal per target, so a rejected second attempt is still recorded beside it
 * (`rule.reference.reversed-once`), and one `OPENING` per wallet, so the opening credit cannot be
 * granted twice (`wallet.opening-credit`). `wallets (id, currency)` carries no rule of its own; it
 * is the target the composite foreign key of the ledger needs.
 */
export class Migration20261029010000_unique_keys extends Migration {
  override up(): void {
    this.addSql(`alter table "wallets"
      add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency")`);
    this.addSql(`alter table "wallets"
      add constraint "wallets_id_currency_unique" unique ("id", "currency")`);

    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_provider_id_external_transaction_id_unique"
      unique ("provider_id", "external_transaction_id")`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_provider_id_idempotency_key_unique"
      unique ("provider_id", "idempotency_key")`);
    this.addSql(`create unique index "wager_transactions_processed_reversal_unique"
      on "wager_transactions" ("reference_transaction_id")
      where "kind" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED'`);
    this.addSql(`create unique index "wager_transactions_opening_per_wallet_unique"
      on "wager_transactions" ("wallet_id") where "kind" = 'OPENING'`);

    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_unique" unique ("transaction_id")`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_id_wallet_version_unique"
      unique ("wallet_id", "wallet_version")`);

    // The claim of ADR 0005: pending rows that are due, oldest first.
    this.addSql(`create index "outbox_messages_claim_index"
      on "outbox_messages" ("published_at", "next_attempt_at", "occurred_at")`);
    // The claim of `ref.scheduler`: parked transactions that are due, and whether they expired.
    this.addSql(`create index "pending_reference_schedule_claim_index"
      on "pending_reference_schedule" ("next_attempt_at", "expires_at")`);
  }

  override down(): void {
    this.addSql(`drop index "pending_reference_schedule_claim_index"`);
    this.addSql(`drop index "outbox_messages_claim_index"`);

    this.addSql(`alter table "wallet_ledger_entries"
      drop constraint "wallet_ledger_entries_wallet_id_wallet_version_unique"`);
    this.addSql(`alter table "wallet_ledger_entries"
      drop constraint "wallet_ledger_entries_transaction_id_unique"`);

    this.addSql(`drop index "wager_transactions_opening_per_wallet_unique"`);
    this.addSql(`drop index "wager_transactions_processed_reversal_unique"`);
    this.addSql(`alter table "wager_transactions"
      drop constraint "wager_transactions_provider_id_idempotency_key_unique"`);
    this.addSql(`alter table "wager_transactions"
      drop constraint "wager_transactions_provider_id_external_transaction_id_unique"`);

    this.addSql(`alter table "wallets" drop constraint "wallets_id_currency_unique"`);
    this.addSql(`alter table "wallets" drop constraint "wallets_player_id_currency_unique"`);
  }
}
