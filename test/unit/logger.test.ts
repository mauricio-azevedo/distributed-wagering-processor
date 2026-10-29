import { describe, expect, test } from 'bun:test';

import { jsonLinesLogger } from '../../src/infrastructure/observability/logger';
import { NestJsonLogger } from '../../src/infrastructure/observability/nest-logger';
import {
  currentLogContext,
  withLogContext,
} from '../../src/infrastructure/observability/log-context';

/** A sink that keeps the lines, which is what a record is asserted on (OBS-001, OBS-002). */
function capture(): { readonly lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];

  return { lines, write: (line: string) => void lines.push(line) };
}

type ParsedLine = Readonly<Record<string, unknown>>;

function parsed(line: string): ParsedLine {
  return JSON.parse(line.trimEnd()) as ParsedLine;
}

/** One field of a line, as a string, which is what every identity field of a record is. */
function field(line: string | undefined, name: string): string {
  return String(parsed(line ?? '')[name]);
}

describe('jsonLinesLogger', () => {
  test('writes one JSON line per record, carrying the level, the component and the event', () => {
    const sink = capture();

    jsonLinesLogger('wagering', sink).info('wager.transaction.recorded', { transactionId: 'tx-1' });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.endsWith('\n')).toBe(true);
    expect(parsed(sink.lines[0] ?? '')).toMatchObject({
      level: 'info',
      component: 'wagering',
      event: 'wager.transaction.recorded',
      transactionId: 'tx-1',
    });
  });

  test('stamps every line with a time an operator can order lines by', () => {
    const sink = capture();

    jsonLinesLogger('wagering', sink).error('wager.message.not-applied', {});

    const time = field(sink.lines[0], 'time');

    expect(new Date(time).toISOString()).toBe(time);
  });

  test('adds the identity fields of the ambient context to every line (OBS-005)', () => {
    const sink = capture();
    const logger = jsonLinesLogger('wager-transactions-consumer', sink);

    withLogContext({ correlationId: 'corr-1', messageId: 'msg-1' }, () => {
      logger.info('wager.message.applied', { transactionId: 'tx-1' });
      logger.error('wager.message.not-acknowledged', {});
    });

    for (const line of sink.lines) {
      expect(parsed(line)).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1' });
    }
  });

  test('lets a caller that knows the correlation id itself override the ambient one', () => {
    const sink = capture();
    const logger = jsonLinesLogger('outbox-publisher', sink);

    withLogContext({ correlationId: 'corr-1' }, () => {
      logger.info('outbox.published', { correlationId: 'corr-of-the-event' });
    });

    expect(field(sink.lines[0], 'correlationId')).toBe('corr-of-the-event');
  });

  test('leaves an unknown identity field out instead of writing it as null', () => {
    const sink = capture();

    jsonLinesLogger('wagering', sink).info('wager.transaction.recorded', { transactionId: 'tx-1' });

    expect(Object.keys(parsed(sink.lines[0] ?? ''))).not.toContain('messageId');
  });

  describe('redaction (OBS-002)', () => {
    test('replaces a value that is shaped like an amount, whatever it is called', () => {
      const sink = capture();

      jsonLinesLogger('wagering', sink).info('wager.transaction.recorded', {
        transactionId: 'tx-1',
        note: '33.77',
      });

      expect(field(sink.lines[0], 'note')).toBe('[redacted]');
      expect(sink.lines[0]).not.toContain('33.77');
    });

    test('replaces a value held under a name that means money or a payload', () => {
      const sink = capture();

      jsonLinesLogger('wagering', sink).error('wager.message.not-applied', {
        balanceAfter: 'thirty-three',
        body: '{"money":{"amount":"33.77"}}',
      });

      expect(field(sink.lines[0], 'balanceAfter')).toBe('[redacted]');
      expect(field(sink.lines[0], 'body')).toBe('[redacted]');
    });

    test('leaves a count, a flag and an identifier alone', () => {
      const sink = capture();

      jsonLinesLogger('wagering', sink).info('wager.pending-reference.attempted', {
        attempts: 3,
        idempotentReplay: false,
        transactionId: '01a17cb1-f5c0-7588-9a61-47a9444c049e',
      });

      expect(parsed(sink.lines[0] ?? '')).toMatchObject({
        attempts: 3,
        idempotentReplay: false,
        transactionId: '01a17cb1-f5c0-7588-9a61-47a9444c049e',
      });
    });

    test('keeps the difference of the one record the contract excepts', () => {
      const sink = capture();

      jsonLinesLogger('reconciliation', sink).divergence('recon.balance-diverged', {
        walletId: 'w-1',
        difference: '-33.77',
        checkedEntries: 4,
      });

      expect(parsed(sink.lines[0] ?? '')).toMatchObject({
        level: 'error',
        walletId: 'w-1',
        difference: '-33.77',
        checkedEntries: 4,
      });
    });
  });
});

describe('withLogContext', () => {
  test('answers an empty context outside any request or message', () => {
    expect(currentLogContext()).toEqual({});
  });

  test('keeps one unit of work from reading another one’s identity', async () => {
    const seen: (string | undefined)[] = [];

    await Promise.all([
      withLogContext({ correlationId: 'corr-1' }, async () => {
        await Bun.sleep(5);
        seen.push(currentLogContext().correlationId);
      }),
      withLogContext({ correlationId: 'corr-2' }, () => {
        seen.push(currentLogContext().correlationId);

        return Promise.resolve();
      }),
    ]);

    expect(seen.toSorted()).toEqual(['corr-1', 'corr-2']);
  });

  test('returns what the work returned, so a caller can wrap a handler in it', async () => {
    expect(await withLogContext({ correlationId: 'corr-1' }, () => Promise.resolve(7))).toBe(7);
  });
});

/**
 * `obs.structured-logs` holds for the whole process and not only for the lines the service writes:
 * the framework's own output goes through the same port, so every line of a container running this
 * service parses as JSON (OBS-001).
 */
describe('NestJsonLogger', () => {
  test('writes the framework\u2019s lines through the port, under the context it was given', () => {
    const sink = capture();
    const nest = new NestJsonLogger((component) => jsonLinesLogger(component, sink));

    nest.log('Nest application successfully started', 'NestApplication');
    nest.warn(new Error('a dependency answered slowly'), 'InstanceLoader');

    expect(parsed(sink.lines[0] ?? '')).toMatchObject({
      level: 'info',
      component: 'NestApplication',
      event: 'nest.message',
      message: 'Nest application successfully started',
    });
    // A warning is an error: nothing an operator does differs, and a level nobody filters on only
    // makes the vocabulary bigger.
    expect(parsed(sink.lines[1] ?? '')).toMatchObject({
      level: 'error',
      component: 'InstanceLoader',
      message: 'Error: a dependency answered slowly',
    });
  });

  test('names the framework itself when no context came with the line', () => {
    const sink = capture();

    new NestJsonLogger((component) => jsonLinesLogger(component, sink)).error('shutting down');

    expect(field(sink.lines[0], 'component')).toBe('nest');
  });
});
