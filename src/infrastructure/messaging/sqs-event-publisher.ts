import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WAGER_INTEGRATION_EVENTS_QUEUE } from './sqs';

export interface SqsEventPublisherOptions {
  /**
   * ADR 0005's bounded publish attempt. It is what keeps one cycle's hold on its database
   * connection finite when the broker neither answers nor refuses, so it belongs to the adapter
   * that makes the call and not to the use case that counts the failure.
   */
  readonly timeoutMs: number;
}

/**
 * `EventPublisher` over SQS: one `SendMessage` per outbox row to `wager-integration-events.fifo`
 * (`outbox.destination`).
 *
 * The two FIFO parameters come off the row and nowhere else. `MessageGroupId` is the wallet, which
 * is the only ordering the broker can offer and which ADR 0005 treats as best effort: two
 * publishers holding consecutive events of one wallet may send them in either order, so consumers
 * order by `walletVersion` or `occurredAt` (`event.ordering`). `MessageDeduplicationId` is the
 * event id, so a republication inside the broker's deduplication window is filtered — an extra
 * filter and never the guarantee, which is the consumer's deduplication by `eventId`
 * (`event.at-least-once`).
 *
 * The body is the stored envelope serialized, so every publication of a row is the same message
 * and nothing is rebuilt from state that has moved on (`outbox.duplicate-safe`).
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SqsEventPublisherOptions,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.eventId,
      }),
      { abortSignal: AbortSignal.timeout(this.options.timeoutMs) },
    );
  }

  /**
   * The queue URL, resolved once and kept. A failed resolution is not kept: the queue is addressed
   * by the name the messaging rules fix, and a broker that is unavailable at the first attempt must
   * not leave the publisher with a rejected promise it would reuse for the rest of the process.
   */
  private async resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.lookUpQueueUrl();

    try {
      return await this.queueUrl;
    } catch (error) {
      this.queueUrl = undefined;

      throw error;
    }
  }

  private async lookUpQueueUrl(): Promise<string> {
    const { QueueUrl } = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: WAGER_INTEGRATION_EVENTS_QUEUE }),
      { abortSignal: AbortSignal.timeout(this.options.timeoutMs) },
    );

    if (QueueUrl === undefined) {
      throw new Error(`SQS reported no URL for ${WAGER_INTEGRATION_EVENTS_QUEUE}`);
    }

    return QueueUrl;
  }
}
