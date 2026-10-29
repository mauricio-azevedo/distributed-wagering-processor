import { describe, expect, test } from 'bun:test';

import {
  AttemptLog,
  classify,
  deltaOf,
  histogramQuantile,
  maxOf,
  parseExposition,
  percentile,
  perSecond,
  sumOf,
  summarize,
} from '../load/measure';

/**
 * The arithmetic of the load experiment (OPS-008), tested apart from the stack it measures. The
 * scenario itself is a run against Docker Compose and cannot assert its own numbers — a throughput
 * is whatever the machine did — so what has to be proven here is that the numbers reported mean
 * what [docs/load-experiment.md](../../docs/load-experiment.md) says they mean: which attempts
 * count as completed work, which count as errors and under what denominator, where a percentile
 * falls, and how a counter spread over five instances is read back from their expositions.
 *
 * It is a unit suite because every one of those is a pure function of recorded samples: a defect in
 * the accounting would otherwise be invisible, since a report nobody can recompute reads exactly
 * like a correct one.
 */
describe('load-measure-percentiles', () => {
  /**
   * Nearest-rank, the definition the report states: the sample at `ceil(q * n)`, so a reported
   * percentile is always a measurement that happened and never an interpolation between two.
   */
  const hundred = Array.from({ length: 100 }, (_unused, index) => index + 1);

  test('a percentile is the sample at the nearest rank', () => {
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.95)).toBe(95);
    expect(percentile(hundred, 0.99)).toBe(99);
    expect(percentile(hundred, 1)).toBe(100);
  });

  test('samples arrive in any order and the rank is taken over the sorted set', () => {
    expect(percentile([9, 1, 7, 3, 5], 0.5)).toBe(5);
    expect(percentile([9, 1, 7, 3, 5], 0.99)).toBe(9);
  });

  test('a single sample is every percentile of itself', () => {
    expect(summarize([42])).toEqual({
      count: 1,
      min: 42,
      p50: 42,
      p95: 42,
      p99: 42,
      max: 42,
      mean: 42,
    });
  });

  /** Nothing measured is reported as `null`, never as a zero that would read as a fast answer. */
  test('an empty sample set has no percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(summarize([])).toBeNull();
  });

  test('a throughput is a count over the window it was counted in', () => {
    expect(perSecond(600, { from: 1_000, to: 31_000 })).toBe(20);
    expect(perSecond(0, { from: 1_000, to: 31_000 })).toBe(0);
    expect(perSecond(5, { from: 1_000, to: 1_000 })).toBe(0);
  });
});

/**
 * `api.status-classes`: what the service answered decides what the attempt was. The split the
 * report rests on is here — a refusal the wallet decided (`422`, `409`) is the service working, and
 * only a transient refusal or a failure is an infrastructure error.
 */
describe('load-measure-classification', () => {
  test('an applied operation is completed work and a replay of it is not', () => {
    expect(classify({ status: 200, recordedStatus: 'PROCESSED', idempotentReplay: false })).toBe(
      'completed',
    );
    expect(classify({ status: 200, recordedStatus: 'PROCESSED', idempotentReplay: true })).toBe(
      'replayed',
    );
    expect(classify({ status: 201 })).toBe('completed');
  });

  test('a rejection the service recorded is business, and so is a conflict with stored state', () => {
    expect(classify({ status: 422, recordedStatus: 'REJECTED' })).toBe('rejected');
    expect(classify({ status: 409 })).toBe('conflict');
  });

  /** A replay of a persisted rejection is still a replay: the outcome was recorded once. */
  test('a replayed rejection counts as a replay and not as a second rejection', () => {
    expect(classify({ status: 422, recordedStatus: 'REJECTED', idempotentReplay: true })).toBe(
      'replayed',
    );
  });

  test('a parked transaction is work in progress, not an outcome', () => {
    expect(classify({ status: 202, recordedStatus: 'PENDING_REFERENCE' })).toBe('parked');
  });

  test('a transient refusal and a failure are infrastructure, and are told apart', () => {
    expect(classify({ status: 503 })).toBe('transient');
    expect(classify({ status: 500 })).toBe('failed');
    expect(classify({ status: 502 })).toBe('failed');
  });

  /**
   * A `400`, `401` or `404` under this scenario is a defect in the generator and not a measurement
   * of the service, so it has a category of its own: counted, reported, and never folded into
   * either the business or the infrastructure number.
   */
  test('a request the service refused to read is a generator defect of its own', () => {
    expect(classify({ status: 400 })).toBe('invalid');
    expect(classify({ status: 404 })).toBe('invalid');
  });
});

