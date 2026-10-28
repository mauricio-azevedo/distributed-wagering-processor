import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';

const logger = new Logger('bootstrap');

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule.create(env));
  app.enableShutdownHooks();
  await app.listen(env.HTTP_PORT);
  logger.log(`Listening on ${await app.getUrl()}`);
}

bootstrap().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
