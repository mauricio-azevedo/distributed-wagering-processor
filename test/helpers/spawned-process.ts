/**
 * A process a suite spawned, as the lines it writes and the code it exits with. It is how a case
 * asserts what `APP_ROLE` composes and what `SIGTERM` drains (`ops.single-image-roles`,
 * `ops.graceful-shutdown`): neither is a property of an application object a suite builds in its
 * own runtime, because the bootstrap, the signal handler and the exit code only exist in a process.
 *
 * It spawns `src/main.ts` for a case about a role, and a helper beside this file for a case that
 * needs a seam the service has none of — a handler slow enough to be signalled in the middle of.
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** The service's own entry point, which is what a case about a role spawns. */
export const SERVICE_MAIN = path.join(ROOT, 'src', 'main.ts');

/** A helper beside this one, spawned as a process of its own. */
export const helperScript = (name: string): string => path.join(ROOT, 'test', 'helpers', name);

/** How long a process is given to say something before a case calls it stuck. */
const BOOT_TIMEOUT_MS = 30_000;

/** The record `src/main.ts` writes once the HTTP server is accepting (`obs.structured-logs`). */
const LISTENING = /"event":"service\.listening"/;

/**
 * The colour codes the framework's logger wraps a line in. They are removed as a line is read, so
 * an assertion matches what the line says rather than how a terminal would paint it; the escape is
 * built rather than written, because a control character in a literal pattern is a lint error.
 */
const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export interface SpawnedProcessOptions {
  /** The script to run: `SERVICE_MAIN`, or a helper through `helperScript`. */
  readonly script: string;
  /** What the script is given on its command line; a helper's knobs are flags of its own. */
  readonly args?: readonly string[];
  /**
   * Layered over the suite's own environment, which carries the addresses of the stack. A variable
   * set to `undefined` is removed, which is how a case starts a role with one genuinely missing
   * rather than with an empty value.
   */
  readonly env: Record<string, string | undefined>;
  /**
   * An env file for the process to read instead of the one Bun finds beside the project. `/dev/null`
   * is how a case starts a role with nothing but the variables it passed, which is what asserting a
   * missing variable requires: the `.env` of a checkout would otherwise supply it.
   */
  readonly envFile?: string;
  /**
   * Whether the process is given a pipe on stdin, which is what `send` writes to. A helper that
   * takes instructions while it runs needs one; a role that is only started and signalled does not,
   * and gets no stdin at all so a read of it cannot hold the process open.
   */
  readonly stdin?: boolean;
}

export class SpawnedProcess {
  private readonly child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>;
  private readonly written: string[] = [];
  private readonly reading: Promise<void>;

  private constructor(
    script: string,
    args: readonly string[],
    overrides: Record<string, string | undefined>,
    envFile: string | undefined,
    stdin: boolean,
  ) {
    // The suite's own environment with the overrides applied, and the variables an override set to
    // `undefined` left out: that absence is what a case asserting a missing variable is about.
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...overrides }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

    // `process.execPath`, as every other helper process in the suites is spawned: the service runs
    // the runtime the suite runs on rather than whichever `bun` the PATH of the moment resolves to.
    this.child = Bun.spawn(
      [
        process.execPath,
        'run',
        ...(envFile === undefined ? [] : [`--env-file=${envFile}`]),
        script,
        ...args,
      ],
      {
        cwd: ROOT,
        env,
        stdin: stdin ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    this.reading = this.read();
  }

  /** Spawns it. Nothing is waited for here: a case that expects a refusal waits for the exit. */
  static spawn({
    script,
    args = [],
    env,
    envFile,
    stdin = false,
  }: SpawnedProcessOptions): SpawnedProcess {
    return new SpawnedProcess(script, args, env, envFile, stdin);
  }

  /**
   * One instruction, as one line of JSON on stdin. The flush is what is awaited, because a process
   * acts on a line and not on a partial write, so a case that asked for something has to know the
   * whole of it left this end of the pipe.
   */
  async send(instruction: unknown): Promise<void> {
    const sink = this.child.stdin;

    if (sink === undefined) {
      throw new Error('the process was spawned without a stdin pipe, so it takes no instructions');
    }

    // The write is not awaited and the flush is: a buffered write resolves to how much it took,
    // which says nothing about the pipe, and the flush is what puts the whole line through it.
    void sink.write(`${JSON.stringify(instruction)}\n`);
    await sink.flush();
  }

  /** The address this instance serves on, which an ephemeral `HTTP_PORT` makes it the only source of. */
  async listening(timeoutMs = BOOT_TIMEOUT_MS): Promise<string> {
    const line = await this.waitFor(LISTENING, timeoutMs);
    const { url } = JSON.parse(line) as { url?: string };

    if (typeof url !== 'string') {
      throw new Error(`the process said "${line}" without an address`);
    }

    return url;
  }

  /** Waits until the process has written a line matching `pattern`, and returns the line. */
  async waitFor(pattern: RegExp, timeoutMs = BOOT_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const line = this.written.find((written) => pattern.test(written));

      if (line !== undefined) {
        return line;
      }

      if (this.child.exitCode !== null) {
        throw new Error(
          `the process exited with ${this.child.exitCode.toString()} before matching ${pattern.source}: ${this.output()}`,
        );
      }

      await Bun.sleep(25);
    }

    throw new Error(`the process never matched ${pattern.source}: ${this.output()}`);
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  /** The exit code, once everything the process wrote has been read. */
  async exited(): Promise<number> {
    const code = await this.child.exited;
    await this.reading;

    return code;
  }

  /**
   * The signal the process died of, or `null` for one that exited by itself. It is what tells a
   * drill that a kill was a kill: a process that ran its own shutdown would have exited with a code
   * and no signal, which is the opposite of the uncleaned death `SIGKILL` is used to produce.
   */
  killedBy(): NodeJS.Signals | number | null {
    return this.child.signalCode;
  }

  /** Whether the process is still running, which is how many instances a drill has left. */
  alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Everything the process has written so far, for an assertion or a diagnosis. */
  output(): string {
    return this.written.join('\n');
  }

  /**
   * Stops the instance however it has to be stopped, so a case leaves nothing holding a port or a
   * database connection: a `SIGTERM` first, and `SIGKILL` once the grace period cannot save it.
   */
  async dispose(): Promise<void> {
    if (this.child.exitCode === null) {
      this.signal('SIGTERM');
      await Promise.race([this.child.exited, Bun.sleep(BOOT_TIMEOUT_MS)]);
      this.child.kill('SIGKILL');
    }

    await this.child.exited;
  }

  /** Both streams into one list of lines: a role writes its log to stdout and its refusals to stderr. */
  private async read(): Promise<void> {
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      let buffered = '';

      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        this.written.push(...lines.map((line) => line.replace(COLOURS, '')));
      }

      if (buffered !== '') {
        this.written.push(buffered.replace(COLOURS, ''));
      }
    };

    await Promise.all([collect(this.child.stdout), collect(this.child.stderr)]);
  }
}

/**
 * A port nothing is listening on, taken by binding one and letting it go: the roles of a case run
 * as real processes, so each needs an address of its own and `HTTP_PORT` has to be a real port.
 */
export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const { port } = server;

  void server.stop(true);

  if (port === undefined) {
    throw new Error('the runtime bound a server without reporting its port');
  }

  return port;
}
