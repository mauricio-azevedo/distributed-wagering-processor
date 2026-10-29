import type { Logger } from '../../application/ports/logger';

export interface WorkerLoopOptions {
  /**
   * One cycle of the work this loop drives, answering whether it found anything: a cycle that did
   * is followed at once, a cycle that did not waits.
   */
  readonly cycle: () => Promise<boolean>;
  /** How long to wait after a cycle that found nothing to do, including one that failed. */
  readonly idleIntervalMs: number;
  /** The event a failed cycle is logged under, which is this loop's name in an operator's logs. */
  readonly failureEvent: string;
  readonly logger: Logger;
}

/**
 * The loop every background process of this service runs: cycles, one after another, for as long as
 * it is started. The outbox publisher (ADR 0005) and the pending-reference scheduler (ADR 0011) are
 * both this loop around a use case, and both depend on the same two properties, which is why they
 * are implemented and tested in one place rather than twice:
 *
 * - A cycle that claimed anything is followed immediately by the next one, because a full batch
 *   means there is probably more due; only an idle cycle waits, which is what keeps an idle
 *   deployment from polling PostgreSQL as fast as it can and a backlog from draining at one batch
 *   per interval.
 * - A cycle that fails is reported and the loop carries on. There is nothing else to do and nothing
 *   is lost: the rows it did not take are still due, and a database that is unavailable now makes
 *   the next cycle fail too, which is the backoff this loop needs and the only one it has, because
 *   a cycle that cannot reach PostgreSQL cannot record an attempt either.
 *
 * `stop` is the whole of `ops.graceful-shutdown` for these processes: it stops the loop from
 * claiming anything new and resolves once the cycle in flight has finished, so work that was
 * started is always committed or rolled back before the process exits, never left half done.
 * `claiming` is the same signal for a cycle that claims item by item — the scheduler's sweep is one
 * claim per transaction — so a stop takes effect between items instead of after fifty of them.
 */
export class WorkerLoop {
  private cycling: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(private readonly options: WorkerLoopOptions) {}

  /** Starts the loop, or does nothing if it is already running. */
  start(): void {
    this.cycling ??= this.run();
  }

  /** Stops claiming and resolves when the cycle in flight has committed or rolled back. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.cycling;
    this.cycling = undefined;
    this.stopping = false;
  }

  /**
   * Whether the loop may still claim work. It is a bound method so a cycle can take it as the
   * predicate it is, and it reads the flag through a call because `stop` sets it from outside the
   * cycle that has to notice.
   */
  readonly claiming = (): boolean => !this.stopping;

  private async run(): Promise<void> {
    while (!this.stopping) {
      if (await this.cycle()) {
        await this.waitForWork();
      }
    }
  }

  /** One cycle; `true` when it found nothing to do, including because it failed. */
  private async cycle(): Promise<boolean> {
    try {
      return !(await this.options.cycle());
    } catch (error) {
      this.options.logger.error(this.options.failureEvent, {
        reason: error instanceof Error ? error.message : String(error),
      });

      return true;
    }
  }

  /**
   * The idle interval, cut short by `stop` so a shutdown never waits out an idle wait. A stop that
   * arrived while the cycle was settling is read here rather than only at the top of the loop: the
   * wait had not begun, so there was no timer for `stop` to wake, and waiting it out would hold a
   * drain for an interval of work nobody asked for.
   */
  private waitForWork(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.options.idleIntervalMs);

      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

/**
 * A background process of the `worker` role, as the runtime starts and drains it. `start` is
 * immediate and `stop` resolves when what was in flight has finished, which is the contract
 * `WorkerRuntime` relies on and `ops.graceful-shutdown` asks for.
 */
export interface WorkerProcess {
  /** What this process is called in the logs of a startup and of a drain. */
  readonly name: string;
  start: () => void;
  stop: () => Promise<void>;
}
