import { Migration } from '@mikro-orm/migrations';

/**
 * The per-table privileges of ADR 0003 (`ops.two-db-roles`). The triggers protect against
 * mistakes; the privileges protect against bypassing the triggers.
 *
 * `wagering_migrator` owns every table, so it needs no grant. `wagering_app` gets exactly what the
 * service writes: `select` and `insert` on the ledger, which it only ever appends to
 * (`ledger.immutable`), `select`, `insert` and `update` on the rest, no `delete` anywhere
 * (`tx.row-append-only`), no privilege at all on the migration log, and no DDL, which comes from
 * not owning the tables.
 *
 * `docker/postgres/01-roles.sql` sets default privileges that already grant the runtime role
 * `select`, `insert` and `update` on everything the migrator creates, so this migration is where
 * the ledger and the migration log are narrowed; `down` restores the default-privilege state.
 */
const APPENDED_AND_UPDATED = [
  'wallets',
  'wager_transactions',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

export class Migration20261029010400_privileges extends Migration {
  override up(): void {
    this.addSql(`revoke all privileges on "wallet_ledger_entries" from "wagering_app"`);
    this.addSql(`grant select, insert on "wallet_ledger_entries" to "wagering_app"`);

    for (const table of APPENDED_AND_UPDATED) {
      this.addSql(`revoke all privileges on "${table}" from "wagering_app"`);
      this.addSql(`grant select, insert, update on "${table}" to "wagering_app"`);
    }

    this.addSql(`revoke all privileges on "mikro_orm_migrations" from "wagering_app"`);
  }

  override down(): void {
    this.addSql(`grant select, insert, update on "mikro_orm_migrations" to "wagering_app"`);

    for (const table of [...APPENDED_AND_UPDATED, 'wallet_ledger_entries']) {
      this.addSql(`grant select, insert, update on "${table}" to "wagering_app"`);
    }
  }
}
