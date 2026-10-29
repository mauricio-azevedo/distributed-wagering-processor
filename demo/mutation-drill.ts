/**
 * Three invariants of this service, each broken on purpose, with the cases that catch it run
 * against the break. It is the other half of [walkthrough.ts](walkthrough.ts): that one shows the
 * guarantees holding, this one shows what the suites do when they stop holding.
 *
 * Usage: `make drill`. Each mutation is applied to one file, only the affected cases are run, their
 * failure is what the drill asserts, and the file is restored before the next one — in a trap, so
 * an interrupt or a failure cannot leave a mutated file behind, and verified against the index
 * afterwards. It refuses to start unless the files it edits are as committed.
 *
 * What it is for is the claim a passing suite cannot make: that the case would notice. A
 * concurrency test that never sees the race it names passes exactly like one that does, and the
 * three mutations here are the three mistakes this design was chosen against (ADR 0002) — the lock
 * removed, the lock replaced by an application-level mutex, and the lock taken in the mode that
 * deadlocks. docs/demonstrations.md records what each one proves.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** One `bun test` run: the cases named by `pattern`, and the result the mutation should give them. */
interface Run {
  readonly tests: string;
  readonly pattern: string;
  readonly expect: 'fail' | 'pass';
  readonly claim: string;
}

interface Mutation {
  readonly title: string;
  /** What changed, in the file's own words, so the reader can picture the edit without reading it. */
  readonly change: string;
  readonly file: string;
  readonly edits: readonly { readonly from: string; readonly to: string }[];
  readonly runs: readonly Run[];
}

const WALLET_REPOSITORY = 'src/infrastructure/persistence/repositories/wallet.repository.ts';
const UNIT_OF_WORK = 'src/infrastructure/persistence/mikro-orm.unit-of-work.ts';
const CONTENTION = 'test/concurrency/wallet-contention.test.ts';
const STRUCTURAL = 'test/unit/wallet-lock-invariants.test.ts';
const LOCK = 'test/integration/wallet-lock.test.ts';

/** The locking select of the wallet repository, which two of the three mutations edit. */
const LOCK_CLAUSE = '\n                        for no key update`;';

const MUTATIONS: readonly Mutation[] = [
  {
    title: 'The wallet row lock, removed',
    change: '"for no key update" dropped from the locking select',
    file: WALLET_REPOSITORY,
    edits: [{ from: LOCK_CLAUSE, to: '`;' }],
    runs: [
      {
        tests: STRUCTURAL,
        pattern: 'every row lock is one of the three reviewed ones',
        expect: 'fail',
        claim: 'the structural check notices the lock is gone, without running anything',
      },
      {
        tests: CONTENTION,
        pattern: 'two concurrent 80.00 bets',
        expect: 'fail',
        claim: 'two bets on one balance stop ending as one debit',
      },
    ],
  },
  {
    title: 'A process-local mutex in place of the lock',
    change: 'every transaction queued behind the previous one, in the unit of work',
    file: UNIT_OF_WORK,
    edits: [
      {
        from: 'const DEFAULT_LOCK_TIMEOUT_MS = 3000;',
        to: `const DEFAULT_LOCK_TIMEOUT_MS = 3000;

let previous: Promise<unknown> = Promise.resolve();`,
      },
      {
        from: `  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.classifying(() =>
      this.em.fork({ clear: true }).transactional(async (transactional) => {
        await transactional.execute(\`set local lock_timeout = \${this.lockTimeoutMs.toString()}\`);

        return work(repositoriesOf(transactional));
      }),
    );
  }`,
        to: `  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const run = (): Promise<T> =>
      this.classifying(() =>
        this.em.fork({ clear: true }).transactional(async (transactional) => {
          await transactional.execute(\`set local lock_timeout = \${this.lockTimeoutMs.toString()}\`);

          return work(repositoriesOf(transactional));
        }),
      );

    const queued = previous.then(run, run);
    previous = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  }`,
      },
    ],
    runs: [
      {
        tests: CONTENTION,
        pattern: 'in the same instance',
        expect: 'fail',
        claim: 'a wallet waits for an unrelated wallet inside one process',
      },
      {
        tests: CONTENTION,
        pattern: 'in another process',
        expect: 'pass',
        claim: 'and a case across processes cannot see it, which is why both exist',
      },
    ],
  },
  {
    title: 'The wallet lock as FOR UPDATE',
    change: 'the mode ADR 0002 rejected, in place of "for no key update"',
    file: WALLET_REPOSITORY,
    edits: [{ from: LOCK_CLAUSE, to: '\n                        for update`;' }],
    runs: [
      {
        tests: STRUCTURAL,
        pattern: 'every row lock is one of the three reviewed ones',
        expect: 'fail',
        claim: 'the structural check pins the mode and not just the clause',
      },
      {
        tests: LOCK,
        pattern: 'ten pairs serialize',
        expect: 'fail',
        claim: 'two submissions on one wallet deadlock instead of queueing',
      },
    ],
  },
];

