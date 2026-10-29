import type { DivergenceFields, LogFields, Logger } from '../../src/application/ports/logger';

/** One record as the port received it, before any adapter added a context field to it. */
export interface LogRecord {
  /** Which method wrote it; `divergence` is the one `obs.no-sensitive-data` excepts. */
  readonly level: 'info' | 'error' | 'divergence';
  readonly event: string;
  readonly fields: LogFields | DivergenceFields;
}

export interface RecordingLogger {
  readonly records: LogRecord[];
  readonly logger: Logger;
  /** The records of one level, which is what a suite asserting a report asks about. */
  at(level: LogRecord['level']): LogRecord[];
}

/**
 * The `Logger` port as a list of what it was asked to write, which is what a suite asserts a use
 * case reported (`obs.structured-logs`). The three methods are recorded apart, so a test can tell
 * the divergence record from every other line and assert that only it was allowed an amount.
 *
 * It is shared rather than written per suite because every use case that reports anything takes
 * this port, and a fake that drifts between suites is a fake that stops proving the same thing.
 */
export function recordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];

  return {
    records,
    at: (level) => records.filter((record) => record.level === level),
    logger: {
      info: (event, fields) => void records.push({ level: 'info', event, fields }),
      error: (event, fields) => void records.push({ level: 'error', event, fields }),
      divergence: (event, fields) => void records.push({ level: 'divergence', event, fields }),
    },
  };
}
