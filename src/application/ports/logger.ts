/**
 * The log sink of a use case, as the one way an operation reports something an operator has to
 * follow or act on. It is a port because the record belongs to the operation and not to the entry
 * point: an operation reports the same line whether it arrived over HTTP, on the queue or through a
 * scheduled sweep, and a use case names no framework (`model.framework-free-domain`).
 *
 * An event is a fixed phrase and the occurrence lives in `fields`, so the two never have to be
 * parsed apart: the structured lines of `obs.structured-logs` carry the fields as members. A
 * caller names the identity fields it knows; the ones the request or the message carries are added
 * by the adapter, which is where they are known (`obs.correlation-propagation`, ADR 0012).
 *
 * `info` is the line that says an operation happened — the one an operator follows a correlation id
 * through — and `error` is something that should not have happened. There is no level below `info`:
 * a line nobody would search for is a line this service does not write.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * The fields of the one record `obs.no-sensitive-data` excepts: a wallet whose stored balance is
 * not the one its ledger implies, or whose stored state is not money at all
 * (`recon.divergence-handling`, RECON-005).
 *
 * It is a type of its own, and a method of its own below, because the exception has to be
 * auditable: every amount this service ever writes to a log reaches it through here, so "which
 * lines may carry an amount" is answered by the type and by grep rather than by reading every call
 * site of `error`.
 */
export interface DivergenceFields {
  readonly walletId: string;
  /** `recon.report-shape`'s signed difference, the amount an operator reconciles against. */
  readonly difference?: string;
  readonly checkedEntries?: number;
  /** Why the stored state could not be rebuilt into money, when that is what happened. */
  readonly reason?: string;
}

export interface Logger {
  /** An operation that happened, as the line its identity fields make searchable. */
  info(event: string, fields: LogFields): void;

  /**
   * Something that should not have happened. Amounts and balances stay out of `fields`
   * (`obs.no-sensitive-data`), and the adapter redacts one that reaches it anyway.
   */
  error(event: string, fields: LogFields): void;

  /**
   * `obs.no-sensitive-data`'s single exception, at error level: a difference nobody can see is a
   * difference nobody can act on, so this record carries it unredacted.
   */
  divergence(event: string, fields: DivergenceFields): void;
}
