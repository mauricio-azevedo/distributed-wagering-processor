import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';

import type { Env } from '../config/env';

// Queue names are fixed by the messaging rules; docker/localstack/queues.sh creates them locally.
export const WAGER_TRANSACTIONS_QUEUE = 'wager-transactions.fifo';
export const WAGER_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
export const WAGER_INTEGRATION_EVENTS_QUEUE = 'wager-integration-events.fifo';

/** The three queues of `msg.queues`, as this process addresses them. */
export interface WagerQueues {
  readonly input: string;
  readonly deadLetter: string;
  readonly events: string;
}

/**
 * The three names under `SQS_QUEUE_PREFIX` (`ops.suite-isolation`). The names are the transport
 * contract and the prefix is the namespace of one deployment, so the prefix is applied here, once,
 * and no component spells a name out: an empty prefix is the contract names unchanged, which is
 * what a deployment that sets nothing addresses.
 */
export function wagerQueues(prefix: string): WagerQueues {
  return {
    input: `${prefix}${WAGER_TRANSACTIONS_QUEUE}`,
    deadLetter: `${prefix}${WAGER_TRANSACTIONS_DLQ}`,
    events: `${prefix}${WAGER_INTEGRATION_EVENTS_QUEUE}`,
  };
}

/** One client per process; credentials come from the SDK's default chain. */
export function sqsClientProvider(env: Env): Provider {
  return {
    provide: SQSClient,
    useFactory: () =>
      new SQSClient({
        region: env.AWS_REGION,
        ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
      }),
  };
}

/**
 * The URL of a queue, resolved once per process and remembered: the name is contract
 * (`msg.queues`) and the URL is deployment, so nothing in the service spells one out.
 *
 * A failed resolution is not remembered, so a consumer that started before the broker was
 * reachable resolves on its next poll instead of holding the failure for the life of the process.
 */
export function queueUrlResolver(sqs: SQSClient, queueName: string): () => Promise<string> {
  let resolved: Promise<string> | null = null;

  return () => {
    resolved ??= sqs
      .send(new GetQueueUrlCommand({ QueueName: queueName }))
      .then(({ QueueUrl }) => {
        if (QueueUrl === undefined) {
          throw new Error(`SQS answered no URL for queue ${queueName}`);
        }

        return QueueUrl;
      })
      .catch((error: unknown) => {
        resolved = null;

        throw error;
      });

    return resolved;
  };
}
