import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

import type { Logger } from '../../application/ports/logger';
import type { WorkerProcess } from './worker-loop';

/** What the runtime is called in the lines it writes about a startup and a drain. */
export const WORKER_RUNTIME = 'worker-runtime';

/**
 * The `worker` half of `ops.single-image-roles`: the processes a role that runs workers starts on
 * boot and drains on the way out. It owns no work of its own — the consumer, the publisher and the
 * scheduler each own theirs — and exists so that starting and draining them is one thing the
 * composition root hands to the framework rather than three the bootstrap has to remember.
 *
 * The drain hangs off `beforeApplicationShutdown` and not `onApplicationShutdown`, and the
 * difference is load-bearing: MikroORM closes the connection pool on the latter, so a loop stopped
 * there could be finishing a transaction on a connection that is being taken away. Running before
 * it, the loops finish their work on a live pool, and the pool closes once nothing is using it.
 *
 * The three are drained at the same time, because they share nothing but PostgreSQL and the grace
 * period is wall-clock: draining them in sequence would spend the budget of each on the ones before
 * it, and a message the consumer is finishing has no stake in the batch the publisher is sending.
 */
export class WorkerRuntime implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly processes: readonly WorkerProcess[],
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    for (const process of this.processes) {
      process.start();
    }

    this.logger.info('worker.started', {
      processes: this.processes.map(({ name }) => name).join(' '),
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.processes.map(async (process) => {
        await process.stop();
        this.logger.info('worker.drained', { process: process.name });
      }),
    );
  }
}
