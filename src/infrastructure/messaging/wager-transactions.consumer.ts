import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type MessageSystemAttributeName,
  ReceiveMessageCommand,
  type SQSClient,
  SendMessageCommand,
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
import { type LogContext, withLogContext } from '../observability/log-context';
import { WorkerLoop, type WorkerProcess } from '../runtime/worker-loop';
import {
  MessageContractError,
  type WagerTransactionRequested,
  commandOf,
  deliveryOf,
  wagerTransactionRequestedOf,
} from './wager-transaction-message.dto';
import { type VisibilityBackoff, visibilityBackoffSeconds } from './visibility-backoff';

/**
 * The queue entry point: `wager-transactions.fifo` into the same `SubmitWagerTransaction` the
 * controller calls (`msg.same-use-case`). It translates a message into a command and a delivery,
 * and decides nothing about money: the use case owns the outcome, the message DTO owns what a
 * message has to look like, and the inbox row the use case writes is what makes a redelivery
 * harmless (ADR 0010).
 *
 * Every delivery is classified before anything is done to the message (`msg.classification`), and
 * the class alone decides the action:
 *
 * - business — the use case answered, whatever the answer was. The message is deleted, and only
 *   after the transaction that recorded it committed (`msg.ack-after-commit`): `deliver` resolves
 *   when the commit returned, and the delete is the next statement. A crash in between leaves the
 *   message in the queue, and its redelivery is absorbed by the inbox (`msg.redelivery-safe`).
 * - transient — a later delivery of the same body can still succeed, so the message is returned
 *   with a visibility derived from the receive count (`msg.transient-backoff`) and the queue's own
 *   redrive policy dead-letters it once the receives are exhausted.
 * - permanent — no delivery of this body can succeed, so it is forwarded to the dead-letter queue
 *   and then deleted, without waiting out five receives of a failure nobody can fix
 *   (`msg.permanent-to-dlq`).
 *
 * Every delivery is bound to the identity its message carries and measured as one processing of the
 * queue entrypoint: the correlation id and the message id reach every line the delivery produces
 * without being handed to anything (`obs.correlation-propagation`), and what was done about the
 * message is counted where the disposition is known and nowhere else (`obs.metrics`).
 *
 * None of it depends on the queue being FIFO or on the broker's deduplication window
 * (`msg.broker-features-optional`): the order deliveries arrive in decides nothing here, and a
 * duplicate the broker did not filter is absorbed by the inbox row rather than by this consumer.
 *
 * A broker call that fails leaves the message where it is instead of failing the batch, so one
 * refused call cannot starve the messages behind it and nothing is ever deleted on the strength of
 * a call that did not happen.
 *
 * `start` and `stop` are the loop, and `stop` is `msg.sigterm`: the receive in flight is abandoned,
 * the message being processed is finished and acknowledged, and every message of the batch this
 * consumer had not reached is handed straight back with its visibility cleared, so another instance
 * takes it immediately instead of waiting out the visibility timeout.
 */

/** `msg.inbox-identity`: the consumer half of every inbox identity this consumer writes. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

/**
 * The ceiling SQS puts on one `ReceiveMessage`. The batch is processed one message at a time, so
 * the group order of a FIFO queue survives it, and a larger batch would only mean more messages
 * holding their visibility while the ones before them commit.
 */
const MAX_MESSAGES_PER_RECEIVE = 10;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * How long the loop waits after a receive that answered nothing, including one that failed. A
 * receive that long-polled has already waited `waitTimeSeconds`, so this is what keeps a consumer
 * configured with no long poll — a suite, or a broker that answers at once — from spinning, and the
 * pause that lets an unreachable broker be unreachable for a second rather than be asked constantly.
 */
const EMPTY_RECEIVE_INTERVAL_MS = 1000;

/** The visibility a released message is handed back under: none, so another instance sees it now. */
const IMMEDIATELY_VISIBLE_SECONDS = 0;

