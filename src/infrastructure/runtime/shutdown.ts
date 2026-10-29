import type { Logger } from '../../application/ports/logger';

/**
 * The exit code of a drain that did not finish inside the grace period, or that failed while
 * finishing. It is non-zero because an operator has to be able to tell the two apart — a deployment
 * whose grace period is too short for its own work is a misconfiguration, not a clean stop — and it
 * is not a sign that anything was lost: work the drain did not finish is work no transaction
 * committed, so it is where a redelivery or the next claim finds it.
 *
 * `75` is `EX_TEMPFAIL` of `sysexits.h`: the condition is temporary and the next process start is
 * the whole of the remedy.
 */
export const DRAIN_INCOMPLETE_EXIT = 75;

/** The signals an orchestrator stops a container with, and that a terminal sends on Ctrl-C. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** How often a drain releases the connections that have gone idle since the last sweep. */
const IDLE_CONNECTION_SWEEP_MS = 100;

/** The one method of an HTTP server a drain needs, so nothing here depends on the adapter. */
export interface IdleConnections {
  closeIdleConnections?: () => void;
}

/**
 * `ops.graceful-shutdown` for an HTTP server that keeps connections alive. Closing the server stops
 * the listener and then waits for every connection to end, and a caller's idle keep-alive
 * connection — a load balancer's, typically — would hold that wait open for as long as the caller
 * feels like, which would turn every ordinary stop into one that hits the grace period.
 *
 * So the connections that are not serving a request are closed, and closed again as the requests in
 * flight finish and release theirs. A socket in the middle of a request is never touched: what
 * bounds this drain is the work in flight, which is the only thing a shutdown may wait for.
 */
export async function drainHttp(
  server: IdleConnections,
  close: () => Promise<void>,
): Promise<void> {
  server.closeIdleConnections?.();
  const releasing = setInterval(() => server.closeIdleConnections?.(), IDLE_CONNECTION_SWEEP_MS);

  try {
    await close();
  } finally {
    clearInterval(releasing);
  }
}

/**
 * Only what a shutdown writes: the two levels of the log port, so a drain reports through the same
 * sink as everything else (`obs.structured-logs`) and a helper process can pass one of its own.
 */
export type ShutdownLogger = Pick<Logger, 'info' | 'error'>;

export interface ShutdownOptions {
  /**
   * The drain: what has to finish before the process may exit. For the service it is
   * `app.close()`, which stops the HTTP server accepting, drains the requests in flight and stops
   * every worker process this role runs.
   */
  readonly drain: () => Promise<void>;
  /** `SHUTDOWN_GRACE_PERIOD_MS`: how long the drain may take before the process exits regardless. */
  readonly gracePeriodMs: number;
  readonly logger: ShutdownLogger;
}

/**
 * `ops.graceful-shutdown`: the one signal handler of a process, and the deadline it keeps.
 *
 * NestJS has shutdown hooks of its own, and they are deliberately not used: they re-raise the
 * signal once the hooks have run, which exits the process with no bound on how long the hooks took.
 * A deployment stops a container with `SIGTERM` and then kills it, so the drain has to be the one
 * that gives up first, on a period the configuration names; otherwise the loser of that race is
 * always `SIGKILL`, and a drain that is interrupted at an arbitrary point is the thing a graceful
 * shutdown exists to avoid. `app.close()` runs exactly the hooks `enableShutdownHooks` would.
 *
 * A second signal while a drain is in flight is ignored rather than escalated: the drain is already
 * bounded, and an operator who sends another `SIGTERM` is asking for the same thing twice.
 */
export function onShutdownSignal({ drain, gracePeriodMs, logger }: ShutdownOptions): void {
  let draining = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (draining) {
      return;
    }

    draining = true;
    logger.info('service.draining', { signal, gracePeriodMs });
    void drainWithin({ drain, gracePeriodMs, logger });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, handle);
  }
}

async function drainWithin({ drain, gracePeriodMs, logger }: ShutdownOptions): Promise<never> {
  const deadline = Bun.sleep(gracePeriodMs).then(() => 'deadline' as const);

  try {
    const outcome = await Promise.race([drain().then(() => 'drained' as const), deadline]);

    if (outcome === 'drained') {
      logger.info('service.drained', { gracePeriodMs });
      process.exit(0);
    }

    logger.error('service.drain-timed-out', { gracePeriodMs });
  } catch (error) {
    logger.error('service.drain-failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  // Nothing waited for a transaction that has not committed: PostgreSQL rolls it back and releases
  // the locks and the claims it held when this connection goes, and an unacknowledged message is
  // redelivered when its visibility expires. Exiting is what hands that work to the next instance.
  process.exit(DRAIN_INCOMPLETE_EXIT);
}
