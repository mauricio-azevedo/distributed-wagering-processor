import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';
import { jsonLinesLogger } from './infrastructure/observability/logger';
import { NestJsonLogger } from './infrastructure/observability/nest-logger';
import {
  type IdleConnections,
  drainHttp,
  onShutdownSignal,
} from './infrastructure/runtime/shutdown';

const logger = jsonLinesLogger('bootstrap');

/**
 * The one entry point of the one image (`ops.single-image-roles`). The environment is validated
 * before anything is built, so an invalid or missing value stops the process by name and no port is
 * ever opened on a configuration the service cannot run (`ops.config-env`); `APP_ROLE` then decides
 * what this process is, inside the composition root.
 *
 * `return503OnClosing` is the first half of `ops.graceful-shutdown`: from the moment a shutdown
 * begins, a request that arrives is refused with `503` and `Connection: close` instead of being
 * accepted by a process that is leaving, while the requests already in flight run to their
 * response. The second half is `onShutdownSignal`, which closes the application — draining the HTTP
 * server and the worker processes of this role — under the grace period the configuration names,
 * with the connections nobody is using released as it goes so a caller's keep-alive pool cannot
 * hold the drain open (ADR 0013).
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env);
  // The framework's own lines go through the same sink, so every line this process writes is JSON
  // (`obs.structured-logs`).
  const app = await NestFactory.create(AppModule.create(env), {
    logger: new NestJsonLogger(),
    return503OnClosing: true,
  });

  await app.listen(env.HTTP_PORT);

  onShutdownSignal({
    drain: () => drainHttp(app.getHttpServer() as IdleConnections, () => app.close()),
    gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
    logger,
  });

  // The role and the address it serves on, which is also how a suite reaches an instance it started
  // on a port the operating system picked (`HTTP_PORT=0`).
  logger.info('service.listening', { role: env.APP_ROLE, url: await app.getUrl() });
}

bootstrap().catch((error: unknown) => {
  logger.error('service.bootstrap-failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