/**
 * The delivery attributes this consumer reads. The receive count drives the transient backoff; the
 * group and deduplication ids are copied onto a forwarded message, so a dead letter keeps the
 * routing its producer gave it (`msg.permanent-to-dlq`). The broker's own message id is not asked
 * for because it arrives with every message anyway, and is never an identity.
 */
const DELIVERY_ATTRIBUTES: readonly MessageSystemAttributeName[] = [
  'ApproximateReceiveCount',
  'MessageGroupId',
  'MessageDeduplicationId',
];

/**
 * A delivery the use case answered, whatever the answer was: the outcome is terminal for the
 * message, so the body parsed and its message id is known.
 */
interface BusinessDelivery {
  readonly classification: 'business';
  readonly messageId: string;
  readonly outcome: DeliveryOutcome;
}

/**
 * A delivery that failed, as one of the two failure classes. The message id is what the body
 * carried, and `null` when the body never parsed; the broker's receipt id is never an identity.
 */
interface FailedDelivery<Class extends 'transient' | 'permanent'> {
  readonly classification: Class;
  readonly messageId: string | null;
  readonly error: unknown;
}

/**
 * A delivery this consumer took from the broker and never opened, because it was draining
 * (`msg.sigterm`). It is not one of the three classes: nothing was attempted, so there is nothing
 * to classify, and the body was not even parsed — the message is handed back as it arrived.
 */
interface UnopenedDelivery {
  readonly classification: 'unopened';
  /** Always absent: a report carries the identity the body declared, and this body was not read. */
  readonly messageId: null;
}

/** A delivery as its class, before anything has been done about it (`msg.classification`). */
type ClassifiedDelivery =
  BusinessDelivery | FailedDelivery<'transient'> | FailedDelivery<'permanent'>;

/**
 * What one delivery amounted to, with what was done about it. The report carries what a test and a
 * log line need and nothing else, the class deciding which of the three shapes it is.
 *
 * The `disposition` names the state of the message in the input queue and nothing else, so a report
 * never claims a broker call that was refused:
 *
 * - `acknowledged` — deleted, the committed outcome being terminal for the message.
 * - `returned` — visibility set to the transient backoff, so it comes back on that schedule.
 * - `dead-lettered` — forwarded to the dead-letter queue and then deleted.
 * - `released` — visibility cleared, so it is immediately available to another instance. It is what
 *   a drain does with a message it took and will not process (`msg.sigterm`).
 * - `retained` — still in the input queue, because the broker refused the call that would have
 *   moved it. The broker redelivers it, and nothing was lost: an acknowledgement that failed is a
 *   redelivery the inbox absorbs, a forward that failed is a message the redrive policy
 *   dead-letters once its receives are exhausted, and a release that failed is one the visibility
 *   timeout hands back a little later.
 */
export type DeliveryReport =
  | (BusinessDelivery & { readonly disposition: 'acknowledged' | 'retained' })
  | (FailedDelivery<'transient'> & {
      /** The backoff asked of the broker, which `retained` means it did not accept. */
      readonly visibilitySeconds: number;
      readonly disposition: 'returned' | 'retained';
    })
  | (FailedDelivery<'permanent'> & { readonly disposition: 'dead-lettered' | 'retained' })
  | (UnopenedDelivery & { readonly disposition: 'released' | 'retained' });

/**
 * The failure a report carries, or `null` when the delivery did not fail: the use case answered, or
 * the message was handed back unopened. It exists so a caller reads one function instead of
 * narrowing the union by hand wherever it wants to know what went wrong.
 */
export function failureOf(report: DeliveryReport): unknown {
  return report.classification === 'transient' || report.classification === 'permanent'
    ? report.error
    : null;
}

