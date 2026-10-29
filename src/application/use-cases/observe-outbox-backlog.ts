import type { Clock } from '../ports/clock';
import type { Metrics } from '../ports/metrics';
import type { UnitOfWork } from '../ports/unit-of-work';

const MILLISECONDS_PER_SECOND = 1000;

/** What one measurement read, as the two gauges of `outbox.lag-metrics` report it. */
export interface OutboxBacklogMeasurement {
  readonly pending: number;
  readonly lagSeconds: number;
}

export interface ObserveOutboxBacklogDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly metrics: Metrics;
}

/**
 * `outbox.lag-metrics` (OUTBOX-008): how many events are waiting to be published and how long the
 * oldest has waited, as the two gauges an operator alerts on.
 *
 * It is a use case and not a job inside the publisher, because the backlog is a fact about the
 * table rather than about the loop: an instance whose publisher is stopped, or one that runs no
 * publisher at all, still answers what the backlog is, which is exactly the condition the alert
 * exists for. A measurement taken only on a publisher cycle would go quiet precisely when
 * publication stopped.
 *
 * The lag is the age of the oldest unpublished row and not the oldest attempt: a row that is
 * backing off is late whether or not its next attempt is due (`outbox.retry-backoff`), and the
 * number an operator reads has to be how far behind the service's announcements are.
 *
 * It reads in the read-only snapshot (`recon.snapshot`'s boundary): two numbers from one committed
 * state, taking no lock, so measuring never waits on a publisher holding a batch and never delays
 * a financial commit.
 */
export class ObserveOutboxBacklog {
  constructor(private readonly dependencies: ObserveOutboxBacklogDependencies) {}

  async execute(): Promise<OutboxBacklogMeasurement> {
    const measuredAt = this.dependencies.clock.now();
    const backlog = await this.dependencies.unitOfWork.snapshot(({ outbox }) => outbox.backlog());
    const measurement = {
      pending: backlog.pending,
      lagSeconds: lagOf(backlog.oldestOccurredAt, measuredAt),
    };

    this.dependencies.metrics.set('wager_outbox_pending', measurement.pending);
    this.dependencies.metrics.set('wager_outbox_lag_seconds', measurement.lagSeconds);

    return measurement;
  }
}

/**
 * How far behind the oldest unpublished row is, in seconds. An empty outbox has no lag, and a row
 * recorded in the future — a clock that moved, which is a condition of the deployment and not of
 * the backlog — reads no lag rather than a negative age a dashboard cannot plot.
 */
function lagOf(oldestOccurredAt: Date | null, measuredAt: Date): number {
  if (oldestOccurredAt === null) {
    return 0;
  }

  const elapsed = measuredAt.getTime() - oldestOccurredAt.getTime();

  return elapsed <= 0 ? 0 : elapsed / MILLISECONDS_PER_SECOND;
}
