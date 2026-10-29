import { describe, expect, test } from 'bun:test';

import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';

/**
 * `obs.metrics`: the names and the labels an operator's dashboard looks for, as the contract and
 * [docs/openapi.yaml](../../docs/openapi.yaml) list them. A name missing from a scrape is a panel
 * that reads zero for a system that is working, so the exposition is asserted name by name
 * (OBS-003); which path raises each one is proven by the suites that drive those paths.
 */
const DOCUMENTED = [
  ['wager_transactions_total', 'counter'],
  ['wager_duplicates_detected_total', 'counter'],
  ['wager_retries_total', 'counter'],
  ['wager_dlq_messages_total', 'counter'],
  ['wager_lock_conflicts_total', 'counter'],
  ['wager_outbox_pending', 'gauge'],
  ['wager_outbox_lag_seconds', 'gauge'],
  ['wager_processing_duration_seconds', 'histogram'],
  ['wager_reconciliation_divergence_total', 'counter'],
  ['wager_pending_reference_total', 'counter'],
] as const;

describe('MetricsRegistry', () => {
  test.each(DOCUMENTED)('declares %s as a %s before anything raises it', async (name, type) => {
    const exposition = await new MetricsRegistry().expose();

    expect(exposition).toContain(`# TYPE ${name} ${type}`);
    expect(exposition).toContain(`# HELP ${name} `);
  });

  test('exposes a counted occurrence as the series its labels name', async () => {
    const metrics = new MetricsRegistry();

    metrics.increment('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { kind: 'WIN', status: 'REJECTED' });

    const exposition = await metrics.expose();
    expect(exposition).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 2');
    expect(exposition).toContain('wager_transactions_total{kind="WIN",status="REJECTED"} 1');
  });

  test('counts a labelless counter per instance and nothing else', async () => {
    const metrics = new MetricsRegistry();

    metrics.increment('wager_lock_conflicts_total');

    expect(await metrics.expose()).toContain('wager_lock_conflicts_total 1');
  });

  test('reads one series back, and reads 0 for one nothing has raised', async () => {
    const metrics = new MetricsRegistry();

    metrics.increment('wager_duplicates_detected_total', { source: 'inbox' });

    expect(await metrics.total('wager_duplicates_detected_total', { source: 'inbox' })).toBe(1);
    expect(
      await metrics.total('wager_duplicates_detected_total', { source: 'inbox-conflict' }),
    ).toBe(0);
    expect(await metrics.total('wager_dlq_messages_total')).toBe(0);
  });

  test('sets a gauge to the value it was measured at, rises and falls included', async () => {
    const metrics = new MetricsRegistry();

    metrics.set('wager_outbox_pending', 12);
    metrics.set('wager_outbox_lag_seconds', 4.5);
    metrics.set('wager_outbox_pending', 0);

    const exposition = await metrics.expose();
    expect(exposition).toContain('wager_outbox_pending 0');
    expect(exposition).toContain('wager_outbox_lag_seconds 4.5');
  });

  test('observes a processing duration as a histogram of its entrypoint', async () => {
    const metrics = new MetricsRegistry();

    metrics.observe('wager_processing_duration_seconds', { entrypoint: 'http' }, 0.02);
    metrics.observe('wager_processing_duration_seconds', { entrypoint: 'queue' }, 1.5);

    const exposition = await metrics.expose();
    expect(exposition).toContain('wager_processing_duration_seconds_count{entrypoint="http"} 1');
    expect(exposition).toContain('wager_processing_duration_seconds_sum{entrypoint="http"} 0.02');
    expect(exposition).toContain('wager_processing_duration_seconds_count{entrypoint="queue"} 1');
  });

  test('keeps two registries apart, so two applications in one process share no total', async () => {
    const one = new MetricsRegistry();
    const other = new MetricsRegistry();

    one.increment('wager_lock_conflicts_total');

    expect(await one.total('wager_lock_conflicts_total')).toBe(1);
    expect(await other.total('wager_lock_conflicts_total')).toBe(0);
  });

  test('answers the content type the Prometheus text format is scraped as', () => {
    expect(new MetricsRegistry().contentType).toContain('text/plain');
  });
});
