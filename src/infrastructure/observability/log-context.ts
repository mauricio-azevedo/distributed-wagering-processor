import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The identity an entry point binds for the whole of one unit of work, so that every line written
 * while handling it carries it without being handed it (`obs.correlation-propagation`, ADR 0012).
 *
 * Only the two fields an entry point knows and a use case does not are here. A transaction id, a
 * wallet id or a provider id is named by whoever recorded the outcome, because it is a fact of the
 * operation rather than of the delivery that carried it.
 */
export interface LogContext {
  /** `api.correlation-header`, `msg.correlation`: the id of the request or the message. */
  readonly correlationId?: string;
  /** `msg.inbox-identity`: the producer-assigned id, on the queue entry point alone. */
  readonly messageId?: string;
}

/**
 * `AsyncLocalStorage` is what makes the binding a property of the unit of work rather than of the
 * process: two requests and two messages are in flight at once in one instance, and each reads the
 * context its own entry point bound, through every `await` in between.
 */
const storage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `work` with `context` bound, and answers whatever it answered. It is written over the return
 * value rather than over a promise, so the two callers it has are both served: a consumer awaits
 * the delivery it wraps, and an HTTP middleware hands control to the next handler and returns
 * nothing — binding has to survive into both.
 */
export function withLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run(context, work);
}

/**
 * The context of the unit of work in flight, empty outside one: a probe, a migration or a sweep
 * that nothing requested writes lines with the identity its caller named and no more.
 */
export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
