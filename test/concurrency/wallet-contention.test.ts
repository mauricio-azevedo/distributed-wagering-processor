import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { sha256Hex } from '../../src/application/sha256';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import {
  ReconcileWallet,
  type ReconciliationReport,
} from '../../src/application/use-cases/reconcile-wallet';
import {
  SubmitWagerTransaction,
  type SubmissionOutcome,
} from '../../src/application/use-cases/submit-wager-transaction';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { systemClock } from '../../src/infrastructure/clock';
import { uuidV7IdGenerator } from '../../src/infrastructure/id-generator';
import { silentLogger } from '../../src/infrastructure/observability/logger';
import { uncountedMetrics } from '../../src/infrastructure/observability/metrics';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import {
  type SubmissionReport,
  type WagerCommand,
  wagerCommandSchema,
} from '../helpers/wager-command';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

/**
 * The claim this service exists to make, proven the only way it can be: several independent
 * processes against one PostgreSQL, with real parallelism and a coordinated start (ADR 0002,
 * CONC-001, CONC-005 to CONC-008).
 *
 * Nothing here is simulated. Each instance is a `wager-worker.ts` process with its own heap, its own
 * entity manager and its own connection pool, and PostgreSQL is the only thing the three of them
 * share — so what the assertions below describe is a deployment and not an event loop. A test that
 * raced promises in one runtime could pass with no locking at all: one event loop never interleaves
 * two transactions, it runs them one after the other.
 *
 * The one case that also runs an instance in the suite's own process is the same-instance shape of
 * CONC-001, and it races nothing: it stops one operation with its transaction open and observes
 * another wallet's operation getting past it. What that asks about is a mutex in this runtime,
 * which is a question only one runtime can be asked.
 *
 * Every case ends by reconciling each wallet it touched against its ledger
 * (`recon.final-invariant`, RECON-004), because a count of outcomes is not a proof of correctness:
 * fifty duplicates could each be answered correctly while the balance drifted.
 *
 * The two rules that are about one transaction rather than a load — the version guard and the lock
 * mode — are `test/integration/wallet-lock.test.ts`; the ones that are about the code are
 * `test/unit/wallet-lock-invariants.test.ts`.
 */

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKER = path.join(ROOT, 'test', 'helpers', 'wager-worker.ts');

/** `conc.multi-instance`: three, which is what "three or more instances" asks for. */
const INSTANCES = 3;

/**
 * How many submissions one instance keeps in flight. It matches the connection pool an instance
 * opens, so the lanes are limited by the database and not by a semaphore of this suite's choosing.
 */
const LANES = 10;

/**
 * The ceiling the instances run with, far above any wait a case here produces: contention is what
 * these cases measure, and a lock wait that gave up would be reported as a transient failure
 * instead. The ceiling itself is CONC-002, in `bet-submission.test.ts` and `queue-submission.test.ts`.
 */
const LOCK_CEILING_MS = 60_000;

/** The canonical scenario, repeated: one favourable interleaving is not a serialization. */
const CANONICAL_ROUNDS = 20;

/** `conc.duplicate-storm`: fifty parallel copies of one submission, three times over. */
const STORM = 50;
const STORM_ROUNDS = 3;

/** `conc.parallel-wallets`: the acceptance scenario's load — 200 wallets, 20 bets each. */
const WALLETS = 200;
const BETS_PER_WALLET = 20;

/**
 * How long an operation on a wallet of its own may take while another wallet's operation is held
 * mid-transaction with its lock still open. It is not a performance bound: a submission that waits
 * for nothing commits in milliseconds, and this is three orders of magnitude above that. What it
 * is for is the failure — an operation that is blocked has to fail the case instead of hanging the
 * suite, which it would do until the lock ceiling if a database lock stopped it and forever if an
 * application mutex did.
 */
const UNBLOCKED_MS = 15_000;

/** `conc.lock-order`: the mixed load of CONC-008, as targets a reversal can name. */
const MIXED_TARGETS = 30;

/** `recon.snapshot` (RECON-001): the load one wallet takes while it is reconciled continuously. */
const RECONCILED_BETS = 300;

/**
 * How much the reconciliation loop may cost the betting it runs beside. The report takes no lock
 * (`recon.snapshot`), so the honest expectation is "nothing measurable"; what the bound has to
 * catch is a report that started taking one, and a loop of them would then stand between every pair
 * of bets. Twice the cost of the same load with no loop is well inside that and well outside the
 * noise of two runs of three hundred transactions.
 */
const RECONCILIATION_OVERHEAD = 2;

