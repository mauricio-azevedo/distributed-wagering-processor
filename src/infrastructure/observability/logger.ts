import type { LogFields, Logger } from '../../application/ports/logger';
import { currentLogContext } from './log-context';

/**
 * Where a line goes. `process.stdout` is the sink of a container, which is what the service runs
 * as; a suite passes one that keeps the lines, which is how `obs.no-sensitive-data` is asserted
 * over real output rather than over a mock's arguments (OBS-002).
 */
export interface LogSink {
  write(line: string): void;
}

/** The value a redacted field is replaced with, so that a line says a field was dropped. */
const REDACTED = '[redacted]';

/**
 * A `MoneyProps` amount: digits, a point and the two decimals `money.string-serialization` fixes,
 * optionally signed (`money.signed-difference-only`). It is matched against every string a line
 * carries, so an amount is caught by its shape wherever a caller put it and whatever it called it.
 */
const AMOUNT = /^-?\d+\.\d{2}$/;

/**
 * The field names that mean money or a payload. The shape test above catches an amount that
 * reached a line; this catches a field that is meant to hold one, so a balance rendered some other
 * way — a localized string, a count of cents, a whole payload — is dropped too.
 */
const SENSITIVE = new Set([
  'amount',
  'balance',
  'balanceAfter',
  'balanceBefore',
  'body',
  'difference',
  'money',
  'observedBalance',
  'payload',
  'requestBody',
  'storedBalance',
]);

/**
 * The `Logger` port as JSON lines on a sink (`obs.structured-logs`, ADR 0012).
 *
 * One line is one record: the moment, the level, the component that wrote it, the event, the
 * identity the entry point bound and the fields the caller named, in that order, so an operator
 * reading raw output sees what happened before the detail of it and a collector parses the line
 * with no grammar of its own.
 *
 * Redaction happens here and not at the call sites, because "no log line carries an amount" is a
 * property of the output and cannot be a property of the discipline of every caller
 * (`obs.no-sensitive-data`). `divergence` is the one documented exception and the one method that
 * bypasses it.
 *
 * A field the caller did not name is absent rather than null: a line says what was known, and a
 * search for a correlation id must not match a line that merely admits it had none.
 */
export function jsonLinesLogger(component: string, sink: LogSink = process.stdout): Logger {
  const write = (level: 'info' | 'error', event: string, fields: object): void => {
    sink.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        component,
        event,
        ...currentLogContext(),
        ...fields,
      })}\n`,
    );
  };

  return {
    info: (event, fields) => {
      write('info', event, redacted(fields));
    },
    error: (event, fields) => {
      write('error', event, redacted(fields));
    },
    divergence: (event, fields) => {
      write('error', event, fields);
    },
  };
}

/**
 * The port for a caller that reports to nobody: a probe or a helper that builds a use case
 * directly. It is named and exported rather than written inline at each default, so a reader of a
 * constructor sees that the fallback writes nothing instead of having to infer it.
 */
export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
  divergence: () => undefined,
};

/** The fields as they may be written: the ones that could carry money replaced, the rest kept. */
function redacted(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) =>
      sensitive(name, value) ? [name, REDACTED] : [name, value],
    ),
  );
}

function sensitive(name: string, value: LogFields[string]): boolean {
  return SENSITIVE.has(name) || (typeof value === 'string' && AMOUNT.test(value));
}
