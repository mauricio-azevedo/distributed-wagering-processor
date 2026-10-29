import { Migration } from '@mikro-orm/migrations';

/**
 * The half of ADR 0003 that no single row can decide: the link between a wallet balance and the
 * ledger that explains it (`wallet.ledger-mirror`, `ledger.chain`,
 * `ledger.wallet-version-sequence`). Both sides are written in the same transaction, so both
 * checks are constraint triggers, `deferrable initially deferred`, and judge the state of the
 * whole transaction at commit; a legitimate write order inside one transaction is never refused
 * mid-way.
 *
 * The wallet side, for every inserted or updated wallet row: the row mirrors the head of its
 * ledger, the entry with the greatest `wallet_version`, carrying its version and its
 * `balance_after`; a wallet with no entries carries version 1 and balance `0.00`, the only state a
 * wallet without a ledger may hold. The function re-reads the wallet row by id rather than reading
 * `new`, so several moves of one wallet in one transaction all judge the state it ends in.
 *
 * The ledger side, for every appended entry: its predecessor, the entry with the greatest lower
 * version, carries `wallet_version - 1` and a `balance_after` equal to the new row's
 * `balance_before`; with no predecessor the row is the wallet's first entry, which starts at
 * `0.00` at version 1 (an opening credit) or 2 (the first operation on a wallet opened with
 * `0.00`). Its successor, the entry with the smallest higher version, carries
 * `wallet_version + 1` and a `balance_before` equal to the new row's `balance_after`; with no
 * successor the row is the head, and the wallet row has to mirror it.
 *
 * Neither side alone is enough. A trigger on `wallets` misses an entry appended without touching
 * the wallet, and comparing only the head accepts a chain with a broken link or a gap underneath
 * it. Together with the arithmetic check of each entry, the unique `(wallet_id, wallet_version)`
 * and the immutability of the ledger, the two make a wallet's ledger one contiguous chain from
 * `0.00` to the head, and the head's `balance_after` equals the sum of credits minus debits by
 * induction; the sum is not recomputed at commit because it is implied, and reconciliation
 * recomputes it independently on demand (`recon.calculation`).
 *
 * The cost per balance change at commit is four probes of existing indexes: the head, the
 * predecessor, the successor and the wallet row. Both raise `integrity_constraint_violation`
 * (SQLSTATE 23000), like every other trigger of ADR 0003, so the persistence adapter needs no
 * special case to call a refusal permanent. Neither function is `security definer`: it reads only
 * the two tables the role writing the row can already read.
 *
 * What they are not is a defence against a non-finite amount: `NaN = NaN` is true and `NaN`
 * propagates through addition, so a `NaN` chain satisfies both sides. The per-row
 * `<> 'NaN'::numeric` of each monetary column is the only thing that refuses it
 * (`money.finite-in-database`, SCHEMA-026).
 */