const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const PROVIDER_ID = 'provider-acme';
const ROUND_ID = 'round-7f3a';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let openWallet: OpenWallet;
let reconcileWallet: ReconcileWallet;
let instances: Instances;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  openWallet = new OpenWallet({
    unitOfWork: new MikroOrmUnitOfWork(runtime.em, LOCK_CEILING_MS),
    clock: systemClock,
    ids: uuidV7IdGenerator,
    sha256Hex,
  });
  reconcileWallet = new ReconcileWallet({
    unitOfWork: new MikroOrmUnitOfWork(runtime.em, LOCK_CEILING_MS),
    clock: systemClock,
    logger: silentLogger,
    metrics: uncountedMetrics,
  });
  instances = await Instances.start(INSTANCES);
});

afterAll(async () => {
  await instances.stop();
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): every case moves money, so each one ends by rebuilding the
// balance of every wallet it touched from that wallet's ledger, in SQL, before the rows are removed.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

/**
 * One service instance as a process, with a line of text in each direction. The lines it writes are
 * what it says about itself: the pid it runs under, the batch it holds and the outcomes it recorded.
 */
class Instance {
  private readonly child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private readonly lines: string[] = [];
  private readonly reading: Promise<void>;

  constructor() {
    // `process.execPath`, so an instance runs the runtime this suite runs on rather than whichever
    // `bun` the PATH of the moment resolves to.
    this.child = Bun.spawn([process.execPath, 'run', WORKER], {
      cwd: ROOT,
      env: { ...process.env, LOCK_TIMEOUT_MS: LOCK_CEILING_MS.toString() },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.reading = this.read();
  }

  /**
   * One instruction, as one line. The flush is what is awaited, because a batch of four thousand
   * operations is more than one pipe write and the instance must have the whole line before the
   * barrier instant is chosen.
   */
  async send(instruction: unknown): Promise<void> {
    void this.child.stdin.write(`${JSON.stringify(instruction)}\n`);
    await this.child.stdin.flush();
  }

  /** Waits until this instance has written a line starting with `prefix`, and returns the rest. */
  async waitFor(prefix: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const line = this.lines.find((written) => written.startsWith(prefix));

      if (line !== undefined) {
        return line.slice(prefix.length);
      }

      if (this.child.exitCode !== null) {
        throw new Error(
          `the instance exited with ${String(this.child.exitCode)} before saying "${prefix}": ${await this.diagnostics()}`,
        );
      }

      await Bun.sleep(5);
    }

    throw new Error(`the instance never said "${prefix}": ${await this.diagnostics()}`);
  }

  async stop(): Promise<void> {
    await this.send({ stop: true });
    await this.child.exited;
    await this.reading;
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';

    for await (const chunk of this.child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      this.lines.push(...parts);
    }
  }

  private async diagnostics(): Promise<string> {
    return `stdout ${JSON.stringify(this.lines)}, stderr ${await new Response(this.child.stderr).text()}`;
  }
}

/** What one fired batch amounted to: the reports per instance, and how long the load took. */
interface Fired {
  readonly reports: SubmissionReport[][];
  readonly elapsedMs: number;
}

/** How long a batch has to produce its outcomes; generous, because the cases are the measurement. */
const BATCH_TIMEOUT_MS = 300_000;

/**
 * The lead the barrier gives the instances: long enough that three pipe writes and three JSON
 * parses finish before the agreed instant, short enough to pay for itself a hundred times over.
 */
const BARRIER_LEAD_MS = 60;

/** The instances of one run, armed and fired together (`conc.multi-instance`). */
class Instances {
  private constructor(
    private readonly workers: readonly Instance[],
    readonly pids: readonly number[],
  ) {}

  static async start(count: number): Promise<Instances> {
    const workers = Array.from({ length: count }, () => new Instance());
    const pids = await Promise.all(
      workers.map(async (worker) => Number(await worker.waitFor('ready ', BATCH_TIMEOUT_MS))),
    );

    return new Instances(workers, pids);
  }

  /**
   * One batch per instance, every instance starting at the same instant. Arming comes first and is
   * acknowledged, so the start is agreed by processes that have already parsed their work; only
   * then is the instant chosen and sent. Without that, the instant would have to cover the slowest
   * parse and the first instance would spend it idling.
   */
  async fire(plans: readonly (readonly WagerCommand[])[], concurrency = LANES): Promise<Fired> {
    if (plans.length > this.workers.length) {
      throw new Error(
        `${plans.length.toString()} batches were given to ${this.workers.length.toString()} instances`,
      );
    }

    const batch = uuidV7IdGenerator.next();
    const working = this.workers.flatMap((worker, index) => {
      const operations = plans[index] ?? [];

      return operations.length === 0 ? [] : [{ worker, operations }];
    });

    await Promise.all(
      working.map(({ worker, operations }) => worker.send({ arm: batch, concurrency, operations })),
    );
    await Promise.all(
      working.map(({ worker }) => worker.waitFor(`armed ${batch}`, BATCH_TIMEOUT_MS)),
    );

    const at = Date.now() + BARRIER_LEAD_MS;
    await Promise.all(working.map(({ worker }) => worker.send({ fire: batch, at })));

    const answered = await Promise.all(
      working.map(async ({ worker }) => worker.waitFor(`done ${batch} `, BATCH_TIMEOUT_MS)),
    );
    const elapsedMs = Date.now() - at;
    const reports = answered.map((line) => JSON.parse(line) as SubmissionReport[]);

    return { reports, elapsedMs };
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}

/** The outcomes of a fired batch, flattened, when which instance recorded one does not matter. */
const outcomesOf = (fired: Fired): SubmissionReport[] => fired.reports.flat();

/** Round-robins operations over the instances, so no instance owns a wallet or a stretch of them. */
function dealt(operations: readonly WagerCommand[], count = INSTANCES): WagerCommand[][] {
  const plans = Array.from({ length: count }, (): WagerCommand[] => []);

  operations.forEach((operation, index) => {
    plans[index % count]?.push(operation);
  });

  return plans;
}

interface Submission {
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly amount: string;
  readonly externalTransactionId: string;
  readonly reference?: string;
}

/** One submission as a provider sends it, with the key that identifies the operation. */
function submission({
  walletId,
  playerId,
  kind,
  amount,
  externalTransactionId,
  reference,
}: Submission): WagerCommand {
  return {
    operation: {
      providerId: PROVIDER_ID,
      externalTransactionId,
      playerId,
      walletId,
      roundId: ROUND_ID,
      gameId: 'lucky-sevens',
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: reference ?? null,
    },
    // `idem.key-recommended`: the provider's own id for the operation is the key it resends with.
    idempotencyKey: externalTransactionId,
    correlationId: CORRELATION_ID,
  };
}

/** A wallet with its player, opened through the use case and registered for the final sweep. */
async function walletWith(initialBalance: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuidV7IdGenerator.next();
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
    correlationId: CORRELATION_ID,
  });

  return { walletId: touched.add(wallet.id), playerId };
}

/** Opens `count` wallets, a few at a time, because opening them one by one dominates a large case. */
async function walletsWith(
  count: number,
  initialBalance: string,
): Promise<{ walletId: string; playerId: string }[]> {
  const opened: { walletId: string; playerId: string }[] = [];

  for (let from = 0; from < count; from += LANES) {
    opened.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(LANES, count - from) }, () => walletWith(initialBalance)),
      )),
    );
  }

  return opened;
}

