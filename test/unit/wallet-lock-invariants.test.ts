import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The three concurrency rules that are statements about the code rather than about a run
 * (CONC-004, and the lock mode of CONC-009): no lock is shared by all wallets, every row lock the
 * service takes is one of the two reviewed ones, and the balance is written in exactly one place,
 * under the version guard, by the one use case that holds the lock.
 *
 * They are checked over the source because that is where they are true or false. A race test can
 * only show that today's paths serialize; it cannot show that tomorrow's second writer does not
 * exist. An advisory lock, a `LOCK TABLE`, a wallet locked `FOR UPDATE` or an `UPDATE wallets`
 * added somewhere else would each leave every scenario in `test/concurrency` green and break the
 * guarantee, so the check that catches them has to read the files (`conc.no-global-lock`,
 * `conc.no-unguarded-rmw`, `conc.row-lock`).
 *
 * Comments are stripped before anything is matched. The prose of ADR 0002 lives in those comments
 * and names `FOR UPDATE` repeatedly to explain why it is not used; a scanner that read it would
 * report the explanation as the defect.
 */

const SRC = path.join(import.meta.dirname, '../../src');

/** Hand-written DDL, which is where the schema's own locking and its `wallets` writes belong. */
const MIGRATIONS = `persistence${path.sep}migrations${path.sep}`;

const WALLET_REPOSITORY = path.join(
  'infrastructure',
  'persistence',
  'repositories',
  'wallet.repository.ts',
);
const OUTBOX_REPOSITORY = path.join(
  'infrastructure',
  'persistence',
  'repositories',
  'outbox.repository.ts',
);
const SCHEDULE_REPOSITORY = path.join(
  'infrastructure',
  'persistence',
  'repositories',
  'pending-reference-schedule.repository.ts',
);
const APPLY_OPERATION = path.join('application', 'apply-wager-operation.ts');
const SUBMIT_USE_CASE = path.join('application', 'use-cases', 'submit-wager-transaction.ts');
const REPROCESS_USE_CASE = path.join('application', 'use-cases', 'reprocess-pending-reference.ts');

/** `//` to end of line, and `/* ... *\/`, the two forms this codebase documents itself with. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * A row-locking clause, in any of the spellings PostgreSQL accepts: the four modes, the optional
 * `OF <table>` that names which table of a join is locked, and the two wait modifiers. Each part is
 * optional in the grammar and none of them may be missed, because a clause this pattern matched
 * only half of would be reported as a different lock than it is.
 */
const ROW_LOCK =
  /\bfor\s+(no\s+key\s+update|update|key\s+share|share)\b(\s+of\s+"?\w+"?)?(\s+skip\s+locked|\s+nowait)?/gi;

/** A lock no single row owns: the advisory functions, and a table-level lock. */
const GLOBAL_LOCK = /\bpg_(try_)?advisory_[a-z_]*lock\b|\block\s+table\b/gi;

/** A write to the wallets table, as raw SQL or through the row mapping's query builder. */
const WALLET_WRITE =
  /\b(update|insert\s+into|delete\s+from)\s+"?wallets"?|createQueryBuilder\(\s*WalletRow\s*\)/gi;

interface SourceFile {
  readonly file: string;
  readonly code: string;
}

function sources(): SourceFile[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.includes(MIGRATIONS))
    .map((file) => ({
      file,
      code: readFileSync(path.join(SRC, file), 'utf8').replaceAll(COMMENTS, ' '),
    }));
}

/** Every match of `pattern` in the service's code, as `file: matched text`, lower-cased. */
function occurrences(pattern: RegExp): string[] {
  return sources()
    .flatMap(({ file, code }) =>
      [...code.matchAll(pattern)].map((match) => `${file}: ${match[0].replace(/\s+/g, ' ')}`),
    )
    .map((occurrence) => occurrence.toLowerCase())
    .toSorted();
}

