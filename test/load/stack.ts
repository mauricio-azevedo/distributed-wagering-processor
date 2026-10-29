import { type MetricSample, parseExposition } from './measure';

/**
 * The Compose side of the load experiment (OPS-008): bringing up the three-instance topology of
 * [compose.load.yaml](../../compose.load.yaml), finding which host port each `api` instance got,
 * and reading the five `/metrics` expositions back.
 *
 * Nothing here recomputes what the Makefile already decides. `make stack` prints this checkout's
 * Compose project, image and published ports, including `LOAD_API_PORTS`, so the experiment drives
 * the stack this checkout owns and two worktrees can run it at the same time (`ops.compose`,
 * ADR 0014) — with one place, the Makefile, deciding the ports.
 */

export const COMPOSE_FILES = ['--file', 'compose.yaml', '--file', 'compose.load.yaml'];

/** The repository root, which is where every Compose and `make` call below runs. */
export const ROOT = new URL('../..', import.meta.url).pathname;

export interface StackSettings {
  readonly project: string;
  readonly slot: string;
  readonly image: string;
  readonly httpPort: number;
  readonly postgresPort: number;
  readonly localstackPort: number;
  readonly loadApiPorts: string;
}

function run(
  command: string[],
  environment: Record<string, string> = {},
): { ok: boolean; stdout: string; stderr: string } {
  const spawned = Bun.spawnSync(command, {
    cwd: ROOT,
    env: { ...process.env, ...environment },
  });

  return {
    ok: spawned.success,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

/**
 * The three variables `.env` sets that the Makefile would otherwise take as deliberate overrides.
 * Bun loads `.env` into this process's environment, and the Makefile assigns its ports with `?=`,
 * so asking it with them set would be asking it to repeat the single-checkout defaults — which is
 * how a linked worktree ends up told to publish `4566` and colliding with the checkout that
 * already has it. They are dropped for the question and for nothing else: `STACK_SLOT`,
 * `COMPOSE_PROJECT_NAME` and `LOAD_API_PORTS` are not in `.env`, so pinning any of them from the
 * environment still works.
 */
const CHECKOUT_PORTS = ['HTTP_PORT', 'POSTGRES_PORT', 'LOCALSTACK_PORT'];

/**
 * This checkout's stack identity, as `make stack` reports it. Reading the Makefile's own output is
 * what keeps `bun run test:load` correct inside a worktree without the caller exporting anything:
 * the ports a linked checkout publishes are shifted by its slot, and only the Makefile knows by how
 * much.
 */
export function stackSettings(): StackSettings {
  const asked = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => !CHECKOUT_PORTS.includes(name) && value !== undefined,
    ) as [string, string][],
  );
  const spawned = Bun.spawnSync(['make', '--silent', 'stack'], { cwd: ROOT, env: asked });

  if (!spawned.success) {
    throw new Error(`make stack failed:\n${spawned.stderr.toString()}`);
  }

  const reported = new Map<string, string>();
  for (const line of spawned.stdout.toString().split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      reported.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }

  const required = (name: string): string => {
    const value = reported.get(name);

    if (value === undefined || value === '') {
      throw new Error(`make stack reported no ${name}`);
    }

    return value;
  };

  return {
    project: required('COMPOSE_PROJECT_NAME'),
    slot: required('STACK_SLOT'),
    image: required('STACK_IMAGE'),
    httpPort: Number(required('HTTP_PORT')),
    postgresPort: Number(required('POSTGRES_PORT')),
    localstackPort: Number(required('LOCALSTACK_PORT')),
    loadApiPorts: required('LOAD_API_PORTS'),
  };
}

/** What Compose has to read to resolve this checkout's stack, as the Makefile exports it. */
export function composeEnvironment(settings: StackSettings): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: settings.project,
    STACK_IMAGE: settings.image,
    HTTP_PORT: String(settings.httpPort),
    POSTGRES_PORT: String(settings.postgresPort),
    LOCALSTACK_PORT: String(settings.localstackPort),
    LOAD_API_PORTS: settings.loadApiPorts,
  };
}

/**
 * Brings up the load topology and waits until every container is healthy, which is the same
 * `--wait` `make up` relies on: the probe is `/health/ready`, so an instance is only counted once
 * PostgreSQL and SQS answer it (OBS-004).
 */
export function bringUpLoadTopology(settings: StackSettings): void {
  const { ok, stderr } = run(
    ['docker', 'compose', ...COMPOSE_FILES, 'up', '--detach', '--wait'],
    composeEnvironment(settings),
  );

  if (!ok) {
    throw new Error(`docker compose up of the load topology failed:\n${stderr}`);
  }
}

