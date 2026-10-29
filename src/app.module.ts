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
import { OpenWallet } from './application/use-cases/open-wallet';
import { PageWalletLedger } from './application/use-cases/page-wallet-ledger';
import { ReconcileWallet } from './application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from './application/use-cases/submit-wager-transaction';
import { systemClock } from './infrastructure/clock';
import type { Env } from './infrastructure/config/env';
import { HealthController } from './infrastructure/health/health.controller';
import { PostgresHealthIndicator } from './infrastructure/health/postgres.health';
import { SqsHealthIndicator } from './infrastructure/health/sqs.health';
import { bindCorrelationId } from './infrastructure/http/correlation-id';
import { ProblemDetailsFilter } from './infrastructure/http/problem-details.filter';
import { ProviderTransactionsController } from './infrastructure/http/provider-transactions.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { uuidV7IdGenerator } from './infrastructure/id-generator';
import {
  WAGER_TRANSACTIONS_QUEUE,
  queueUrlResolver,
  sqsClientProvider,
} from './infrastructure/messaging/sqs';
import {
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumer,
} from './infrastructure/messaging/wager-transactions.consumer';
import { nestLogger } from './infrastructure/observability/logger';
import { CounterRegistry } from './infrastructure/observability/metrics';
import { ormConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm.unit-of-work';

/**
 * Composition root. The validated environment is its only input, so a test can start the service on
 * any configuration.
 *
 * The use cases are constructed here with their ports rather than injected into: they carry no
 * framework decorator, which is what keeps the application layer free of NestJS
 * (`model.framework-free-domain`, ARCHITECTURE.md section 4). The adapters they are given — the
 * unit of work over the entity manager, the clock and the id mint — are the only places a use case
 * can reach the outside.
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
        WalletsController,
        WageringController,
        ProviderTransactionsController,
      ],
      providers: [
        sqsClientProvider(env),
        PostgresHealthIndicator,
        SqsHealthIndicator,
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        {
          provide: MikroOrmUnitOfWork,
          useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em, env.LOCK_TIMEOUT_MS),
          inject: [EntityManager],
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
        CounterRegistry,
        {
          provide: ReconcileWallet,
          useFactory: (unitOfWork: MikroOrmUnitOfWork, metrics: CounterRegistry) =>
            new ReconcileWallet({
              unitOfWork,
              clock: systemClock,
              logger: nestLogger('reconciliation'),
              metrics,
            }),
          inject: [MikroOrmUnitOfWork, CounterRegistry],
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (unitOfWork: MikroOrmUnitOfWork) =>
            new SubmitWagerTransaction({
              unitOfWork,
              clock: systemClock,
              ids: uuidV7IdGenerator,
              sha256Hex,
            }),
          inject: [MikroOrmUnitOfWork],
        },
        {
          provide: WagerTransactionsConsumer,
          useFactory: (sqs: SQSClient, submit: SubmitWagerTransaction, metrics: CounterRegistry) =>
            new WagerTransactionsConsumer({
              sqs,
              queueUrl: queueUrlResolver(sqs, WAGER_TRANSACTIONS_QUEUE),
              submit,
              metrics,
              logger: nestLogger(WAGER_TRANSACTIONS_CONSUMER),
              consumerName: WAGER_TRANSACTIONS_CONSUMER,
              waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
              visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
            }),
          inject: [SQSClient, SubmitWagerTransaction, CounterRegistry],
        },
      ],
    };
  }

  /**
   * The correlation id is bound to every request, the health routes included, so no response leaves
   * without one and the exception filter always has an id to put in a problem
   * (`api.correlation-header`).
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(bindCorrelationId).forRoutes('*splat');
  }
}
