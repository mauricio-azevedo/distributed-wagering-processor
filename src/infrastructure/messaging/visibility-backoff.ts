/**
 * `msg.transient-backoff`: how long a message whose delivery failed transiently stays invisible
 * before the broker hands it over again.
 *
 * The schedule is exponential in the receive count, which is the only state a stateless consumer
 * has about a message: the broker counts the deliveries, so two instances taking turns at one
 * message back off as one would, and nothing has to be remembered between them. The first receive
 * waits the base, every further one doubles, and the ceiling stops the sequence from parking a
 * message for longer than an operator would wait for the dependency to come back.
 *
 * It is here, and pure, because what it decides is arithmetic and not messaging: the consumer reads
 * the receive count off the delivery and asks for the number this returns.
 */

/** SQS's own ceiling on a visibility timeout, twelve hours; a larger value is refused outright. */
export const SQS_MAX_VISIBILITY_SECONDS = 43_200;

/**
 * The two settings behind the schedule. They are a deployment's trade between how soon a message
 * is retried and how much load a retried message puts on a dependency that is still down; neither
 * changes what is guaranteed, because the redrive policy — not this backoff — is what ends the
 * sequence (`msg.transient-backoff`).
 */
export interface VisibilityBackoff {
  readonly baseSeconds: number;
  readonly maxSeconds: number;
}

/**
 * `min(base * 2^(receives - 1), max)`, within what SQS accepts.
 *
 * The ceiling is applied to the base as well, so a deployment that sets a base above the maximum
 * gets the maximum rather than a contradiction: the two settings are validated independently, and
 * the one that bounds the wait is the one that wins.
 *
 * A receive count that is not a whole number of deliveries — absent, zero, unparsed — is the first
 * receive, so a missing attribute costs the base and never the ceiling.
 */
export function visibilityBackoffSeconds(receiveCount: number, backoff: VisibilityBackoff): number {
  return Math.min(
    backoff.baseSeconds * 2 ** doublingsOf(receiveCount),
    backoff.maxSeconds,
    SQS_MAX_VISIBILITY_SECONDS,
  );
}

/**
 * How often the base has doubled by this delivery. The exponent is capped well below where the
 * double would stop being exact, because every value past the first few is the ceiling anyway.
 */
function doublingsOf(receiveCount: number): number {
  if (!Number.isInteger(receiveCount) || receiveCount < 1) {
    return 0;
  }

  return Math.min(receiveCount - 1, 32);
}
