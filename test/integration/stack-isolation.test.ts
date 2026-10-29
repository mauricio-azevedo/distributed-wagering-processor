import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { loadEnv } from '../../src/infrastructure/config/env';
import {
  WAGER_INTEGRATION_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  type WagerQueues,
  wagerQueues,
} from '../../src/infrastructure/messaging/sqs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const STACK_SH = path.join(ROOT, 'docker', 'stack.sh');

/** The ports a single checkout publishes, which is what slot 0 keeps. */
const SINGLE_CHECKOUT_PORTS = {
  HTTP_PORT: '3000',
  POSTGRES_PORT: '5433',
  LOCALSTACK_PORT: '4566',
} as const;

const PORT_VARIABLES = Object.keys(SINGLE_CHECKOUT_PORTS);

/** Where Linux starts handing out source ports, so a port bound below it cannot be taken first. */
const EPHEMERAL_FLOOR = 32768;

/**
 * Only what a child needs to run, so a variable `make` exported for this checkout never leaks into
 * a case that asserts what happens without it.
 */
const BARE_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
};

/** Keeps the fixture repositories off the developer's git configuration, hooks included. */
const FIXTURE_GIT_ENV: Record<string, string> = {
  ...BARE_ENV,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function run(
  command: readonly string[],
  { cwd = ROOT, env = BARE_ENV }: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const { success, stdout, stderr } = Bun.spawnSync([...command], { cwd, env });
  if (!success) {
    throw new Error(`${command.join(' ')} failed in ${cwd}:\n${stderr.toString()}`);
  }
  return stdout.toString().trim();
}

interface Stack {
  readonly project: string;
  readonly slot: number;
}

/** What `docker/stack.sh` answers for a checkout: its stack, and the three ports of its slot. */
interface Chosen extends Stack {
  readonly ports: Record<string, string>;
}

function chosenStack(directory: string, env: Record<string, string> = BARE_ENV): Chosen {
  const [project = '', slot = '', ...published] = run([STACK_SH], { cwd: directory, env }).split(
    ' ',
  );

  return {
    project,
    slot: Number(slot),
    ports: Object.fromEntries(
      PORT_VARIABLES.map((variable, index) => [variable, published[index] ?? '']),
    ),
  };
}

function stackOf(directory: string, env: Record<string, string> = BARE_ENV): Stack {
  const { project, slot } = chosenStack(directory, env);

  return { project, slot };
}

/** What `docker/stack.sh` says for itself, which is where a slot it moved to is announced. */
function noticeOf(directory: string, env: Record<string, string> = BARE_ENV): string {
  const { success, stderr } = Bun.spawnSync([STACK_SH], { cwd: directory, env });
  if (!success) {
    throw new Error(`${STACK_SH} failed in ${directory}:\n${stderr.toString()}`);
  }

  return stderr.toString();
}

/** Holds `ports` for the duration of `body`, as another checkout's containers would hold them. */
function occupying(ports: readonly string[], body: () => void): void {
  const listeners = ports.map((port) =>
    Bun.listen({ hostname: '127.0.0.1', port: Number(port), socket: { data: () => undefined } }),
  );

  try {
    body();
  } finally {
    for (const listener of listeners) {
      listener.stop(true);
    }
  }
}

/**
 * Publishes `port` from a container labelled as `project`'s, for the duration of `body`: what a
 * second `make up` on a checkout whose stack is already running meets. The image is the one the
 * dependencies already run, so nothing is pulled for this.
 */
function publishing(port: string, project: string, body: () => void): void {
  const container = run([
    'docker',
    'run',
    '--detach',
    '--rm',
    '--label',
    `com.docker.compose.project=${project}`,
    '--publish',
    `${port}:9`,
    '--entrypoint',
    'sleep',
    'postgres:18-alpine',
    '120',
  ]);

  try {
    body();
  } finally {
    run(['docker', 'rm', '--force', container]);
  }
}

/**
 * A repository whose main worktree is `name`, with one linked worktree per entry of `worktrees`,
 * created in that order. Every path is a sibling, as `.claude/worktrees` is not: the helper reads
 * the worktree list, not the directory layout.
 */
function withRepository(
  name: string,
  worktrees: readonly string[],
  body: (paths: { readonly main: string; readonly linked: readonly string[] }) => void,
): void {
  const base = mkdtempSync(path.join(tmpdir(), 'stack-isolation-'));
  const main = path.join(base, name);
  mkdirSync(main);
  const git = (...args: string[]) => run(['git', ...args], { cwd: main, env: FIXTURE_GIT_ENV });

  try {
    git('init', '--initial-branch=main', '--quiet');
    git(
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '--allow-empty',
      '--quiet',
      '--message=root',
    );
    const linked = worktrees.map((worktree) => path.join(base, worktree));
    for (const worktree of linked) {
      git('worktree', 'add', '--detach', '--quiet', worktree);
    }

    body({ main, linked });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const portSchema = z.object({ target: z.number(), published: z.string() });
const serviceSchema = z.object({ image: z.string(), ports: z.array(portSchema) });
/** A role of the service image: what it is configured with matters here, not what it publishes. */
const roleSchema = z.object({ environment: z.record(z.string(), z.string()) });
const composeSchema = z.object({
  name: z.string(),
  services: z.object({
    api: serviceSchema.extend(roleSchema.shape),
    worker: roleSchema,
    migrate: roleSchema,
    postgres: serviceSchema,
    localstack: serviceSchema,
  }),
});

/** `compose.yaml` resolved against `env` alone: `--env-file /dev/null` keeps `.env` out of it. */
function composeConfig(env: Record<string, string>) {
  const raw: unknown = JSON.parse(
    run(['docker', 'compose', '--env-file', '/dev/null', 'config', '--format', 'json'], {
      env: { ...BARE_ENV, ...env },
    }),
  );

  return composeSchema.parse(raw);
}

function publishedPort(service: z.infer<typeof serviceSchema>, target: number): string | undefined {
  return service.ports.find((port) => port.target === target)?.published;
}

/** The variables `make` exports for this checkout, or for `overrides`, as `make stack` reports. */
function makeStack(overrides: readonly string[] = []): Record<string, string> {
  return Object.fromEntries(
    run(['make', '--silent', 'stack', ...overrides])
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');

        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

function reported(stack: Record<string, string>, variable: string): string {
  const value = stack[variable];
  if (value === undefined) {
    throw new Error(`make stack reported no ${variable}`);
  }
  return value;
}

/** Just the three published ports of a `make stack` report, keyed by their variable. */
function ports(stack: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    PORT_VARIABLES.map((variable) => [variable, reported(stack, variable)]),
  );
}

/**
 * Two checkouts of this repository must be able to run `make check` at the same time, and stopping
 * one stack must leave the other running. That holds when each checkout owns its Compose project,
 * its image and its published ports, and when the addresses the suites read point at the
 * containers that checkout started. A single clone stays on the names and ports it always had, and
 * moves to the next free slot rather than failing when something else already publishes one of
 * them.
 */
describe('docker-stack-is-per-checkout', () => {
  test('a repository with no linked worktree takes its own name', () => {
    withRepository('wagering', [], ({ main }) => {
      expect(stackOf(main).project).toBe('wagering');
    });
  });

  test('every linked worktree takes its own project name', () => {
    withRepository('wagering', ['first', 'second'], ({ main, linked }) => {
      expect([main, ...linked].map((checkout) => stackOf(checkout).project)).toEqual([
        'wagering',
        'wagering-first',
        'wagering-second',
      ]);
    });
  });

  /**
   * Which slot a checkout lands on depends on what the host already publishes. That no two
   * checkouts of one repository land on the same one does not: each searches from its own position
   * in `git worktree list` in steps of the number of worktrees, so the slots it will consider are
   * exactly those whose remainder is its position, and two of them searching in the same second
   * still cannot choose the same ports.
   */
  test('no two checkouts of one repository can land on the same slot', () => {
    withRepository('wagering', ['first', 'second'], ({ main, linked }) => {
      const checkouts = [main, ...linked];
      const slots = checkouts.map((checkout) => stackOf(checkout).slot);

      expect(new Set(slots).size).toBe(checkouts.length);
      expect(slots.map((slot) => slot % checkouts.length)).toEqual([0, 1, 2]);
      expect(slots.every((slot, position) => slot >= position)).toBe(true);
    });
  });

  test('a name Compose would reject becomes one it accepts', () => {
    withRepository('Wagering.Processor', ['Issue.42'], ({ main, linked }) => {
      const [issue = ''] = linked;

      expect(stackOf(main).project).toBe('wagering-processor');
      expect(stackOf(issue).project).toBe('wagering-processor-issue-42');
    });
  });

  test('an exported tree with no repository falls back to its directory name', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'stack-isolation-'));
    const exported = path.join(base, 'wagering-export');
    mkdirSync(exported);

    try {
      // Reached through git, not through the filesystem: the fixture has no repository above it.
      expect(stackOf(exported, { ...FIXTURE_GIT_ENV, GIT_CEILING_DIRECTORIES: base }).project).toBe(
        'wagering-export',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('make takes the project, the image and the slot from this checkout', () => {
    const { project, slot } = stackOf(ROOT);
    const stack = makeStack();

    expect(reported(stack, 'STACK_SLOT')).toBe(String(slot));
    expect(reported(stack, 'COMPOSE_PROJECT_NAME')).toBe(project);
    expect(reported(stack, 'STACK_IMAGE')).toBe(project);
    expect(ports(stack)).toEqual(ports(makeStack([`STACK_SLOT=${String(slot)}`])));
  });

  test('slot 0 publishes the ports of a single checkout, so a plain clone is unchanged', () => {
    expect(ports(makeStack(['STACK_SLOT=0']))).toEqual(SINGLE_CHECKOUT_PORTS);
  });

  test('no two slots publish the same port', () => {
    const published = [0, 1, 2, 3].flatMap((slot) =>
      Object.values(ports(makeStack([`STACK_SLOT=${String(slot)}`]))),
    );

    expect(new Set(published).size).toBe(published.length);
  });

  test('every published port is a fixed one, below the range Linux hands out', () => {
    for (const slot of [0, 1, 2, 3]) {
      for (const port of Object.values(ports(makeStack([`STACK_SLOT=${String(slot)}`])))) {
        expect(Number(port)).toBeGreaterThan(1023);
        expect(Number(port)).toBeLessThan(EPHEMERAL_FLOOR);
      }
    }
  });

  /**
   * A checkout whose slot is already published by something else has to start anyway, or the first
   * command a reviewer runs fails on a port they did not choose and cannot see. The slot is
   * therefore the first one from this checkout's own whose three ports are all free, which leaves
   * the answer deterministic — the same ports whenever they are free — and self-announcing when it
   * is not.
   *
   * The cases take the current answer as their baseline rather than naming a slot: what runs
   * beside them on the host is not theirs to decide, and the property is the move, not its
   * destination.
   */
  test('a slot with a port in use is skipped for the next one whose ports are all free', () => {
    withRepository('wagering', [], ({ main }) => {
      const free = chosenStack(main);

      occupying([free.ports['POSTGRES_PORT'] ?? ''], () => {
        const moved = chosenStack(main);

        expect(moved.slot).toBeGreaterThan(free.slot);
        expect(Object.values(moved.ports)).not.toContain(free.ports['POSTGRES_PORT']);
        expect(moved.project).toBe(free.project);
      });

      // Deterministic, not sticky: nothing is remembered, so the ports come back when they are free.
      expect(chosenStack(main)).toEqual(free);
    });
  });

  test('the move is announced in one line, naming the slot and the base URL it leads to', () => {
    withRepository('wagering', [], ({ main }) => {
      const free = chosenStack(main);

      occupying(Object.values(free.ports), () => {
        const moved = chosenStack(main);
        const notice = noticeOf(main);

        expect(notice.trimEnd().split('\n')).toHaveLength(1);
        expect(notice).toContain(`slot ${String(moved.slot)}`);
        expect(notice).toContain(`http://localhost:${moved.ports['HTTP_PORT'] ?? ''}`);
      });
    });
  });

  // Silence is the other half of announcing it: a checkout that is on the slot it asked for has
  // nothing to tell anyone, and this checkout is on its own.
  test('a checkout that stays on its own slot says nothing', () => {
    expect(noticeOf(ROOT)).toBe('');
  });

  test('an explicit STACK_SLOT is taken as given, with its ports in use and unannounced', () => {
    withRepository('wagering', [], ({ main }) => {
      const free = chosenStack(main);
      const pinned = { ...BARE_ENV, STACK_SLOT: String(free.slot) };

      occupying(Object.values(free.ports), () => {
        expect(chosenStack(main, pinned)).toEqual(free);
        expect(noticeOf(main, pinned)).toBe('');
      });
    });
  });

  /**
   * The occupant that must not move a checkout is its own stack: `make up` on a checkout whose
   * containers are already running has to find the slot they publish, or it would start a second
   * stack beside the one the reviewer is reading.
   */
  test("a port published by this checkout's own stack keeps it, another project's moves it", () => {
    withRepository('wagering', [], ({ main }) => {
      const free = chosenStack(main);
      const port = free.ports['HTTP_PORT'] ?? '';

      publishing(port, free.project, () => {
        expect(chosenStack(main)).toEqual(free);
      });

      publishing(port, `${free.project}-someone-else`, () => {
        expect(chosenStack(main).slot).toBeGreaterThan(free.slot);
      });
    });
  });

  test('compose publishes the ports and tags the image the environment asks for', () => {
    const config = composeConfig({
      COMPOSE_PROJECT_NAME: 'wagering-seven',
      STACK_IMAGE: 'wagering-seven',
      HTTP_PORT: '3007',
      POSTGRES_PORT: '5440',
      LOCALSTACK_PORT: '4573',
    });

    expect(config.name).toBe('wagering-seven');
    expect(publishedPort(config.services.api, 3000)).toBe('3007');
    expect(publishedPort(config.services.postgres, 5432)).toBe('5440');
    expect(publishedPort(config.services.localstack, 4566)).toBe('4573');
    expect(config.services.api.image).toBe('wagering-seven');
    expect(config.services.postgres.image).toBe('postgres:18-alpine');
  });

  test('compose keeps the single-checkout ports and image when nothing is set', () => {
    const config = composeConfig({});

    expect(publishedPort(config.services.api, 3000)).toBe(SINGLE_CHECKOUT_PORTS.HTTP_PORT);
    expect(publishedPort(config.services.postgres, 5432)).toBe(SINGLE_CHECKOUT_PORTS.POSTGRES_PORT);
    expect(publishedPort(config.services.localstack, 4566)).toBe(
      SINGLE_CHECKOUT_PORTS.LOCALSTACK_PORT,
    );
    expect(config.services.api.image).toBe('distributed-wagering-processor');
  });
});

/**
 * The addresses the suites and `make dev` read must point at the containers `make` started for this
 * checkout, or a worktree would reconcile another worktree's database. `.env` builds them from the
 * same ports `make` exports, and this suite proves the environment it runs under agrees.
 */
describe('stack-addresses-match-the-started-containers', () => {
  const port = (variable: string) => new URL(process.env[variable] ?? '').port;

  /**
   * What `make` reports for this checkout under the pin the suites are running with. A checkout
   * whose default ports are already taken on the host exports `STACK_SLOT` to take a block of its
   * own (`docker/stack.sh`), and the stack that started the containers is then the pinned one, not
   * the one this directory's position in the worktree list would name. `makeStack` runs `make` on a
   * bare environment on purpose, so the pin is handed back to it rather than inherited.
   */
  const startedStack = () => {
    const slot = process.env['STACK_SLOT'];

    return makeStack(slot === undefined ? [] : [`STACK_SLOT=${slot}`]);
  };

  test('the database URLs carry this checkout published PostgreSQL port', () => {
    const expected = reported(startedStack(), 'POSTGRES_PORT');

    expect({
      DATABASE_URL: port('DATABASE_URL'),
      MIGRATION_DATABASE_URL: port('MIGRATION_DATABASE_URL'),
    }).toEqual({ DATABASE_URL: expected, MIGRATION_DATABASE_URL: expected });
  });

  test('the SQS endpoint carries this checkout published LocalStack port', () => {
    expect(port('SQS_ENDPOINT')).toBe(reported(startedStack(), 'LOCALSTACK_PORT'));
  });
});

/**
 * One checkout runs two things against its containers: the demonstrations of `make demo`, which
 * need the `api` and `worker` instances, and the suites, which drive the queues and claim the
 * outbox rows themselves. They must not meet. Running both used to mean `make down` in between,
 * which is a note in three documents rather than a property of the tooling: a reviewer who misses
 * it watches the suite that proves determinism flake, and loses the data of the walkthrough they
 * were reading. The suites therefore address a database and a set of queues of their own, on the
 * same containers, and this suite proves the two namespaces are disjoint.
 */
describe('suites-are-isolated-from-the-stack', () => {
  const stack = composeConfig({});

  /** The database a URL names, which is the last segment of its path. */
  const databaseOf = (url: string) => new URL(url).pathname.replace(/^\//, '');

  const required = (service: { environment: Record<string, string> }, variable: string): string => {
    const value = service.environment[variable];
    if (value === undefined) {
      throw new Error(`the stack sets no ${variable}`);
    }
    return value;
  };

  test('the suites write to a database no instance of the stack writes to', () => {
    const suites = [
      databaseOf(process.env['DATABASE_URL'] ?? ''),
      databaseOf(process.env['MIGRATION_DATABASE_URL'] ?? ''),
    ];
    const started = [
      databaseOf(required(stack.services.api, 'DATABASE_URL')),
      databaseOf(required(stack.services.worker, 'DATABASE_URL')),
      databaseOf(required(stack.services.migrate, 'MIGRATION_DATABASE_URL')),
    ];

    expect(new Set(suites).size).toBe(1);
    expect(suites.filter((database) => started.includes(database))).toEqual([]);
  });

  /** The three names of a trio, as an array the comparison below can be typed over. */
  const names = (queues: WagerQueues): readonly string[] => [
    queues.input,
    queues.deadLetter,
    queues.events,
  ];

  test('the suites drive queues no instance of the stack polls', () => {
    const suites = names(wagerQueues(loadEnv(process.env).SQS_QUEUE_PREFIX));
    const started = names(wagerQueues(stack.services.worker.environment['SQS_QUEUE_PREFIX'] ?? ''));

    expect(suites.filter((name) => started.includes(name))).toEqual([]);
  });

  test('a deployment that sets no prefix addresses the names the transport contract fixes', () => {
    expect(wagerQueues('')).toEqual({
      input: WAGER_TRANSACTIONS_QUEUE,
      deadLetter: WAGER_TRANSACTIONS_DLQ,
      events: WAGER_INTEGRATION_EVENTS_QUEUE,
    });
  });

  test('a prefix keeps every name a FIFO name SQS accepts', () => {
    for (const name of names(wagerQueues(loadEnv(process.env).SQS_QUEUE_PREFIX))) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,75}\.fifo$/);
    }
  });
});
