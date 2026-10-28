import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import { WAGER_TRANSACTIONS_QUEUE } from '../messaging/sqs';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly sqs: SQSClient,
    private readonly indicators: HealthIndicatorService,
  ) {}

  /** Resolves the input queue by name: SQS answers and the queue exists. */
  check<const Key extends string>(key: Key) {
    return this.indicators
      .check(key)
      .attempt(async ({ signal }) => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE }), {
          abortSignal: signal,
        });
      })
      .withTimeout(2_000);
  }
}
