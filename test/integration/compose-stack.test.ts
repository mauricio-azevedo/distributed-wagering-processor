import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Only what Compose needs to resolve the file, so a variable `make` exported for this checkout
 * cannot make the topology look different from the one a single clone brings up.
 */
const BARE_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
};

interface ComposeDependency {
  readonly condition: string;
}

interface ComposeService {
  readonly image?: string;
  readonly environment?: Record<string, string>;
  readonly ports?: { readonly published?: string; readonly target?: number }[];
  readonly deploy?: { readonly replicas?: number };
  readonly depends_on?: Record<string, ComposeDependency>;
  readonly healthcheck?: { readonly test?: string[] };
  readonly stop_grace_period?: string;
  readonly volumes?: { readonly source?: string; readonly target?: string }[];
}

interface ComposeFile {
  readonly services: Record<string, ComposeService>;
}

/**
 * The topology as Compose itself resolves it, anchors, defaults and variables included: asserting
 * the YAML text would prove what the file says, and this proves what Compose will do with it.
 */
function resolved(...files: string[]): ComposeFile {
  const { success, stdout, stderr } = Bun.spawnSync(
    [
      'docker',
      'compose',
      ...['compose.yaml', ...files].flatMap((file) => ['--file', file]),
      'config',
      '--format',
      'json',
    ],
    { cwd: ROOT, env: BARE_ENV },
  );

  if (!success) {
    throw new Error(`docker compose config failed:\n${stderr.toString()}`);
  }

  return JSON.parse(stdout.toString()) as ComposeFile;
}

const stack = resolved();

const publishedBy = (service: ComposeService): string[] =>
  (service.ports ?? []).map(
    ({ published, target }) => `${published ?? ''}:${(target ?? 0).toString()}`,
  );

const serviceOf = (name: string): ComposeService => {
  const service = stack.services[name];

  if (service === undefined) {
    throw new Error(`the stack declares no ${name} service`);
  }

  return service;
};

/**
 * `ops.compose` (OPS-006): one `docker compose up` brings the whole topology the suites and a local
 * run work against — PostgreSQL, LocalStack with the three queues, the migration step, one `api`
 * and two `worker` instances. The dependencies of it are what every integration suite in this
 * directory already runs against (`make infra`); what this case pins is the shape of the stack
 * `make up` starts, which is the part no other suite would notice breaking.
 */
