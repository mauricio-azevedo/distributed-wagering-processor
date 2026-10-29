import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly sqs: SQSClient,
    private readonly indicators: HealthIndicatorService,
    /** The input queue of this deployment, from `wagerQueues`: readiness is about the one it polls. */
    private readonly queueName: string,
  ) {}

  /** Resolves the input queue by name: SQS answers and the queue exists. */
  check<const Key extends string>(key: Key) {
    return this.indicators
      .check(key)
      .attempt(async ({ signal }) => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
          abortSignal: signal,
        });
      })
      .withTimeout(2_000);
  }
}