export class Migration20261029010500_balance_to_ledger_triggers extends Migration {
  override up(): void {
    this.addSql(`create function "wallets_mirror_ledger_head"() returns trigger
      language plpgsql as $$
      declare
        wallet record;
        head record;
      begin
        select w."balance", w."version" into wallet from "wallets" w where w."id" = new."id";
        if not found then
          -- the row no longer exists at commit, so there is nothing left to judge
          return null;
        end if;

        select e."id", e."wallet_version", e."balance_after" into head
          from "wallet_ledger_entries" e
         where e."wallet_id" = new."id"
         order by e."wallet_version" desc
         limit 1;

        if not found then
          if wallet.version <> 1 or wallet.balance <> 0 then
            raise exception
              'wallet % has no ledger entry, so it must carry version 1 and balance 0.00, not version % and balance % (wallet.ledger-mirror)',
              new."id", wallet.version, wallet.balance
              using errcode = 'integrity_constraint_violation';
          end if;

          return null;
        end if;

        if wallet.version <> head.wallet_version or wallet.balance <> head.balance_after then
          raise exception
            'wallet % carries version % and balance %, which does not mirror the head of its ledger, entry % at version % with balance_after % (wallet.ledger-mirror)',
            new."id", wallet.version, wallet.balance,
            head.id, head.wallet_version, head.balance_after
            using errcode = 'integrity_constraint_violation';
        end if;

        return null;
      end;
      $$`);
    this.addSql(`create constraint trigger "wallets_mirror_ledger_head"
      after insert or update on "wallets"
      deferrable initially deferred
      for each row execute function "wallets_mirror_ledger_head"()`);

    this.addSql(`create function "wallet_ledger_entries_continue_chain"() returns trigger
      language plpgsql as $$
      declare
        predecessor record;
        successor record;
        wallet record;
      begin
        select e."id", e."wallet_version", e."balance_after" into predecessor
          from "wallet_ledger_entries" e
         where e."wallet_id" = new."wallet_id" and e."wallet_version" < new."wallet_version"
         order by e."wallet_version" desc
         limit 1;

        if found then
          if predecessor.wallet_version <> new."wallet_version" - 1
             or predecessor.balance_after <> new."balance_before" then
            raise exception
              'ledger entry % of wallet % at version % with balance_before % does not continue entry % at version % with balance_after % (ledger.chain)',
              new."id", new."wallet_id", new."wallet_version", new."balance_before",
              predecessor.id, predecessor.wallet_version, predecessor.balance_after
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif new."wallet_version" > 2 or new."balance_before" <> 0 then
          raise exception
            'ledger entry % is the first entry of wallet %, so it must carry version 1 or 2 and balance_before 0.00, not version % and balance_before % (ledger.chain)',
            new."id", new."wallet_id", new."wallet_version", new."balance_before"
            using errcode = 'integrity_constraint_violation';
        end if;

        select e."id", e."wallet_version", e."balance_before" into successor
          from "wallet_ledger_entries" e
         where e."wallet_id" = new."wallet_id" and e."wallet_version" > new."wallet_version"
         order by e."wallet_version" asc
         limit 1;

        if found then
          if successor.wallet_version <> new."wallet_version" + 1
             or successor.balance_before <> new."balance_after" then
            raise exception
              'ledger entry % of wallet % at version % with balance_after % is not continued by entry % at version % with balance_before % (ledger.chain)',
              new."id", new."wallet_id", new."wallet_version", new."balance_after",
              successor.id, successor.wallet_version, successor.balance_before
              using errcode = 'integrity_constraint_violation';
          end if;

          return null;
        end if;

        select w."balance", w."version" into wallet
          from "wallets" w where w."id" = new."wallet_id";
        if not found then
          raise exception
            'ledger entry % belongs to wallet %, which has no row (wallet.ledger-mirror)',
            new."id", new."wallet_id"
            using errcode = 'integrity_constraint_violation';
        end if;

        if wallet.version <> new."wallet_version" or wallet.balance <> new."balance_after" then
          raise exception
            'ledger entry % is the head of wallet % at version % with balance_after %, but the wallet row carries version % and balance % (wallet.ledger-mirror)',
            new."id", new."wallet_id", new."wallet_version", new."balance_after",
            wallet.version, wallet.balance
            using errcode = 'integrity_constraint_violation';
        end if;

        return null;
      end;
      $$`);
    this.addSql(`create constraint trigger "wallet_ledger_entries_continue_chain"
      after insert on "wallet_ledger_entries"
      deferrable initially deferred
      for each row execute function "wallet_ledger_entries_continue_chain"()`);
  }

  override down(): void {
    this.addSql(`drop trigger "wallet_ledger_entries_continue_chain"
      on "wallet_ledger_entries"`);
    this.addSql(`drop function "wallet_ledger_entries_continue_chain"()`);
    this.addSql(`drop trigger "wallets_mirror_ledger_head" on "wallets"`);
    this.addSql(`drop function "wallets_mirror_ledger_head"()`);
  }
}
