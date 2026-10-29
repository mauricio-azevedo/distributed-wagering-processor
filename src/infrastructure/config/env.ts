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
  /**
   * The three knobs of the outbox publisher (ADR 0005). They are configuration and not
   * correctness: whatever they are set to, every row is published at least once and none is lost.
   *
   * `OUTBOX_BATCH_SIZE` and `OUTBOX_PUBLISH_TIMEOUT_MS` together bound how long one cycle holds a
   * database connection while it talks to the broker, which is the cost ADR 0005 accepts for a
   * protocol with no lease; `OUTBOX_POLL_INTERVAL_MS` is how long a publisher waits after a cycle
   * that found nothing, so it is the upper bound on how late an event is published when the
   * service is idle, and the floor on the load an empty outbox puts on PostgreSQL.
   */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(1000),
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
