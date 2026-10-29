import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { OpenEndpoint } from '../http/open-endpoint';
import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

/**
 * The two probes of `obs.health-split`. They answer an orchestrator, which presents no credentials
 * and must not be made to: both stay open whatever the authentication setting
 * (`api.health-open`, `auth.open-endpoints`).
 */
@OpenEndpoint()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  /** The process serves HTTP. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** Every dependency answers; a 503 stops traffic before requests fail. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.postgres.check('postgres'), () => this.sqs.check('sqs')]);
  }
}