/** The content every mutated file is restored to, held from before the first edit. */
const committed = new Map<string, string>();

function absolute(file: string): string {
  return path.join(ROOT, file);
}

function git(...args: string[]): string {
  const { success, stdout, stderr } = Bun.spawnSync(['git', ...args], { cwd: ROOT });
  if (!success) {
    throw new Error(`git ${args.join(' ')} failed:\n${stderr.toString()}`);
  }

  return stdout.toString();
}

/**
 * Puts every mutated file back. Registered as a trap and run again after each mutation, so an
 * interrupt, a crash and the ordinary path all leave the tree as they found it.
 */
function restore(): void {
  for (const [file, content] of committed) {
    writeFileSync(absolute(file), content);
  }
  committed.clear();
}

process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

let failures = 0;

function shows(claim: string, held: boolean, counts: string): void {
  if (held) {
    console.log(`  ✓ ${claim}: ${counts}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${claim}: ${counts}`);
  }
}

function refuse(reason: string, next: string): never {
  console.error(`✗ ${reason}\nNext: ${next}`);
  process.exit(1);
}

/**
 * The files the drill edits, as they stand against the index. Only those files: the rest of the
 * tree is none of its business, and a reviewer reading an unrelated change should still be able to
 * run it.
 */
function assertCommitted(): void {
  const files = [...new Set(MUTATIONS.map(({ file }) => file))];
  const changed = git('status', '--porcelain', '--', ...files)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(3));

  if (changed.length > 0) {
    refuse(
      `the drill would overwrite uncommitted work in ${changed.join(', ')}`,
      `git diff -- ${changed.join(' ')}`,
    );
  }
}

function apply({ file, edits }: Mutation): void {
  const source = readFileSync(absolute(file), 'utf8');
  committed.set(file, source);

  const mutated = edits.reduce((text, { from, to }) => {
    const occurrences = text.split(from).length - 1;
    if (occurrences !== 1) {
      refuse(
        `the drill expected one place to edit in ${file} and found ${occurrences.toString()}, so it changed nothing`,
        `read ${file} and update demo/mutation-drill.ts to what it says now`,
      );
    }

    return text.replace(from, to);
  }, source);

  writeFileSync(absolute(file), mutated);
}

interface Result {
  readonly pass: number;
  readonly fail: number;
  readonly reported: readonly string[];
}

/**
 * Runs `pattern` of `tests` through `make test`, which is the gate's own isolation: the suites'
 * database and the suites' queues, never the stack's (`ops.suite-isolation`). The output is read
 * rather than shown, so what reaches the reader is the lines bun wrote about the cases and nothing
 * about Compose.
 */
function runCases({ tests, pattern }: Run): Result {
  const { stdout, stderr } = Bun.spawnSync(['make', 'test', `TESTS=${tests} -t '${pattern}'`], {
    cwd: ROOT,
  });
  const output = stdout.toString() + stderr.toString();
  const counted = (what: 'pass' | 'fail'): number =>
    Number(new RegExp(`^\\s*(\\d+) ${what}$`, 'm').exec(output)?.[1] ?? '0');

  return {
    pass: counted('pass'),
    fail: counted('fail'),
    reported: [...output.matchAll(/^\(fail\) .+$/gm)].map(([line]) => line),
  };
}

assertCommitted();

console.log(
  'Three invariants broken one at a time, each with the cases that catch it. Every file is restored before the next.',
);

for (const [index, mutation] of MUTATIONS.entries()) {
  console.log(`\n${String(index + 1)}. ${mutation.title}`);
  console.log(`   ${path.basename(mutation.file)}: ${mutation.change}\n`);
  apply(mutation);

  for (const run of mutation.runs) {
    const { pass, fail, reported } = runCases(run);
    for (const line of reported) {
      console.log(`  ${line}`);
    }

    const ran = pass + fail;
    const held = ran > 0 && (run.expect === 'fail' ? fail > 0 : fail === 0);
    shows(
      run.claim,
      held,
      ran === 0
        ? `no case of ${path.basename(run.tests)} is named "${run.pattern}"`
        : `${String(pass)} pass, ${String(fail)} fail`,
    );
  }

  restore();
  const dirty = git('status', '--porcelain', '--', mutation.file).trim();
  if (dirty !== '') {
    refuse(
      `${mutation.file} was mutated and could not be put back`,
      `git checkout -- ${mutation.file}`,
    );
  }
  console.log(`  ✓ ${path.basename(mutation.file)} is as committed again`);
}

console.log(
  failures === 0
    ? '\nEvery mutation was caught by the cases that name it, and no file was left changed.'
    : `\n${String(failures)} claim(s) did not hold. No file was left changed.`,
);
process.exit(failures === 0 ? 0 : 1);
