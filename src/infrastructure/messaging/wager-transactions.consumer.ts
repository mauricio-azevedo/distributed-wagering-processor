import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  ApplicationError,
  InboxPayloadConflictError,
  ServiceUnavailableError,
} from '../../application/errors';
import type { Logger } from '../../application/ports/logger';
import type { Metrics } from '../../application/ports/metrics';
import type {
  DeliveryOutcome,
  SubmitWagerTransaction,
} from '../../application/use-cases/submit-wager-transaction';
import {
  MessageContractError,
  commandOf,
  deliveryOf,
  wagerTransactionRequestedOf,
} from './wager-transaction-message.dto';

/**
 * The queue entry point: `wager-transactions.fifo` into the same `SubmitWagerTransaction` the
 * controller calls (`msg.same-use-case`). It translates a message into a command and a delivery,
 * and decides nothing about money: the use case owns the outcome, the message DTO owns what a
 * message has to look like, and the inbox row the use case writes is what makes a redelivery
 * harmless (ADR 0010).
 *
 * A message is deleted only after the transaction that recorded it committed
 * (`msg.ack-after-commit`), which is the whole acknowledgement protocol: `deliver` resolves when
 * the commit returned, and the delete is the next statement. A crash in between leaves the message
 * in the queue, and its redelivery is absorbed by the inbox (`msg.redelivery-safe`).
 *
 * What this consumer does not do yet, and #17 adds: act on the two failure classes. A transient or
 * permanent failure is classified, counted and logged here, and the message is left in the queue,
 * so it becomes visible again after the visibility timeout and the queue's own redrive policy
 * dead-letters it after five receives. The visibility backoff of `msg.transient-backoff` and the
 * direct forward of `msg.permanent-to-dlq` are that issue's scope. Starting and stopping the loop
 * is `run` and `stop`; which process runs it, and how it drains on `SIGTERM`, is #19's.
 */

/** `msg.inbox-identity`: the consumer half of every inbox identity this consumer writes. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

/**
 * The ceiling SQS puts on one `ReceiveMessage`. The batch is processed one message at a time, so
 * the group order of a FIFO queue survives it, and a larger batch would only mean more messages
 * holding their visibility while the ones before them commit.
 */
const MAX_MESSAGES_PER_RECEIVE = 10;

/**
 * What one delivery amounted to (`msg.classification`). A business class is terminal for the
 * message and acknowledged; the two failure classes are not, and this slice leaves them to the
 * queue. The report carries what a test and a log line need and nothing else: the body message id
 * when the body parsed, because the broker's receipt id is never an identity.
 */
export type DeliveryReport =
  | {
      readonly classification: 'business';
      readonly messageId: string;
      readonly outcome: DeliveryOutcome;
      readonly acknowledged: true;
    }
  | {
      readonly classification: 'transient' | 'permanent';
      readonly messageId: string | null;
      readonly error: unknown;
      readonly acknowledged: false;
    };

export interface WagerTransactionsConsumerDependencies {
  readonly sqs: SQSClient;
  /** The input queue's URL; the name is contract, the URL is deployment (`msg.queues`). */
  readonly queueUrl: () => Promise<string>;
  readonly submit: SubmitWagerTransaction;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly consumerName: string;
  /** Long polling: how long one receive waits for a message before answering empty. */
  readonly waitTimeSeconds: number;
  /** How long a received message stays invisible, which is how long processing it may take. */
  readonly visibilityTimeoutSeconds: number;
}

export class WagerTransactionsConsumer {
  private polling = false;

  constructor(private readonly dependencies: WagerTransactionsConsumerDependencies) {}

