import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** What the service reads; the migrator credentials stay out so a running instance never holds them. */
const serviceSchema = z.object({
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: postgresUrl,
  /**
   * `conc.row-lock`: how long a financial operation waits for a wallet row before the attempt
   * becomes a transient failure (ADR 0002). It is a setting because the ceiling belongs to the
   * deployment: it trades how long a caller is held for how often one is asked to retry.
   */
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(3000),
  AWS_REGION: z.string().min(1),
  /** Set for LocalStack; absent, the SDK resolves the regional endpoint. */
  SQS_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
});

const migrationSchema = z.object({
  MIGRATION_DATABASE_URL: postgresUrl,
});

export type Env = z.infer<typeof serviceSchema>;
export type MigrationEnv = z.infer<typeof migrationSchema>;

type Source = Record<string, string | undefined>;

function parse<T extends z.ZodType>(schema: T, source: Source): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Throws, naming the variable, on a missing or invalid value; callers exit before serving traffic. */
export function loadEnv(source: Source): Env {
  return parse(serviceSchema, source);
}

export function loadMigrationEnv(source: Source): MigrationEnv {
  return parse(migrationSchema, source);
}
