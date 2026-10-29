/**
 * The current time, as the only source a use case reads it from.
 *
 * Every timestamp the service persists or publishes is a value a use case decides, never one a row
 * default or a `new Date()` buried in a mapper produces: one operation's wallet, transaction,
 * ledger entry and events all carry the same moment, which is what lets a test assert the instant a
 * whole operation recorded. It is a port rather than a parameter because the moment belongs to the
 * execution, not to the request.
 */
export interface Clock {
  now(): Date;
}
