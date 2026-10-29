import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `api.correlation-header`: `X-Correlation-Id` is optional on a request and present on every
 * response, generated when the request carried none.
 *
 * Binding is idempotent and happens on first need rather than only in the middleware, because not
 * everything that answers a request runs after it: the body parser refuses a malformed payload
 * before any route middleware, and that problem has to carry a correlation id like every other
 * (`api.problem-details`). The first caller fixes the id and puts it on the response; every later
 * one reads the same value, so the header and the body of one response can never disagree.
 *
 * `CorrelationId` of [docs/openapi.yaml](../../../docs/openapi.yaml) is the authoritative form.
 * A caller's value is taken when it matches and replaced with a generated one when it does not:
 * refusing a malformed one as `400` arrives with the sweep of API-001, and until then a response
 * always carries an id an operator can search for, which is the point of the header.
 */
const CORRELATION_ID = /^[!-~]{1,128}$/;

const HEADER = 'X-Correlation-Id';

const BOUND = Symbol('correlationId');

type Carrier = IncomingMessage & { [BOUND]?: string };

/** The id of this request, bound and written to the response the first time it is asked for. */
export function correlationIdFor(request: IncomingMessage, response: ServerResponse): string {
  const carrier = request as Carrier;
  const bound = carrier[BOUND];

  if (bound !== undefined) {
    return bound;
  }

  const supplied = request.headers['x-correlation-id'];
  const correlationId =
    typeof supplied === 'string' && CORRELATION_ID.test(supplied) ? supplied : Bun.randomUUIDv7();

  carrier[BOUND] = correlationId;
  response.setHeader(HEADER, correlationId);

  return correlationId;
}

/**
 * Nest middleware: binds the id before any handler runs, so a response that never reaches the
 * filter carries the header too.
 */
export function bindCorrelationId(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  correlationIdFor(request, response);

  next();
}

/** The correlation id as a handler parameter (`obs.correlation-propagation`). */
export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const http = context.switchToHttp();

  return correlationIdFor(http.getRequest(), http.getResponse());
});
