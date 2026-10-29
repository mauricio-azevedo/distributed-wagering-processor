import { Migration } from '@mikro-orm/migrations';

/**
 * `obs.correlation-propagation` (OBS-005): the claim list carries the correlation id of the arrival
 * that parked the transaction, so a scheduled attempt an hour later — in another process, with no
 * request and no message behind it — is logged and announced under the id of the operation that
 * created the work (ADR 0011, ADR 0012).
 *
 * It is a `varchar(128)`, the cap `CorrelationId` of [docs/openapi.yaml](../../../../docs/openapi.yaml)
 * puts on the header and `msg.correlation` on the message member, and it has no default like every
 * other column of this schema: the application decides every value it writes.
 *
 * A row parked before this migration recorded no correlation id, and there is no value that would
 * be the truth for it, so it is backfilled with the transaction's own id: still a value every line
 * and every event of those attempts can be found under, and unmistakable for an id a provider sent.
 * The column is made `NOT NULL` afterwards, which is what keeps the absence a one-off of the
 * migration rather than a state the mapping has to admit.
 */
export class Migration20261029020000_schedule_correlation extends Migration {
  override up(): void {
    this.addSql(`alter table "pending_reference_schedule"
      add column "correlation_id" varchar(128) null`);
    this.addSql(`update "pending_reference_schedule"
         set "correlation_id" = "transaction_id"::text
       where "correlation_id" is null`);
    this.addSql(`alter table "pending_reference_schedule"
      alter column "correlation_id" set not null`);
  }

  override down(): void {
    this.addSql(`alter table "pending_reference_schedule" drop column "correlation_id"`);
  }
}
