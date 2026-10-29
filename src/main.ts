import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';
import { jsonLinesLogger } from './infrastructure/observability/logger';
import { NestJsonLogger } from './infrastructure/observability/nest-logger';

const logger = jsonLinesLogger('bootstrap');

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env);
  // The framework's own lines go through the same sink, so every line this process writes is JSON
  // (`obs.structured-logs`).
  const app = await NestFactory.create(AppModule.create(env), { logger: new NestJsonLogger() });
  app.enableShutdownHooks();
  await app.listen(env.HTTP_PORT);
  logger.info('service.listening', { url: await app.getUrl() });
}

bootstrap().catch((error: unknown) => {
  logger.error('service.bootstrap-failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
