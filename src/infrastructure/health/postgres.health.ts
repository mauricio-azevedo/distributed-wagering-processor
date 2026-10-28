import { MikroORM } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly orm: MikroORM,
    private readonly indicators: HealthIndicatorService,
  ) {}

  /** `SELECT 1` through the pool: the runtime role reaches PostgreSQL right now. */
  check<const Key extends string>(key: Key) {
    return this.indicators
      .check(key)
      .attempt(async () => {
        await this.orm.em.getConnection().execute('select 1');
      })
      .withTimeout(1_000);
  }
}
