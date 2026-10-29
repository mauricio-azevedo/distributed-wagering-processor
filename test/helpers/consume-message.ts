/**
 * Processes one message in a process of its own and dies after the commit and before the
 * acknowledgement: the window `msg.ack-after-commit` exists for (MSG-006).
 *
 * The death is a real one — the process exits while the message is still in the queue, holding its
 * visibility — so nothing in the production path knows this is a test: the crash is injected by
 * overriding `deliver` here, after the transaction it opens has committed.
 *
 * Usage: `bun run test/helpers/consume-message.ts`. It prints the transaction it committed and
 * exits `9`, prints `absorbed` and exits `9` when the inbox already held the delivery, and prints
 * `nothing` and exits `0` when the queue had no message to take.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import type {
  DeliveryOutcome,
  MessageDelivery,
  SubmitWagerTransactionCommand,
} from '../../src/application/use-cases/submit-wager-transaction';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import { sha256Hex } from '../../src/application/sha256';
import { systemClock } from '../../src/infrastructure/clock';
import { loadEnv } from '../../src/infrastructure/config/env';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import {
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  queueUrlResolver,
} from '../../src/infrastructure/messaging/sqs';
import {
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
} from '../../src/infrastructure/messaging/wager-transactions.consumer';
import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { MetricsRegistry, uncountedMetrics } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';

/** The exit code the test recognises: the commit happened and the acknowledgement never did. */
const KILLED_AFTER_COMMIT = 9;

class DiesBeforeAcknowledgement extends SubmitWagerTransaction {
  override async deliver(
    command: SubmitWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<DeliveryOutcome> {
    const outcome = await super.deliver(command, delivery);

    process.stdout.write(outcome.absorbed ? 'absorbed' : outcome.transaction.id);
    process.exit(KILLED_AFTER_COMMIT);
  }
}

const env = loadEnv(process.env);
const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));
const sqs = new SQSClient({
  region: env.AWS_REGION,
  ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
});

try {
  const consumer = new WagerTransactionsConsumer({
    sqs,
    queueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_QUEUE),
    deadLetterQueueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_DLQ),
    submit: new DiesBeforeAcknowledgement({
      unitOfWork: new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS),
      clock: systemClock,
      ids: uuidV7IdGenerator,
      sha256Hex,
      logger: jsonLinesLogger('consume-message', process.stderr),
      metrics: uncountedMetrics,
    }),
    metrics: new MetricsRegistry(),
    logger: jsonLinesLogger('consume-message', process.stderr),
    consumerName: WAGER_TRANSACTIONS_CONSUMER,
    waitTimeSeconds: 5,
    visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
    retryBackoff: {
      baseSeconds: env.SQS_RETRY_BACKOFF_BASE_SECONDS,
      maxSeconds: env.SQS_RETRY_BACKOFF_MAX_SECONDS,
    },
  });

  await consumer.poll();
  process.stdout.write('nothing');
} finally {
  await orm.close(true);
  sqs.destroy();
}
