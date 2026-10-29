/**
 * The arithmetic of the load experiment (OPS-008): how attempts are classified, how percentiles and
 * throughput are taken, and how a counter spread across five instances is read back from their
 * `/metrics` expositions.
 *
 * It is a module of its own, with no I/O in it, because a load report is only worth what its
 * definitions are worth. The scenario cannot assert its own numbers — a throughput is whatever the
 * machine did — so the one thing that can be proven is that the numbers mean what
 * [docs/load-experiment.md](../../docs/load-experiment.md) says they mean, and that is what
 * `test/unit/load-measure.test.ts` proves.
 */

/**
 * What one attempt turned out to be, as `api.status-classes` decides it. The four groups the report
 * keeps apart:
 *
 * - completed work: `completed`, one unique operation the service recorded an outcome for;
 * - duplicates: `replayed`, an operation whose outcome was already recorded (`idem.persistent`);
 * - business refusals: `rejected` and `conflict`, the service working as specified;
 * - infrastructure errors: `transient`, `failed` and `transport`, the only numerator of the error
 *   rate.
 *
 * `parked` is work in progress rather than an outcome (`ref.parked-state`), and `invalid` is a
 * defect in the generator — a request the service refused to read — which is counted and reported
 * but folded into neither of the two error groups, because it measures the harness and not the
 * service.
 */
export type AttemptCategory =
  | 'completed'
  | 'replayed'
  | 'rejected'
  | 'conflict'
  | 'parked'
  | 'transient'
  | 'failed'
  | 'invalid'
  | 'transport';

const CATEGORIES: readonly AttemptCategory[] = [
  'completed',
  'replayed',
  'rejected',
  'conflict',
  'parked',
  'transient',
  'failed',
  'invalid',
  'transport',
];

/** What the generator read off one answer: the status class and the two fields that qualify it. */
export interface SubmissionAnswer {
  readonly status: number;
  /** `status` of the submission result — the outcome the service recorded, when it recorded one. */
  readonly recordedStatus?: string | null | undefined;
  readonly idempotentReplay?: boolean | null | undefined;
}

/**
 * The category of one answer. A replay is a replay whatever outcome it replays: the work was done
 * once and counted once, so a second answer carrying the stored outcome is a duplicate and not a
 * second completion (`idem.replay-shape`).
 */
export function classify(answer: SubmissionAnswer): AttemptCategory {
  const { status, recordedStatus, idempotentReplay } = answer;

  if (idempotentReplay === true) {
    return 'replayed';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 422) {
    return 'rejected';
  }
  if (status === 202 || recordedStatus === 'PENDING_REFERENCE') {
    return 'parked';
  }
  if (status === 503) {
    return 'transient';
  }
  if (status >= 500) {
    return 'failed';
  }
  if (status >= 400) {
    return 'invalid';
  }

  return 'completed';
}

/** One attempt as the generator recorded it; `at` is when the attempt started, by the host clock. */
export interface Attempt {
  readonly at: number;
  readonly latencyMs: number;
  readonly category: AttemptCategory;
}

/**
 * A measurement window in host-clock milliseconds, `from` inclusive and `to` exclusive, so two
 * adjacent windows — the warm-up and the measured phase — can never count one attempt twice, and
 * the duration a rate is taken over is exactly `to - from`.
 */
export interface Window {
  readonly from: number;
  readonly to: number;
}

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export interface Tally {
  readonly attempts: number;
  readonly byCategory: Readonly<Record<AttemptCategory, number>>;
  readonly completed: number;
  readonly replays: number;
  readonly businessRejections: number;
  readonly infrastructureErrors: number;
  /** Infrastructure errors over every attempt, which is the denominator the report states. */
  readonly errorRate: number;
}

/**
 * Nearest-rank: the sample at `ceil(q * n)` of the sorted set, so a reported percentile is a
 * measurement that happened rather than an interpolation between two that did. `null` for an empty
 * set — nothing measured is never reported as a zero, which would read as a fast answer.
 */
export function percentile(samples: readonly number[], q: number): number | null {
  if (samples.length === 0) {
    return null;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));

  return sorted[rank - 1] ?? null;
}

