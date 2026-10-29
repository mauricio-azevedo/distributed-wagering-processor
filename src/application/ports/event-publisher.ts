import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * The broker, as the publisher reaches it (`outbox.destination`).
 *
 * It takes the outbox row and not an envelope, a body or a set of message parameters, because
 * everything the message needs is already on the row and fixed when the event was enqueued: the
 * envelope is sent as it was stored, the wallet is the FIFO group and the event id is the
 * deduplication id. A port spelled in those three parts would let a call site pair a body with
 * another row's identity, and `outbox.duplicate-safe` is exactly the promise that cannot happen.
 *
 * A rejection means the publication did not happen, or is not known to have happened, which the
 * publisher treats the same way: the row stays pending and is retried (`outbox.retry-backoff`). A
 * resolution means the broker accepted the message.
 */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