describe('wallet-concurrency-is-structural', () => {
  test('the scan reaches the code, so an empty result cannot pass a rule by accident', () => {
    const files = sources();

    expect(files.length).toBeGreaterThan(40);
    expect(files.some(({ file }) => file.endsWith('wallet.repository.ts'))).toBe(true);
    expect(files.every(({ code }) => !code.includes('conc.row-lock'))).toBe(true);
  });

  /**
   * `conc.no-global-lock`: contention is per wallet row and nothing else. An advisory lock keyed on
   * anything, or a lock on the table, would serialize wallets that have no reason to wait for each
   * other and would make `conc.parallel-wallets` unprovable however the use case is written.
   */
  test('no advisory lock and no table lock exists anywhere in the service', () => {
    expect(occurrences(GLOBAL_LOCK)).toEqual([]);
  });

  /**
   * `conc.row-lock`: every row lock the service takes, named with the file that takes it.
   *
   * - The wallet lock is `FOR NO KEY UPDATE`, because `FOR UPDATE` conflicts with the
   *   `FOR KEY SHARE` the reservation's foreign key holds on the same row and the pair deadlocks
   *   (ADR 0002, proven in `test/integration/wallet-lock.test.ts`).
   * - The outbox claim is `FOR UPDATE SKIP LOCKED`, which is ADR 0005's protocol.
   * - The scheduler's claim is `FOR UPDATE OF "s" SKIP LOCKED`: the same protocol, with `OF`
   *   naming the schedule row so the transaction it joins is read without being locked. It takes
   *   the wallet lock afterwards, like the reservation does, so it joins the fixed order rather
   *   than adding one.
   *
   * The assertion is the whole set rather than the absence of `FOR UPDATE` on wallets: a row lock
   * added anywhere has to be considered against the fixed order of `conc.lock-order`, and extending
   * this list is how that consideration is recorded.
   */
  test('every row lock is one of the three reviewed ones, in its reviewed mode', () => {
    expect(occurrences(ROW_LOCK)).toEqual([
      `${OUTBOX_REPOSITORY.toLowerCase()}: for update skip locked`,
      `${SCHEDULE_REPOSITORY.toLowerCase()}: for update of "s" skip locked`,
      `${WALLET_REPOSITORY.toLowerCase()}: for no key update`,
    ]);
  });

  /**
   * `conc.no-unguarded-rmw`: one writer of the balance, and it is the one that holds the lock. The
   * wallet repository is the only place that writes the table, so there is no path that could read,
   * compute and write a balance without taking the lock first.
   */
  test('the wallet repository is the only writer of the wallets table', () => {
    const writers = new Set(
      occurrences(WALLET_WRITE).map((occurrence) => occurrence.split(':')[0] ?? ''),
    );

    expect([...writers]).toEqual([WALLET_REPOSITORY.toLowerCase()]);
  });

  /**
   * `conc.version-guard`: the balance update matches the row only while it still carries the
   * version the lock read, so a write that bypassed the lock fails instead of overwriting a
   * balance someone else computed. The integration suite proves the behaviour; this proves the
   * clause cannot be dropped while the statement stays.
   */
  test('the balance update is constrained by the version the lock read', () => {
    const repository = readFileSync(path.join(SRC, WALLET_REPOSITORY), 'utf8').replaceAll(
      COMMENTS,
      ' ',
    );

    expect(repository).toMatch(/\.where\(\s*\{[^}]*\bversion:\s*expectedVersion\b[^}]*\}\s*\)/);
  });

  /**
   * `conc.lock-order`: who may take the lock, and who may write the balance behind it.
   *
   * Two paths take it — a submission and a scheduled attempt on a parked one — and each is
   * preceded by a claim of its own: the reservation insert for the first, the schedule claim for
   * the second. Which order each follows is asserted on the use cases themselves, in
   * `submit-wager-transaction.test.ts` and `reprocess-pending-reference.test.ts`; what this adds is
   * that there is no third path, and that the balance is written in one place both of them share,
   * so the guarded update cannot come to exist twice with two notions of the expected version.
   */
  test('only the two operation paths take the lock, and one shared step writes the balance', () => {
    const callers = (method: string): string[] =>
      sources()
        .filter(({ code }) => code.includes(`wallets.${method}(`))
        .map(({ file }) => file)
        .toSorted();

    expect(callers('lockById')).toEqual([REPROCESS_USE_CASE, SUBMIT_USE_CASE].toSorted());
    expect(callers('update')).toEqual([APPLY_OPERATION]);
  });
});
