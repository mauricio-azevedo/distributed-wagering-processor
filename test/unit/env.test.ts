import { describe, expect, test } from 'bun:test';

import { APP_ROLES, loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';

const complete = {
  DATABASE_URL: 'postgres://wagering_app:secret@localhost:5433/wagering',
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://localhost:4566',
};

/** Every default the service runs with when the deployment names none. */
const DEFAULTS = {
  APP_ROLE: 'api' as const,
  HTTP_PORT: 3000,
  SHUTDOWN_GRACE_PERIOD_MS: 15_000,
  PENDING_REFERENCE_SWEEP_INTERVAL_MS: 1000,
  LOCK_TIMEOUT_MS: 3000,
  OUTBOX_BATCH_SIZE: 50,
  OUTBOX_PUBLISH_TIMEOUT_MS: 5000,
  OUTBOX_POLL_INTERVAL_MS: 1000,
  SQS_WAIT_TIME_SECONDS: 20,
  SQS_VISIBILITY_TIMEOUT_SECONDS: 30,
  SQS_RETRY_BACKOFF_BASE_SECONDS: 2,
  SQS_RETRY_BACKOFF_MAX_SECONDS: 300,
  SQS_QUEUE_PREFIX: '',
};

describe('environment-schema', () => {
  test('a complete environment parses, with the port defaulted and unrelated variables dropped', () => {
    expect(loadEnv({ ...complete, PATH: '/usr/bin' })).toEqual({ ...complete, ...DEFAULTS });
  });

  test('the SQS endpoint is optional, so the SDK can resolve the regional endpoint', () => {
    const withoutEndpoint = {
      DATABASE_URL: complete.DATABASE_URL,
      AWS_REGION: complete.AWS_REGION,
    };

    expect(loadEnv(withoutEndpoint)).toEqual({ ...withoutEndpoint, ...DEFAULTS });
  });

  test('a missing variable is refused by name', () => {
    expect(() => loadEnv({ ...complete, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  test('a non-numeric port is refused by name', () => {
    expect(() => loadEnv({ ...complete, HTTP_PORT: 'eighty' })).toThrow(/HTTP_PORT/);
  });

  test('a database URL with another scheme is refused by name', () => {
    expect(() => loadEnv({ ...complete, DATABASE_URL: 'mysql://localhost/wagering' })).toThrow(
      /DATABASE_URL/,
    );
  });

  test('the publisher knobs are read from the environment, and refused by name', () => {
    expect(
      loadEnv({
        ...complete,
        OUTBOX_BATCH_SIZE: '10',
        OUTBOX_PUBLISH_TIMEOUT_MS: '2500',
        OUTBOX_POLL_INTERVAL_MS: '200',
      }),
    ).toEqual({
      ...complete,
      ...DEFAULTS,
      OUTBOX_BATCH_SIZE: 10,
      OUTBOX_PUBLISH_TIMEOUT_MS: 2500,
      OUTBOX_POLL_INTERVAL_MS: 200,
    });
    expect(() => loadEnv({ ...complete, OUTBOX_BATCH_SIZE: '0' })).toThrow(/OUTBOX_BATCH_SIZE/);
    expect(() => loadEnv({ ...complete, OUTBOX_POLL_INTERVAL_MS: 'often' })).toThrow(
      /OUTBOX_POLL_INTERVAL_MS/,
    );
  });

  test('the consumer backoff is read from the environment, and refused by name', () => {
    expect(
      loadEnv({
        ...complete,
        SQS_RETRY_BACKOFF_BASE_SECONDS: '1',
        SQS_RETRY_BACKOFF_MAX_SECONDS: '4',
      }),
    ).toEqual({
      ...complete,
      ...DEFAULTS,
      SQS_RETRY_BACKOFF_BASE_SECONDS: 1,
      SQS_RETRY_BACKOFF_MAX_SECONDS: 4,
    });
    expect(() => loadEnv({ ...complete, SQS_RETRY_BACKOFF_BASE_SECONDS: 'soon' })).toThrow(
      /SQS_RETRY_BACKOFF_BASE_SECONDS/,
    );
    expect(() => loadEnv({ ...complete, SQS_RETRY_BACKOFF_MAX_SECONDS: '43201' })).toThrow(
      /SQS_RETRY_BACKOFF_MAX_SECONDS/,
    );
  });

  /** `ops.single-image-roles`: the one variable that decides what a process of this image runs. */
  test('each role is accepted and anything else is refused by name', () => {
    for (const role of APP_ROLES) {
      expect(loadEnv({ ...complete, APP_ROLE: role })).toEqual({
        ...complete,
        ...DEFAULTS,
        APP_ROLE: role,
      });
    }

    expect(() => loadEnv({ ...complete, APP_ROLE: 'publisher' })).toThrow(/APP_ROLE/);
    expect(() => loadEnv({ ...complete, APP_ROLE: '' })).toThrow(/APP_ROLE/);
  });

  test('the shutdown grace period and the sweep interval are read, and refused by name', () => {
    expect(
      loadEnv({
        ...complete,
        SHUTDOWN_GRACE_PERIOD_MS: '2000',
        PENDING_REFERENCE_SWEEP_INTERVAL_MS: '250',
      }),
    ).toEqual({
      ...complete,
      ...DEFAULTS,
      SHUTDOWN_GRACE_PERIOD_MS: 2000,
      PENDING_REFERENCE_SWEEP_INTERVAL_MS: 250,
    });
    expect(() => loadEnv({ ...complete, SHUTDOWN_GRACE_PERIOD_MS: 'a while' })).toThrow(
      /SHUTDOWN_GRACE_PERIOD_MS/,
    );
    expect(() => loadEnv({ ...complete, PENDING_REFERENCE_SWEEP_INTERVAL_MS: '0' })).toThrow(
      /PENDING_REFERENCE_SWEEP_INTERVAL_MS/,
    );
  });

  /**
   * `ops.suite-isolation`: the namespace the three queue names are addressed under. The default is
   * empty, so a deployment that says nothing addresses the names the transport contract fixes, and
   * anything SQS would refuse in a queue name is refused here instead, at startup.
   */
  test('the queue prefix defaults to empty, is read, and is refused by name', () => {
    expect(loadEnv({ ...complete, SQS_QUEUE_PREFIX: 'test-' })).toEqual({
      ...complete,
      ...DEFAULTS,
      SQS_QUEUE_PREFIX: 'test-',
    });
    expect(loadEnv(complete).SQS_QUEUE_PREFIX).toBe('');

    for (const refused of ['test.', 'test/', 'a b', 'x'.repeat(33)]) {
      expect(() => loadEnv({ ...complete, SQS_QUEUE_PREFIX: refused })).toThrow(/SQS_QUEUE_PREFIX/);
    }
  });

  test('the migration step needs only the migrator URL', () => {
    const url = 'postgres://wagering_migrator:secret@localhost:5433/wagering';

    expect(loadMigrationEnv({ MIGRATION_DATABASE_URL: url })).toEqual({
      MIGRATION_DATABASE_URL: url,
    });
    expect(() => loadMigrationEnv({})).toThrow(/MIGRATION_DATABASE_URL/);
  });
});
