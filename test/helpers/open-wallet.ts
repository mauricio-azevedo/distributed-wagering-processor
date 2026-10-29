/**
 * Opens one wallet in a process of its own and exits: the other instance WALLET-001 needs. The
 * command arrives as JSON on the command line and the only thing the process leaves behind is what
 * it committed, so the process that spawned it can only learn the outcome from the database.
 *
 * Usage: `bun run test/helpers/open-wallet.ts '<command as JSON>'`. It prints the wallet id on
 * success, and on a refusal prints the `ErrorCode` the use case raised and exits non-zero, so a
 * caller racing two of these tells a conflict from a crash.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import { ApplicationError } from '../../src/application/errors';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { loadEnv } from '../../src/infrastructure/config/env';
import { systemClock } from '../../src/infrastructure/clock';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

const commandSchema = z.object({
  playerId: z.string(),
  initialBalance: z.object({ amount: z.string(), currency: z.string() }),
  correlationId: z.string(),
});

const [argument] = process.argv.slice(2);

if (argument === undefined) {
  throw new Error('open-wallet expects the command as its one argument');
}

const command = commandSchema.parse(JSON.parse(argument) as unknown);
const orm = await MikroORM.init(ormConfig(loadEnv(process.env).DATABASE_URL));

try {
  const openWallet = new OpenWallet({
    unitOfWork: new MikroOrmUnitOfWork(orm.em),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });

  process.stdout.write((await openWallet.execute(command)).id);
} catch (error) {
  process.stdout.write(error instanceof ApplicationError ? error.code : String(error));
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
