import { describe, expect, test } from 'bun:test';

import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';

const complete = {
  DATABASE_URL: 'postgres://wagering_app:secret@localhost:5433/wagering',
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://localhost:4566',
};

describe('config-validation', () => {
  test('a complete environment parses, with the port defaulted and unrelated variables dropped', () => {
    expect(loadEnv({ ...complete, PATH: '/usr/bin' })).toEqual({ ...complete, HTTP_PORT: 3000 });
  });

  test('the SQS endpoint is optional, so the SDK can resolve the regional endpoint', () => {
    const withoutEndpoint = {
      DATABASE_URL: complete.DATABASE_URL,
      AWS_REGION: complete.AWS_REGION,
    };

    expect(loadEnv(withoutEndpoint)).toEqual({ ...withoutEndpoint, HTTP_PORT: 3000 });
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

  test('the migration step needs only the migrator URL', () => {
    const url = 'postgres://wagering_migrator:secret@localhost:5433/wagering';

    expect(loadMigrationEnv({ MIGRATION_DATABASE_URL: url })).toEqual({
      MIGRATION_DATABASE_URL: url,
    });
    expect(() => loadMigrationEnv({})).toThrow(/MIGRATION_DATABASE_URL/);
  });
});
