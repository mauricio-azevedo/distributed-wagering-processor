import { describe, expect, test } from 'bun:test';

import { WorkerLoop } from '../../src/infrastructure/runtime/worker-loop';
import { recordingLogger } from '../helpers/recording-logger';

/** Long enough that a loop which waited it out inside a test would hang the test instead. */
const NEVER_ELAPSES_MS = 600_000;

/** How long a `stop` that is meant to resolve at once is given before the case calls it stuck. */
const PROMPTLY_MS = 500;

/**
 * A cycle the case controls: it reports how often it was entered and settles when the case says so,
 * which is how a test asserts what `stop` waits for without waiting for a timer.
 */
function controllableCycle(): {
  readonly entered: () => number;
  readonly settle: (foundWork: boolean) => void;
  readonly fail: (error: Error) => void;
  readonly cycle: () => Promise<boolean>;
} {
  let entries = 0;
  let resolveCurrent: ((foundWork: boolean) => void) | undefined;
  let rejectCurrent: ((error: Error) => void) | undefined;

  return {
    entered: () => entries,
    settle: (foundWork) => resolveCurrent?.(foundWork),
    fail: (error) => rejectCurrent?.(error),
    cycle: () => {
      entries += 1;

      return new Promise<boolean>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
      });
    },
  };
}

/** Lets every microtask queued so far run, so a loop that could advance already has. */
const settled = (): Promise<void> => Bun.sleep(5);

const raceAgainst = async (promise: Promise<void>, ms: number): Promise<'settled' | 'pending'> =>
  Promise.race([
    promise.then(() => 'settled' as const),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);

describe('worker-loop', () => {
  test('starting twice runs one loop', async () => {
    const controllable = controllableCycle();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: NEVER_ELAPSES_MS,
      failureEvent: 'test.cycle-failed',
      logger: recordingLogger().logger,
    });

    loop.start();
    loop.start();
    await settled();

    expect(controllable.entered()).toBe(1);

    const stopping = loop.stop();
    controllable.settle(true);
    await stopping;
  });

  test('a cycle that found work is followed at once, and one that found none waits', async () => {
    const controllable = controllableCycle();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: NEVER_ELAPSES_MS,
      failureEvent: 'test.cycle-failed',
      logger: recordingLogger().logger,
    });

    loop.start();
    await settled();
    controllable.settle(true);
    await settled();

    // A full batch means there is probably more due, so the next cycle starts without a wait.
    expect(controllable.entered()).toBe(2);

    controllable.settle(false);
    await settled();

    // Nothing was due, so the loop is inside the interval and no third cycle has started.
    expect(controllable.entered()).toBe(2);

    await loop.stop();
  });

  test('stop resolves only once the cycle in flight has settled', async () => {
    const controllable = controllableCycle();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: NEVER_ELAPSES_MS,
      failureEvent: 'test.cycle-failed',
      logger: recordingLogger().logger,
    });

    loop.start();
    await settled();

    const stopping = loop.stop();

    // `ops.graceful-shutdown`: the work in flight is finished, not abandoned.
    expect(await raceAgainst(stopping, PROMPTLY_MS)).toBe('pending');
    // And the cycle knows it is the last one, so a cycle that claims item by item stops claiming.
    expect(loop.claiming()).toBe(false);

    controllable.settle(true);
    await stopping;

    // The loop took nothing new after the signal, however much the settled cycle had found.
    expect(controllable.entered()).toBe(1);
  });

  test('stop cuts short the wait of a cycle that found nothing', async () => {
    const controllable = controllableCycle();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: NEVER_ELAPSES_MS,
      failureEvent: 'test.cycle-failed',
      logger: recordingLogger().logger,
    });

    loop.start();
    await settled();
    controllable.settle(false);
    await settled();

    expect(await raceAgainst(loop.stop(), PROMPTLY_MS)).toBe('settled');
  });

  test('a failed cycle is logged and the loop carries on', async () => {
    const controllable = controllableCycle();
    const recording = recordingLogger();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: 1,
      failureEvent: 'test.cycle-failed',
      logger: recording.logger,
    });

    loop.start();
    await settled();
    controllable.fail(new Error('the database is unreachable'));
    await settled();

    expect(recording.at('error')).toEqual([
      {
        level: 'error',
        event: 'test.cycle-failed',
        fields: { reason: 'the database is unreachable' },
      },
    ]);
    // The failure is the backoff: the loop waits its interval and tries again rather than exiting.
    expect(controllable.entered()).toBeGreaterThan(1);

    const stopping = loop.stop();
    controllable.settle(false);
    await stopping;
  });

  test('a loop can be started again after it was stopped', async () => {
    const controllable = controllableCycle();
    const loop = new WorkerLoop({
      cycle: controllable.cycle,
      idleIntervalMs: NEVER_ELAPSES_MS,
      failureEvent: 'test.cycle-failed',
      logger: recordingLogger().logger,
    });

    loop.start();
    await settled();
    controllable.settle(false);
    await loop.stop();

    expect(loop.claiming()).toBe(true);

    loop.start();
    await settled();

    expect(controllable.entered()).toBe(2);

    controllable.settle(false);
    await loop.stop();
  });
});
