import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { IntegrationEventEnvelope } from '../../src/domain/integration-events';
import type { Env } from '../../src/infrastructure/config/env';
import { wagerQueues } from '../../src/infrastructure/messaging/sqs';

/** One message as it reached the queue: the envelope, and the two FIFO parameters it was sent with. */
export interface DeliveredEvent {
  readonly envelope: IntegrationEventEnvelope;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
  /** The body as bytes, so two publications of one row can be compared without parsing them. */
  readonly body: string;
}

/** SQS takes at most ten messages per receive, however many are waiting. */
const PER_RECEIVE = 10;

/** Enough receivers to drain a backlog of a few thousand without serializing on the round trips. */
const RECEIVERS = 8;

/** How many empty receives in a row mean the queue really has nothing more for this caller. */
const EMPTY_ROUNDS = 3;

/**
 * The integration events queue as a suite reads it: a real consumer's two operations, receive and
 * delete, against LocalStack (`ops.compose`). It deletes what it hands over, so one suite's
 * messages never reach the next, and it takes the message group and deduplication ids along with
 * the body, because those are half of what `outbox.destination` promises.
 */
export class EventsQueue {
  private constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  static async open(env: Env): Promise<EventsQueue> {
    const sqs = new SQSClient({
      region: env.AWS_REGION,
      ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
    });
    const name = wagerQueues(env.SQS_QUEUE_PREFIX).events;
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));

    if (QueueUrl === undefined) {
      throw new Error(`LocalStack reported no URL for ${name}`);
    }

    return new EventsQueue(sqs, QueueUrl);
  }

  /**
   * Everything waiting, until `expected` messages have arrived or the queue has answered empty
   * `emptyRounds` times in a row, whichever comes first, and never longer than `timeoutMs`. It
   * returns what it has either way: a test asserting that nothing more was published needs the
   * empty answer, and one asserting a count needs to see a short delivery rather than hang.
   *
   * One empty answer proves nothing, which is why several are required: a FIFO queue holds back a
   * message group while an earlier message of it is in flight, so a receive issued just after the
   * previous one was deleted can come back empty with the next message already waiting.
   */
  async receive(
    expected: number,
    {
      timeoutMs = 20_000,
      emptyRounds = EMPTY_ROUNDS,
    }: { readonly timeoutMs?: number; readonly emptyRounds?: number } = {},
  ): Promise<DeliveredEvent[]> {
    const delivered: DeliveredEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    let empty = 0;

    while (delivered.length < expected && Date.now() < deadline && empty < emptyRounds) {
      const rounds = await Promise.all(
        Array.from({ length: receiversFor(expected - delivered.length) }, () => this.poll()),
      );
      const received = rounds.flat();

      delivered.push(...received);
      empty = received.length === 0 ? empty + 1 : 0;
    }

    return delivered;
  }

  /** Leaves the queue empty, so a suite starts on messages of its own alone. */
  async drain(): Promise<void> {
    let empty = 0;

    while (empty < EMPTY_ROUNDS) {
      empty = (await this.poll()).length === 0 ? empty + 1 : 0;
    }
  }

  /** One receive, deleted as a batch: a consumer's acknowledgement of what it took. */
  private async poll(): Promise<DeliveredEvent[]> {
    const { Messages } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: PER_RECEIVE,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );

    if (Messages === undefined || Messages.length === 0) {
      return [];
    }

    await this.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: Messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle,
        })),
      }),
    );

    return Messages.map((message) => {
      const body = message.Body ?? '';

      return {
        envelope: JSON.parse(body) as IntegrationEventEnvelope,
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
        body,
      };
    });
  }
}

function receiversFor(remaining: number): number {
  return Math.max(1, Math.min(RECEIVERS, Math.ceil(remaining / PER_RECEIVE)));
}