/** Every wallet with what its ledger holds, in one query, since the tables hold this case alone. */
async function walletSummaries(): Promise<
  { id: string; balance: string; version: number; entries: number; debits: number }[]
> {
  return (
    await runtime.em.getConnection().execute<
      { id: string; balance: string; version: number; entries: string; debits: string }[]
    >(`select w."id",
               w."balance"::text as "balance",
               w."version",
               count(e."id")::text as "entries",
               (count(e."id") filter (where e."direction" = 'DEBIT'))::text as "debits"
          from "wallets" w
          left join "wallet_ledger_entries" e on e."wallet_id" = w."id"
         group by w."id"`)
  ).map((row) => ({ ...row, entries: Number(row.entries), debits: Number(row.debits) }));
}

/**
 * One wallet row, read by the migrator outside every transaction a case opened. It is how a case
 * observes what is committed while something else is still holding a transaction open: the role is
 * not the service's, the statement is in no transaction under test, and `READ COMMITTED` means an
 * uncommitted change is invisible to it by construction.
 */
async function walletRow(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await schema.em
    .getConnection()
    .execute<{ balance: string; version: number }[]>(
      'select "balance"::text as "balance", "version" from "wallets" where "id" = ?',
      [walletId],
    );

  if (row === undefined) {
    throw new Error(`no wallet has the id ${walletId}`);
  }

  return row;
}

/** The ledger of one wallet, as the pairs of kind and direction its entries carry, in order. */
async function ledgerOf(walletId: string): Promise<string[]> {
  const rows = await runtime.em
    .getConnection()
    .execute<{ kind: string; direction: string }[]>(
      'select "kind", "direction" from "wallet_ledger_entries" where "wallet_id" = ? order by "wallet_version"',
      [walletId],
    );

  return rows.map((row) => `${row.kind} ${row.direction}`);
}

/**
 * How many deadlocks PostgreSQL has resolved in this database. It is the server's own count, so it
 * sees a deadlock whether or not the application noticed one, which is what CONC-008 needs: an
 * aborted transaction that something retried would leave the outcomes looking correct.
 */
