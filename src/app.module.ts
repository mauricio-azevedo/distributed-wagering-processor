import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';

import { sha256Hex } from './application/sha256';
import { GetWagerTransaction } from './application/use-cases/get-wager-transaction';
import { GetWallet } from './application/use-cases/get-wallet';
import { ObserveOutboxBacklog } from './application/use-cases/observe-outbox-backlog';
import { OpenWallet } from './application/use-cases/open-wallet';
import { PageWalletLedger } from './application/use-cases/page-wallet-ledger';
import { ReconcileWallet } from './application/use-cases/reconcile-wallet';
import { ReprocessPendingReference } from './application/use-cases/reprocess-pending-reference';
import { SubmitWagerTransaction } from './application/use-cases/submit-wager-transaction';
import { systemClock } from './infrastructure/clock';
import type { Env } from './infrastructure/config/env';
import { HealthController } from './infrastructure/health/health.controller';
import { PostgresHealthIndicator } from './infrastructure/health/postgres.health';
import { SqsHealthIndicator } from './infrastructure/health/sqs.health';
import { ObserveRequest } from './infrastructure/http/observe-request';
import { ProblemDetailsFilter } from './infrastructure/http/problem-details.filter';
import { ProviderTransactionsController } from './infrastructure/http/provider-transactions.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { uuidV7IdGenerator } from './infrastructure/id-generator';
import {
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  queueUrlResolver,
  sqsClientProvider,
} from './infrastructure/messaging/sqs';
import {
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
} from './infrastructure/messaging/wager-transactions.consumer';
import { jsonLinesLogger } from './infrastructure/observability/logger';
import { MetricsRegistry } from './infrastructure/observability/metrics';
import {
  MetricsController,
  OBSERVABILITY_LOGGER,
} from './infrastructure/observability/metrics.controller';
import { ormConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm.unit-of-work';

/**
 * Composition root. The validated environment is its only input, so a test can start the service on
 * any configuration.
 *
 * The use cases are constructed here with their ports rather than injected into: they carry no
 * framework decorator, which is what keeps the application layer free of NestJS
 * (`model.framework-free-domain`, ARCHITECTURE.md section 4). The adapters they are given — the
 * unit of work over the entity manager, the clock, the id mint, the log sink and the metric
 * registry — are the only places a use case can reach the outside.
 *
 * One registry serves the whole instance, because a counter is per instance and the `/metrics`
 * endpoint has to read what the use cases raised (`obs.metrics`). Each component gets a logger
 * named after it, so the `component` field of a line says which part of the service wrote it
 * (`obs.structured-logs`).
 *
 * `WagerTransactionsConsumer` is constructed with the very `SubmitWagerTransaction` the controller
 * receives, which is what `msg.same-use-case` asks of the composition root, and is not started
 * here: which process polls the queue is `APP_ROLE`, and that with its shutdown behaviour is #19.
 */
@Module({})
export class AppModule implements NestModule {
  static create(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormConfig(env.DATABASE_URL)), TerminusModule],
      controllers: [
        HealthController,
        MetricsController,
        WalletsController,
        WageringController,
        ProviderTransactionsController,
      ],
      providers: [
        sqsClientProvider(env),
        PostgresHealthIndicator,
        SqsHealthIndicator,
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        MetricsRegistry,
        ObserveRequest,
        { provide: OBSERVABILITY_LOGGER, useValue: jsonLinesLogger('observability') },
        {
          provide: MikroOrmUnitOfWork,
          // The registry the use cases and the consumer raise, so a lock wait is counted on the
          // instance that waited whichever entry point it arrived through (CONC-002).
          useFactory: (em: EntityManager, metrics: MetricsRegistry) =>
            new MikroOrmUnitOfWork(em, env.LOCK_TIMEOUT_MS, metrics),
          inject: [EntityManager, MetricsRegistry],
        },
        {
          provide: OpenWallet,
          useFactory: (unitOfWork: MikroOrmUnitOfWork) =>
            new OpenWallet({ unitOfWork, clock: systemClock, ids: uuidV7IdGenerator, sha256Hex }),
          inject: [MikroOrmUnitOfWork],
        },
        {
          provide: GetWallet,
          useFactory: (unitOfWork: MikroOrmUnitOfWork) => new GetWallet(unitOfWork),
          inject: [MikroOrmUnitOfWork],
        },
        {
          provide: PageWalletLedger,
          useFactory: (unitOfWork: MikroOrmUnitOfWork) => new PageWalletLedger(unitOfWork),
          inject: [MikroOrmUnitOfWork],
        },
        {
          provide: GetWagerTransaction,
          useFactory: (unitOfWork: MikroOrmUnitOfWork) => new GetWagerTransaction(unitOfWork),
          inject: [MikroOrmUnitOfWork],
        },
        {
          provide: ReconcileWallet,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: MetricsRegistry) =>
            new ReconcileWallet({
              unitOfWork,
              clock: systemClock,
              logger: jsonLinesLogger('reconciliation'),
              metrics,
            }),
          inject: [MikroOrmUnitOfWork, MetricsRegistry],
        },
        {
          /*
           * The backlog the `/metrics` endpoint measures on every scrape, so the two gauges of
           * `outbox.lag-metrics` are answered by any instance and not only by one running a
           * publisher (OUTBOX-008).
           */
          provide: ObserveOutboxBacklog,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: MetricsRegistry) =>
            new ObserveOutboxBacklog({ unitOfWork, clock: systemClock, metrics }),
          inject: [MikroOrmUnitOfWork, MetricsRegistry],
        },
        {
          /*
           * The recovery of a parked transaction (ADR 0011). It is constructed here and swept by
           * nothing yet: the `worker` role that runs it on a timer, like the queue consumer and the
           * outbox publisher beside it, arrives with the runtime roles (#19). Until then a parked
           * transaction is reprocessed by whatever drives a sweep — the integration suites do.
           */
          provide: ReprocessPendingReference,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: MetricsRegistry) =>
            new ReprocessPendingReference({
              unitOfWork,
              clock: systemClock,
              ids: uuidV7IdGenerator,
              logger: jsonLinesLogger('pending-reference-scheduler'),
              metrics,
            }),
          inject: [MikroOrmUnitOfWork, MetricsRegistry],
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: MetricsRegistry) =>
            new SubmitWagerTransaction({
              unitOfWork,
              clock: systemClock,
              ids: uuidV7IdGenerator,
              sha256Hex,
              logger: jsonLinesLogger('wagering'),
              metrics,
            }),
          inject: [MikroOrmUnitOfWork, MetricsRegistry],
        },
        {
          provide: WagerTransactionsConsumer,
          useFactory: (sqs: SQSClient, submit: SubmitWagerTransaction, metrics: MetricsRegistry) =>
            new WagerTransactionsConsumer({
              sqs,
              queueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_QUEUE),
              deadLetterQueueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_DLQ),
              submit,
              metrics,
              logger: jsonLinesLogger(WAGER_TRANSACTIONS_CONSUMER),
              consumerName: WAGER_TRANSACTIONS_CONSUMER,
              waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
              visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
              retryBackoff: {
                baseSeconds: env.SQS_RETRY_BACKOFF_BASE_SECONDS,
                maxSeconds: env.SQS_RETRY_BACKOFF_MAX_SECONDS,
              },
            }),
          inject: [SQSClient, SubmitWagerTransaction, MetricsRegistry],
        },
      ],
    };
  }

  /**
   * Every request runs inside `ObserveRequest`, the health and metrics routes included: no response
   * leaves without a correlation id, the exception filter always has one to put in a problem
   * (`api.correlation-header`), and every line a request produces carries it
   * (`obs.correlation-propagation`).
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ObserveRequest).forRoutes('*splat');
  }
}
