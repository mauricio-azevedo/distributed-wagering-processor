import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { withLogContext } from '../observability/log-context';
import { MetricsRegistry } from '../observability/metrics';
import { correlationIdFor } from './correlation-id';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The operational endpoints, which are measured by nobody and would drown the measurement of the
 * ones that are: a scrape every few seconds at a millisecond each moves the quantiles of
 * `wager_processing_duration_seconds{entrypoint="http"}` away from the provider-facing operations
 * the histogram exists to describe. They are still bound to a correlation id, because every
 * response carries one (`api.correlation-header`).
 */
const UNMEASURED = ['/health', '/metrics'];

/**
 * What every HTTP request is wrapped in: the correlation id bound before any handler runs, the log
 * context that carries it into every line the request produces, and the measurement of how long
 * the request took (`api.correlation-header`, `obs.correlation-propagation`, `obs.metrics`).
 *
 * The three belong together because they are one decision — this request, this id, this long — and
 * because the binding has to happen in the first thing that touches the request: a response the
 * body parser refuses never reaches a handler, and its problem details still carry an id
 * (`api.problem-details`).
 *
 * The duration is taken on `finish` and not when the handler returned, so it is the time the caller
 * waited, filters and serialization included. It is read from a monotonic source rather than from
 * the `Clock` port, because a duration is not a moment any financial decision is taken against.
 */
@Injectable()
export class ObserveRequest implements NestMiddleware {
  constructor(private readonly metrics: MetricsRegistry) {}

  use(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    const correlationId = correlationIdFor(request, response);
    const startedAt = performance.now();

    if (measured(pathOf(request))) {
      response.on('finish', () => {
        this.metrics.observe(
          'wager_processing_duration_seconds',
          { entrypoint: 'http' },
          (performance.now() - startedAt) / MILLISECONDS_PER_SECOND,
        );
      });
    }

    withLogContext({ correlationId }, next);
  }
}

/**
 * The path the caller asked for, without its query. A middleware mounted on a wildcard route is
 * handed a `url` relative to that mount, so the path of the request is `originalUrl` wherever the
 * framework recorded one, and `url` only for a request that reached no router.
 */
function pathOf(request: IncomingMessage): string {
  const asked = (request as IncomingMessage & { originalUrl?: string }).originalUrl ?? request.url;

  return (asked ?? '/').split('?')[0] ?? '/';
}

/** Whether this request is one of the service's own operations rather than an operator's probe. */
function measured(path: string): boolean {
  return !UNMEASURED.some(
    (operational) => path === operational || path.startsWith(`${operational}/`),
  );
}
