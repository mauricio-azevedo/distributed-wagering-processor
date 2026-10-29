import type { LoggerService } from '@nestjs/common';

import type { Logger } from '../../application/ports/logger';
import { jsonLinesLogger } from './logger';

/**
 * The framework's own output through the same sink as everything else, so that
 * `obs.structured-logs` holds for the whole process and not only for the lines the service writes:
 * every line of a container running this service parses as JSON, the bootstrap and route-mapping
 * lines included (OBS-001).
 *
 * `log`, `warn` and the two diagnostic levels all become one of the two levels the port has: there
 * is nothing an operator does differently about a framework warning than about an error, and a
 * level nobody filters on is a level that only makes the vocabulary bigger. The context NestJS
 * passes — the class that wrote the line — becomes the `component` field, which is what the service
 * uses it for too.
 */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly loggerFor: (component: string) => Logger = jsonLinesLogger) {}

  log(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }

  error(message: unknown, context?: unknown): void {
    this.write('error', message, context);
  }

  warn(message: unknown, context?: unknown): void {
    this.write('error', message, context);
  }

  debug(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }

  verbose(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }

  private write(level: 'info' | 'error', message: unknown, context: unknown): void {
    const logger = this.loggerFor(typeof context === 'string' ? context : 'nest');

    logger[level]('nest.message', { message: textOf(message) });
  }
}

/** The framework's message as one field; an `Error` reaches it as its message and its name. */
function textOf(message: unknown): string {
  if (message instanceof Error) {
    return `${message.name}: ${message.message}`;
  }

  return typeof message === 'string' ? message : JSON.stringify(message);
}
