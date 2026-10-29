import type { TransactionKind } from '../../domain/transaction-kind';
import type { RecordedTransactionStatus } from '../../domain/wager-transaction';

/**
 * The operational measurements of `obs.metrics`, as the paths that own them raise them. The names
 * are the operational contract and not a label a caller invents, so they are keys of a type rather
 * than a `string`: a typo is a compile error, and the set a reader has to look for in a dashboard
 * is the set this module lists.
 *
 * It is a port for the same reason the `Logger` is: the measurement belongs to the operation, so
 * one entry point cannot count what another does not (`msg.same-use-case`). The registry behind it
 * and the `/metrics` endpoint that exposes it are infrastructure (OBS-003).
 *
 * The label vocabularies live here too, because a label value is the dimension a dashboard slices
 * by and therefore as much a part of the contract as the name: a path can only count an occurrence
 * as one of the cases the contract named.
 */

/** Where a duplicate was caught, which is the one thing `wager_duplicates_detected_total` says. */
export type DuplicateSource =
  /** A submission whose outcome was already recorded, replayed from the row (`idem.persistent`). */
  | 'idempotency'
  /** A redelivery the inbox absorbed (`msg.redelivery-safe`). */
  | 'inbox'
  /** A message id reused for other content (`msg.inbox-payload-conflict`). */
  | 'inbox-conflict';

/** Which backoff a retry belongs to, so one component's outage is read apart from another's. */
export type RetryComponent =
  /** A transient delivery handed back to the input queue (`msg.transient-backoff`). */
  | 'queue'
  /** A publication the broker refused, rescheduled by the capped backoff (`outbox.retry-backoff`). */
  | 'outbox'
  /** An attempt at a parked transaction, rescheduled by `ref.backoff`. */
  | 'pending-reference';

/**
 * How one attempt at a parked transaction ended (`ref.*`), which is the dimension
 * `wager_pending_reference_total` counts attempts by and the result `ReprocessPendingReference`
 * reports per claim:
 *
 * - `settled`: the reference resolved and the operation was applied under the normal rules, which
 *   records `PROCESSED` or the `REJECTED` one of those rules decides (`ref.resolution-on-arrival`).
 * - `pending`: the reference still has not resolved and the window is open, so the attempt was
 *   counted and the next one scheduled (`ref.backoff`).
 * - `expired`: the window closed with the reference still unresolved (`ref.expiry`).
 * - `retried`: a transient failure, so nothing was recorded and the attempt was rescheduled
 *   (`ref.transient-failure`).
 * - `failed`: a permanent failure, so the transaction is `FAILED` (`ref.permanent-failure`).
 */
export type PendingReferenceOutcome = 'settled' | 'pending' | 'expired' | 'retried' | 'failed';

/**
 * Which way into the service an operation came, as `wager_processing_duration_seconds` separates
 * them: a request a provider is waiting on and a message nobody is are different latencies with
 * different thresholds, and the same financial use case serves both (`msg.same-use-case`).
 *
 * The roles that drive the sweep and the publisher measure nothing yet, so they name nothing here;
 * an entrypoint arrives with the loop that owns it (#19).
 */
export type Entrypoint = 'http' | 'queue';

/**
 * Every counter, with the labels one occurrence of it carries. `undefined` is a counter with no
 * labels — a lock wait, a dead letter and a divergence are counted per instance and nothing about
 * one occurrence distinguishes its series from another's.
 */
export interface CounterLabels {
  /**
   * One recorded outcome of a transaction. A transaction that was parked and later settled is
   * counted under both statuses, because each is an outcome that was recorded
   * (`tx.transitions`); it is a count of outcomes and never of distinct transactions.
   */
  readonly wager_transactions_total: {
    readonly kind: TransactionKind;
    readonly status: RecordedTransactionStatus;
  };
  readonly wager_duplicates_detected_total: { readonly source: DuplicateSource };
  readonly wager_retries_total: { readonly component: RetryComponent };
  readonly wager_pending_reference_total: { readonly outcome: PendingReferenceOutcome };
  readonly wager_dlq_messages_total: undefined;
  readonly wager_lock_conflicts_total: undefined;
  readonly wager_reconciliation_divergence_total: undefined;
}

export type CounterName = keyof CounterLabels;

/**
 * The measurements that are a level and not a total: the backlog an operator alerts on
 * (`outbox.lag-metrics`). A gauge is read from the database on every scrape rather than written by
 * whatever happened last, so it reports the backlog of an instance whose publisher is stopped too
 * (OUTBOX-008).
 */
export type GaugeName = 'wager_outbox_pending' | 'wager_outbox_lag_seconds';

export type HistogramName = 'wager_processing_duration_seconds';

export interface HistogramLabels {
  readonly wager_processing_duration_seconds: { readonly entrypoint: Entrypoint };
}

/**
 * The labels of one counter as an argument list: none for a counter that has none, so a caller
 * neither invents a label nor passes an empty object for a counter that takes none.
 */
export type CounterLabelArguments<Name extends CounterName> = CounterLabels[Name] extends undefined
  ? []
  : [labels: CounterLabels[Name]];

export interface Metrics {
  /** Adds one to a counter's series. A counter never decreases and is never set to a value. */
  increment<Name extends CounterName>(counter: Name, ...labels: CounterLabelArguments<Name>): void;

  /** Records one measurement in a histogram's series, in seconds. */
  observe<Name extends HistogramName>(
    histogram: Name,
    labels: HistogramLabels[Name],
    seconds: number,
  ): void;

  /** Reports a level as it stands now; the next measurement replaces it. */
  set(gauge: GaugeName, value: number): void;
}