describe('load-measure-tally', () => {
  const log = new AttemptLog();
  const at = (offset: number): number => 10_000 + offset;

  log.record({ at: at(0), latencyMs: 5, category: 'completed' });
  log.record({ at: at(1_000), latencyMs: 15, category: 'completed' });
  log.record({ at: at(2_000), latencyMs: 25, category: 'replayed' });
  log.record({ at: at(3_000), latencyMs: 35, category: 'rejected' });
  log.record({ at: at(4_000), latencyMs: 45, category: 'conflict' });
  log.record({ at: at(5_000), latencyMs: 55, category: 'transient' });
  log.record({ at: at(6_000), latencyMs: 65, category: 'failed' });
  log.record({ at: at(7_000), latencyMs: 75, category: 'transport' });

  test('completed work, replays, business refusals and infrastructure errors are separate', () => {
    const tally = log.tally();

    expect({
      attempts: tally.attempts,
      completed: tally.completed,
      replays: tally.replays,
      businessRejections: tally.businessRejections,
      infrastructureErrors: tally.infrastructureErrors,
    }).toEqual({
      attempts: 8,
      completed: 2,
      replays: 1,
      businessRejections: 2,
      infrastructureErrors: 3,
    });
  });

  /** The denominator the report states: every attempt, business refusals included. */
  test('the error rate is infrastructure errors over every attempt', () => {
    expect(log.tally().errorRate).toBe(3 / 8);
    expect(new AttemptLog().tally().errorRate).toBe(0);
  });

  test('every category is reported, including the ones nothing fell into', () => {
    expect(log.tally().byCategory).toEqual({
      completed: 2,
      replayed: 1,
      rejected: 1,
      conflict: 1,
      parked: 0,
      transient: 1,
      failed: 1,
      invalid: 0,
      transport: 1,
    });
  });

  /**
   * The warm-up is excluded by the window and not by a separate counter, so the attempts a
   * percentile is taken over are the same attempts the throughput counted.
   */
  test('a window keeps the attempts that started inside it and nothing else', () => {
    const steady = log.within({ from: at(2_000), to: at(5_000) });

    expect(steady.latencies()).toEqual([25, 35, 45]);
    expect(steady.tally().attempts).toBe(3);
  });
});

/**
 * `obs.metrics`: counters are per instance and the aggregation across instances is the scraper's
 * job, which in this experiment is this code. Reading five expositions back is therefore part of
 * the measurement, not a convenience.
 */
