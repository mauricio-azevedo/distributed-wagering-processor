import { Logger as NestLogger } from '@nestjs/common';

import type { LogFields, Logger } from '../../application/ports/logger';

/**
 * The `Logger` port over the framework's logger, which is what the process writes through and what
 * a bootstrap replaces to silence or capture output.
 *
 * The fields are serialized as JSON beside the event, so a record is already machine-readable and
 * an operator reading a terminal still sees the event first. One line per record is the whole
 * formatting policy here; the JSON-lines envelope with the correlation and identity fields of
 * `obs.structured-logs` replaces it with OBS-001, in this one adapter.
 */
export function nestLogger(context: string): Logger {
  const nest = new NestLogger(context);

  return {
    error: (event: string, fields: LogFields) => {
      nest.error(`${event} ${JSON.stringify(fields)}`);
    },
  };
}
