import type { EntityManager, QueryResult } from '@mikro-orm/postgresql';

import type { PendingReferenceScheduleRepository } from '../../../application/ports/repositories';
import type { PendingReferenceSchedule } from '../../../domain/pending-reference-schedule';
import {
  type ClaimedPendingReferenceScheduleRow,
  PendingReferenceScheduleRow,
  toPendingReferenceSchedule,
  toPendingReferenceScheduleRow,
} from '../mappings/pending-reference-schedule.mapping';

/**
 * `ref.scheduler`: the claim, as one explicit statement.
 *
 * `FOR UPDATE OF "s" SKIP LOCKED` is what makes the claim exclusive without any worker waiting: a
 * row another worker is attempting is passed over rather than queued behind, so several schedulers
 * sweep one backlog in parallel and a worker that dies mid-attempt releases its claim with its
 * connection (ADR 0005 claims the outbox the same way). The lock covers the schedule row alone,
 * which is why the locking clause names its alias: the transaction row is read here and locked, if
 * at all, by the operation itself.
 *
 * The join is what retires a row. The runtime role holds no `DELETE` on any table
 * (`tx.row-append-only`), so a schedule row outlives the wait it recorded; what takes a transaction
 * out of the claim list is reaching a terminal outcome, read from the transaction row in the same
 * statement that takes the lock. A row whose transaction is `PROCESSED`, `REJECTED` or `FAILED` is
 * therefore invisible to every later sweep, and the schedule row stays as the audit of how many
 * attempts that transaction took.
 *
 * `next_attempt_at <= ?` with `expires_at` is the index of SCHEMA-019's neighbour,
 * `pending_reference_schedule_claim_index`; the oldest due row is taken first, so a backlog drains
 * in the order it was parked rather than by whichever row the planner reaches.
 */
const CLAIM_NEXT_DUE = `select "s"."transaction_id" as "transactionId",
                               "s"."attempts",
                               "s"."next_attempt_at" as "nextAttemptAt",
                               "s"."expires_at" as "expiresAt"
                          from "pending_reference_schedule" as "s"
                          join "wager_transactions" as "t" on "t"."id" = "s"."transaction_id"
                         where "s"."next_attempt_at" <= ?
                           and "t"."status" = 'PENDING_REFERENCE'
                         order by "s"."next_attempt_at"
                         limit 1
                           for update of "s" skip locked`;

/** `PendingReferenceScheduleRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmPendingReferenceScheduleRepository implements PendingReferenceScheduleRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(schedule: PendingReferenceSchedule): Promise<void> {
    this.em.persist(toPendingReferenceScheduleRow(schedule));
    await this.em.flush();
  }

  async claimNextDue(at: Date): Promise<PendingReferenceSchedule | null> {
    const [row] = await this.em.execute<ClaimedPendingReferenceScheduleRow[]>(CLAIM_NEXT_DUE, [at]);

    return row === undefined ? null : toPendingReferenceSchedule(row);
  }

  /**
   * The two columns an attempt changes, and no others: the window a row was opened with is never
   * rewritten (`ref.ttl`), and the transaction it belongs to is not this row's to name.
   *
   * No row updated means the schedule this is the attempt of is gone, which nothing can do — the
   * runtime role cannot delete it — so it is raised rather than reported.
   */
  async update(schedule: PendingReferenceSchedule): Promise<void> {
    const result = await this.em
      .createQueryBuilder(PendingReferenceScheduleRow)
      .update({ attempts: schedule.attempts, nextAttemptAt: schedule.nextAttemptAt })
      .where({ transactionId: schedule.transactionId })
      .execute<QueryResult<PendingReferenceScheduleRow>>('run');

    if (result.affectedRows !== 1) {
      throw new Error(
        `rescheduling the pending reference of transaction ${schedule.transactionId} matched no row`,
      );
    }
  }
}
