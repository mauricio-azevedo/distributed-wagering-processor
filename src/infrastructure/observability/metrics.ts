import type { CounterLabels, CounterName, Metrics } from '../../application/ports/metrics';

/**
 * The `Metrics` port as counters held by the process, the shape every Prometheus client has: a
 * counter is per instance and a scrape reads the instance, so the aggregation across instances is
 * the scraper's job and never this registry's.
 *
 * It is one provider rather than a module-level counter so that a test, and the `/metrics` endpoint
 * of OBS-002, read the same instance the use cases increment, and so that two applications started
 * in one process do not share totals.
 */
/**
 * The port for a caller that counts nothing: a test helper or a probe that builds an adapter
 * directly, with no registry and no `/metrics` endpoint behind it. It is named and exported rather
 * than written inline at each default, so a reader of a constructor sees that the fallback counts
 * nothing instead of having to infer it, and so there is one place to look for who uses it.
 *
 * The service never uses it. What keeps that true is not the type — a mis-wired composition root
 * would take it silently — but the suites that assert the counters through the composition root
 * itself (CONC-002, MSG-010, RECON-003).
 */
export const uncountedMetrics: Metrics = { increment: () => undefined };

export class CounterRegistry implements Metrics {
  private readonly counters = new Map<string, number>();

  increment(counter: CounterName, labels?: CounterLabels): void {
    this.counters.set(seriesOf(counter, labels), this.total(counter, labels) + 1);
  }

  /** The value of one series; one never raised reads `0`, as an unseen counter does in Prometheus. */
  total(counter: CounterName, labels?: CounterLabels): number {
    return this.counters.get(seriesOf(counter, labels)) ?? 0;
  }
}

/**
 * `name{label="value"}`, the exposition spelling of one series, which is what a counter is counted
 * per: two label sets of one counter are two totals of it. The labels are spelled out rather than
 * walked, so the series a counter has are the ones `CounterLabels` can describe and a label added
 * to that type is added here too.
 */
function seriesOf(counter: CounterName, labels: CounterLabels | undefined): string {
  return labels === undefined ? counter : `${counter}{source="${labels.source}"}`;
}
