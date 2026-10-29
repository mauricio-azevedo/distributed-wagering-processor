import { describe, expect, test } from 'bun:test';

import { ServiceUnavailableError } from '../../src/application/errors';
import { transientDatabaseFailure } from '../../src/infrastructure/persistence/transient-failure';

const LIMITS = { lockTimeoutMs: 3000 };

const classify = (error: unknown): ServiceUnavailableError | null =>
  transientDatabaseFailure(error, LIMITS);

/** A driver error as PostgreSQL raises it: the SQLSTATE sits on `code`. */
const sqlState = (code: string): Error => Object.assign(new Error(`SQLSTATE ${code}`), { code });

describe('transient-failures-become-a-retryable-refusal', () => {
  test('a lock wait past the ceiling names the wallet lock and the ceiling it exceeded', () => {
    const refusal = classify(sqlState('55P03'));

    expect(refusal).toBeInstanceOf(ServiceUnavailableError);
    expect(refusal?.code).toBe('SERVICE_UNAVAILABLE');
    expect(refusal?.message).toBe('The wallet lock was not acquired within 3000 ms.');
    expect(refusal?.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('a serialization failure, a deadlock and a cancelled statement are transient', () => {
    for (const code of ['40001', '40P01', '57014']) {
      expect(classify(sqlState(code))).toBeInstanceOf(ServiceUnavailableError);
    }
  });

  test('a database that is unreachable, shutting down or out of connections is transient', () => {
    for (const code of ['08006', '08001', '57P01', '53300', 'ECONNREFUSED', 'ETIMEDOUT']) {
      expect(classify(sqlState(code))?.message).toBe(
        'The service could not reach the database to complete the operation.',
      );
    }
  });

  test('a failure the driver wrapped is classified by the cause it carries', () => {
    const wrapped = new Error('could not run the statement', { cause: sqlState('08006') });

    expect(classify(wrapped)).toBeInstanceOf(ServiceUnavailableError);
  });

  test('a constraint violation, a defect and an unclassifiable error stay what they are', () => {
    expect(classify(sqlState('23505'))).toBeNull();
    expect(classify(sqlState('23503'))).toBeNull();
    expect(classify(new Error('the use case computed a balance it should not have'))).toBeNull();
    expect(classify(null)).toBeNull();
  });

  test('the detail of a transient refusal names no amount and no balance', () => {
    for (const code of ['55P03', '08006']) {
      expect(classify(sqlState(code))?.message).not.toMatch(/\d+\.\d{2}/);
    }
  });
});