export interface WagerTransactionsConsumerDependencies {
  readonly sqs: SQSClient;
  /** The input queue's URL; the name is contract, the URL is deployment (`msg.queues`). */
  readonly queueUrl: () => Promise<string>;
  /** `wager-transactions-dlq.fifo`, resolved the same way and only when a message needs it. */
  readonly deadLetterQueueUrl: () => Promise<string>;
  readonly submit: SubmitWagerTransaction;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly consumerName: string;
  /** Long polling: how long one receive waits for a message before answering empty. */
  readonly waitTimeSeconds: number;
  /** How long a received message stays invisible, which is how long processing it may take. */
  readonly visibilityTimeoutSeconds: number;
  /** `msg.transient-backoff`: the schedule a returned message comes back on. */
  readonly retryBackoff: VisibilityBackoff;
}

export class WagerTransactionsConsumer implements WorkerProcess {
  private readonly loop: WorkerLoop;

  /** The receive in flight, so a drain can abandon it instead of waiting out its long poll. */
  private receiving: AbortController | undefined;

  constructor(private readonly dependencies: WagerTransactionsConsumerDependencies) {
    this.loop = new WorkerLoop({
      cycle: async () => (await this.poll()).length > 0,
      // A receive that found nothing has already long-polled for `waitTimeSeconds`, so this wait is
      // only what keeps a consumer configured not to long-poll from spinning on an empty queue.
      idleIntervalMs: EMPTY_RECEIVE_INTERVAL_MS,
      failureEvent: 'wager.poll-failed',
      logger: dependencies.logger,
    });
  }

  get name(): string {
    return this.dependencies.consumerName;
  }

  /**
   * One receive-and-process cycle, which is what the loop repeats and what a test drives directly.
   * Messages are processed in the order the broker handed them over and one at a time, so a FIFO
   * group is applied in its order and no message of a batch waits on another's commit.
   *
   * Once the consumer is draining, the messages of the batch it has not reached are not opened at
   * all: each is handed back with its visibility cleared, which is the half of `msg.sigterm` that
   * gets them to another instance immediately rather than after the visibility timeout.
   */
  async poll(): Promise<readonly DeliveryReport[]> {
    const queueUrl = await this.dependencies.queueUrl();
    const received = await this.receive(queueUrl);

    const reports: DeliveryReport[] = [];

    for (const message of received) {
      reports.push(
        this.loop.claiming()
          ? await this.handle(queueUrl, message)
          : await this.hand(queueUrl, message),
      );
    }

    return reports;
  }

  /** Receive, process, repeat until `stop`. */
  start(): void {
    this.loop.start();
  }

  /**
   * `msg.sigterm`: stop receiving, finish what is in flight, hand back the rest.
   *
   * The receive in flight is abandoned rather than awaited, because a long poll holds a drain for
   * up to twenty seconds for messages that have not arrived. A receive the broker had already
   * answered when the abort landed is the one window this leaves: those messages were never handed
   * to this process, so they are redelivered when their visibility expires and absorbed by the
   * inbox — late, never lost (`msg.redelivery-safe`).
   */
  async stop(): Promise<void> {
    const stopping = this.loop.stop();
    this.receiving?.abort();
    await stopping;
  }

