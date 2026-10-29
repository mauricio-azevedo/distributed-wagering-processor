/**
 * The counters of `obs.metrics`, as a use case raises them. The names are the operational contract
 * and not a label a caller invents, so they are a union rather than a `string`: a typo is a compile
 * error, and the set a reader has to look for in a dashboard is the set this type lists.
 *
 * It is a port for the same reason the `Logger` is: the measurement belongs to the operation, so
 * one entry point cannot count what another does not. The registry behind it and the `/metrics`
 * endpoint that exposes it are infrastructure (OBS-002).
 *
 * The names here are the ones the implemented behaviour raises; the rest of `obs.metrics` arrives
 * with the behaviour that counts.
 */
export type CounterName =
  'wager_duplicates_detected_total' | 'wager_reconciliation_divergence_total';

/**
 * The labels a counted occurrence carries, which `obs.metrics` states per counter. They are a
 * closed union rather than a free record for the same reason the names are: a dashboard looks for
 * the series this type can spell and no other.
 *
 * `source` distinguishes where a duplicate was caught: `inbox` is a redelivery the inbox absorbed
 * (`msg.redelivery-safe`), `inbox-conflict` a message id reused for other content
 * (`msg.inbox-payload-conflict`). A counter with no labels is incremented without a second
 * argument.
 */
export interface CounterLabels {
  readonly source: 'inbox' | 'inbox-conflict';
}

export interface Metrics {
  /** Adds one to a counter's series. A counter never decreases and is never set to a value. */
  increment(counter: CounterName, labels?: CounterLabels): void;
}
