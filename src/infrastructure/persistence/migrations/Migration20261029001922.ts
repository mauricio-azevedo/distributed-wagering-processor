import { Migration } from '@mikro-orm/migrations';

/**
 * The tables of the service, as the mappings of ADR 0008 read them: columns, their types and
 * their nullability only. Every guarantee the schema carries is a separate migration: uniqueness,
 * checks, foreign keys, the append-only triggers and the per-table privileges (ADR 0003), then the
 * deferred wallet-to-ledger triggers. Nothing here depends on them, and they all depend on this.
 *
 * Conventions in this schema:
 *
 * - Money is `NUMERIC(20,2)`, the capacity the domain bound matches exactly (ADR 0001), with the
 *   currency of the row beside it. `wager_transactions` carries two currencies because an
 *   outcome's observed balance is the wallet's and the amount is the one submitted.
 * - An identifier minted outside the service is a `VARCHAR` of the length its contract caps it at
 *   (120 for a provider identifier, 255 for an idempotency key, 128 for a message id, 71 for a
 *   `sha256:` digest); one minted by the service is a `UUID`.
 * - A column holding a closed vocabulary (a kind, a status, a direction, a failure code, an event
 *   type) is `TEXT`, with the admitted values enforced by the `CHECK` constraints of ADR 0003
 *   rather than by a length.
 * - No column has a default: the application decides every value it writes, including every
 *   timestamp, so that nothing in a row comes from the database clock.
 */
export class Migration20261029001922 extends Migration {
  override up(): void {
    this.addSql(`create table "wallets" (
      "id" uuid not null,
      "player_id" uuid not null,
      "currency" varchar(3) not null,
      "balance" numeric(20,2) not null,
      "version" integer not null,
      "created_at" timestamptz(6) not null,
      "updated_at" timestamptz(6) not null,
      constraint "wallets_pkey" primary key ("id")
    )`);

    this.addSql(`create table "wager_transactions" (
      "id" uuid not null,
      "provider_id" varchar(120) not null,
      "external_transaction_id" varchar(120) not null,
      "idempotency_key" varchar(255) not null,
      "payload_hash" varchar(71) not null,
      "wallet_id" uuid not null,
      "player_id" uuid not null,
      "round_id" varchar(120) not null,
      "game_id" varchar(120) not null,
      "kind" text not null,
      "currency" varchar(3) not null,
      "amount" numeric(20,2) not null,
      "status" text not null,
      "failure_code" text null,
      "observed_balance" numeric(20,2) null,
      "observed_balance_currency" varchar(3) null,
      "reference_external_transaction_id" varchar(120) null,
      "reference_transaction_id" uuid null,
      "processed_at" timestamptz(6) null,
      "created_at" timestamptz(6) not null,
      constraint "wager_transactions_pkey" primary key ("id")
    )`);

    this.addSql(`create table "wallet_ledger_entries" (
      "id" uuid not null,
      "wallet_id" uuid not null,
      "transaction_id" uuid not null,
      "kind" text not null,
      "direction" text not null,
      "currency" varchar(3) not null,
      "amount" numeric(20,2) not null,
      "balance_before" numeric(20,2) not null,
      "balance_after" numeric(20,2) not null,
      "wallet_version" integer not null,
      "created_at" timestamptz(6) not null,
      constraint "wallet_ledger_entries_pkey" primary key ("id")
    )`);

    this.addSql(`create table "inbox_messages" (
      "consumer_name" varchar(64) not null,
      "message_id" varchar(128) not null,
      "payload_hash" varchar(71) not null,
      "received_at" timestamptz(6) not null,
      "processed_at" timestamptz(6) null,
      constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
    )`);

    this.addSql(`create table "outbox_messages" (
      "event_id" uuid not null,
      "event_type" text not null,
      "aggregate_id" uuid not null,
      "payload" jsonb not null,
      "occurred_at" timestamptz(6) not null,
      "attempts" integer not null,
      "next_attempt_at" timestamptz(6) not null,
      "published_at" timestamptz(6) null,
      constraint "outbox_messages_pkey" primary key ("event_id")
    )`);

    // The scheduler's claim list (ref.scheduler): one row per parked transaction, carrying when it
    // is due and when its waiting window closes. It has no mapping yet; the scheduler brings it.
    this.addSql(`create table "pending_reference_schedule" (
      "transaction_id" uuid not null,
      "attempts" integer not null,
      "next_attempt_at" timestamptz(6) not null,
      "expires_at" timestamptz(6) not null,
      constraint "pending_reference_schedule_pkey" primary key ("transaction_id")
    )`);
  }

  override down(): void {
    this.addSql(`drop table if exists "pending_reference_schedule"`);
    this.addSql(`drop table if exists "outbox_messages"`);
    this.addSql(`drop table if exists "inbox_messages"`);
    this.addSql(`drop table if exists "wallet_ledger_entries"`);
    this.addSql(`drop table if exists "wager_transactions"`);
    this.addSql(`drop table if exists "wallets"`);
  }
}
