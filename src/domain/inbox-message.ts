import { InvalidMessageStateError } from './errors';

/** An inbox row as the database holds it; `processedAt` is `null` until processing completed. */
export interface InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

/**
 * What the consumer records about a message it accepted for processing. `messageId` is the body
 * field (`msg.inbox-identity`): a producer resend keeps it and gets a new broker receipt id, which
 * is logged for diagnosis and is not part of any identity, so it is not stored here.
 */
export type ReceivedMessage = Omit<InboxMessageState, 'processedAt'>;

/**
 * The record that makes a redelivery a no-op (`msg.redelivery-safe`). Its identity is
 * `(consumerName, messageId)`, the primary key of `inbox_messages`, so the database decides
 * whether a message is new across every instance; `payloadHash` is what a reused message id is
 * compared against (`msg.inbox-payload-conflict`).
 *
 * The row is written in the same transaction as the financial change and completed by the same
 * commit (`outbox.single-transaction`), which is why the inbox absorbs a redelivery that arrives
 * after a crash between commit and acknowledgement (`msg.ack-after-commit`).
 *
 * Unlike `Wallet`, which answers an operation with a new instance (ADR 0006), a message record
 * changes in place: it owns no paired artifact that could drift from it, and the row, not a
 * value, is the thing the transaction advances.
 */
export class InboxMessage implements InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;

  /** Behind a getter so that `markProcessed` is the only way a row completes. */
  private completedAt: Date | null;

  private constructor(state: InboxMessageState) {
    this.consumerName = state.consumerName;
    this.messageId = state.messageId;
    this.payloadHash = state.payloadHash;
    this.receivedAt = state.receivedAt;
    this.completedAt = state.processedAt;
  }

  /** Records a message the consumer accepted, not yet processed. */
  static receive(message: ReceivedMessage): InboxMessage {
    return new InboxMessage({
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: null,
    });
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored row, trusting the database. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get processedAt(): Date | null {
    return this.completedAt;
  }

  /** What the consumer asks a stored row before acting, to absorb a redelivery. */
  isProcessed(): boolean {
    return this.completedAt !== null;
  }

  /**
   * Completes the row, in the transaction that recorded the outcome of the message
   * (`outbox.single-transaction`). Completing a completed row is a programming error: the
   * consumer asks `isProcessed` first.
   */
  markProcessed(processedAt: Date): void {
    if (this.completedAt !== null) {
      throw new InvalidMessageStateError(
        `message ${this.messageId} of consumer ${this.consumerName} was already processed at ${this.completedAt.toISOString()}`,
      );
    }

    this.completedAt = processedAt;
  }
}
