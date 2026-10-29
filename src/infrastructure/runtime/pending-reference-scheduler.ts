import type { Logger } from '../../application/ports/logger';
import type { ReprocessPendingReference } from '../../application/use-cases/reprocess-pending-reference';
import { WorkerLoop, type WorkerProcess } from './worker-loop';

/** `msg.inbox-identity`'s neighbour: what this process is called in the logs it writes. */
export const PENDING_REFERENCE_SCHEDULER = 'pending-reference-scheduler';

export interface PendingReferenceSchedulerOptions {
  /** How long to wait after a sweep that found nothing due. */
  readonly sweepIntervalMs: number;
  readonly logger: Logger;
}

/**
 * The scheduler as a running process: sweeps of `ReprocessPendingReference`, one after another, for
 * as long as it is started (ADR 0011). It holds no state about the backlog — the schedule rows are
 * the state — so any number of these sweep one claim list and a new one takes over whatever a dead
 * one was attempting (`ref.scheduler`).
 *
 * Its shutdown is the one thing this class adds to the loop, and it is a property of the claim
 * rather than of any code here: a claim exists only inside the transaction that took it with
 * `SELECT ... FOR UPDATE SKIP LOCKED`, so there is nothing for a drain to release. `stop` stops the
 * sweep from claiming the next row and waits for the attempt in flight, which either commits —
 * recording its outcome and its backoff — or rolls back, leaving `next_attempt_at` exactly where it
 * was. A row the process was holding when it exited is therefore due the moment another instance
 * sweeps, with no backoff to wait out (`ops.graceful-shutdown`, OPS-007).
 */
export class PendingReferenceScheduler implements WorkerProcess {
  readonly name = PENDING_REFERENCE_SCHEDULER;

  private readonly loop: WorkerLoop;

  constructor(reprocess: ReprocessPendingReference, options: PendingReferenceSchedulerOptions) {
    this.loop = new WorkerLoop({
      cycle: async () => (await reprocess.execute(this.loop.claiming)).length > 0,
      idleIntervalMs: options.sweepIntervalMs,
      failureEvent: 'pending-reference.sweep-failed',
      logger: options.logger,
    });
  }

  start(): void {
    this.loop.start();
  }

  /** Stops claiming and resolves when the attempt in flight has committed or rolled back. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
