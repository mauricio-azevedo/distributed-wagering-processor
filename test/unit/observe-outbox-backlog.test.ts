import { describe, expect, test } from 'bun:test';

import type { Clock } from '../../src/application/ports/clock';
import type { OutboxBacklog } from '../../src/application/ports/repositories';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ObserveOutboxBacklog } from '../../src/application/use-cases/observe-outbox-backlog';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';

const NOW = new Date('2026-10-29T12:00:30.000Z');

/**
 * `recon.snapshot`'s neighbour: the backlog is read without locking anything, so a measurement
 * never waits on a publisher and never holds a row it was only counting. A unit of work that
 * refuses `transactional` is what proves the use case asks for the read-only boundary.
 */
function unitOfWorkOver(backlog: OutboxBacklog, calls: string[]): UnitOfWork {
  return {
    transactional() {
      throw new Error('measuring the backlog writes nothing, so it must not open a transaction');
    },
    snapshot(work) {
      calls.push('snapshot');

      return work({
        outbox: { backlog: () => Promise.resolve(backlog) },
      } as unknown as Repositories);
    },
  };
}

function measuring(backlog: OutboxBacklog) {
  const calls: string[] = [];
  const metrics = new MetricsRegistry();
  const clock: Clock = { now: () => NOW };

  return {
    calls,
    metrics,
    useCase: new ObserveOutboxBacklog({
      unitOfWork: unitOfWorkOver(backlog, calls),
      clock,
      metrics,
    }),
  };
}

describe('ObserveOutboxBacklog', () => {
  test('reports the pending rows and the age of the oldest one (OUTBOX-008)', async () => {
    const measurement = measuring({
      pending: 3,
      oldestOccurredAt: new Date('2026-10-29T12:00:00.000Z'),
    });

    expect(await measurement.useCase.execute()).toEqual({ pending: 3, lagSeconds: 30 });
    expect(await measurement.metrics.expose()).toContain('wager_outbox_pending 3');
    expect(await measurement.metrics.expose()).toContain('wager_outbox_lag_seconds 30');
    expect(measurement.calls).toEqual(['snapshot']);
  });

  test('reports an empty outbox as no rows and no lag', async () => {
    const measurement = measuring({ pending: 0, oldestOccurredAt: null });

    expect(await measurement.useCase.execute()).toEqual({ pending: 0, lagSeconds: 0 });
    expect(await measurement.metrics.expose()).toContain('wager_outbox_pending 0');
    expect(await measurement.metrics.expose()).toContain('wager_outbox_lag_seconds 0');
  });

  test('reports no lag for a row recorded in the future rather than a negative age', async () => {
    const measurement = measuring({
      pending: 1,
      oldestOccurredAt: new Date('2026-10-29T12:00:35.000Z'),
    });

    expect(await measurement.useCase.execute()).toEqual({ pending: 1, lagSeconds: 0 });
  });
});