export interface Instance {
  readonly service: string;
  readonly name: string;
  /** The Compose instance number, which is what `--index` addresses. */
  readonly index: number;
  /** The host port this instance publishes, when it publishes one. */
  readonly httpPort: number | null;
  readonly health: string;
}

interface ComposeProcess {
  readonly Service?: string;
  readonly Name?: string;
  readonly Health?: string;
  readonly State?: string;
  readonly Publishers?: { readonly TargetPort?: number; readonly PublishedPort?: number }[] | null;
}

/**
 * The running `api` and `worker` instances, each with the host port Compose gave it. Compose hands
 * out the ports of the published range in no particular order — instance 1 is not necessarily the
 * lowest port — so the mapping is asked for rather than computed.
 */
export function instances(settings: StackSettings): Instance[] {
  const { ok, stdout, stderr } = run(
    ['docker', 'compose', ...COMPOSE_FILES, 'ps', '--format', 'json'],
    composeEnvironment(settings),
  );

  if (!ok) {
    throw new Error(`docker compose ps failed:\n${stderr}`);
  }

  const found: Instance[] = [];

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const process_ = JSON.parse(line) as ComposeProcess;
    const service = process_.Service ?? '';
    const name = process_.Name ?? '';

    if (service !== 'api' && service !== 'worker') {
      continue;
    }

    const published = (process_.Publishers ?? []).find(
      (publisher) => publisher.TargetPort === 3000 && (publisher.PublishedPort ?? 0) > 0,
    );

    found.push({
      service,
      name,
      index: Number(/-(?<index>\d+)$/.exec(name)?.groups?.['index'] ?? '1'),
      httpPort: published?.PublishedPort ?? null,
      health: process_.Health ?? process_.State ?? 'unknown',
    });
  }

  return found.toSorted((left, right) => left.name.localeCompare(right.name));
}

const SCRAPE = "process.stdout.write(await (await fetch('http://localhost:3000/metrics')).text())";

/**
 * One instance's exposition, read from inside its container. A `worker` publishes no port — two
 * instances could not share one — so the uniform way to reach all five is the way the health probe
 * reaches them: `bun` inside the container, over localhost. Every sample is stamped with the
 * instance it came from, because a counter is per instance (`obs.metrics`) and the aggregation
 * across them is this experiment's job.
 */
export function scrape(settings: StackSettings, instance: Instance): MetricSample[] {
  const { ok, stdout, stderr } = run(
    [
      'docker',
      'compose',
      ...COMPOSE_FILES,
      'exec',
      '--no-TTY',
      '--index',
      String(instance.index),
      instance.service,
      'bun',
      '--eval',
      SCRAPE,
    ],
    composeEnvironment(settings),
  );

  if (!ok) {
    throw new Error(`scraping ${instance.name} failed:\n${stderr}`);
  }

  return parseExposition(stdout, { instance: instance.name, role: instance.service });
}

/** Every instance's exposition, merged, which is what the counter sums are taken over. */
export function scrapeAll(settings: StackSettings, running: readonly Instance[]): MetricSample[] {
  return running.flatMap((instance) => scrape(settings, instance));
}

/**
 * What the machine was, which a load number means nothing without. Everything here is read from the
 * host and from Docker rather than described by hand, so a second run on another machine reports
 * that machine instead of repeating this one's.
 */
export interface HostFacts {
  readonly kernel: string;
  readonly hostCpus: number;
  readonly hostMemoryGiB: number;
  readonly dockerVersion: string;
  readonly dockerCpus: number;
  readonly dockerMemoryGiB: number;
  readonly bunVersion: string;
  readonly containerLimits: string;
}

export function hostFacts(): HostFacts {
  const uname = run(['uname', '-sr']);
  const docker = run(['docker', 'info', '--format', '{{.ServerVersion}} {{.NCPU}} {{.MemTotal}}']);
  const [version = '', cpus = '0', memory = '0'] = docker.stdout.trim().split(' ');
  const hostMemory = run(['sh', '-c', "awk '/MemTotal/ {print $2}' /proc/meminfo"]);

  return {
    kernel: uname.stdout.trim(),
    hostCpus: navigator.hardwareConcurrency,
    hostMemoryGiB: Number((Number(hostMemory.stdout.trim()) / 1024 / 1024).toFixed(1)),
    dockerVersion: version,
    dockerCpus: Number(cpus),
    dockerMemoryGiB: Number((Number(memory) / 1024 ** 3).toFixed(1)),
    bunVersion: Bun.version,
    // compose.yaml declares no `cpus`, `memory` or `deploy.resources` limit for any service, so
    // every container competes for the whole host with the generator process. Stated rather than
    // measured: it is a property of the file, and the report has to say it.
    containerLimits: 'none declared; the host is shared by the stack and the generator',
  };
}
