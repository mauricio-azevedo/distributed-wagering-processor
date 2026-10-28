import { SQSClient } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';

import type { Env } from '../config/env';

// Queue names are fixed by the messaging rules; docker/localstack/queues.sh creates them locally.
export const WAGER_TRANSACTIONS_QUEUE = 'wager-transactions.fifo';
export const WAGER_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
export const WAGER_INTEGRATION_EVENTS_QUEUE = 'wager-integration-events.fifo';

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