  /**
   * One receive, under an abort a drain can trigger. A receive that was abandoned answers with no
   * messages instead of raising: the drain asked for it, and there is nothing for the loop to
   * report or retry.
   */
  private async receive(queueUrl: string): Promise<readonly Message[]> {
    const receiving = new AbortController();
    this.receiving = receiving;

    try {
      const { Messages } = await this.dependencies.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: MAX_MESSAGES_PER_RECEIVE,
          WaitTimeSeconds: this.dependencies.waitTimeSeconds,
          VisibilityTimeout: this.dependencies.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: [...DELIVERY_ATTRIBUTES],
        }),
        { abortSignal: receiving.signal },
      );

      return Messages ?? [];
    } catch (error) {
      if (receiving.signal.aborted) {
        return [];
      }

      throw error;
    } finally {
      this.receiving = undefined;
    }
  }

  /**
   * One message, from its body to what was done about it. The identity the message carries is bound
   * before anything else runs, so every line this delivery produces — the use case's, this
   * consumer's, a broker refusal's — carries the correlation id and the message id without being
   * handed them (`obs.correlation-propagation`, OBS-005). A body that never parsed binds nothing,
   * because nothing about it is known.
   *
   * The whole of it is one measurement of the queue entrypoint: the processing an operator cares
   * about is how long the service held the message, acknowledgement included (`obs.metrics`). It is
   * taken from a monotonic reading and not from the `Clock` port, because a duration is not a
   * moment any financial decision is taken against.
   */
  private async handle(queueUrl: string, message: Message): Promise<DeliveryReport> {
    const parsed = parsedOf(message.Body);
    const startedAt = performance.now();

    return withLogContext(contextOf(parsed), async () => {
      try {
        return await this.act(queueUrl, message, await this.deliver(parsed, message));
      } finally {
        this.dependencies.metrics.observe(
          'wager_processing_duration_seconds',
          { entrypoint: 'queue' },
          (performance.now() - startedAt) / MILLISECONDS_PER_SECOND,
        );
      }
    });
  }

  /** The parsed message delivered to the use case, and classified by what came back. */
  private async deliver(parsed: ParsedBody, message: Message): Promise<ClassifiedDelivery> {
    if (!('requested' in parsed)) {
      return this.failure(parsed.failure, null, message);
    }

    const requested = parsed.requested;

    try {
      const outcome = await this.dependencies.submit.deliver(
        commandOf(requested),
        deliveryOf(requested, this.dependencies.consumerName),
      );

      return { classification: 'business', messageId: requested.messageId, outcome };
    } catch (error) {
      return this.failure(error, requested.messageId, message);
    }
  }

  /** The action the class decides, and the report of what the broker made of it. */
  private async act(
    queueUrl: string,
    message: Message,
    delivery: ClassifiedDelivery,
  ): Promise<DeliveryReport> {
    if (delivery.classification === 'business') {
      return this.reported({ ...delivery, disposition: await this.acknowledge(queueUrl, message) });
    }

    if (delivery.classification === 'permanent') {
      return this.reported({ ...delivery, disposition: await this.deadLetter(queueUrl, message) });
    }

    const visibilitySeconds = visibilityBackoffSeconds(
      receiveCountOf(message),
      this.dependencies.retryBackoff,
    );

    return this.reported({
      ...delivery,
      visibilitySeconds,
      disposition: await this.returnToQueue(queueUrl, message, visibilitySeconds),
    });
  }

  /**
   * What was done about one message, counted and logged. The counters are raised here because this
   * is where the disposition is known and nowhere else: a retry is a message the broker accepted a
   * new visibility for (`msg.transient-backoff`), a dead letter is one it accepted the forward of
   * (`msg.permanent-to-dlq`), and a `retained` report — a call the broker refused — counts neither,
   * so the numbers stay a count of what happened rather than of what was attempted.
   */
  private reported(report: DeliveryReport): DeliveryReport {
    if (report.disposition === 'returned') {
      this.dependencies.metrics.increment('wager_retries_total', { component: 'queue' });
    }

    if (report.disposition === 'dead-lettered') {
      this.dependencies.metrics.increment('wager_dlq_messages_total');
    }

    this.dependencies.logger.info('wager.message.handled', {
      classification: report.classification,
      disposition: report.disposition,
      messageId: report.messageId,
    });

    return report;
  }

  /**
   * `msg.ack-after-commit`: the delete, issued once the transaction that recorded the message
   * committed. The receipt handle identifies the delivery to the broker and nothing else; the
   * identity that survives a redelivery is the body `messageId` the inbox row holds.
   *
   * A refused delete is the window the inbox exists for, so it is logged and not raised: the
   * message is redelivered and absorbed, which is cheaper than failing the rest of the batch over
   * an effect that is already committed.
   */
  private async acknowledge(
    queueUrl: string,
    message: Message,
  ): Promise<'acknowledged' | 'retained'> {
    try {
      await this.dependencies.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );

      return 'acknowledged';
    } catch (error) {
      this.brokerRefused('wager.message.not-acknowledged', error, message);

      return 'retained';
    }
  }

  /**
   * `msg.transient-backoff`: the message handed back with the delay its receive count earned. The
   * redrive policy, not this call, is what ends the sequence — after five receives the broker moves
   * the message to the dead-letter queue instead of delivering it again — so this consumer counts
   * nothing and gives up on nothing.
   *
   * A refused visibility change leaves the message with the visibility its receive was granted,
   * which is a shorter wait and not a lost message, so it is logged and the report says the backoff
   * did not take.
   */
  private async returnToQueue(
    queueUrl: string,
    message: Message,
    visibilitySeconds: number,
  ): Promise<'returned' | 'retained'> {
    try {
      await this.dependencies.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );

      return 'returned';
    } catch (error) {
      this.brokerRefused('wager.message.not-returned', error, message);

      return 'retained';
    }
  }

  /**
   * `msg.sigterm`: a message this consumer took and will not process, handed straight back with its
   * visibility cleared so another instance receives it at once. Nothing was attempted on it, so
   * there is no outcome, no inbox row and nothing to undo; what the next instance gets is a
   * delivery of the same body, one receive later.
   *
   * A refused release leaves the message invisible for the rest of its visibility timeout, which is
   * a redelivery slightly later and not a loss, so it is logged and reported as retained.
   */
  private async hand(queueUrl: string, message: Message): Promise<DeliveryReport> {
    const unopened: UnopenedDelivery = { classification: 'unopened', messageId: null };

    try {
      await this.dependencies.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: IMMEDIATELY_VISIBLE_SECONDS,
        }),
      );

      return { ...unopened, disposition: 'released' };
    } catch (error) {
      this.brokerRefused('wager.message.not-released', error, message);

      return { ...unopened, disposition: 'retained' };
    }
  }

  /**
   * `msg.permanent-to-dlq`: the forward, then the delete, in that order and never the other way
   * round. A forward that failed therefore leaves the message in the input queue, where the redrive
   * policy will dead-letter it after its receives: nothing is lost when the broker refuses the
   * send, which is the one ordering this method exists to fix.
   *
   * The body is forwarded unchanged, so an operator reads the message as it arrived — a dead letter
   * may well violate the message schema, validation failure being one of the permanent classes —
   * and the group and deduplication ids are copied, so a redelivery after a crash between the
   * forward and the delete dead-letters the same body and the broker deduplicates it.
   */
  private async deadLetter(
    queueUrl: string,
    message: Message,
  ): Promise<'dead-lettered' | 'retained'> {
    const deduplicationId = attributeOf(message, 'MessageDeduplicationId');

    try {
      await this.dependencies.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.dependencies.deadLetterQueueUrl(),
          MessageBody: message.Body,
          // A FIFO queue always carries a group; the consumer's own name stands in for one the
          // broker did not report, because order in a queue nothing consumes decides nothing.
          MessageGroupId: attributeOf(message, 'MessageGroupId') ?? this.dependencies.consumerName,
          // Absent, the dead-letter queue deduplicates on the body it was handed.
          ...(deduplicationId !== undefined && { MessageDeduplicationId: deduplicationId }),
        }),
      );
    } catch (error) {
      this.brokerRefused('wager.message.not-dead-lettered', error, message);

      return 'retained';
    }

    return (await this.acknowledge(queueUrl, message)) === 'acknowledged'
      ? 'dead-lettered'
      : 'retained';
  }

  /**
   * The failure as its class, logged with the broker's receipt id for diagnosis and for nothing
   * else (`msg.inbox-identity`). The log carries the failure, never the body: a message an operator
   * has to read is the one in the dead-letter queue (`obs.no-sensitive-data`).
   *
   * The duplicate a reused message id is is counted by the use case that claimed the inbox row,
   * which is where the reuse is recognised (`msg.inbox-payload-conflict`): this consumer sees a
   * refusal it could not tell from any other permanent one.
   */
  private failure(
    error: unknown,
    messageId: string | null,
    message: Message,
  ): FailedDelivery<'transient'> | FailedDelivery<'permanent'> {
    const classification = classificationOf(error);

    this.dependencies.logger.error('wager.message.not-applied', {
      classification,
      messageId,
      receiptId: message.MessageId ?? null,
      ...describe(error),
    });

    return { classification, messageId, error };
  }

  /**
   * A broker call that did not happen, as the operational event it is: the message is still in the
   * input queue and the broker will deliver it again, so this is a line for an operator watching a
   * dependency and never a reason to stop the batch.
   */
  private brokerRefused(event: string, error: unknown, message: Message): void {
    this.dependencies.logger.error(event, {
      receiptId: message.MessageId ?? null,
      ...describe(error),
    });
  }
}

