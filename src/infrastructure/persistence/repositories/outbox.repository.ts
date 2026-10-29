import type { EntityManager, QueryResult } from '@mikro-orm/postgresql';

import type {
  OutboxBacklog,
  OutboxClaim,
  OutboxRepository,
} from '../../../application/ports/repositories';
import type {
  IntegrationEventEnvelope,
  IntegrationEventType,
} from '../../../domain/integration-events';
import { OutboxMessage } from '../../../domain/outbox-message';
import {
  OutboxMessageRow,
  toOutboxMessage,
  toOutboxMessageRow,
} from '../mappings/outbox-message.mapping';

/**
 * ADR 0005's claim, as one statement. `FOR UPDATE SKIP LOCKED` is the whole protocol: the lock is
 * the claim, so a second publisher skips what this one holds instead of waiting for it
 * (`outbox.concurrent-publishers`), and PostgreSQL releases it when the publisher's connection
 * closes, which is why a crash needs no lease, no reaper and no operator
 * (`outbox.crash-recovery`).
 *
 * The predicate is the definition of pending work: `published_at is null` can only match committed
 * rows, which is `outbox.publish-after-commit` enforced by the database rather than by the
 * publisher's good behaviour, and `next_attempt_at` keeps a row that is backing off out of the
 * batch (`outbox.retry-backoff`). The order is `occurred_at, event_id` — the recorded order, with
 * the primary key breaking ties, because UUIDv7 does not order across instances. It is also the
 * order of `outbox_messages_claim_index`.
 *
 * It is spelled out rather than built through the ORM because the lock mode is the correctness of
 * this repository: `SKIP LOCKED` is what makes two publishers disjoint, and a statement that
 * quietly lost it would wait on another publisher's batch instead.
 */
const CLAIM_PENDING = `select "event_id" as "eventId",
                              "event_type" as "eventType",
                              "aggregate_id" as "aggregateId",
                              "payload",
                              "occurred_at" as "occurredAt",
                              "attempts",
                              "next_attempt_at" as "nextAttemptAt"
                         from "outbox_messages"
                        where "published_at" is null
                          and "next_attempt_at" <= ?
                        order by "occurred_at", "event_id"
                        limit ?
                          for update skip locked`;

/**
 * `outbox.lag-metrics`: the backlog as one aggregate over the same predicate the claim uses, minus
 * the due condition — a row that is backing off is still unpublished, and an operator alerting on
 * the backlog has to see it (OUTBOX-008). No locking clause: measuring must not wait on the
 * publisher it measures, and the index the claim already needs serves this scan too.
 */
const BACKLOG = `select count(*) as "pending", min("occurred_at") as "oldestOccurredAt"
                   from "outbox_messages"
                  where "published_at" is null`;

/** What `BACKLOG` answers: a count the driver renders as text, and a moment or no row at all. */
interface BacklogColumns {
  readonly pending: number | string;
  readonly oldestOccurredAt: Date | string | null;
}

/** The columns `CLAIM_PENDING` reads: a pending row, so `published_at` is known to be null. */
interface ClaimedColumns {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: IntegrationEventEnvelope;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

/** `OutboxRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    this.em.persist(toOutboxMessageRow(message));
    await this.em.flush();
  }

  async findByEventId(eventId: string): Promise<OutboxMessage | null> {
    const row = await this.em.findOne(OutboxMessageRow, { eventId });

    return row === null ? null : toOutboxMessage(row);
  }

  /**
   * The claim runs through the entity manager, so it is part of the transaction the unit of work
   * opened and the lock lives exactly as long as that transaction: the publisher cannot hold rows
   * beyond the commit that records what it did with them.
   *
   * The rows are rebuilt through the domain factory rather than loaded as managed entities, which
   * keeps the publication state the use case changes out of an identity map and makes
   * `recordAttempt` the one way a claimed row reaches the database.
   */
  async claimPending(claim: OutboxClaim): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<ClaimedColumns[]>(CLAIM_PENDING, [claim.dueAt, claim.limit]);

    return rows.map((row) =>
      OutboxMessage.rehydrate({
        eventId: row.eventId,
        eventType: row.eventType as IntegrationEventType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        publishedAt: null,
      }),
    );
  }

  /**
   * The three columns a publication attempt decides, and no others: the envelope, the event id and
   * the aggregate of an enqueued row are never rewritten (`outbox.stable-event-id`).
   *
   * Zero rows matched is a broken assumption and not an outcome: the caller holds this row's lock
   * from the claim, so the row is there. Raising it rolls the cycle back rather than committing a
   * batch whose publications were recorded for nothing.
   */
  async recordAttempt(message: OutboxMessage): Promise<void> {
    const result = await this.em
      .createQueryBuilder(OutboxMessageRow)
      .update({
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt,
      })
      .where({ eventId: message.eventId })
      .execute<QueryResult<OutboxMessageRow>>('run');

    if (result.affectedRows !== 1) {
      throw new Error(
        `recording the publication attempt of event ${message.eventId} matched no outbox row, so the row this publisher claimed is gone`,
      );
    }
  }

  /**
   * The backlog. `count` arrives as a string from PostgreSQL's `bigint` and the aggregate is read
   * through the mapping that turns both columns into the values the use case reasons about, the
   * same way a claimed row's timestamps are (ADR 0008).
   */
  async backlog(): Promise<OutboxBacklog> {
    const [row] = await this.em.execute<BacklogColumns[]>(BACKLOG);

    return {
      pending: Number(row?.pending ?? 0),
      oldestOccurredAt:
        row?.oldestOccurredAt === undefined || row.oldestOccurredAt === null
          ? null
          : new Date(row.oldestOccurredAt),
    };
  }
}
