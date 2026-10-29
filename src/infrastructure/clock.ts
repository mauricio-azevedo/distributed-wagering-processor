import type { Clock } from '../application/ports/clock';

/** The `Clock` port over the host clock; the one place the service reads the current time. */
export const systemClock: Clock = {
  now: () => new Date(),
};
