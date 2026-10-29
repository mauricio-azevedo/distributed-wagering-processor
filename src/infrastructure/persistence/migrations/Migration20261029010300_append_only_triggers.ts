import { Migration } from '@mikro-orm/migrations';

/**
 * The immutability half of ADR 0003, for the two tables that are audit logs.
 *
 * `wallet_ledger_entries` refuses every `UPDATE` and `DELETE`, for every role including its owner
 * (`ledger.immutable`). `wager_transactions` refuses every delete, every update of a row that
 * already reached a terminal status, and any update that touches the identity, context, kind,
 * amount, currency, reference target or creation time of a row that may still change
 * (`tx.terminal-immutable`, `tx.row-append-only`). What stays writable on a non-terminal row is
 * its outcome: `status`, `processed_at`, `failure_code`, `observed_balance` with its currency and
 * the resolved `reference_transaction_id`.
 *
 * The checks of the previous migration cannot carry this. `status = 'PROCESSED'` if and only if
 * `processed_at is not null` holds just as well for a row set back to `PENDING` with its processed
 * time cleared, and that downgrade re-opens an idempotency key for a second debit and frees the
 * partial unique index for a second reversal. The transition graph stays in the domain
 * (`tx.transitions`); the trigger freezes only what has already been decided.
 *
 * Both raise `integrity_constraint_violation` (SQLSTATE 23000), so a refusal by a trigger is
 * classified like a refusal by a constraint and the persistence adapter needs no special case to
 * call it permanent. Truncation fires neither, which is what lets an integration suite reset the
 * tables between cases; a corrective migration that has to touch a transaction row disables the
 * trigger explicitly, in the migration, under review.
 */
export class Migration20261029010300_append_only_triggers extends Migration {
  override up(): void {
    this.addSql(`create function "wallet_ledger_entries_immutable"() returns trigger
      language plpgsql as $$
      begin
        raise exception
          'wallet_ledger_entries is immutable: % on entry % is refused (ledger.immutable)',
          tg_op, old."id"
          using errcode = 'integrity_constraint_violation';
      end;
      $$`);
    this.addSql(`create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "wallet_ledger_entries_immutable"()`);

    this.addSql(`create function "wager_transactions_append_only"() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception
            'wager_transactions is append-only: row % cannot be deleted (tx.row-append-only)',
            old."id"
            using errcode = 'integrity_constraint_violation';
        end if;

        if old."status" in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception
            'wager_transactions outcome is final: row % is % and cannot be updated (tx.terminal-immutable)',
            old."id", old."status"
            using errcode = 'integrity_constraint_violation';
        end if;

        if (new."id", new."provider_id", new."external_transaction_id", new."idempotency_key",
            new."payload_hash", new."wallet_id", new."player_id", new."round_id", new."game_id",
            new."kind", new."currency", new."amount", new."reference_external_transaction_id",
            new."created_at")
           is distinct from
           (old."id", old."provider_id", old."external_transaction_id", old."idempotency_key",
            old."payload_hash", old."wallet_id", old."player_id", old."round_id", old."game_id",
            old."kind", old."currency", old."amount", old."reference_external_transaction_id",
            old."created_at") then
          raise exception
            'wager_transactions is append-only: the identity, context, kind, amount and currency of row % cannot change (tx.row-append-only)',
            old."id"
            using errcode = 'integrity_constraint_violation';
        end if;

        return new;
      end;
      $$`);
    this.addSql(`create trigger "wager_transactions_append_only"
      before update or delete on "wager_transactions"
      for each row execute function "wager_transactions_append_only"()`);
  }

  override down(): void {
    this.addSql(`drop trigger "wager_transactions_append_only" on "wager_transactions"`);
    this.addSql(`drop function "wager_transactions_append_only"()`);
    this.addSql(`drop trigger "wallet_ledger_entries_immutable" on "wallet_ledger_entries"`);
    this.addSql(`drop function "wallet_ledger_entries_immutable"()`);
  }
}