async function deadlocks(): Promise<number> {
  const [row] = await runtime.em
    .getConnection()
    .execute<{ deadlocks: string }[]>(
      'select "deadlocks"::text as "deadlocks" from "pg_stat_database" where "datname" = current_database()',
    );

  return Number(row?.deadlocks ?? '0');
}

/** The report of a submission that was applied or replayed, which is what most assertions read. */
function recorded(report: SubmissionReport): Extract<SubmissionReport, { status: string }> {
  if ('error' in report) {
    throw new Error(`the submission was refused with ${report.error}`);
  }

  return report;
}

const statusesOf = (reports: readonly SubmissionReport[]): string[] =>
  reports.map((report) => recorded(report).status).toSorted();

/**
 * `conc.multi-instance` (CONC-005): the instances every case below runs through are separate
 * operating-system processes. The guarantees are then shown by those cases, so what this one has to
 * establish is only that the processes are real — a suite whose "instances" were three objects in
 * one runtime would prove nothing, and would look identical from the assertions.
 */
describe('three-instances-suite', () => {
  test('the three instances are distinct processes, none of them the suite', () => {
    expect(new Set(instances.pids).size).toBe(INSTANCES);
    expect(instances.pids).not.toContain(process.pid);
  });
});

/**
 * `conc.canonical-scenario` (CONC-006): the scenario the contract names. Two bets of `80.00` reach
 * one wallet holding `100.00` at the same moment from two instances; one is afforded and one is
 * not, and which is which is the database's to decide.
 */
