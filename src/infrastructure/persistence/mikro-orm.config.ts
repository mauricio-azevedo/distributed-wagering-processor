import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import path from 'node:path';

import { inboxMessageSchema } from './mappings/inbox-message.mapping';
import { outboxMessageSchema } from './mappings/outbox-message.mapping';
import { pendingReferenceScheduleSchema } from './mappings/pending-reference-schedule.mapping';
import { wagerTransactionSchema } from './mappings/wager-transaction.mapping';
import { walletLedgerEntrySchema } from './mappings/wallet-ledger-entry.mapping';
import { walletSchema } from './mappings/wallet.mapping';

/**
 * One configuration per connection role: the service passes the runtime URL, the migration step the
 * migrator URL. The entities are the row mappings of ADR 0008, not the domain classes.
 */
export function ormConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [
      walletSchema,
      wagerTransactionSchema,
      walletLedgerEntrySchema,
      inboxMessageSchema,
      outboxMessageSchema,
      pendingReferenceScheduleSchema,
    ],
    // The database is provisioned with the stack (docker/postgres); neither role may create it.
    ensureDatabase: false,
    extensions: [Migrator],
    migrations: {
      path: path.join(import.meta.dirname, 'migrations'),
      // Migrations are written by hand, so the snapshot the generator would diff against has no
      // reader; without this, applying one writes a file into the migrations folder.
      snapshot: false,
    },
  });
}
