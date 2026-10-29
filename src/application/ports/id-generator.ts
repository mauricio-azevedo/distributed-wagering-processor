/**
 * The mint of the identifiers the service assigns: wallet ids, transaction ids, ledger entry ids
 * and event ids. The implementation produces UUIDv7 for index locality; nothing orders anything by
 * one, because UUIDv7 is not monotonic across instances (ARCHITECTURE.md, section 6).
 *
 * A use case mints every id it needs before it opens its transaction, so the rows of one operation
 * are written with ids that are already fixed, and a test can hand the use case a sequence and name
 * the id of every row it wrote.
 */
export interface IdGenerator {
  next(): string;
}
