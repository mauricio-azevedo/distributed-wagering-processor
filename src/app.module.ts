import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';

import type { ProviderIdentityPort } from './application/ports/provider-identity';
import { unauthenticatedProviderIdentity } from './application/ports/provider-identity';
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
import { type AppRole, type Env, runsWorkers } from './infrastructure/config/env';
import { HealthController } from './infrastructure/health/health.controller';
import { PostgresHealthIndicator } from './infrastructure/health/postgres.health';
import { SqsHealthIndicator } from './infrastructure/health/sqs.health';
import { ContractDocumentController } from './infrastructure/http/contract-document.controller';
import { ObserveRequest } from './infrastructure/http/observe-request';
import { ProblemDetailsFilter } from './infrastructure/http/problem-details.filter';
import {
  PROVIDER_IDENTITY,
  ProviderIdentityGuard,
} from './infrastructure/http/provider-identity.guard';
import { ProviderTransactionsController } from './infrastructure/http/provider-transactions.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { uuidV7IdGenerator } from './infrastructure/id-generator';
import { OutboxPublisher, outboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { queueUrlResolver, sqsClientProvider, wagerQueues } from './infrastructure/messaging/sqs';
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
import {
  PENDING_REFERENCE_SCHEDULER,
  PendingReferenceScheduler,
} from './infrastructure/runtime/pending-reference-scheduler';
import { WORKER_RUNTIME, WorkerRuntime } from './infrastructure/runtime/worker-runtime';

/**
 * `ops.single-image-roles`: what each role serves over HTTP. The operational routes belong to every
 * role, so a container is probed and scraped the same way whichever it is, and the financial surface
 * belongs to the roles that are there to answer providers: a `worker` that served it would take
 * requests the load balancer never meant to send it.
 */
function controllersOf(role: AppRole): Type<unknown>[] {
  // Health and metrics belong to every role: a worker is probed like an api instance, and the
  // counters of the instance that raised them are read where they were raised (`obs.metrics`).
  const everyRole = [HealthController, MetricsController];

  return role === 'worker'
    ? everyRole
    : [
        ...everyRole,
        // The contract document goes with the surface it describes (`api.contract-document`): an
        // instance that answers none of its operations has no business publishing it.
        ContractDocumentController,
        WalletsController,
        WageringController,
        ProviderTransactionsController,
      ];
}

/**
 * The three loops of the `worker` role, started and drained as one (`ops.graceful-shutdown`). They
 * are constructed for every role — a provider costs nothing until something calls it, and a suite
 * reaches for one whatever role it built the application with — and started only by the roles that
 * are meant to claim work.
 */
const workerRuntimeProvider: Provider = {
  provide: WorkerRuntime,
  useFactory: (
    consumer: WagerTransactionsConsumer,
    publisher: OutboxPublisher,
    scheduler: PendingReferenceScheduler,
  ) => new WorkerRuntime([consumer, publisher, scheduler], jsonLinesLogger(WORKER_RUNTIME)),
  inject: [WagerTransactionsConsumer, OutboxPublisher, PendingReferenceScheduler],
};

/**
 * Composition root. The validated environment is its only input, so a test can start the service on
 * any configuration, and `APP_ROLE` is the one part of it that changes what the process is: which
 * controllers answer, and whether the worker processes run (`ops.single-image-roles`).
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
 * receives, which is what `msg.same-use-case` asks of the composition root.
 */
@Module({})
export class AppModule implements NestModule {
  /**
   * The adapters a deployment chooses, as the composition root takes them. Each one has the
   * implementation this version runs with as its default, so naming one is the whole of replacing
   * it: `providerIdentity` is the authentication extension point, and binding another
   * implementation here is what enabling authentication consists of (`auth.extension-point`,
   * AUTH-001).
   */
  static create(
    env: Env,
    adapters: { readonly providerIdentity?: ProviderIdentityPort } = {},
  ): DynamicModule {
    // The three queues this deployment addresses, resolved once from the prefix so that the
    // consumer, the publisher and the readiness probe cannot disagree about which trio they mean.
    const queues = wagerQueues(env.SQS_QUEUE_PREFIX);

    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormConfig(env.DATABASE_URL)), TerminusModule],
      controllers: controllersOf(env.APP_ROLE),
      providers: [
        sqsClientProvider(env),
        PostgresHealthIndicator,
        {
          provide: SqsHealthIndicator,
          useFactory: (sqs: SQSClient, indicators: HealthIndicatorService) =>
            new SqsHealthIndicator(sqs, indicators, queues.input),
          inject: [SQSClient, HealthIndicatorService],
        },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_GUARD, useClass: ProviderIdentityGuard },
        {
          provide: PROVIDER_IDENTITY,
          useValue: adapters.providerIdentity ?? unauthenticatedProviderIdentity,
        },
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
          /* The recovery of a parked transaction (ADR 0011), swept by `PendingReferenceScheduler`. */
          provide: ReprocessPendingReference,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: MetricsRegistry) =>
            new ReprocessPendingReference({
              unitOfWork,
              clock: systemClock,
              ids: uuidV7IdGenerator,
              logger: jsonLinesLogger(PENDING_REFERENCE_SCHEDULER),
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
              queueUrl: queueUrlResolver(sqs, queues.input),
              deadLetterQueueUrl: queueUrlResolver(sqs, queues.deadLetter),
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
        {
          /*
           * The publisher of ADR 0005, wired from the same environment a suite wires it from and
           * given this process's SQS client, so one process holds one connection pool to the
           * broker whichever of its components is talking to it.
           */
          provide: OutboxPublisher,
          useFactory: (em: EntityManager, sqs: SQSClient, metrics: MetricsRegistry) =>
            outboxPublisher({ em, env, sqs, metrics }),
          inject: [EntityManager, SQSClient, MetricsRegistry],
        },
        {
          provide: PendingReferenceScheduler,
          useFactory: (reprocess: ReprocessPendingReference) =>
            new PendingReferenceScheduler(reprocess, {
              sweepIntervalMs: env.PENDING_REFERENCE_SWEEP_INTERVAL_MS,
              logger: jsonLinesLogger(PENDING_REFERENCE_SCHEDULER),
            }),
          inject: [ReprocessPendingReference],
        },
        ...(runsWorkers(env.APP_ROLE) ? [workerRuntimeProvider] : []),
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
