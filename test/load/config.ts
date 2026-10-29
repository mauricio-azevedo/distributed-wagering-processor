import { z } from 'zod';

/**
 * The inputs of the load experiment (OPS-008). Every one of them has a default, and the defaults
 * are the experiment [docs/load-experiment.md](../../docs/load-experiment.md) reports: `bun run
 * test:load` with nothing set reproduces the documented run, and a run that set something is a run
 * whose report says so, because the resolved configuration is printed and carried in the report.
 *
 * It is validated the way the service validates its own environment (`ops.config-validation`): a
 * value that is not a number, or a share outside its range, is refused by name before the stack is
 * touched. A scenario that silently fell back to a default would produce numbers nobody could
 * reproduce, which is the one thing a load report cannot afford.
 */
const scenarioSchema = z
  .object({
    /** The measured window. Load keeps running until it closes; nothing is extrapolated. */
    LOAD_DURATION_MS: z.coerce.number().int().min(1_000).default(30_000),
    /**
     * Load the report throws away: connections opened, pools filled, JIT warmed, the first
     * publisher cycle done. The window below starts when it ends, and `Window` is half-open, so no
     * attempt is counted in both.
     */
    LOAD_WARMUP_MS: z.coerce.number().int().min(0).default(10_000),
    /** Concurrent HTTP submitters, and concurrent producers on the input queue. */
    LOAD_HTTP_CONCURRENCY: z.coerce.number().int().min(1).max(512).default(32),
    LOAD_QUEUE_CONCURRENCY: z.coerce.number().int().min(0).max(512).default(4),
    /**
     * The offered rate of the queue path, in messages per second across every producer. The HTTP
     * path is driven as fast as its submitters can go, because a provider waiting on an answer is
     * what that path is for; a producer is not waiting on anything, so an unbounded one would
     * simply outrun the two workers and the end-to-end latency reported would be the growth of a
     * backlog rather than what processing a message costs. The rate is therefore an input, and
     * whether the workers kept up with it is one of the findings.
     */
    LOAD_QUEUE_RATE_PER_SECOND: z.coerce.number().min(1).max(10_000).default(100),
    /**
     * The wallet pool, and how much of it is contended. `LOAD_HOT_SHARE` of the attempts are aimed
     * at `LOAD_HOT_WALLETS` of the wallets, which is what makes `wager_lock_conflicts_total` a
     * measurement rather than a zero: a pool with no hot rows would never make two operations wait
     * for the same wallet (`conc.row-lock`).
     */
    LOAD_WALLETS: z.coerce.number().int().min(1).max(10_000).default(60),
    LOAD_HOT_WALLETS: z.coerce.number().int().min(0).max(10_000).default(4),
    LOAD_HOT_SHARE: z.coerce.number().min(0).max(1).default(0.5),
    /**
     * The share of attempts that resubmit an operation already submitted, and the share of `BET`s
     * aimed above any balance. The first measures `idem.persistent` under load and the second
     * `rule.bet.insufficient-balance`: both are the service working, so the report counts them
     * apart from its errors and this is where their size is decided.
     */
    LOAD_REPLAY_RATIO: z.coerce.number().min(0).max(1).default(0.08),
    LOAD_REJECTION_RATIO: z.coerce.number().min(0).max(1).default(0.05),
    /** The mix is drawn from a seeded generator, so two runs of one command draw the same mix. */
    LOAD_SEED: z.coerce.number().int().default(20_261_029),
    /**
     * How long work already submitted is given to finish after load stops, before anything is
     * counted or reconciled. Work still pending when it expires is reported as pending and is never
     * counted as completed.
     *
     * Generous because of what the drain waits for: not the financial work, which the measured
     * window already finished, but the outbox the operations filled — the publisher moves rows at
     * its own rate (ADR 0005) and a measured minute of HTTP load leaves it minutes of publishing to
     * do. How far behind it got is one of the findings, so the timeout is set to let it finish
     * rather than to hide it.
     */
    LOAD_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).default(300_000),
    /** How often the two outbox gauges are sampled, which is what the reported lag is taken from. */
    LOAD_GAUGE_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
    /** Where the machine-readable report is written. Printed to stdout when unset. */
    LOAD_REPORT_PATH: z.string().min(1).optional(),
  })
  .refine((config) => config.LOAD_HOT_WALLETS <= config.LOAD_WALLETS, {
    error: 'LOAD_HOT_WALLETS must not exceed LOAD_WALLETS',
  });

export type ScenarioConfig = z.infer<typeof scenarioSchema>;

export function loadScenarioConfig(source: Record<string, string | undefined>): ScenarioConfig {
  const result = scenarioSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`Invalid load scenario:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

/**
 * A seeded generator (mulberry32), so the mix of one run is the mix of the next: the point of the
 * experiment is that the same command and the same inputs produce comparable numbers, and a mix
 * drawn from `Math.random` would make every difference between two runs ambiguous.
 */
export function sequence(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;

    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}
