import { Migration } from '@mikro-orm/migrations';

/**
 * The referential half of ADR 0003. One of the keys carries a financial rule rather than mere
 * integrity: `(wallet_id, currency)` on the ledger points at `wallets (id, currency)`, so an entry
 * can never hold a currency other than its wallet's (`ledger.currency-matches-wallet`), which no
 * single-column key could express.
 *
 * None of them cascades or nullifies: no row of these tables is ever deleted
 * (`tx.row-append-only`, `ledger.immutable`), so the default `no action` is the behaviour the
 * contract asks for and a cascade would be a way to lose history.
 */
export class Migration20261029010200_foreign_keys extends Migration {
  override up(): void {
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_wallet_id_foreign"
      foreign key ("wallet_id") references "wallets" ("id")`);
    this.addSql(`alter table "wager_transactions"
      add constraint "wager_transactions_reference_transaction_id_foreign"
      foreign key ("reference_transaction_id") references "wager_transactions" ("id")`);

    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_foreign"
      foreign key ("transaction_id") references "wager_transactions" ("id")`);
    this.addSql(`alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_id_currency_foreign"
      foreign key ("wallet_id", "currency") references "wallets" ("id", "currency")`);

    this.addSql(`alter table "pending_reference_schedule"
      add constraint "pending_reference_schedule_transaction_id_foreign"
      foreign key ("transaction_id") references "wager_transactions" ("id")`);
  }

  override down(): void {
    this.addSql(`alter table "pending_reference_schedule"
      drop constraint "pending_reference_schedule_transaction_id_foreign"`);
    this.addSql(`alter table "wallet_ledger_entries"
      drop constraint "wallet_ledger_entries_wallet_id_currency_foreign"`);
    this.addSql(`alter table "wallet_ledger_entries"
      drop constraint "wallet_ledger_entries_transaction_id_foreign"`);
    this.addSql(`alter table "wager_transactions"
      drop constraint "wager_transactions_reference_transaction_id_foreign"`);
    this.addSql(`alter table "wager_transactions"
      drop constraint "wager_transactions_wallet_id_foreign"`);
  }
}