describe('load-measure-exposition', () => {
  const exposition = `# HELP wager_lock_conflicts_total Financial operations that gave up waiting.
# TYPE wager_lock_conflicts_total counter
wager_lock_conflicts_total 7
# TYPE wager_transactions_total counter
wager_transactions_total{kind="BET",status="PROCESSED"} 120
wager_transactions_total{kind="BET",status="REJECTED"} 3
# TYPE wager_outbox_pending gauge
wager_outbox_pending 41
wager_outbox_lag_seconds 2.5
`;

  test('a scrape is read as its series, labels included', () => {
    const samples = parseExposition(exposition);

    expect(samples).toContainEqual({
      name: 'wager_lock_conflicts_total',
      labels: {},
      value: 7,
    });
    expect(samples).toContainEqual({
      name: 'wager_transactions_total',
      labels: { kind: 'BET', status: 'PROCESSED' },
      value: 120,
    });
    expect(samples.some(({ name }) => name.startsWith('#'))).toBe(false);
  });

  test('a counter is summed across the instances that reported it', () => {
    const instances = [
      ...parseExposition(exposition, { instance: 'api-1' }),
      ...parseExposition(exposition, { instance: 'api-2' }),
    ];

    expect(sumOf(instances, 'wager_lock_conflicts_total')).toBe(14);
    expect(sumOf(instances, 'wager_lock_conflicts_total', { instance: 'api-2' })).toBe(7);
    expect(sumOf(instances, 'wager_transactions_total', { status: 'REJECTED' })).toBe(6);
  });

  /**
   * A gauge is a level every instance reads from the same database, so the backlog is the highest
   * reading and never their sum: adding them would multiply one outbox by the instances watching it.
   */
  test('a gauge is the highest level reported, not the sum of the readings', () => {
    const instances = [
      ...parseExposition(exposition, { instance: 'api-1' }),
      ...parseExposition('wager_outbox_pending 58\n', { instance: 'api-2' }),
    ];

    expect(maxOf(instances, 'wager_outbox_pending')).toBe(58);
    expect(maxOf(instances, 'wager_outbox_lag_seconds')).toBe(2.5);
    expect(maxOf(instances, 'wager_outbox_absent')).toBeNull();
  });

  test('a series nothing reported reads as zero, as an unseen counter does in Prometheus', () => {
    expect(sumOf(parseExposition(exposition), 'wager_dlq_messages_total')).toBe(0);
  });

  /**
   * Every counter in the report is a difference between two scrapes, not a total: an instance has
   * been counting since it started, so the warm-up and the wallet pool would otherwise be inside
   * the numbers the measured window is supposed to describe.
   */
  test('a counter is the difference between the two scrapes of the window', () => {
    const before = parseExposition(exposition, { instance: 'api-1' });
    const after = parseExposition(
      `wager_lock_conflicts_total 19
wager_transactions_total{kind="BET",status="PROCESSED"} 300
wager_transactions_total{kind="WIN",status="PROCESSED"} 12
`,
      { instance: 'api-1' },
    );
    const delta = deltaOf(before, after);

    expect(sumOf(delta, 'wager_lock_conflicts_total')).toBe(12);
    expect(sumOf(delta, 'wager_transactions_total', { kind: 'BET' })).toBe(180);
    // A series the window itself introduced counts from zero, not from nothing.
    expect(sumOf(delta, 'wager_transactions_total', { kind: 'WIN' })).toBe(12);
    // A series that stopped being reported is dropped rather than counted as a decrease.
    expect(sumOf(delta, 'wager_outbox_pending')).toBe(0);
  });
});

/**
 * The service's own histogram, read back the way Prometheus would read it. It is the second source
 * the report cross-checks the client-measured percentiles against: the generator measures a round
 * trip and this measures what the use case took, so the two disagreeing by much is itself a
 * finding.
 */
describe('load-measure-histogram', () => {
  const buckets = `# TYPE wager_processing_duration_seconds histogram
wager_processing_duration_seconds_bucket{entrypoint="http",le="0.005"} 0
wager_processing_duration_seconds_bucket{entrypoint="http",le="0.01"} 50
wager_processing_duration_seconds_bucket{entrypoint="http",le="0.025"} 90
wager_processing_duration_seconds_bucket{entrypoint="http",le="0.05"} 100
wager_processing_duration_seconds_bucket{entrypoint="http",le="+Inf"} 100
wager_processing_duration_seconds_bucket{entrypoint="queue",le="0.005"} 0
wager_processing_duration_seconds_bucket{entrypoint="queue",le="+Inf"} 10
`;
  const samples = parseExposition(buckets);
  const quantile = (q: number, entrypoint = 'http'): number | null =>
    histogramQuantile(samples, 'wager_processing_duration_seconds', { entrypoint }, q);

  test('a quantile is interpolated inside the bucket it falls in', () => {
    // 50 of 100 observations are at or below 10ms, so the median is the top of that bucket.
    expect(quantile(0.5)).toBeCloseTo(0.01, 6);
    // The 90th is the top of the 25ms bucket, which holds observations 51 to 90.
    expect(quantile(0.9)).toBeCloseTo(0.025, 6);
    // The 95th falls halfway through the 25ms-to-50ms bucket, which holds observations 91 to 100.
    expect(quantile(0.95)).toBeCloseTo(0.0375, 6);
  });

  /** Prometheus' own rule: a quantile in the `+Inf` bucket reads as the last finite bound. */
  test('a quantile past the last finite bucket reads as that bucket', () => {
    expect(
      histogramQuantile(
        parseExposition(
          'x_bucket{le="0.005"} 1\nx_bucket{le="0.01"} 1\nx_bucket{le="+Inf"} 10\n',
          {},
        ),
        'x',
        {},
        0.99,
      ),
    ).toBe(0.01);
  });

  test('a histogram nothing observed has no quantile', () => {
    expect(quantile(0.5, 'absent')).toBeNull();
    expect(
      histogramQuantile(parseExposition('x_bucket{le="+Inf"} 0\n', {}), 'x', {}, 0.5),
    ).toBeNull();
  });
});
