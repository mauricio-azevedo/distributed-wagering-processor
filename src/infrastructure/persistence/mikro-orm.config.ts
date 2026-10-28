import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import path from 'node:path';

/**
 * One configuration per connection role: the service passes the runtime URL, the migration step the
 * migrator URL. Entity mappings join the list as the domain model lands.
 */
export function ormConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    // Mappings arrive with the domain model; until then discovery must accept an empty list.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    // The database is provisioned with the stack (docker/postgres); neither role may create it.
    ensureDatabase: false,
    extensions: [Migrator],
    migrations: {
      path: path.join(import.meta.dirname, 'migrations'),
    },
  });
}