describe('two-bets-one-balance', () => {
  test(
    `${CANONICAL_ROUNDS.toString()} rounds of two concurrent 80.00 bets against 100.00 each end with one debit`,
    async () => {
      for (let round = 0; round < CANONICAL_ROUNDS; round += 1) {
        const { walletId, playerId } = await walletWith('100.00');
        const bets = [0, 1].map((index) =>
          submission({
            walletId,
            playerId,
            kind: 'BET',
            amount: '80.00',
            externalTransactionId: `acme-tx-${walletId}-${index.toString()}`,
          }),
        );
        const plans = bets.map((bet) => [bet]);

        const first = await instances.fire(plans);
        const outcomes = outcomesOf(first).map(recorded);

        // One of the two was afforded and the other was not, decided under the lock against the
        // balance the first one left behind (`conc.unit-wallet`).
        expect(statusesOf(outcomes)).toEqual(['PROCESSED', 'REJECTED']);
        expect(outcomes.find((outcome) => outcome.status === 'REJECTED')?.failureCode).toBe(
          'INSUFFICIENT_BALANCE',
        );
        expect(outcomes.every((outcome) => !outcome.idempotentReplay)).toBe(true);

        // The rejection is an outcome and not an effect: one debit, one version
        // (`rule.rejected.no-effect`, `wallet.version-increments-on-balance-change`).
        expect(await ledgerOf(walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
        expect(await walletSummaries()).toEqual([
          { id: walletId, balance: '20.00', version: 2, entries: 2, debits: 1 },
        ]);

        // Both resent with their own keys, again at once: each replays the outcome it recorded and
        // neither moves the balance (`idem.replay-same-outcome`).
        const retried = outcomesOf(await instances.fire(plans)).map(recorded);

        expect(statusesOf(retried)).toEqual(['PROCESSED', 'REJECTED']);
        expect(retried.every((outcome) => outcome.idempotentReplay)).toBe(true);
        expect(retried.map((outcome) => outcome.transactionId).toSorted()).toEqual(
          outcomes.map((outcome) => outcome.transactionId).toSorted(),
        );

        expect(await ledgerOf(walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
        expect(await walletSummaries()).toEqual([
          { id: walletId, balance: '20.00', version: 2, entries: 2, debits: 1 },
        ]);

        await touched.expectReconciled(runtime);
        await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
      }
    },
    BATCH_TIMEOUT_MS,
  );
});

/**
 * `conc.duplicate-storm` (CONC-007): fifty copies of one submission, in parallel, over three
 * instances. The reservation decides it — forty-nine of them block on the unique index of the
 * first one's uncommitted row, then read what it committed and replay it — so none of them ever
 * reaches the wallet lock (ADR 0004, `conc.lock-order`).
 */
describe('fifty-duplicates-one-debit', () => {
  test(
    `${STORM.toString()} parallel copies of one bet produce one debit and ${(STORM - 1).toString()} replays`,
    async () => {
      for (let round = 0; round < STORM_ROUNDS; round += 1) {
        const { walletId, playerId } = await walletWith('100.00');
        const copy = submission({
          walletId,
          playerId,
          kind: 'BET',
          amount: '40.00',
          externalTransactionId: `acme-tx-${walletId}`,
        });

        const fired = await instances.fire(dealt(Array.from({ length: STORM }, () => copy)));
        const outcomes = outcomesOf(fired).map(recorded);
        const applied = outcomes.filter((outcome) => !outcome.idempotentReplay);

        expect(outcomes).toHaveLength(STORM);
        expect(applied).toHaveLength(1);
        expect(outcomes.every((outcome) => outcome.status === 'PROCESSED')).toBe(true);

        // Every copy answers with the one transaction that was recorded, whichever instance
        // answered: the identity of the operation is the row, not the request (`idem.persistent`).
        expect([...new Set(outcomes.map((outcome) => outcome.transactionId))]).toEqual(
          applied.map((outcome) => outcome.transactionId),
        );

        // `conc.multi-instance`: the decision crossed process boundaries. The copy that applied ran
        // in one instance, and every other instance replayed it rather than applying its own.
        const appliedBy = fired.reports.findIndex((reports) =>
          reports.some((report) => !recorded(report).idempotentReplay),
        );
        expect(
          fired.reports
            .filter((_reports, index) => index !== appliedBy)
            .every((reports) => reports.every((report) => recorded(report).idempotentReplay)),
        ).toBe(true);

        // The count is scoped to the `BET`: the wallet was opened with a positive balance, so it
        // already holds its `OPENING` credit at version 1 and ends at version 2 with two entries.
        expect(await ledgerOf(walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
        expect(await walletSummaries()).toEqual([
          { id: walletId, balance: '60.00', version: 2, entries: 2, debits: 1 },
        ]);

        await touched.expectReconciled(runtime);
        await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
      }
    },
    BATCH_TIMEOUT_MS,
  );
});

/**
 * `conc.parallel-wallets` (CONC-001): the unit of concurrency is the wallet, so an operation on one
 * wallet must not wait for an operation on another.
 *
 * That is a claim about the scope of a lock, and lock scope is observed rather than timed: one
 * wallet's operation is stopped between its last statement and its commit, with everything it took
 * still held, and another wallet's operation is applied and committed while it waits. What a
 * failure then means is that the second operation could not get past the first — the narrowing
 * this case exists to refuse — and never that the machine was busy, because no assertion here
 * reads a clock. The one time value is the safety timeout that turns a blocked operation into a
 * failed case instead of a hung suite.
 *
 * Both shapes are covered, because they fall to different mutations: the second operation in
 * another process, which is where a lock wider than the row shows up, and in the same process,
 * which is the only place an application-level mutex can be seen at all. Beside them, the load the
 * acceptance scenario names — two hundred wallets taking twenty bets each, from three instances at
 * once — is the case that every wallet ends holding exactly its own operations.
 */
describe('distinct-wallets-in-parallel', () => {
  test(
    `${WALLETS.toString()} wallets taking ${BETS_PER_WALLET.toString()} bets each all apply, every wallet holding only its own`,
    async () => {
      const wallets = await walletsWith(WALLETS, '100.00');

      // Ordered by bet and then by wallet, so consecutive operations in an instance's lane belong
      // to different wallets: a run that happened to walk one wallet at a time would serialize on
      // its own and measure nothing.
      const spread = Array.from({ length: BETS_PER_WALLET }, (_unused, bet) =>
        wallets.map(({ walletId, playerId }) =>
          submission({
            walletId,
            playerId,
            kind: 'BET',
            amount: '1.00',
            externalTransactionId: `acme-tx-${walletId}-${bet.toString()}`,
          }),
        ),
      ).flat();

      const parallel = await instances.fire(dealt(spread));

      expect(outcomesOf(parallel)).toHaveLength(WALLETS * BETS_PER_WALLET);
      expect(outcomesOf(parallel).every((report) => recorded(report).status === 'PROCESSED')).toBe(
        true,
      );

      // Every wallet took exactly its own bets: its opening credit plus twenty debits.
      const summaries = await walletSummaries();
      expect(summaries).toHaveLength(WALLETS);
      expect(
        summaries.every(
          (wallet) =>
            wallet.balance === '80.00' &&
            wallet.version === BETS_PER_WALLET + 1 &&
            wallet.entries === BETS_PER_WALLET + 1 &&
            wallet.debits === BETS_PER_WALLET,
        ),
      ).toBe(true);
    },
    BATCH_TIMEOUT_MS,
  );

  /** A promise and the call that resolves it: one direction of the handshake with a held operation. */
  function signal(): { awaited: Promise<void>; send: () => void } {
    let send!: () => void;
    const awaited = new Promise<void>((resolve) => {
      send = (): void => {
        resolve();
      };
    });

    return { awaited, send };
  }

  /**
   * The production unit of work with one addition: the transaction it is armed for stops between
   * its last statement and its commit, and resumes when the case releases it. Everything up to
   * that point is the service's own — the reservation, the lock statement of ADR 0002 in its fixed
   * place, the decision and the writes — so what stays held while the case submits elsewhere is the
   * real lock of a real operation and not a hand-written `SELECT ... FOR NO KEY UPDATE` standing in
   * for one. The difference is the point of the case: a stand-in would still be taken if the
   * service's own lock were widened or replaced, and nothing would notice.
   *
   * Every other transaction passes straight through, the ones the same instance opens while the
   * held one waits included. That is what lets one `SubmitWagerTransaction` apply both operations
   * of the same-instance case, so a mutex anywhere in the path — around the module, in the
   * instance, inside the unit of work — is held by the stopped operation and the second submission
   * cannot pass it.
   */
  class HoldingUnitOfWork implements UnitOfWork {
    private readonly arrived = signal();
    private readonly released = signal();
    private arming = false;

    constructor(private readonly inner: UnitOfWork) {}

    /** Resolves once the armed transaction has run its last statement and is waiting to commit. */
    get reached(): Promise<void> {
      return this.arrived.awaited;
    }

    /** Arms the hold on the next transaction, and answers the call that lets it commit. */
    holdNext(): () => void {
      this.arming = true;

      return this.released.send;
    }

    transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
      if (!this.arming) {
        return this.inner.transactional(work);
      }

      this.arming = false;

      return this.inner.transactional(async (repositories) => {
        const done = await work(repositories);
        this.arrived.send();
        await this.released.awaited;

        return done;
      });
    }

    snapshot<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
      return this.inner.snapshot(work);
    }
  }

  /** One instance of the service in this process: the use case, and the hold on its unit of work. */
  interface HoldingInstance {
    readonly submit: SubmitWagerTransaction;
    readonly holder: HoldingUnitOfWork;
  }

  /**
   * An instance in the suite's own process, wired from the same parts as the worker's
   * (`submitterOf` in `test/helpers/wager-command.ts`) with the hold around its unit of work.
   */
  function instanceHere(): HoldingInstance {
    const holder = new HoldingUnitOfWork(new MikroOrmUnitOfWork(runtime.em, LOCK_CEILING_MS));

    return {
      holder,
      submit: new SubmitWagerTransaction({
        unitOfWork: holder,
        clock: systemClock,
        ids: uuidV7IdGenerator,
        sha256Hex,
        logger: silentLogger,
        metrics: uncountedMetrics,
      }),
    };
  }

  /**
   * `work`, or a failure within `UNBLOCKED_MS` naming what did not finish. The bound asserts
   * nothing about speed: it is what makes a blocked operation fail the case, which it would
   * otherwise do only when the lock ceiling expired, or never at all if a mutex was what blocked it.
   */
  async function unblocked<T>(what: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${what} did not finish within ${UNBLOCKED_MS.toString()} ms while another wallet's operation held its transaction open`,
          ),
        );
      }, UNBLOCKED_MS);
    });

    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Submits `holdOn` through an instance of its own, stops it with its transaction open, runs `act`
   * while it waits and then lets it commit. Answers the outcome the held submission recorded, so a
   * case can assert that being held changed it in no way.
   */
  async function holdingMidTransaction(
    holdOn: WagerCommand,
    act: (instance: HoldingInstance) => Promise<void>,
  ): Promise<SubmissionOutcome> {
    const instance = instanceHere();
    const release = instance.holder.holdNext();
    const holding = instance.submit.execute(wagerCommandSchema.parse(holdOn));

    // Either the hold is in place, or the held submission failed before reaching it: waiting on the
    // barrier alone would spend the case's whole timeout on a submission that is never coming.
    await Promise.race([instance.holder.reached, holding]);

    try {
      await act(instance);
    } finally {
      // Unconditional, so a failure in `act` leaves no transaction open and no promise pending
      // behind the case; the held outcome is still what this returns, rejection included.
      release();
      await holding.catch(() => undefined);
    }

    return holding;
  }

  /**
   * The observation CONC-001 rests on, in whichever shape `applyFree` submits the second operation:
   * one wallet's operation is held with its transaction open, another wallet's operation is applied
   * while it waits, and each wallet ends as its own operation left it.
   *
   * `applyFree` answers the statuses it recorded, which is all the two shapes have in common — one
   * reads them off a pipe from another process, the other off an outcome in this one.
   */
  async function anotherWalletMovesWhileOneIsHeld(
    applyFree: (instance: HoldingInstance, free: WagerCommand) => Promise<string[]>,
  ): Promise<void> {
    const stopped = await walletWith('100.00');
    const free = await walletWith('100.00');

    const held = await holdingMidTransaction(
      submission({
        ...stopped,
        kind: 'BET',
        amount: '30.00',
        externalTransactionId: `acme-tx-${stopped.walletId}`,
      }),
      async (instance) => {
        expect(
          await applyFree(
            instance,
            submission({
              ...free,
              kind: 'BET',
              amount: '40.00',
              externalTransactionId: `acme-tx-${free.walletId}`,
            }),
          ),
        ).toEqual(['PROCESSED']);

        // Read by the migrator while the hold is still in place, which is the observation itself:
        // the free wallet's debit is committed and the held wallet's is not, so the operation that
        // did not wait is the one that committed, and the transaction it did not wait for is still
        // open with its lock.
        expect(await walletRow(free.walletId)).toEqual({ balance: '60.00', version: 2 });
        expect(await walletRow(stopped.walletId)).toEqual({ balance: '100.00', version: 1 });
      },
    );

    // Being held changed the held submission in no way: it commits its own outcome afterwards.
    expect(held.transaction.status).toBe('PROCESSED');
    expect(held.idempotentReplay).toBe(false);

    expect(await walletRow(stopped.walletId)).toEqual({ balance: '70.00', version: 2 });
    expect(await ledgerOf(stopped.walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
    expect(await ledgerOf(free.walletId)).toEqual(['OPENING CREDIT', 'BET DEBIT']);
  }

  /**
   * Across processes, which is the shape a database lock wider than the wallet row falls to: the
   * held operation is in this process and the one that must not wait for it is in a worker, so
   * nothing the two share is in a heap. A table lock or an advisory lock taken by the held
   * operation stops the worker's bet here, and the wait is reported instead of being averaged away.
   */
  test(
    "a bet on another wallet commits in another process while one wallet's operation is held mid-transaction",
    () =>
      anotherWalletMovesWhileOneIsHeld(async (_instance, free) =>
        statusesOf(
          outcomesOf(await unblocked('the bet in another instance', instances.fire([[free]]))),
        ),
      ),
    UNBLOCKED_MS * 2,
  );

  /**
   * Inside one process, which is the shape an application-level mutex falls to and the one a
   * cross-process case cannot see at all: both operations are applied by the same
   * `SubmitWagerTransaction`, on the same instance, in the suite's own runtime. A mutex held across
   * the submission — in the use case, in the unit of work, in a module around either — is held by
   * the stopped operation, and the second bet never reaches the database.
   */
  test(
    "a bet on another wallet commits in the same instance while one wallet's operation is held mid-transaction",
    () =>
      anotherWalletMovesWhileOneIsHeld(async ({ submit }, free) => [
        (
          await unblocked(
            'the bet in the same instance',
            submit.execute(wagerCommandSchema.parse(free)),
          )
        ).transaction.status,
      ]),
    UNBLOCKED_MS * 2,
  );
});

/**
 * `conc.lock-order` (CONC-008): the order inside the financial transaction is fixed, and with the
 * lock mode of `conc.row-lock` it is deadlock-free. The load that would expose a variable order is
 * a mix on one wallet — bets, duplicates of them and reversals that take the wallet lock and then
 * read another row of the transactions table — from three instances at once.
 *
 * The evidence is PostgreSQL's own deadlock counter and not the absence of an error in the
 * outcomes: a deadlock that something retried would leave every outcome looking correct.
 */
describe('mixed-load-no-deadlock', () => {
  test(
    'bets, duplicates and reversals on one wallet from three instances raise no deadlock',
    async () => {
      const { walletId, playerId } = await walletWith('1000.00');
      const before = await deadlocks();

      const targets = Array.from({ length: MIXED_TARGETS }, (_unused, index) =>
        submission({
          walletId,
          playerId,
          kind: 'BET',
          amount: '1.00',
          externalTransactionId: `acme-tx-${walletId}-bet-${index.toString()}`,
        }),
      );

      expect(
        outcomesOf(await instances.fire(dealt(targets))).every(
          (report) => recorded(report).status === 'PROCESSED',
        ),
      ).toBe(true);

      /**
       * The mix. Every target is named by a `REFUND` and by a `ROLLBACK` at once, which is the
       * hardest ordering for the lock: both take the wallet lock and then read the same reversal
       * rows, so exactly one of each pair may be processed (`rule.reference.reversed-once`) and the
       * other is refused for the right reason rather than by a deadlock.
       */
      const mixed = targets.flatMap((target, index) => [
        target,
        submission({
          walletId,
          playerId,
          kind: 'BET',
          amount: '1.00',
          externalTransactionId: `acme-tx-${walletId}-late-${index.toString()}`,
        }),
        submission({
          walletId,
          playerId,
          kind: 'REFUND',
          amount: '1.00',
          externalTransactionId: `acme-tx-${walletId}-refund-${index.toString()}`,
          reference: target.operation.externalTransactionId,
        }),
        submission({
          walletId,
          playerId,
          kind: 'ROLLBACK',
          amount: '1.00',
          externalTransactionId: `acme-tx-${walletId}-rollback-${index.toString()}`,
          reference: target.operation.externalTransactionId,
        }),
      ]);

      const outcomes = outcomesOf(await instances.fire(dealt(mixed))).map(recorded);

      expect(outcomes).toHaveLength(mixed.length);
      expect(await deadlocks()).toBe(before);

      // The outcomes are counted rather than matched to the operation that produced them, because
      // which instance applied which is the database's to decide and the dealing is round-robin.
      // Each target was reversed once and refused once, whichever reversal kind won the race, so
      // the counts are exact: the duplicates replayed, the late bets applied, one reversal per
      // target was processed, and the other was refused for the one reason it can be.
      expect({
        replayed: outcomes.filter((outcome) => outcome.idempotentReplay).length,
        processed: outcomes.filter((outcome) => outcome.status === 'PROCESSED').length,
        alreadyReversed: outcomes.filter(
          (outcome) => outcome.failureCode === 'REFERENCE_ALREADY_REVERSED',
        ).length,
      }).toEqual({
        replayed: MIXED_TARGETS,
        processed: MIXED_TARGETS * 3,
        alreadyReversed: MIXED_TARGETS,
      });

      // The balance is what the ledger says: 1000 - 30 bets - 30 late bets + 30 reversals of 1.00.
      expect(await walletSummaries()).toEqual([
        {
          id: walletId,
          balance: '970.00',
          version: MIXED_TARGETS * 3 + 1,
          entries: MIXED_TARGETS * 3 + 1,
          debits: MIXED_TARGETS * 2,
        },
      ]);
    },
    BATCH_TIMEOUT_MS,
  );
});

/**
 * `recon.snapshot` (RECON-001): reconciliation is consistent under concurrent writes and never
 * blocks them. The deterministic half — a competing balance change committed between the two
 * readings of one report — is `wallet-reconciliation.test.ts`; what this adds is the load, which is
 * the only thing that can show the loop costing the betting nothing.
 */
describe('reconciliation-under-load', () => {
  /**
   * Reconciles one wallet over and over until it is told to stop, keeping every report. It runs in
   * the suite's process and the betting runs in three others, so nothing but PostgreSQL decides
   * what a report sees.
   */
  function reconcilingContinuously(walletId: string): {
    reports: ReconciliationReport[];
    stop: () => Promise<void>;
  } {
    const reports: ReconciliationReport[] = [];
    let reconciling = true;
    // Read through a call, because the flag is cleared from outside the loop, as the consumer's own
    // `running` is.
    const running = (): boolean => reconciling;

    const loop = (async (): Promise<void> => {
      while (running()) {
        reports.push(await reconcileWallet.execute(walletId));
      }
    })();

    return {
      reports,
      stop: async () => {
        reconciling = false;
        await loop;
      },
    };
  }

  test(
    `${RECONCILED_BETS.toString()} bets on one wallet stay consistent while it is reconciled continuously`,
    async () => {
      const bets = (walletId: string, playerId: string): WagerCommand[] =>
        Array.from({ length: RECONCILED_BETS }, (_unused, index) =>
          submission({
            walletId,
            playerId,
            kind: 'BET',
            amount: '1.00',
            externalTransactionId: `acme-tx-${walletId}-${index.toString()}`,
          }),
        );

      const reconciled = await walletWith('1000.00');
      const loop = reconcilingContinuously(reconciled.walletId);
      const underReconciliation = await instances.fire(
        dealt(bets(reconciled.walletId, reconciled.playerId)),
      );
      await loop.stop();

      expect(
        outcomesOf(underReconciliation).every((report) => recorded(report).status === 'PROCESSED'),
      ).toBe(true);

      // Every report is consistent, and they were taken while the balance was moving rather than
      // all before it or all after it: the versions they saw span the load.
      expect(loop.reports.filter((report) => !report.consistent)).toEqual([]);
      expect(loop.reports.length).toBeGreaterThan(10);
      expect(new Set(loop.reports.map((report) => report.checkedEntries)).size).toBeGreaterThan(10);

      // The same load on a wallet nobody is reconciling, as the cost to compare against.
      const alone = await walletWith('1000.00');
      const undisturbed = await instances.fire(dealt(bets(alone.walletId, alone.playerId)));

      expect(
        outcomesOf(undisturbed).every((report) => recorded(report).status === 'PROCESSED'),
      ).toBe(true);
      expect(underReconciliation.elapsedMs).toBeLessThan(
        undisturbed.elapsedMs * RECONCILIATION_OVERHEAD,
      );
    },
    BATCH_TIMEOUT_MS,
  );
});
