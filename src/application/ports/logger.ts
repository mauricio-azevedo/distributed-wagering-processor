/**
 * The log sink of a use case, as the one way an operation reports something an operator has to act
 * on. It is a port because the record belongs to the operation and not to the entry point: a
 * reconciliation divergence is logged the same whether the report was asked for over HTTP, by a
 * scheduled sweep or by a test, and a use case names no framework (`model.framework-free-domain`).
 *
 * An event is a fixed phrase and the occurrence lives in `fields`, so the two never have to be
 * parsed apart: the structured lines of `obs.structured-logs` carry the fields as members, and the
 * correlation and identity fields of a line are added by the adapter, which is where the request or
 * the message that carries them is known (`obs.correlation-propagation`).
 *
 * Only `error` exists because only `error` has a caller: `recon.divergence-handling` is the single
 * record the implemented behaviour writes. The levels the later slices need arrive with them.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Logger {
  /**
   * Something that should not have happened and that no caller can fix by retrying. Amounts and
   * balances stay out of `fields` (`obs.no-sensitive-data`); the divergence record is the one
   * documented exception, because a difference nobody can see is a difference nobody can act on.
   */
  error(event: string, fields: LogFields): void;
}