/**
 * A body read before anything is done with it: the message it is, or whatever refused to parse it.
 * The failure is carried as it was raised rather than as a contract error, so the classification
 * below still decides it: a validation failure is permanent, and a defect nobody classified stays
 * transient instead of being dead-lettered on the strength of where it happened.
 */
type ParsedBody = { readonly requested: WagerTransactionRequested } | { readonly failure: unknown };

/**
 * The message a body is, or the refusal it is not (`msg.message-contract`). It is read before the
 * identity is bound rather than inside the delivery, because the correlation id and the message id
 * every line of that delivery is searched by are only known once the body parsed.
 */
function parsedOf(body: string | undefined): ParsedBody {
  try {
    return { requested: wagerTransactionRequestedOf(body) };
  } catch (failure) {
    return { failure };
  }
}

/**
 * The identity one delivery binds (`msg.correlation`, `msg.inbox-identity`). A body that never
 * parsed carries none: a line about it says what is known, which is the broker's receipt id.
 */
function contextOf(parsed: ParsedBody): LogContext {
  if (!('requested' in parsed)) {
    return {};
  }

  return {
    correlationId: commandOf(parsed.requested).correlationId,
    messageId: parsed.requested.messageId,
  };
}

/**
 * `msg.classification` for the two classes that are not terminal for the message: a transient
 * failure is one a later receive of the same message can still succeed at, a permanent one is not.
 *
 * `ServiceUnavailableError` is the transient one the unit of work raises for an unreachable
 * database, a lock wait and a serialization failure (`api.transient-failure`), and it is matched
 * before `ApplicationError`, which it extends. Every other refusal a use case raises is a
 * provider's mistake — a validation failure, a reused message id, an unknown wallet, an
 * idempotency conflict — and delivering the same body again cannot change it.
 *
 * Anything else is unclassified and treated as transient, which is the rule that keeps a defect
 * from becoming terminal: an error nobody classified is retried and, its receives exhausted, kept
 * in the dead-letter queue by the broker, so it is never discarded and never acknowledged as if it
 * had been applied (`ref.permanent-failure`).
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

/** The two fields every failure is logged by: what it was and what it said. */
function describe(error: unknown): { readonly failure: string; readonly reason: string } {
  return {
    failure: error instanceof Error ? error.name : 'unknown',
    reason: error instanceof Error ? error.message : String(error),
  };
}

/**
 * How often the broker has delivered this message, counting this delivery. An attribute it did not
 * report, or one this consumer cannot read as a count, leaves the backoff at its base.
 */
function receiveCountOf(message: Message): number {
  return Number(message.Attributes?.ApproximateReceiveCount ?? Number.NaN);
}

/** One delivery attribute, with the empty string read as the absence it stands for. */
function attributeOf(
  message: Message,
  name: 'MessageGroupId' | 'MessageDeduplicationId',
): string | undefined {
  const value = message.Attributes?.[name];

  return value === undefined || value === '' ? undefined : value;
}
