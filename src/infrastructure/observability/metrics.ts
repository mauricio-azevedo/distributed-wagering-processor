import type { CounterName, Metrics } from '../../application/ports/metrics';

/**
 * The `Metrics` port as counters held by the process, the shape every Prometheus client has: a
 * counter is per instance and a scrape reads the instance, so the aggregation across instances is
 * the scraper's job and never this registry's.
 *
 * It is one provider rather than a module-level counter so that a test, and the `/metrics` endpoint
 * of OBS-002, read the same instance the use cases increment, and so that two applications started
 * in one process do not share totals.
 */
export class CounterRegistry implements Metrics {
  private readonly counters = new Map<CounterName, number>();

  increment(counter: CounterName): void {
    this.counters.set(counter, this.total(counter) + 1);
  }

  /** The value of a counter; one never raised reads `0`, as an unseen counter does in Prometheus. */
  total(counter: CounterName): number {
    return this.counters.get(counter) ?? 0;
  }
}
