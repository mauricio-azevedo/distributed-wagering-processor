/**
 * Reserves one submission in a process of its own and exits: the other instance IDEM-009 needs.
 * Everything it learns about the operation arrives as JSON on the command line, and everything it
 * leaves behind is the committed row, so the process that spawned it can only decide a replay from
 * the database (`idem.persistent`).
 *
 * Usage: `bun run test/helpers/reserve-transaction.ts '<submission as JSON>'`. It prints the
 * reservation as JSON and exits non-zero with the reason when anything goes wrong.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';

import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { loadEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

const submissionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  externalTransactionId: z.string(),
  idempotencyKey: z.string(),
  payloadHash: z.string(),
  walletId: z.string(),
  playerId: z.string(),
  roundId: z.string(),
  gameId: z.string(),
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  amount: z.string(),
  currency: z.string(),
  referenceExternalTransactionId: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
});

const [argument] = process.argv.slice(2);

if (argument === undefined) {
  throw new Error('reserve-transaction expects the submission as its one argument');
}

const { amount, currency, ...submission } = submissionSchema.parse(JSON.parse(argument) as unknown);

const orm = await MikroORM.init(ormConfig(loadEnv(process.env).DATABASE_URL));

try {
  const unitOfWork = new MikroOrmUnitOfWork(orm.em);
  const reservation = await unitOfWork.transactional(({ transactions }) =>
    transactions.reserve(
      WagerTransaction.create({ ...submission, money: Money.from(amount, currency) }),
    ),
  );

  process.stdout.write(JSON.stringify({ reserved: reservation.reserved }));
} finally {
  await orm.close(true);
}
