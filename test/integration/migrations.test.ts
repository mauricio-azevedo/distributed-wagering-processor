import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * OPS-002: every migration is reversible, and reversing then reapplying leaves the same schema.
 * The guarantees of ADR 0003 are carried by migrations rather than by a generated schema, so their
 * `down` has to remove constraints, indexes, triggers, functions and grants in an order PostgreSQL
 * accepts; a snapshot of the catalogue before and after is what proves it does.
 *
 * This suite takes the schema down and puts it back, so it keeps that to itself: it opens its own
 * connection, restores the schema even when an expectation fails, and shares no state with the
 * suites that read the tables.
 */
const migrationEnv = loadMigrationEnv(process.env);

const FINANCIAL_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/** The catalogue of what a migration can create, read back as text so it compares by value. */
const CATALOGUE = {
  columns: `select table_name, column_name, data_type, is_nullable, numeric_precision,
                   numeric_scale, character_maximum_length
              from information_schema.columns
             where table_schema = 'public'
             order by table_name, column_name`,
  constraints: `select conrelid::regclass::text as relation, conname,
                       pg_get_constraintdef(oid) as definition, convalidated
                  from pg_constraint
                 where connamespace = 'public'::regnamespace
                 order by relation, conname`,
  indexes: `select tablename, indexname, indexdef
              from pg_indexes
             where schemaname = 'public'
             order by tablename, indexname`,
  triggers: `select tgrelid::regclass::text as relation, tgname,
                    pg_get_triggerdef(oid) as definition
               from pg_trigger
              where not tgisinternal
                and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
              order by relation, tgname`,
  functions: `select proname, pg_get_functiondef(oid) as definition
                from pg_proc
               where pronamespace = 'public'::regnamespace
               order by proname, definition`,
  privileges: `select table_name, grantee, privilege_type
                 from information_schema.table_privileges
                where table_schema = 'public'
                order by table_name, grantee, privilege_type`,
};

type Catalogue = Record<keyof typeof CATALOGUE, unknown[]>;

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
});

afterAll(async () => {
  await orm.close(true);
});

async function catalogue(): Promise<Catalogue> {
  const connection = orm.em.getConnection();
  const entries = await Promise.all(
    Object.entries(CATALOGUE).map(
      async ([name, query]) => [name, await connection.execute(query)] as const,
    ),
  );
  return Object.fromEntries(entries) as Catalogue;
}

async function tableNames(): Promise<string[]> {
  const rows = await orm.em
    .getConnection()
    .execute<{ table_name: string }[]>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
  return rows.map((row) => row.table_name);
}

test('migrations-up-down-up', async () => {
  try {
    await orm.migrator.up();
    const applied = await catalogue();
    expect(await orm.migrator.getPending()).toEqual([]);
    const present = await tableNames();
    for (const table of FINANCIAL_TABLES) {
      expect(present).toContain(table);
    }

    await orm.migrator.down({ to: 0 });

    const reverted = await tableNames();
    for (const table of FINANCIAL_TABLES) {
      expect(reverted).not.toContain(table);
    }
    expect((await orm.migrator.getPending()).length).toBeGreaterThan(0);

    await orm.migrator.up();

    expect(await catalogue()).toEqual(applied);
  } finally {
    // Whatever failed above, the tables the other suites read have to be back.
    await orm.migrator.up();
  }
});
