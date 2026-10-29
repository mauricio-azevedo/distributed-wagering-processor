import { Controller, Get, Inject, Res } from '@nestjs/common';

import type { Logger } from '../../application/ports/logger';
import { ObserveOutboxBacklog } from '../../application/use-cases/observe-outbox-backlog';
import { MetricsRegistry } from './metrics';

/** The `Logger` port as a Nest token: an interface cannot be one, and the adapter is chosen once. */
export const OBSERVABILITY_LOGGER = Symbol('observabilityLogger');

/** The members this controller writes, named structurally so it imports no HTTP framework. */
interface ExpositionResponse {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/**
 * `GET /metrics` of [docs/openapi.yaml](../../../docs/openapi.yaml): the Prometheus text exposition
 * of this instance's metrics (`obs.metrics`, OBS-003). It is never authenticated and belongs to the
 * operator rather than to a provider.
 *
 * A scrape measures the outbox backlog before it renders, which is what makes the two gauges of
 * `outbox.lag-metrics` continuous rather than a side effect of a publisher cycle: an instance whose
 * publisher is stopped, or one that runs no publisher at all, still answers how far behind the
 * outbox is — exactly the condition the alert exists for (OUTBOX-008). The cost is one indexed
 * aggregate per scrape, taken in a read-only snapshot that locks nothing.
 *
 * A database that cannot be reached fails the measurement and not the scrape: every counter this
 * instance holds is still the truth about it, and an operator losing the whole exposition because
 * one gauge could not be read would lose the metrics that say why. The two gauges then keep the
 * last value they were measured at, and the failure is a line of its own.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly registry: MetricsRegistry,
    private readonly backlog: ObserveOutboxBacklog,
    @Inject(OBSERVABILITY_LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  async scrape(@Res() response: ExpositionResponse): Promise<void> {
    try {
      await this.backlog.execute();
    } catch (error) {
      this.logger.error('obs.outbox-backlog-unmeasured', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    response.setHeader('Content-Type', this.registry.contentType);
    response.send(await this.registry.expose());
  }
}
