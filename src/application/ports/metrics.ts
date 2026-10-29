/**
 * The counters of `obs.metrics`, as a use case raises them. The names are the operational contract
 * and not a label a caller invents, so they are a union rather than a `string`: a typo is a compile
 * error, and the set a reader has to look for in a dashboard is the set this type lists.
 *
 * It is a port for the same reason the `Logger` is: the measurement belongs to the operation, so
 * one entry point cannot count what another does not. The registry behind it and the `/metrics`
 * endpoint that exposes it are infrastructure (OBS-002).
 *
 * `wager_reconciliation_divergence_total` is the only name here because it is the only one the
 * implemented behaviour raises; the rest of `obs.metrics` arrives with the behaviour that counts.
 */
export type CounterName = 'wager_reconciliation_divergence_total';

export interface Metrics {
  /** Adds one to a counter. A counter never decreases and is never set to a value. */
  increment(counter: CounterName): void;
}
