import { MikroORM } from '@mikro-orm/postgresql';

import { loadMigrationEnv } from '../config/env';
import { ormConfig } from './mikro-orm.config';

// Applies pending migrations as the migrator role. Run at deploy time, never by the service.
const orm = await MikroORM.init(ormConfig(loadMigrationEnv(process.env).MIGRATION_DATABASE_URL));
try {
  const applied = await orm.migrator.up();
  console.log(
    applied.length === 0
      ? 'migrations: nothing pending'
      : `migrations: applied ${applied.map((migration) => migration.name).join(', ')}`,
  );
} finally {
  await orm.close(true);
}
