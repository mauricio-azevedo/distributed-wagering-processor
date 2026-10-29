import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * `ops.single-image-roles`: which composition of the one image this process runs. `api` serves the
 * HTTP surface and claims no queue or database work; `worker` runs the queue consumer, the outbox
 * publisher and the pending-reference scheduler and serves only the health routes; `all` runs both,
 * which is the shape of a local run and of nothing else.
 *
 * `api` is the default because an unasked-for role is the costly one: a process that was told
 * nothing and started consuming would compete for financial work no deployment meant to give it,
 * whereas one that only serves traffic adds nothing to the claims already in flight.
 */
export const APP_ROLES = ['api', 'worker', 'all'] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** Whether this role runs the three loops; `ops.single-image-roles` is this line and `controllersOf`. */
export function runsWorkers(role: AppRole): boolean {
  return role === 'worker' || role === 'all';
}

/** What the service reads; the migrator credentials stay out so a running instance never holds them. */
const serviceSchema = z.object({
  APP_ROLE: z.enum(APP_ROLES).default('api'),
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
   * What the three queue names of `msg.queues` are addressed under. Empty by default, so a
   * deployment that says nothing addresses exactly the names the transport contract fixes.
   *
   * It is a setting because the names are the contract and the namespace is the deployment's:
   * several environments of this service can share one broker account, and in this repository the
   * suites drive a trio of their own while the Compose stack holds the contract names
   * (`ops.suite-isolation`). The pattern is what SQS accepts in a queue name, bounded so that the
   * longest name under it stays inside the eighty characters SQS allows.
   */
  SQS_QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/, 'must be empty or alphanumeric with - and _')
    .max(32)
    .default(''),
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
  /**
   * Long polling: how long one receive waits for a message before answering empty. The SQS
   * maximum, 20 seconds, is the default because an idle consumer should cost one request every
   * twenty seconds rather than a spin; a suite that drives `poll` itself sets it low so an empty
   * queue answers at once.
   */
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  /**
   * How long a received message stays invisible to other consumers, which is the time this one has
   * to commit it (`msg.ack-after-commit`). It bounds how long a redelivery takes after a consumer
   * died mid-message, so it is a deployment setting: long enough to cover a financial transaction,
   * short enough that a crash does not park the message.
   */
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(43200).default(30),
  /**
   * `msg.transient-backoff`: the schedule a transiently failed message comes back on, as the first
   * delay and the ceiling the doubling stops at. They are a deployment's trade between how soon a
   * retry happens and how much load a dependency that is still down takes, and neither changes what
   * is guaranteed: the queue's redrive policy, not this backoff, is what ends the sequence.
   *
   * Five minutes is the ceiling the outbox publisher already retries under (ADR 0005), so an
   * operator reads one number for how late the service can be about work it is holding. The two are
   * validated independently and the backoff clamps the base to the ceiling, so a deployment that
   * sets a base above it gets the ceiling rather than a refusal to start.
   */
  SQS_RETRY_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(0).max(43200).default(2),
  SQS_RETRY_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(0).max(43200).default(300),
  /**
   * `ops.graceful-shutdown`: how long the drain started by `SIGTERM` may take before the process
   * exits regardless. It is the deployment's trade between finishing work in hand and freeing the
   * slot, and it decides nothing about correctness: work the drain did not finish is work no
   * transaction committed, so it is where a redelivery or the next claim finds it.
   *
   * Fifteen seconds is below the thirty a Kubernetes pod is given by default and above the longest
   * a financial operation under the default lock ceiling can take, so the common shutdown finishes
   * inside it. A deployment whose container grace period is shorter sets this one shorter too,
   * because the process has to be the one that decides it is done, not `SIGKILL`.
   */
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().min(1).default(15_000),
  /**
   * `ref.scheduler`: how long a scheduler waits after a sweep that found nothing due, which is the
   * upper bound on how late a parked transaction is picked up once it becomes due. Like the outbox
   * poll interval it is latency against idle load on PostgreSQL and changes no outcome: what is due
   * is claimed by the next sweep, of this instance or of any other.
   */
  PENDING_REFERENCE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1).default(1000),
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
