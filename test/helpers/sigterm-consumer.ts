/**
 * One queue consumer in a process of its own, slow on purpose, under the service's own signal
 * handling: the instance MSG-010 signals while it holds a batch.
 *
 * It is the production consumer and the production shutdown — `WagerTransactionsConsumer.start`,
 * `stop` and `onShutdownSignal` — with one seam: `deliver` announces the message it is about to
 * apply and then takes `--delay-ms` over applying it, so the case can signal the process at a
 * moment when one message is in flight and the rest of the batch is not. A delay is the only thing
 * a test can inject here that a real slow database would not do by itself.
 *
 * Usage: `bun run test/helpers/sigterm-consumer.ts --delay-ms 2000`. It writes one line per event:
 * `ready` when the loop started, `applying <messageId>` before each message, `applied <messageId>`
 * after the commit, and whatever the drain says when it is signalled.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { sha256Hex } from '../../src/application/sha256';
import type {
  DeliveryOutcome,
  MessageDelivery,
  SubmitWagerTransactionCommand,
} from '../../src/application/use-cases/submit-wager-transaction';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
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
import { onShutdownSignal } from '../../src/infrastructure/runtime/shutdown';

const argv = process.argv.slice(2);

const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);

  return at === -1 ? undefined : argv[at + 1];
};

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const delayMs = Number(option('delay-ms') ?? 0);

/** The seam: the message in flight takes `--delay-ms`, and says so before and after. */
class SlowToApply extends SubmitWagerTransaction {
  override async deliver(
    command: SubmitWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<DeliveryOutcome> {
    say(`applying ${delivery.messageId}`);
    await Bun.sleep(delayMs);
    const outcome = await super.deliver(command, delivery);
    say(`applied ${delivery.messageId}`);

    return outcome;
  }
}

const env = loadEnv(process.env);
// On stderr, so the lines a case parses off stdout are this helper's own.
const logger = jsonLinesLogger('sigterm-consumer', process.stderr);
const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));
const sqs = new SQSClient({
  region: env.AWS_REGION,
  ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
});

const consumer = new WagerTransactionsConsumer({
  sqs,
  queueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_QUEUE),
  deadLetterQueueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_DLQ),
  submit: new SlowToApply({
    unitOfWork: new MikroOrmUnitOfWork(orm.em, env.LOCK_TIMEOUT_MS),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
    logger,
    metrics: uncountedMetrics,
  }),
  metrics: new MetricsRegistry(),
  logger,
  consumerName: WAGER_TRANSACTIONS_CONSUMER,
  waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
  visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
  retryBackoff: {
    baseSeconds: env.SQS_RETRY_BACKOFF_BASE_SECONDS,
    maxSeconds: env.SQS_RETRY_BACKOFF_MAX_SECONDS,
  },
});

onShutdownSignal({
  drain: async () => {
    await consumer.stop();
    await orm.close(true);
    sqs.destroy();
    say(`drained ${WAGER_TRANSACTIONS_CONSUMER}`);
  },
  gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
  logger,
});

consumer.start();
say('ready');

// The process now belongs to the signal: `onShutdownSignal` is what ends it.
await new Promise(() => {
  /* until SIGTERM */
});
