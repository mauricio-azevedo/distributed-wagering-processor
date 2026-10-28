import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import type { Env } from './infrastructure/config/env';
import { HealthController } from './infrastructure/health/health.controller';
import { PostgresHealthIndicator } from './infrastructure/health/postgres.health';
import { SqsHealthIndicator } from './infrastructure/health/sqs.health';
import { sqsClientProvider } from './infrastructure/messaging/sqs';
import { ormConfig } from './infrastructure/persistence/mikro-orm.config';

/** Composition root. The validated environment is its only input, so a test can start the service on any configuration. */
@Module({})
export class AppModule {
  static create(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormConfig(env.DATABASE_URL)), TerminusModule],
      controllers: [HealthController],
      providers: [sqsClientProvider(env), PostgresHealthIndicator, SqsHealthIndicator],
    };
  }
}
