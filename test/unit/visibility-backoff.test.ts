import { describe, expect, test } from 'bun:test';

import {
  SQS_MAX_VISIBILITY_SECONDS,
  visibilityBackoffSeconds,
} from '../../src/infrastructure/messaging/visibility-backoff';

/** The deployed defaults: two seconds doubling to a five-minute ceiling. */
const BACKOFF = { baseSeconds: 2, maxSeconds: 300 };

const schedule = (receives: number, backoff = BACKOFF): number[] =>
  Array.from({ length: receives }, (_unused, index) =>
    visibilityBackoffSeconds(index + 1, backoff),
  );

describe('transient-backoff-schedule', () => {
  test('the delay doubles with every receive of the same message', () => {
    expect(schedule(6)).toEqual([2, 4, 8, 16, 32, 64]);
  });

  test('the ceiling holds however often the message was received', () => {
    expect(visibilityBackoffSeconds(9, BACKOFF)).toBe(300);
    expect(visibilityBackoffSeconds(1000, BACKOFF)).toBe(300);
    expect(visibilityBackoffSeconds(Number.MAX_SAFE_INTEGER, BACKOFF)).toBe(300);
  });

  /**
   * A receive count SQS did not report, or reported as something this consumer cannot read, is the
   * first delivery: the backoff is the base, never the ceiling, so an attribute the broker stopped
   * sending cannot park a message for five minutes per delivery.
   */
  test('a missing or unreadable receive count is treated as the first receive', () => {
    for (const unreadable of [Number.NaN, 0, -3, 0.5, Number.POSITIVE_INFINITY]) {
      expect(visibilityBackoffSeconds(unreadable, BACKOFF)).toBe(2);
    }
  });

  test('a base above the ceiling is the ceiling, so the two settings cannot contradict', () => {
    expect(schedule(3, { baseSeconds: 90, maxSeconds: 30 })).toEqual([30, 30, 30]);
  });

  /** Zero is the one way to ask for an immediate redelivery, and it stays immediate. */
  test('a base of zero returns the message at once on every receive', () => {
    expect(schedule(4, { baseSeconds: 0, maxSeconds: 300 })).toEqual([0, 0, 0, 0]);
  });

  test("nothing exceeds SQS's own visibility ceiling, whatever the settings ask for", () => {
    const beyond = { baseSeconds: SQS_MAX_VISIBILITY_SECONDS, maxSeconds: 86_400 };

    expect(schedule(3, beyond)).toEqual([
      SQS_MAX_VISIBILITY_SECONDS,
      SQS_MAX_VISIBILITY_SECONDS,
      SQS_MAX_VISIBILITY_SECONDS,
    ]);
  });
});
