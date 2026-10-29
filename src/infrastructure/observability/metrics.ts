import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import type {
  CounterLabelArguments,
  CounterName,
  GaugeName,
  HistogramLabels,
  HistogramName,
  Metrics,
} from '../../application/ports/metrics';

/**
 * The port for a caller that counts nothing: a test helper or a probe that builds a use case
 * directly, with no registry and no `/metrics` endpoint behind it. It is named and exported rather
 * than written inline at each default, so a reader of a constructor sees that the fallback counts
 * nothing instead of having to infer it, and so there is one place to look for who uses it.
 *
 * The service never uses it. What keeps that true is not the type — a mis-wired composition root
 * would take it silently — but the suites that assert the counters through the composition root
 * itself (OBS-003, CONC-002, MSG-010, RECON-003).
 */
export const uncountedMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
  set: () => undefined,
};

/** The label each counter is counted per, as `CounterLabels` names them (`obs.metrics`). */
const COUNTERS: Readonly<Record<CounterName, { help: string; labelNames: readonly string[] }>> = {
  wager_transactions_total: {
    help: 'Transactions by kind and status.',
    labelNames: ['kind', 'status'],
  },
  wager_duplicates_detected_total: {
    help: 'Duplicate operations detected, by where they were caught.',
    labelNames: ['source'],
  },
  wager_retries_total: {
    help: 'Retries scheduled, by the component that backs off.',
    labelNames: ['component'],
  },
  wager_pending_reference_total: {
    help: 'Attempts at a parked transaction, by what the attempt ended in.',
    labelNames: ['outcome'],
  },
  wager_dlq_messages_total: {
    help: 'Messages forwarded to the dead-letter queue.',
    labelNames: [],
  },
  wager_lock_conflicts_total: {
    help: 'Financial operations that gave up waiting for a wallet lock.',
    labelNames: [],
  },
  wager_reconciliation_divergence_total: {
    help: 'Wallets whose stored balance did not match their ledger.',
    labelNames: [],
  },
};

const GAUGES: Readonly<Record<GaugeName, string>> = {
  wager_outbox_pending: 'Outbox rows awaiting publication.',
  wager_outbox_lag_seconds: 'Age of the oldest unpublished outbox row, in seconds.',
};

/**
 * The buckets of `wager_processing_duration_seconds`. They straddle the two numbers that decide
 * what an operation costs: the sub-millisecond-to-tens-of-milliseconds band an uncontended
 * operation lands in, and the `LOCK_TIMEOUT_MS` ceiling a contended one waits out before it
 * becomes a transient refusal (ADR 0002), so a shift from the first band into the second is
 * visible as a bucket moving rather than as an average creeping.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const HISTOGRAMS: Readonly<
  Record<HistogramName, { help: string; labelNames: readonly string[]; buckets: number[] }>
> = {
  wager_processing_duration_seconds: {
    help: 'Time one operation took, by the entrypoint it arrived through.',
    labelNames: ['entrypoint'],
    buckets: DURATION_BUCKETS,
  },
};

/**
 * The `Metrics` port over a Prometheus registry of this instance's own (OBS-003).
 *
 * Every documented metric is declared when the registry is built and not when something first
 * raises it, so a scrape of an idle instance already carries every name with its type and an
 * operator's panel reads zero instead of reading nothing (`obs.metrics`). A counter is per instance
 * and a scrape reads the instance, so the aggregation across instances is the scraper's job and
 * never this registry's.
 *
 * It is one provider with a `Registry` of its own rather than the library's global default, so that
 * a suite and the `/metrics` endpoint read the same instance the use cases raise, and two
 * applications started in one process — which is what an integration suite does — do not share
 * totals.
 */
export class MetricsRegistry implements Metrics {
  private readonly registry = new Registry();

  private readonly counters: Readonly<Record<CounterName, Counter>>;
  private readonly gauges: Readonly<Record<GaugeName, Gauge>>;
  private readonly histograms: Readonly<Record<HistogramName, Histogram>>;

  constructor() {
    this.counters = Object.fromEntries(
      Object.entries(COUNTERS).map(([name, declaration]) => [
        name,
        new Counter({
          name,
          help: declaration.help,
          labelNames: [...declaration.labelNames],
          registers: [this.registry],
        }),
      ]),
    ) as Record<CounterName, Counter>;

    this.gauges = Object.fromEntries(
      Object.entries(GAUGES).map(([name, help]) => [
        name,
        new Gauge({ name, help, registers: [this.registry] }),
      ]),
    ) as Record<GaugeName, Gauge>;

    this.histograms = Object.fromEntries(
      Object.entries(HISTOGRAMS).map(([name, declaration]) => [
        name,
        new Histogram({
          name,
          help: declaration.help,
          labelNames: [...declaration.labelNames],
          buckets: declaration.buckets,
          registers: [this.registry],
        }),
      ]),
    ) as Record<HistogramName, Histogram>;
  }

  increment<Name extends CounterName>(counter: Name, ...labels: CounterLabelArguments<Name>): void {
    const [series] = labels as [Record<string, string> | undefined];

    this.counters[counter].inc(series ?? {});
  }

  observe<Name extends HistogramName>(
    histogram: Name,
    labels: HistogramLabels[Name],
    seconds: number,
  ): void {
    this.histograms[histogram].observe(labels, seconds);
  }

  set(gauge: GaugeName, value: number): void {
    this.gauges[gauge].set(value);
  }

  /**
   * The value of one counter's series as a scrape would read it; a series nothing has raised reads
   * `0`, as an unseen counter does in Prometheus. It is what a suite asserts a path incremented
   * without parsing the exposition for it.
   */
  async total<Name extends CounterName>(
    counter: Name,
    ...labels: CounterLabelArguments<Name>
  ): Promise<number> {
    const [series] = labels as [Record<string, string> | undefined];
    const measured = await this.counters[counter].get();

    return measured.values.find((value) => matches(value.labels, series ?? {}))?.value ?? 0;
  }

  /** The Prometheus text exposition of every metric, which is the body of `GET /metrics`. */
  expose(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

/** Whether a measured series is the one asked for, compared by the labels asked about. */
function matches(
  measured: Partial<Record<string, string | number>>,
  asked: Record<string, string>,
): boolean {
  return Object.entries(asked).every(([label, value]) => measured[label] === value);
}