export function summarize(samples: readonly number[]): LatencySummary | null {
  if (samples.length === 0) {
    return null;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5) ?? 0,
    p95: percentile(sorted, 0.95) ?? 0,
    p99: percentile(sorted, 0.99) ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: total / sorted.length,
  };
}

/** A count over the window it was counted in. A window of no duration has no rate. */
export function perSecond(count: number, window: Window): number {
  const seconds = (window.to - window.from) / 1_000;

  return seconds > 0 ? count / seconds : 0;
}

/**
 * Every attempt one entry point made, kept as records rather than as running totals: the warm-up is
 * then excluded by a window instead of by a second set of counters, so the attempts a percentile is
 * taken over are exactly the attempts the throughput counted.
 */
export class AttemptLog {
  private readonly recorded: Attempt[] = [];

  record(attempt: Attempt): void {
    this.recorded.push(attempt);
  }

  get attempts(): readonly Attempt[] {
    return this.recorded;
  }

  /** The attempts that started inside the window, as a log of their own. */
  within(window: Window): AttemptLog {
    const kept = new AttemptLog();

    for (const attempt of this.recorded) {
      if (attempt.at >= window.from && attempt.at < window.to) {
        kept.record(attempt);
      }
    }

    return kept;
  }

  latencies(): number[] {
    return this.recorded.map(({ latencyMs }) => latencyMs);
  }

  count(category: AttemptCategory): number {
    return this.recorded.filter((attempt) => attempt.category === category).length;
  }

  tally(): Tally {
    const byCategory = Object.fromEntries(
      CATEGORIES.map((category) => [category, this.count(category)]),
    ) as Record<AttemptCategory, number>;

    const attempts = this.recorded.length;
    const infrastructureErrors = byCategory.transient + byCategory.failed + byCategory.transport;

    return {
      attempts,
      byCategory,
      completed: byCategory.completed,
      replays: byCategory.replayed,
      businessRejections: byCategory.rejected + byCategory.conflict,
      infrastructureErrors,
      errorRate: attempts === 0 ? 0 : infrastructureErrors / attempts,
    };
  }
}

/** One series of one scrape: the metric, the labels that identify it, and its value. */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

const SERIES = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>[^}]*)\})?\s+(?<value>.+)$/;
const LABEL = /(?<name>[a-zA-Z_][a-zA-Z0-9_]*)="(?<value>(?:[^"\\]|\\.)*)"/g;

/**
 * A number as the exposition spells one. `+Inf` is not a JavaScript numeral and it is the upper
 * bound of every histogram's last bucket, so reading it as `NaN` would drop the one bucket that
 * carries a histogram's total.
 */
function exposed(text: string): number {
  const trimmed = text.trim();

  if (trimmed === '+Inf' || trimmed === 'Inf') {
    return Number.POSITIVE_INFINITY;
  }
  if (trimmed === '-Inf') {
    return Number.NEGATIVE_INFINITY;
  }

  return Number(trimmed);
}

/**
 * The Prometheus text exposition of one instance, as its series. `extra` is stamped on every sample
 * — the instance a scrape came from, which is the label the exposition itself cannot carry: a
 * counter is per instance (`obs.metrics`), so which instance reported a value has to survive the
 * merge of the five scrapes this experiment reads.
 */
export function parseExposition(
  text: string,
  extra: Readonly<Record<string, string>> = {},
): MetricSample[] {
  const samples: MetricSample[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const match = SERIES.exec(trimmed)?.groups;
    if (match?.['name'] === undefined || match['value'] === undefined) {
      continue;
    }

    const value = exposed(match['value'].split(' ')[0] ?? '');
    if (Number.isNaN(value)) {
      continue;
    }

    const labels: Record<string, string> = { ...extra };
    for (const label of (match['labels'] ?? '').matchAll(LABEL)) {
      const name = label.groups?.['name'];
      const labelValue = label.groups?.['value'];
      if (name !== undefined && labelValue !== undefined) {
        labels[name] = labelValue;
      }
    }

    samples.push({ name: match['name'], labels, value });
  }

  return samples;
}