  /**
   * One receive-and-process cycle, which is what the loop repeats and what a test drives directly.
   * Messages are processed in the order the broker handed them over and one at a time, so a FIFO
   * group is applied in its order and no message of a batch waits on another's commit.
   */
  async poll(): Promise<readonly DeliveryReport[]> {
    const queueUrl = await this.dependencies.queueUrl();
    const received = await this.dependencies.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: MAX_MESSAGES_PER_RECEIVE,
        WaitTimeSeconds: this.dependencies.waitTimeSeconds,
        VisibilityTimeout: this.dependencies.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const reports: DeliveryReport[] = [];

    for (const message of received.Messages ?? []) {
      const report = await this.deliver(message);

      if (report.acknowledged) {
        await this.acknowledge(queueUrl, message);
      }

      reports.push(report);
    }

    return reports;
  }

  /**
   * Receive, process, repeat until `stop`. Stopping takes effect after the receive in flight
   * answers, so it is bounded by `waitTimeSeconds`; the shutdown behaviour `msg.sigterm` asks for,
   * which also returns the visibility of what it could not finish, is #19.
   */
  async run(): Promise<void> {
    this.polling = true;

    while (this.running()) {
      await this.poll();
    }
  }

  stop(): void {
    this.polling = false;
  }

  /** Read through a call, because the flag is set outside the loop and cleared from outside it. */
  private running(): boolean {
    return this.polling;
  }

  /** One message: validated, delivered to the use case, and reported as what it amounted to. */
  private async deliver(message: Message): Promise<DeliveryReport> {
    let messageId: string | null = null;

    try {
      const requested = wagerTransactionRequestedOf(message.Body);
      messageId = requested.messageId;

      const outcome = await this.dependencies.submit.deliver(
        commandOf(requested),
        deliveryOf(requested, this.dependencies.consumerName),
      );

      if (outcome.absorbed) {
        this.dependencies.metrics.increment('wager_duplicates_detected_total', {
          source: 'inbox',
        });
      }

      return { classification: 'business', messageId, outcome, acknowledged: true };
    } catch (error) {
      return this.failure(error, messageId, message);
    }
  }

  /**
   * `msg.ack-after-commit`: the delete, issued once the transaction that recorded the message
   * committed. The receipt handle identifies the delivery to the broker and nothing else; the
   * identity that survives a redelivery is the body `messageId` the inbox row holds.
   */
  private async acknowledge(queueUrl: string, message: Message): Promise<void> {
    await this.dependencies.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  /**
   * The failure as its class, counted and logged. The reused message id is counted as the duplicate
   * it is (`msg.inbox-payload-conflict`), and the broker's receipt id is logged for diagnosis and
   * for nothing else (`msg.inbox-identity`). The log carries the failure, never the body: a message
   * an operator has to read is the one in the dead-letter queue (`obs.no-sensitive-data`).
   */
  private failure(error: unknown, messageId: string | null, message: Message): DeliveryReport {
    const classification = classificationOf(error);

    if (error instanceof InboxPayloadConflictError) {
      this.dependencies.metrics.increment('wager_duplicates_detected_total', {
        source: 'inbox-conflict',
      });
    }

    this.dependencies.logger.error('wager.message.not-applied', {
      classification,
      messageId,
      receiptId: message.MessageId ?? null,
      failure: error instanceof Error ? error.name : 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    });

    return { classification, messageId, error, acknowledged: false };
  }
}

/**
 * `msg.classification` for the two classes that are not terminal for the message: a transient
 * failure is one a later receive of the same message can still succeed at, a permanent one is not.
 *
 * `ServiceUnavailableError` is the transient one the unit of work raises for an unreachable
 * database, a lock wait and a serialization failure (`api.transient-failure`), and it is matched
 * before `ApplicationError`, which it extends. Every other refusal a use case raises is a
 * provider's mistake — a validation failure, a reused message id, an unknown wallet, an
 * idempotency conflict — and delivering the same body again cannot change it. Anything else is
 * unclassified and treated as transient, so nothing becomes terminal because nobody classified it;
 * #17 is where that rule and the actions behind all three classes are completed.
 */
function classificationOf(error: unknown): 'transient' | 'permanent' {
  if (error instanceof ServiceUnavailableError) {
    return 'transient';
  }

  const permanent =
    error instanceof MessageContractError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof ApplicationError;

  return permanent ? 'permanent' : 'transient';
}
