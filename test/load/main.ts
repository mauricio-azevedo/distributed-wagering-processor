/**
 * The load experiment of OPS-008, run end to end against the Compose stack: three `api` instances
 * and the two `worker` instances of [compose.load.yaml](../../compose.load.yaml), driven over HTTP
 * and over `wager-transactions.fifo` at the same time, drained, measured and reconciled.
 *
 * Usage: `bun run test:load`. It brings the topology up itself (`docker compose … up --wait`), so
 * the one prerequisite is Docker and a `.env` copied from `.env.example`; `make stack` decides the
 * ports, including the three the load topology publishes, so a worktree needs nothing exported.
 * Every input has a documented default in [config.ts](config.ts) and the resolved configuration is
 * carried in the report, which is what makes two runs comparable.
 *
 * What it is not is a test of correctness, and it is not in `make check`: a throughput is whatever
 * the machine did, so there is nothing here to assert. The guarantees are proven by the suites;
 * this measures what they cost. The one thing it does assert is the invariant no load is allowed to
 * break — stored balance equals ledger-derived balance for every wallet it touched (RECON-004) —
 * and it exits non-zero when that, or its own accounting, does not hold.
 *
 * The method, the definitions and two recorded runs: [docs/load-experiment.md](../../docs/load-experiment.md).
 */
import { GetQueueAttributesCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { loadEnv } from '../../src/infrastructure/config/env';
import { queueUrlResolver, wagerQueues } from '../../src/infrastructure/messaging/sqs';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import type { WagerOperationFields } from '../../src/infrastructure/transport/wager-operation.dto';
import { loadScenarioConfig, sequence } from './config';
import {
  AttemptLog,
  classify,
  deltaOf,
  histogramQuantile,
  type MetricSample,
  maxOf,
  parseExposition,
  perSecond,
  sumOf,
  summarize,
  type Window,
} from './measure';
import {
  bringUpLoadTopology,
  hostFacts,
  type Instance,
  instances,
  scrapeAll,
  stackSettings,
} from './stack';

const config = loadScenarioConfig(process.env);
const settings = stackSettings();

function step(message: string): void {
  console.log(`[load] ${message}`);
}

step(`stack ${settings.project} (slot ${settings.slot}), api ports ${settings.loadApiPorts}`);
step('bringing up three api instances and two workers, waiting for health');
bringUpLoadTopology(settings);

const running = instances(settings);
const apiInstances = running.filter(({ service }) => service === 'api');
const workerInstances = running.filter(({ service }) => service === 'worker');
const baseUrls = apiInstances
  .map(({ httpPort }) => httpPort)
  .filter((port): port is number => port !== null)
  .map((port) => `http://localhost:${String(port)}`);

if (baseUrls.length !== 3 || workerInstances.length !== 2) {
  throw new Error(
    `the load topology must be three api instances and two workers; found ${String(
      baseUrls.length,
    )} and ${String(workerInstances.length)}`,
  );
}

step(
  `api at ${baseUrls.join(', ')}; workers ${workerInstances.map(({ name }) => name).join(', ')}`,
);

/**
 * The addresses of the stack this checkout owns. `.env` carries the credentials and the queue
 * prefix; the ports come from `make stack`, so the URLs are rewritten rather than reassembled and
 * nothing here spells out a password or a database name (`ops.suite-isolation`).
 */
function withPort(url: string, port: number): string {
  const rewritten = new URL(url);
  rewritten.port = String(port);

  return rewritten.toString().replace(/\/$/, '');
}

const env = loadEnv({
  ...process.env,
  HTTP_PORT: String(settings.httpPort),
  DATABASE_URL: withPort(
    process.env['DATABASE_URL'] ?? 'postgres://wagering_app:wagering_app@localhost/wagering',
    settings.postgresPort,
  ),
  ...(process.env['SQS_ENDPOINT'] !== undefined && {
    SQS_ENDPOINT: withPort(process.env['SQS_ENDPOINT'], settings.localstackPort),
  }),
});

const orm = await MikroORM.init(ormConfig(env.DATABASE_URL));
const sql = orm.em.getConnection();
const sqs = new SQSClient({
  region: env.AWS_REGION,
  ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
});
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const transactionsQueueUrl = queueUrlResolver(sqs, queues.input);

/**
 * How much the stack's database already holds. It is part of the environment and not a detail: the
 * tables grow by tens of thousands of rows per run, every index on them with it, so a run against a
 * database a previous run has filled is not the same measurement as a run against a fresh volume.
 * Reported rather than cleaned up, because the experiment has no business truncating a stack
 * somebody else may be using.
 */
const databaseState = await sql.execute<{ relation: string; rows: string }[]>(
  `select 'wager_transactions' as relation, count(*)::text as rows from wager_transactions
   union all select 'wallet_ledger_entries', count(*)::text from wallet_ledger_entries
   union all select 'wallets', count(*)::text from wallets
   union all select 'outbox_messages', count(*)::text from outbox_messages
   union all select 'inbox_messages', count(*)::text from inbox_messages`,
);

const random = sequence(config.LOAD_SEED);
const run = Bun.randomUUIDv7().slice(-12);
/** One provider per run, so every row this experiment wrote is selectable and no key is reused. */
const providerId = `load-${run}`;

interface PooledWallet {
  readonly id: string;
  readonly playerId: string;
  readonly hot: boolean;
}

/** A `BET` the service recorded as `PROCESSED` and nothing has reversed: a legal `REFUND` target. */
interface RefundTarget {
  readonly externalTransactionId: string;
  readonly wallet: PooledWallet;
  readonly roundId: string;
  readonly amount: string;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// ----------------------------------------------------------------- the wallet pool

/**
 * The pool, opened before the clock starts. The opening credit is large enough that the random walk
 * of debits and credits over a run cannot exhaust it, so an `INSUFFICIENT_BALANCE` in the report is
 * one the scenario asked for (`LOAD_REJECTION_RATIO`) and never an artefact of a drifting balance.
 */
const OPENING_BALANCE = '100000.00';
const CURRENCY = 'BRL';

step(
  `opening ${String(config.LOAD_WALLETS)} wallets, ${String(config.LOAD_HOT_WALLETS)} of them contended`,
);

const wallets: PooledWallet[] = [];
for (let index = 0; index < config.LOAD_WALLETS; index += 1) {
  const playerId = crypto.randomUUID();
  const opened = await call(baseUrls[index % baseUrls.length] ?? '', 'POST', '/wallets', {
    playerId,
    initialBalance: { amount: OPENING_BALANCE, currency: CURRENCY },
  });

  if (opened.status !== 201) {
    throw new Error(
      `opening a wallet answered ${String(opened.status)}: ${JSON.stringify(opened.body)}`,
    );
  }

  wallets.push({ id: String(opened.body['id']), playerId, hot: index < config.LOAD_HOT_WALLETS });
}

const hotWallets = wallets.filter(({ hot }) => hot);
const coldWallets = wallets.filter(({ hot }) => !hot);

/** `LOAD_HOT_SHARE` of the attempts land on the contended wallets, which is where locks collide. */
function pickWallet(): PooledWallet {
  const pool = hotWallets.length > 0 && random() < config.LOAD_HOT_SHARE ? hotWallets : coldWallets;
  const drawnFrom = pool.length > 0 ? pool : wallets;

  return (
    drawnFrom[Math.floor(random() * drawnFrom.length)] ??
    wallets[0] ?? { id: '', playerId: '', hot: false }
  );
}

// ----------------------------------------------------------------- the mix

let minted = 0;
const refundTargets: RefundTarget[] = [];

/** `0.01` to `5.00`: small against the opening credit, so no wallet's balance trends anywhere. */
function amount(): string {
  const minorUnits = 1 + Math.floor(random() * 500);

  return `${String(Math.floor(minorUnits / 100))}.${String(minorUnits % 100).padStart(2, '0')}`;
}

interface Operation {
  readonly fields: WagerOperationFields;
  readonly key: string;
  /** The wallet it goes to, carried so the latency can be read per contention class. */
  readonly wallet: PooledWallet;
  readonly target?: RefundTarget;
}

function operation(
  entrypoint: 'h' | 'q',
  wallet: PooledWallet,
  kind: WagerOperationFields['kind'],
  money: string,
  roundId: string,
  reference?: string,
): Operation {
  minted += 1;
  const fields: WagerOperationFields = {
    providerId,
    externalTransactionId: `${entrypoint}-${run}-${String(minted)}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'load-game',
    kind,
    money: { amount: money, currency: CURRENCY },
    ...(reference !== undefined && { referenceExternalTransactionId: reference }),
  };

  return { fields, key: `${providerId}:${fields.externalTransactionId}`, wallet };
}

/**
 * One HTTP operation. The mix: `BET`s, `WIN`s and `LOSS`es in the proportions below, plus the share
 * of `BET`s aimed above any balance (a persisted rejection, `rule.bet.insufficient-balance`) and the
 * `REFUND`s that reverse a `BET` the service already processed. A `REFUND` carries the round, the
 * wallet, the player and the amount of its target, so it resolves on arrival instead of parking
 * (`rule.reference.same-context`, `rule.reference.equal-amount`): a parked transaction waits sixty
 * minutes by contract (`ref.ttl`) and would be pending work no drain could finish.
 */
function nextHttpOperation(): Operation {
  const wallet = pickWallet();
  const draw = random();

  if (draw < config.LOAD_REJECTION_RATIO) {
    return operation('h', wallet, 'BET', '999999999.99', `${run}-r${String(minted)}`);
  }

  const kindDraw = random();
  if (kindDraw < 0.1 && refundTargets.length > 0) {
    const target = refundTargets.pop();

    if (target !== undefined) {
      return {
        ...operation(
          'h',
          target.wallet,
          'REFUND',
          target.amount,
          target.roundId,
          target.externalTransactionId,
        ),
        target,
      };
    }
  }
  if (kindDraw < 0.65) {
    return operation('h', wallet, 'BET', amount(), `${run}-r${String(minted)}`);
  }
  if (kindDraw < 0.9) {
    return operation('h', wallet, 'WIN', amount(), `${run}-r${String(minted)}`);
  }

  return operation('h', wallet, 'LOSS', amount(), `${run}-r${String(minted)}`);
}

/**
 * One queued operation. No reference on this path: a producer cannot know whether the `BET` it would
 * reference has been processed yet, and a reference that has not resolved parks the transaction for
 * an hour. The queue half therefore measures `BET`, `WIN` and `LOSS` — the same financial use case
 * the HTTP half reaches (`msg.same-use-case`).
 */
function nextQueueOperation(): Operation {
  const wallet = pickWallet();
  const draw = random();
  const kind = draw < 0.6 ? 'BET' : draw < 0.9 ? 'WIN' : 'LOSS';

  return operation('q', wallet, kind, amount(), `${run}-r${String(minted)}`);
}

// ----------------------------------------------------------------- the load

const httpAttempts = new AttemptLog();
/**
 * The same HTTP attempts split by the wallet they went to. `wager_lock_conflicts_total` counts only
 * the operations that gave up waiting for a row (`conc.row-lock`), so it stays at zero until the
 * wait exceeds `LOCK_TIMEOUT_MS` — three seconds — and says nothing about contention below that.
 * What contention actually costs is the difference between these two latencies: the same operation
 * against a row four wallets share and against one almost nobody else is touching.
 */
const contended = { hot: new AttemptLog(), cold: new AttemptLog() };
/**
 * The enqueue side of the queue path. Its categories are about the `SendMessage` call and nothing
 * else: `completed` is an acknowledgement from the broker, never a processed operation. What the
 * workers then did with the message is read from the rows after the drain, which is the only way to
 * keep the two apart (`msg.ack-after-commit`).
 */
const enqueues = new AttemptLog();
/** When the broker acknowledged each queued operation, which is where its latency starts. */
const acknowledgedAt = new Map<string, number>();
/**
 * Duplicate sends the generator made. A replay cannot be recognised at enqueue time — the broker
 * acknowledges a duplicate exactly as it acknowledges anything else — so the queue path's
 * duplicates are counted here and what the service did with them is read from
 * `wager_duplicates_detected_total{source="inbox"}` (`msg.redelivery-safe`).
 */
let duplicateSends = 0;

async function submit(base: string, { fields, key, wallet, target }: Operation): Promise<void> {
  const at = Date.now();
  const started = Bun.nanoseconds();

  try {
    const response = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(fields),
    });
    const body = (await response.json()) as { status?: string; idempotentReplay?: boolean };
    const category = classify({
      status: response.status,
      recordedStatus: body.status,
      idempotentReplay: body.idempotentReplay,
    });

    const attempt = { at, latencyMs: (Bun.nanoseconds() - started) / 1_000_000, category };
    httpAttempts.record(attempt);
    (wallet.hot ? contended.hot : contended.cold).record(attempt);

    if (category === 'completed' && fields.kind === 'BET' && target === undefined) {
      refundTargets.push({
        externalTransactionId: fields.externalTransactionId,
        wallet,
        roundId: fields.roundId,
        amount: fields.money.amount,
      });
    }
    // A refund the service did not apply releases its target: the bet is still unreversed.
    if (category !== 'completed' && target !== undefined) {
      refundTargets.push(target);
    }
  } catch {
    const failed = {
      at,
      latencyMs: (Bun.nanoseconds() - started) / 1_000_000,
      category: 'transport' as const,
    };
    httpAttempts.record(failed);
    (wallet.hot ? contended.hot : contended.cold).record(failed);
  }
}

async function enqueue(
  { fields, key }: Operation,
  messageId: string,
  deduplicationId: string,
): Promise<void> {
  const at = Date.now();
  const started = Bun.nanoseconds();

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: await transactionsQueueUrl(),
        // The operation itself, not the wallet: these operations are independent, and a FIFO group
        // admits one message in flight, so grouping by wallet would serialize the contended ones.
        MessageGroupId: key,
        MessageDeduplicationId: deduplicationId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          correlationId: `load-${messageId}`,
          data: { ...fields, idempotencyKey: key },
        }),
      }),
    );

    enqueues.record({
      at,
      latencyMs: (Bun.nanoseconds() - started) / 1_000_000,
      category: 'completed',
    });
    // The first acknowledgement wins: a redelivery of an operation already acknowledged is not a
    // second operation, and taking the later ack as its start would date the latency from after the
    // work was done.
    if (!acknowledgedAt.has(fields.externalTransactionId)) {
      acknowledgedAt.set(fields.externalTransactionId, Date.now());
    }
  } catch {
    enqueues.record({
      at,
      latencyMs: (Bun.nanoseconds() - started) / 1_000_000,
      category: 'transport',
    });
  }
}

/** Replays resubmit an operation this worker already submitted, key and payload unchanged. */
async function httpWorker(worker: number, endAt: number): Promise<void> {
  const base = baseUrls[worker % baseUrls.length] ?? '';
  let previous: Operation | null = null;

  while (Date.now() < endAt) {
    const next: Operation =
      previous !== null && random() < config.LOAD_REPLAY_RATIO ? previous : nextHttpOperation();

    await submit(base, next);
    previous = next;
  }
}

/**
 * A replay on this path resends the operation under the message id it already carried, with a
 * deduplication id the broker has never seen: the identity of a delivery is the producer's
 * `messageId` (`msg.inbox-identity`), so this is exactly the redelivery the inbox has to absorb
 * (`msg.redelivery-safe`) rather than a duplicate the broker's own five-minute window would filter
 * before the service ever saw it.
 */
async function queueProducer(worker: number, endAt: number): Promise<void> {
  let previous: { readonly operation: Operation; readonly messageId: string } | null = null;
  let sent = 0;
  // This producer's share of `LOAD_QUEUE_RATE_PER_SECOND`, paced against the clock rather than by
  // sleeping a fixed amount after each send, so a slow send is caught up with instead of added on.
  const interval = (1_000 * config.LOAD_QUEUE_CONCURRENCY) / config.LOAD_QUEUE_RATE_PER_SECOND;
  let due = Date.now();

  while (Date.now() < endAt) {
    due += interval;
    const wait = due - Date.now();
    if (wait > 0) {
      await Bun.sleep(wait);
    }
    if (Date.now() >= endAt) {
      return;
    }

    sent += 1;
    const label = `${run}-${String(worker)}-${String(sent)}`;

    if (previous !== null && random() < config.LOAD_REPLAY_RATIO) {
      duplicateSends += 1;
      await enqueue(previous.operation, previous.messageId, `${label}-again`);
      continue;
    }

    const next = nextQueueOperation();
    await enqueue(next, label, label);
    previous = { operation: next, messageId: label };
  }
}

/** The two outbox gauges over time, which is what the reported backlog and lag are taken from. */
interface BacklogSample {
  readonly at: number;
  readonly pending: number | null;
  readonly lagSeconds: number | null;
}

const backlog: BacklogSample[] = [];
let sampling = true;

async function sampleBacklog(): Promise<void> {
  const base = baseUrls[0] ?? '';

  while (sampling) {
    try {
      const response = await fetch(`${base}/metrics`);
      const samples = parseExposition(await response.text());

      backlog.push({
        at: Date.now(),
        pending: maxOf(samples, 'wager_outbox_pending'),
        lagSeconds: maxOf(samples, 'wager_outbox_lag_seconds'),
      });
    } catch {
      backlog.push({ at: Date.now(), pending: null, lagSeconds: null });
    }

    await Bun.sleep(config.LOAD_GAUGE_INTERVAL_MS);
  }
}

const warmupStartedAt = Date.now();
const measuredStartedAt = warmupStartedAt + config.LOAD_WARMUP_MS;
const loadEndsAt = measuredStartedAt + config.LOAD_DURATION_MS;

step(
  `warming up for ${String(config.LOAD_WARMUP_MS)}ms, then measuring for ${String(
    config.LOAD_DURATION_MS,
  )}ms with ${String(config.LOAD_HTTP_CONCURRENCY)} http and ${String(
    config.LOAD_QUEUE_CONCURRENCY,
  )} queue producers`,
);

const sampler = sampleBacklog();
/** The scrape the measured window starts from, so the warm-up's own work is not in the deltas. */
let before: MetricSample[] = [];
const scrapeBefore = Bun.sleep(Math.max(0, measuredStartedAt - Date.now())).then(() => {
  before = scrapeAll(settings, running);
});

await Promise.all([
  ...Array.from({ length: config.LOAD_HTTP_CONCURRENCY }, (_unused, worker) =>
    httpWorker(worker, loadEndsAt),
  ),
  ...Array.from({ length: config.LOAD_QUEUE_CONCURRENCY }, (_unused, worker) =>
    queueProducer(worker, loadEndsAt),
  ),
  scrapeBefore,
]);

const loadStoppedAt = Date.now();
const measured: Window = { from: measuredStartedAt, to: loadEndsAt };

step('load stopped; draining the work already submitted');

// ----------------------------------------------------------------- the drain

interface Pending {
  readonly queueMessages: number;
  readonly nonTerminalRows: number;
  readonly outboxPending: number | null;
}

async function queueDepth(): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await transactionsQueueUrl(),
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );

  return Object.values(Attributes).reduce((sum, count) => sum + Number(count), 0);
}

async function nonTerminalRows(): Promise<number> {
  const [row] = await sql.execute<{ rows: string }[]>(
    `select count(*)::text as rows from wager_transactions
      where provider_id = ? and status in ('PENDING', 'PENDING_REFERENCE')`,
    [providerId],
  );

  return Number(row?.rows ?? '0');
}

/**
 * The backlog as an instance reads it now. A scrape measures the two gauges before it renders
 * (`outbox.lag-metrics`), so this is a fresh reading of the whole outbox and not the last value some
 * publisher cycle happened to leave behind.
 */
function backlogNow(): BacklogSample {
  const samples = scrapeAll(settings, apiInstances.slice(0, 1));

  return {
    at: Date.now(),
    pending: maxOf(samples, 'wager_outbox_pending'),
    lagSeconds: maxOf(samples, 'wager_outbox_lag_seconds'),
  };
}

async function pendingWork(): Promise<Pending> {
  return {
    queueMessages: await queueDepth(),
    nonTerminalRows: await nonTerminalRows(),
    outboxPending: backlogNow().pending,
  };
}

const drainStartedAt = Date.now();
const drainDeadline = drainStartedAt + config.LOAD_DRAIN_TIMEOUT_MS;
let pending = await pendingWork();

while (
  Date.now() < drainDeadline &&
  (pending.queueMessages > 0 || pending.nonTerminalRows > 0 || (pending.outboxPending ?? 0) > 0)
) {
  await Bun.sleep(1_000);
  pending = await pendingWork();
}

const drainEndedAt = Date.now();
const drainTimedOut =
  pending.queueMessages > 0 || pending.nonTerminalRows > 0 || (pending.outboxPending ?? 0) > 0;

sampling = false;
await sampler;

/** Read after the drain and not taken from the periodic samples, the last of which predates it. */
const settledBacklog = backlogNow();

step(
  drainTimedOut
    ? `drain timed out after ${String(drainEndedAt - drainStartedAt)}ms with work still pending`
    : `drained in ${String(drainEndedAt - drainStartedAt)}ms`,
);

const after = scrapeAll(settings, running);
const delta = deltaOf(before, after);

// ----------------------------------------------------------------- what the rows say

interface OutcomeRow {
  readonly kind: string;
  readonly status: string;
  readonly entrypoint: string;
  readonly rows: string;
}

const outcomes = await sql.execute<OutcomeRow[]>(
  `select kind,
          status,
          case when external_transaction_id like 'h-%' then 'http' else 'queue' end as entrypoint,
          count(*)::text as rows
     from wager_transactions
    where provider_id = ?
    group by 1, 2, 3
    order by 1, 2, 3`,
  [providerId],
);

const recorded = (status: string, entrypoint?: string): number =>
  outcomes
    .filter(
      (row) => row.status === status && (entrypoint === undefined || row.entrypoint === entrypoint),
    )
    .reduce((sum, row) => sum + Number(row.rows), 0);

interface QueueRow {
  readonly id: string;
  readonly status: string;
  readonly createdMs: string;
  readonly processedMs: string | null;
}

/**
 * The queue path's latency, with both ends named and neither overclaimed.
 *
 * It starts at the broker's acknowledgement of the send, which the producer recorded by the host
 * clock, and ends at the operation's recorded timestamp, written by the service inside its own
 * container — the same kernel clock, since both run on this host.
 *
 * That end is the service's *receipt* and not its completion: `SubmitWagerTransaction` reads its
 * clock once per submission, before the first statement, so `created_at` and `processed_at` carry
 * the same instant and the row cannot decompose further. What this measures is therefore the
 * hand-off — the message sitting in the broker plus the consumer's long poll — and the processing
 * it does not include is `wager_processing_duration_seconds{entrypoint="queue"}`, which the service
 * measures itself. The report carries both rather than one number pretending to be the whole.
 *
 * The rows come back in receipt order so the first and the last tenth can be compared: a hand-off
 * that is flat across the run is a fixed cost, and one that grows is a backlog the workers never
 * caught up with.
 */
const queueRows = await sql.execute<QueueRow[]>(
  `select external_transaction_id as "id",
          status,
          (extract(epoch from created_at) * 1000)::text as "createdMs",
          case when processed_at is null then null
               else (extract(epoch from processed_at) * 1000)::text end as "processedMs"
     from wager_transactions
    where provider_id = ? and external_transaction_id like 'q-%'
    order by created_at`,
  [providerId],
);

/** The hand-off of the messages sent inside the measured window, like every other headline. */
const queueHandoffs: number[] = [];
/**
 * The hand-off of every message of the run, warm-up included, in receipt order. The trend is read
 * from this and not from the window: a backlog is visible precisely in the difference between the
 * messages sent first and the ones sent last.
 */
const queueHandoffsOverTheRun: number[] = [];
let queueCompletionsInWindow = 0;

for (const row of queueRows) {
  const acknowledged = acknowledgedAt.get(row.id);
  const created = Number(row.createdMs);
  const processed = row.processedMs === null ? null : Number(row.processedMs);

  if (processed !== null && processed >= measured.from && processed < measured.to) {
    queueCompletionsInWindow += 1;
  }
  if (acknowledged === undefined) {
    continue;
  }

  /*
   * A hand-off of a millisecond below zero is the ordering of two timestamps and not a message
   * received before it was sent: the producer stamps its own clock after the SDK call returns, by
   * which time a worker may already have received the message and stamped the row.
   */
  queueHandoffsOverTheRun.push(created - acknowledged);
  if (acknowledged >= measured.from && acknowledged < measured.to) {
    queueHandoffs.push(created - acknowledged);
  }
}

const decile = Math.max(1, Math.floor(queueHandoffsOverTheRun.length / 10));

// ----------------------------------------------------------------- reconciliation (RECON-004)

step(`reconciling ${String(wallets.length)} wallets against their ledgers`);

interface RebuiltWallet {
  readonly id: string;
  readonly stored: string;
  readonly calculated: string;
  readonly head: string | null;
  readonly entries: string;
}

/**
 * `recon.final-invariant`: the stored balance against the balance rebuilt from the ledger, summed
 * in SQL so a defect in the service's own arithmetic cannot agree with itself, and compared as the
 * decimal strings PostgreSQL renders rather than as JavaScript numbers (ADR 0001).
 */
const rebuilt = await sql.execute<RebuiltWallet[]>(
  `select w.id,
          w.balance::text as stored,
          coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end),
                   0)::numeric(20,2)::text as calculated,
          max(case when e.wallet_version = w.version then e.balance_after end)::text as head,
          count(e.id)::text as entries
     from wallets w
     left join wallet_ledger_entries e on e.wallet_id = w.id
    where w.id in (${wallets.map(() => '?').join(', ')})
    group by w.id`,
  wallets.map(({ id }) => id),
);

const sqlDivergences = rebuilt
  .filter((wallet) => wallet.stored !== wallet.calculated || wallet.head !== wallet.stored)
  .map(({ id, stored, calculated, head }) => ({ walletId: id, stored, calculated, head }));

/** The same invariant through the documented surface, which is what an operator would run. */
const reports = await Promise.all(
  wallets.map(async (wallet, index) => {
    const answer = await call(
      baseUrls[index % baseUrls.length] ?? '',
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    return {
      walletId: wallet.id,
      status: answer.status,
      consistent: answer.body['consistent'] === true,
      difference: (answer.body['difference'] as { amount?: string } | undefined)?.amount ?? null,
    };
  }),
);

const endpointDivergences = reports.filter(
  (report) => report.status !== 200 || !report.consistent || report.difference !== '0.00',
);

// ----------------------------------------------------------------- the report

const httpMeasured = httpAttempts.within(measured);
const enqueueMeasured = enqueues.within(measured);
const httpTally = httpMeasured.tally();
const enqueueTally = enqueueMeasured.tally();
const hotMeasured = contended.hot.within(measured);
const coldMeasured = contended.cold.within(measured);
const ledgerEntries = rebuilt.reduce((sum, wallet) => sum + Number(wallet.entries), 0);

const serviceQuantiles = (entrypoint: 'http' | 'queue'): Record<string, number | null> => ({
  p50: histogramQuantile(delta, 'wager_processing_duration_seconds', { entrypoint }, 0.5),
  p95: histogramQuantile(delta, 'wager_processing_duration_seconds', { entrypoint }, 0.95),
  p99: histogramQuantile(delta, 'wager_processing_duration_seconds', { entrypoint }, 0.99),
});

const backlogDuringLoad = backlog.filter(({ at }) => at >= measured.from);

const report = {
  experiment: 'OPS-008 load experiment',
  runId: run,
  providerId,
  startedAt: new Date(warmupStartedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  environment: {
    ...hostFacts(),
    stack: {
      project: settings.project,
      slot: settings.slot,
      image: settings.image,
      apiInstances: apiInstances.map(({ name, httpPort }) => ({ name, httpPort })),
      workerInstances: workerInstances.map(({ name }: Instance) => name),
      lockTimeoutMs: env.LOCK_TIMEOUT_MS,
      outboxBatchSize: env.OUTBOX_BATCH_SIZE,
      outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      queuePrefix: env.SQS_QUEUE_PREFIX,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      /** The long poll one receive waits, which is part of what the queue hand-off measures. */
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
    },
    databaseRowsBeforeTheRun: databaseState,
    postgres: await sql.execute<{ setting: string; value: string }[]>(
      `select name as setting, setting as value from pg_settings
        where name in ('server_version', 'max_connections', 'shared_buffers', 'work_mem',
                       'effective_cache_size', 'synchronous_commit', 'default_transaction_isolation')
        order by name`,
    ),
  },
  configuration: config,
  method: {
    walletPool: {
      wallets: wallets.length,
      hot: hotWallets.length,
      hotShare: config.LOAD_HOT_SHARE,
    },
    openingBalance: `${OPENING_BALANCE} ${CURRENCY}`,
    httpMix: 'BET 55%, WIN 25%, LOSS 10%, REFUND of a processed BET 10%, plus the rejection share',
    queueMix: 'BET 60%, WIN 30%, LOSS 10%; no references, so nothing parks',
    offeredQueueRatePerSecond: config.LOAD_QUEUE_RATE_PER_SECOND,
    windows: {
      warmup: {
        from: new Date(warmupStartedAt).toISOString(),
        to: new Date(measuredStartedAt).toISOString(),
      },
      measured: {
        from: new Date(measured.from).toISOString(),
        to: new Date(measured.to).toISOString(),
      },
      drain: {
        from: new Date(drainStartedAt).toISOString(),
        to: new Date(drainEndedAt).toISOString(),
        timedOut: drainTimedOut,
      },
      loadStoppedAt: new Date(loadStoppedAt).toISOString(),
    },
  },
  throughput: {
    definition:
      'completed operations per second over the measured window: HTTP answers the generator counted as applied, plus queued operations whose processed_at falls inside the window',
    httpAttemptsPerSecond: perSecond(httpTally.attempts, measured),
    httpCompletedPerSecond: perSecond(httpTally.completed, measured),
    enqueuesPerSecond: perSecond(enqueueTally.attempts, measured),
    queueCompletedPerSecond: perSecond(queueCompletionsInWindow, measured),
    completedPerSecond: perSecond(httpTally.completed + queueCompletionsInWindow, measured),
  },
  work: {
    uniqueOperationsSubmitted: minted,
    attemptsInWindow: { http: httpTally.attempts, enqueued: enqueueTally.attempts },
    idempotentReplays: {
      definition:
        'http: answers the service marked idempotentReplay, counted in the measured window; queue: sends of a messageId already sent, which the inbox absorbs and the broker never sees as a duplicate. The counter deltas are the measured window; the generator counted its duplicate sends across the whole load phase, warm-up included, so the two are not the same denominator.',
      httpAnsweredAsReplayInTheWindow: httpTally.replays,
      queueDuplicateSendsOverTheRun: duplicateSends,
      absorbedByTheInboxInTheWindow: sumOf(delta, 'wager_duplicates_detected_total', {
        source: 'inbox',
      }),
      absorbedByIdempotencyInTheWindow: sumOf(delta, 'wager_duplicates_detected_total', {
        source: 'idempotency',
      }),
    },
    completedInWindow: { http: httpTally.completed, queue: queueCompletionsInWindow },
    recordedOutcomes: {
      processed: recorded('PROCESSED'),
      rejected: recorded('REJECTED'),
      failed: recorded('FAILED'),
      parked: recorded('PENDING_REFERENCE'),
      byEntrypoint: {
        http: { processed: recorded('PROCESSED', 'http'), rejected: recorded('REJECTED', 'http') },
        queue: {
          processed: recorded('PROCESSED', 'queue'),
          rejected: recorded('REJECTED', 'queue'),
        },
      },
      byKindAndStatus: outcomes,
    },
    pendingAfterDrain: pending,
  },
  errors: {
    denominator: 'attempts in the measured window, per entry point',
    http: {
      attempts: httpTally.attempts,
      infrastructureErrors: httpTally.infrastructureErrors,
      errorRate: httpTally.errorRate,
      businessRejections: httpTally.businessRejections,
      byCategory: httpTally.byCategory,
    },
    enqueue: {
      attempts: enqueueTally.attempts,
      infrastructureErrors: enqueueTally.infrastructureErrors,
      errorRate: enqueueTally.errorRate,
      byCategory: enqueueTally.byCategory,
    },
  },
  latencyMs: {
    http: summarize(httpMeasured.latencies()),
    /**
     * What contention costs, which `wager_lock_conflicts_total` cannot say below the lock ceiling:
     * the same operations against the contended wallets and against the rest.
     */
    httpByContention: {
      hot: { wallets: hotWallets.length, ...summarize(hotMeasured.latencies()) },
      cold: { wallets: coldWallets.length, ...summarize(coldMeasured.latencies()) },
      hotAttempts: hotMeasured.tally().attempts,
      coldAttempts: coldMeasured.tally().attempts,
    },
    enqueueAcknowledgement: summarize(enqueueMeasured.latencies()),
    queueHandoff: {
      definition:
        'from the broker acknowledging the send to the operation’s recorded timestamp, which is the service’s receipt: the service reads its clock once per submission, so created_at equals processed_at and the row cannot decompose further. The processing this excludes is metrics.serviceLatencySeconds.queue.',
      inMeasuredWindow: summarize(queueHandoffs),
      overTheRun: summarize(queueHandoffsOverTheRun),
      firstTenthOfTheRun: summarize(queueHandoffsOverTheRun.slice(0, decile)),
      lastTenthOfTheRun: summarize(queueHandoffsOverTheRun.slice(-decile)),
    },
  },
  metrics: {
    source: 'the five instances scraped at the start and the end of the measured window, summed',
    lockConflicts: sumOf(delta, 'wager_lock_conflicts_total'),
    transactionsByStatus: {
      processed: sumOf(delta, 'wager_transactions_total', { status: 'PROCESSED' }),
      rejected: sumOf(delta, 'wager_transactions_total', { status: 'REJECTED' }),
      failed: sumOf(delta, 'wager_transactions_total', { status: 'FAILED' }),
      pendingReference: sumOf(delta, 'wager_transactions_total', { status: 'PENDING_REFERENCE' }),
    },
    duplicatesBySource: {
      idempotency: sumOf(delta, 'wager_duplicates_detected_total', { source: 'idempotency' }),
      inbox: sumOf(delta, 'wager_duplicates_detected_total', { source: 'inbox' }),
      inboxConflict: sumOf(delta, 'wager_duplicates_detected_total', { source: 'inbox-conflict' }),
    },
    retriesByComponent: {
      queue: sumOf(delta, 'wager_retries_total', { component: 'queue' }),
      outbox: sumOf(delta, 'wager_retries_total', { component: 'outbox' }),
      pendingReference: sumOf(delta, 'wager_retries_total', { component: 'pending-reference' }),
    },
    deadLetters: sumOf(delta, 'wager_dlq_messages_total'),
    reconciliationDivergences: sumOf(delta, 'wager_reconciliation_divergence_total'),
    outbox: {
      samples: backlogDuringLoad.length,
      peakPending: Math.max(0, ...backlogDuringLoad.map(({ pending: value }) => value ?? 0)),
      peakLagSeconds: Math.max(0, ...backlogDuringLoad.map(({ lagSeconds }) => lagSeconds ?? 0)),
      afterDrainPending: settledBacklog.pending,
      afterDrainLagSeconds: settledBacklog.lagSeconds,
      readings: backlog,
    },
    serviceLatencySeconds: {
      note: 'wager_processing_duration_seconds over the measured window, read as Prometheus reads a histogram',
      http: serviceQuantiles('http'),
      queue: serviceQuantiles('queue'),
    },
  },
  reconciliation: {
    wallets: wallets.length,
    ledgerEntries,
    sqlRebuildDivergences: sqlDivergences,
    endpointDivergences,
  },
};

const problems: string[] = [];
if (sqlDivergences.length > 0) {
  problems.push(`${String(sqlDivergences.length)} wallets diverge from their ledger`);
}
if (endpointDivergences.length > 0) {
  problems.push(`${String(endpointDivergences.length)} reconciliation reports are not consistent`);
}
if (recorded('FAILED') > 0) {
  problems.push(`${String(recorded('FAILED'))} operations were recorded as FAILED`);
}
if (httpTally.byCategory.invalid > 0 || enqueueTally.byCategory.invalid > 0) {
  problems.push('the service refused to read a request, which is a defect in the generator');
}
if (drainTimedOut) {
  problems.push('the drain timed out with work still pending, so the run is not fully measured');
}

const verdict = { ok: problems.length === 0, problems };
const complete = { ...report, verdict };

// ----------------------------------------------------------------- output

const line = (label: string, value: unknown): void => {
  console.log(`  ${label.padEnd(34)} ${String(value)}`);
};
const fixed = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined ? '—' : value.toFixed(digits);

console.log('\n======== OPS-008 load experiment ========');
line('run', `${run} (provider ${providerId})`);
line('topology', `3 api, 2 worker, ${settings.project}`);
line(
  'measured window',
  `${String(config.LOAD_DURATION_MS)}ms after ${String(config.LOAD_WARMUP_MS)}ms warm-up`,
);
line('http attempts / completed', `${String(httpTally.attempts)} / ${String(httpTally.completed)}`);
line(
  'enqueued / queue completions',
  `${String(enqueueTally.attempts)} / ${String(queueCompletionsInWindow)}`,
);
line('completed operations per second', fixed(report.throughput.completedPerSecond, 1));
line(
  'http latency p50/p95/p99 ms',
  `${fixed(report.latencyMs.http?.p50)} / ${fixed(report.latencyMs.http?.p95)} / ${fixed(report.latencyMs.http?.p99)}`,
);
line(
  'service http p50/p95/p99 ms',
  `${fixed((serviceQuantiles('http')['p50'] ?? 0) * 1000)} / ${fixed((serviceQuantiles('http')['p95'] ?? 0) * 1000)} / ${fixed((serviceQuantiles('http')['p99'] ?? 0) * 1000)}`,
);
line(
  'queue hand-off p50/p95/p99 ms',
  `${fixed(report.latencyMs.queueHandoff.inMeasuredWindow?.p50)} / ${fixed(report.latencyMs.queueHandoff.inMeasuredWindow?.p95)} / ${fixed(report.latencyMs.queueHandoff.inMeasuredWindow?.p99)}`,
);
line(
  'hand-off first/last tenth p50 ms',
  `${fixed(report.latencyMs.queueHandoff.firstTenthOfTheRun?.p50)} / ${fixed(report.latencyMs.queueHandoff.lastTenthOfTheRun?.p50)}`,
);
line(
  'service queue p50/p95/p99 ms',
  `${fixed((serviceQuantiles('queue')['p50'] ?? 0) * 1000)} / ${fixed((serviceQuantiles('queue')['p95'] ?? 0) * 1000)} / ${fixed((serviceQuantiles('queue')['p99'] ?? 0) * 1000)}`,
);
line(
  'http error rate',
  `${fixed(httpTally.errorRate * 100, 3)}% of ${String(httpTally.attempts)} attempts`,
);
line('business rejections', `${String(httpTally.businessRejections)} (not errors)`);
line(
  'idempotent replays',
  `${String(httpTally.replays)} answered as replays, ${String(duplicateSends)} duplicate sends, ${String(report.work.idempotentReplays.absorbedByTheInboxInTheWindow)} absorbed by the inbox`,
);
line(
  'hot vs cold p50/p99 ms',
  `${fixed(report.latencyMs.httpByContention.hot.p50)}/${fixed(report.latencyMs.httpByContention.hot.p99)} on ${String(hotWallets.length)} wallets, ${fixed(report.latencyMs.httpByContention.cold.p50)}/${fixed(report.latencyMs.httpByContention.cold.p99)} on ${String(coldWallets.length)}`,
);
line(
  'lock conflicts',
  `${String(report.metrics.lockConflicts)} (gave up after ${String(env.LOCK_TIMEOUT_MS)}ms)`,
);
line(
  'outbox peak pending / lag s',
  `${String(report.metrics.outbox.peakPending)} / ${fixed(report.metrics.outbox.peakLagSeconds, 1)}`,
);
line(
  'outbox after drain',
  `${String(report.metrics.outbox.afterDrainPending ?? '—')} pending, ${fixed(report.metrics.outbox.afterDrainLagSeconds, 1)}s lag`,
);
line('dead letters', String(report.metrics.deadLetters));
line(
  'pending after drain',
  `${String(pending.queueMessages)} messages, ${String(pending.nonTerminalRows)} rows`,
);
line(
  'recorded outcomes',
  `${String(recorded('PROCESSED'))} processed, ${String(recorded('REJECTED'))} rejected, ${String(recorded('FAILED'))} failed`,
);
line(
  'reconciliation',
  `${String(wallets.length)} wallets, ${String(ledgerEntries)} entries, ${String(sqlDivergences.length + endpointDivergences.length)} divergences`,
);
line('verdict', verdict.ok ? 'consistent' : problems.join('; '));
console.log('');

const json = JSON.stringify(complete, null, 2);
if (config.LOAD_REPORT_PATH === undefined) {
  console.log(json);
} else {
  await Bun.write(config.LOAD_REPORT_PATH, `${json}\n`);
  step(`report written to ${config.LOAD_REPORT_PATH}`);
}

await orm.close();
sqs.destroy();

process.exit(verdict.ok ? 0 : 1);