describe('compose-stack', () => {
  test('the stack declares the dependencies, the migration step and both service roles', () => {
    expect(Object.keys(stack.services).toSorted()).toEqual([
      'api',
      'localstack',
      'migrate',
      'postgres',
      'worker',
    ]);
  });

  test('the three queues and the two database roles are created by the containers themselves', () => {
    const mounts = (service: ComposeService): string[] =>
      (service.volumes ?? []).map((volume) => `${volume.source ?? ''} -> ${volume.target ?? ''}`);

    expect(mounts(serviceOf('localstack'))).toEqual([
      `${ROOT}/docker/localstack -> /etc/localstack/init/ready.d`,
    ]);
    expect(mounts(serviceOf('postgres'))).toContain(
      `${ROOT}/docker/postgres -> /docker-entrypoint-initdb.d`,
    );
  });

  test('one image runs the migration step and both roles, which differ only in APP_ROLE', () => {
    const api = serviceOf('api');
    const worker = serviceOf('worker');

    expect(api.image).toBe(serviceOf('migrate').image);
    expect(worker.image).toBe(api.image);
    expect(api.environment?.['APP_ROLE']).toBe('api');
    expect(worker.environment?.['APP_ROLE']).toBe('worker');

    // Everything but the role is shared, so no variable that changes behaviour can drift between
    // the role that answers providers and the role that works (`ops.single-image-roles`).
    const { APP_ROLE: apiRole, ...apiRest } = api.environment ?? {};
    const { APP_ROLE: workerRole, ...workerRest } = worker.environment ?? {};

    expect(apiRest).toEqual(workerRest);
    expect([apiRole, workerRole]).toEqual(['api', 'worker']);
  });

  test('two worker instances run, and only the api publishes a port', () => {
    expect(serviceOf('worker').deploy?.replicas).toBe(2);
    expect(publishedBy(serviceOf('api'))).toEqual(['3000:3000']);
    expect(serviceOf('worker').ports).toBeUndefined();
  });

  test('both roles wait for the migration step and LocalStack, and are probed the same way', () => {
    for (const role of ['api', 'worker']) {
      const service = serviceOf(role);

      expect(Object.keys(service.depends_on ?? {}).toSorted()).toEqual(['localstack', 'migrate']);
      expect(service.depends_on?.['migrate']?.condition).toBe('service_completed_successfully');
      expect(service.depends_on?.['localstack']?.condition).toBe('service_healthy');
      expect(service.healthcheck?.test?.join(' ')).toContain('/health/ready');
    }

    expect(Object.keys(serviceOf('migrate').depends_on ?? {})).toEqual(['postgres']);
    expect(serviceOf('migrate').depends_on?.['postgres']?.condition).toBe('service_healthy');
  });

  /**
   * `ops.graceful-shutdown`: the process has to be the one that decides it is done draining, so the
   * period Compose waits before `SIGKILL` is longer than the period the process drains within.
   */
  test('both roles are given longer to stop than they take to drain', () => {
    for (const role of ['api', 'worker']) {
      const service = serviceOf(role);
      const grace = Number(service.environment?.['SHUTDOWN_GRACE_PERIOD_MS']);

      expect(service.stop_grace_period).toBe('20s');
      expect(grace).toBeGreaterThan(0);
      expect(grace).toBeLessThan(20_000);
    }
  });
});

/**
 * `compose-load-stack` (OPS-008): the topology the load experiment measures, which is the stack
 * above with three `api` instances instead of one. It is an overlay of `compose.yaml` and not a
 * second stack precisely because of what the experiment claims: the numbers describe the deployed
 * configuration, so the only difference the overlay is allowed to make is the instance count and
 * the host ports those instances need. A knob tuned here — a longer lock timeout, a larger outbox
 * batch — would turn the report into a measurement of something nobody runs.
 */
describe('compose-load-stack', () => {
  const load = resolved('compose.load.yaml');

  const loadServiceOf = (name: string): ComposeService => {
    const service = load.services[name];

    if (service === undefined) {
      throw new Error(`the load topology declares no ${name} service`);
    }

    return service;
  };

  test('three api instances run, and the two workers are the ones the stack already runs', () => {
    expect(loadServiceOf('api').deploy?.replicas).toBe(3);
    expect(loadServiceOf('worker').deploy?.replicas).toBe(2);
    expect(Object.keys(load.services).toSorted()).toEqual(Object.keys(stack.services).toSorted());
  });

  /**
   * One published range instead of one port, because three containers cannot share a host port and
   * `make stack` reserves a block of them per checkout. Compose hands each instance a free port
   * from the range in no particular order, which is why the experiment asks Compose which port
   * went to which instance instead of computing it.
   */
  test('the api publishes a range of exactly three ports, replacing the single one', () => {
    expect(publishedBy(loadServiceOf('api'))).toEqual(['3000-3002:3000']);
  });

  test('nothing else about either role changes, so the numbers describe the deployed stack', () => {
    for (const role of ['api', 'worker']) {
      expect(loadServiceOf(role).environment).toEqual(serviceOf(role).environment);
      expect(loadServiceOf(role).image).toBe(serviceOf(role).image);
      expect(loadServiceOf(role).stop_grace_period).toBe(serviceOf(role).stop_grace_period);
      expect(loadServiceOf(role).healthcheck?.test).toEqual(serviceOf(role).healthcheck?.test);
      expect(loadServiceOf(role).depends_on).toEqual(serviceOf(role).depends_on);
    }

    expect(loadServiceOf('worker').ports).toBeUndefined();
  });
});
