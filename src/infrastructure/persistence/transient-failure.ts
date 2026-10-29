import { ConnectionException } from '@mikro-orm/postgresql';

import { ServiceUnavailableError } from '../../application/errors';

/**
 * Which database failures are transient (`api.transient-failure`, interpretation 9 of the system
 * contract): the ones a later attempt of the same request can still succeed at. They become
 * `ServiceUnavailableError`, which HTTP answers as `503` with `Retry-After` and the queue consumer
 * retries with backoff; everything else keeps travelling as what it is.
 *
 * The classification is here, beside the connection, because the vocabulary it reads is
 * PostgreSQL's. It is deliberately a closed list: an error nobody classified stays unclassified, so
 * a defect surfaces as one instead of being reported to providers as a dependency they should wait
 * for. The one place that must never over-report is `FAILED` (`tx.failed-semantics`), which only
 * the scheduler writes and which this never produces.
 */

/**
 * The SQLSTATE classes a retry can clear. `55P03` is the one `lock_timeout` raises, which is the
 * wallet lock of ADR 0002 giving up; `40001` and `40P01` are the two the server resolves by
 * aborting a transaction; `57014` is a statement the server cancelled; the `08` class is the
 * connection itself; `53` is a resource the server ran out of; `57P01` to `57P03` are a server
 * shutting down, restarting or not yet accepting connections.
 */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '40001',
  '40P01',
  '53000',
  '53100',
  '53200',
  '53300',
  '53400',
  '55006',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
]);

/** `lock_timeout` giving up, the one state that names the wallet lock in its detail. */
const LOCK_NOT_AVAILABLE = '55P03';

/** The socket failures that reach the driver as a Node error rather than as a server answer. */
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * `api.retry-after`: how long a caller is asked to wait before resending with the same key. It is a
 * constant and not a setting because it is advice about one request, not a tuning parameter: a lock
 * wait is bounded by `lock_timeout` and a dependency outage outlasts any number a header could
 * carry, so the value only has to be long enough that an immediate retry storm does not form.
 */
const RETRY_AFTER_SECONDS = 5;

/**
 * The transient failure an error is, or `null` when it is not one. `cause` is followed because the
 * driver wraps the socket error it was handed, and MikroORM copies the original's own properties
 * onto the exception it raises, so the SQLSTATE is read off either.
 */
export function transientDatabaseFailure(
  error: unknown,
  limits: { readonly lockTimeoutMs: number },
): ServiceUnavailableError | null {
  const code = failureCodeOf(error);

  if (code === LOCK_NOT_AVAILABLE) {
    return new ServiceUnavailableError(
      `The wallet lock was not acquired within ${limits.lockTimeoutMs.toString()} ms.`,
      RETRY_AFTER_SECONDS,
    );
  }

  if (error instanceof ConnectionException || isTransient(code)) {
    return new ServiceUnavailableError(
      'The service could not reach the database to complete the operation.',
      RETRY_AFTER_SECONDS,
    );
  }

  return null;
}

function isTransient(code: string | null): boolean {
  return code !== null && (TRANSIENT_SQL_STATES.has(code) || TRANSIENT_SOCKET_CODES.has(code));
}

function failureCodeOf(error: unknown): string | null {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };

    if (typeof code === 'string') {
      return code;
    }

    current = cause;
  }

  return null;
}