/**
 * What each series counted between two scrapes. Every counter in the report is a difference and
 * never a total: an instance has been counting since it started, so the warm-up and the wallets
 * opened before the clock started would otherwise sit inside the numbers the measured window is
 * supposed to describe.
 *
 * A series only the later scrape reported counts from zero — it is work the window introduced — and
 * one only the earlier scrape reported is dropped, because a counter that stopped being exported
 * says nothing about the window and a negative difference would be a lie about it.
 */
export function deltaOf(
  before: readonly MetricSample[],
  after: readonly MetricSample[],
): MetricSample[] {
  const identify = ({ name, labels }: MetricSample): string =>
    `${name}|${Object.entries(labels)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([label, value]) => `${label}=${value}`)
      .join(',')}`;

  const earlier = new Map(before.map((sample) => [identify(sample), sample.value]));

  return after.map((sample) => ({
    ...sample,
    value: sample.value - (earlier.get(identify(sample)) ?? 0),
  }));
}

/** The samples of one metric whose labels include every label asked for. */
export function seriesOf(
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): MetricSample[] {
  return samples.filter(
    (sample) =>
      sample.name === name &&
      Object.entries(labels).every(([label, value]) => sample.labels[label] === value),
  );
}

/**
 * A counter across the instances that reported it. Counters are per instance and the aggregation is
 * the scraper's job (`obs.metrics`); in this experiment the scraper is this function. A series
 * nothing reported reads as zero, as an unseen counter does in Prometheus.
 */
export function sumOf(
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number {
  return seriesOf(samples, name, labels).reduce((sum, sample) => sum + sample.value, 0);
}

/**
 * A gauge across the instances that reported it. A gauge is a level every instance reads from the
 * same database (`outbox.lag-metrics`), so the backlog is the highest reading and never the sum:
 * adding them would multiply one outbox by the number of instances watching it. `null` when no
 * instance reported the metric at all, which is a scrape that failed rather than a backlog of zero.
 */
export function maxOf(
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number | null {
  const series = seriesOf(samples, name, labels);

  return series.length === 0 ? null : Math.max(...series.map(({ value }) => value));
}

/**
 * The quantile of a histogram, read the way Prometheus reads one: the bucket the rank falls in,
 * interpolated linearly between its bounds, and the last finite bound when the rank falls in
 * `+Inf`. The buckets are summed across instances first, so this is the quantile of the whole stack
 * and not of whichever instance was scraped.
 *
 * It is the second source the report cross-checks its client-measured percentiles against: the
 * generator measures a round trip and `wager_processing_duration_seconds` measures what the use
 * case took, so a large disagreement between them is itself a finding.
 */
export function histogramQuantile(
  samples: readonly MetricSample[],
  name: string,
  labels: Readonly<Record<string, string>>,
  q: number,
): number | null {
  const cumulative = new Map<number, number>();

  for (const sample of seriesOf(samples, `${name}_bucket`, labels)) {
    const le = exposed(sample.labels['le'] ?? '');
    if (Number.isNaN(le)) {
      continue;
    }
    cumulative.set(le, (cumulative.get(le) ?? 0) + sample.value);
  }

  const bounds = [...cumulative.keys()].sort((left, right) => left - right);
  const total = bounds.length === 0 ? 0 : (cumulative.get(bounds[bounds.length - 1] ?? 0) ?? 0);
  if (total === 0) {
    return null;
  }

  const rank = q * total;
  let previousBound = 0;
  let previousCount = 0;

  for (const bound of bounds) {
    const count = cumulative.get(bound) ?? 0;

    if (count >= rank) {
      if (!Number.isFinite(bound)) {
        // Prometheus' own rule: a quantile in the `+Inf` bucket reads as the last finite bound.
        return previousBound;
      }
      if (count === previousCount) {
        return bound;
      }

      return (
        previousBound + ((bound - previousBound) * (rank - previousCount)) / (count - previousCount)
      );
    }

    previousBound = Number.isFinite(bound) ? bound : previousBound;
    previousCount = count;
  }

  return previousBound;
}
