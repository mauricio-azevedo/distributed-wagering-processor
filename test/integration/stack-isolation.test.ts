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

function stackOf(directory: string, env: Record<string, string> = BARE_ENV): Stack {
  const [project = '', slot = ''] = run([STACK_SH], { cwd: directory, env }).split(' ');

  return { project, slot: Number(slot) };
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
 * containers that checkout started. A single clone stays on the names and ports it always had.
 */
describe('docker-stack-is-per-checkout', () => {
  test('a repository with no linked worktree takes its own name and slot 0', () => {
    withRepository('wagering', [], ({ main }) => {
      expect(stackOf(main)).toEqual({ project: 'wagering', slot: 0 });
    });
  });

  test('every linked worktree takes its own project name and its own slot', () => {
    withRepository('wagering', ['first', 'second'], ({ main, linked }) => {
      const [first = '', second = ''] = linked;

      expect(stackOf(main)).toEqual({ project: 'wagering', slot: 0 });
      expect(stackOf(first)).toEqual({ project: 'wagering-first', slot: 1 });
      expect(stackOf(second)).toEqual({ project: 'wagering-second', slot: 2 });
    });
  });

  test('a name Compose would reject becomes one it accepts', () => {
    withRepository('Wagering.Processor', ['Issue.42'], ({ main, linked }) => {
      const [issue = ''] = linked;

      expect(stackOf(main).project).toBe('wagering-processor');
      expect(stackOf(issue).project).toBe('wagering-processor-issue-42');
    });
  });

  test('an exported tree with no repository falls back to its directory name and slot 0', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'stack-isolation-'));
    const exported = path.join(base, 'wagering-export');
    mkdirSync(exported);

    try {
      // Reached through git, not through the filesystem: the fixture has no repository above it.
      expect(stackOf(exported, { ...FIXTURE_GIT_ENV, GIT_CEILING_DIRECTORIES: base })).toEqual({
        project: 'wagering-export',
        slot: 0,
      });
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
