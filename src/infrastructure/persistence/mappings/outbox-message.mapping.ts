import { EntitySchema } from '@mikro-orm/postgresql';

import type {
  IntegrationEventEnvelope,
  IntegrationEventType,
} from '../../../domain/integration-events';
import { OutboxMessage } from '../../../domain/outbox-message';

/**
 * The `outbox_messages` row (ADR 0008). The envelope is stored as it was enqueued, so every
 * publication of the row is the same message (`outbox.duplicate-safe`) and nothing is rebuilt
 * from state that has moved on.
 */
export class OutboxMessageRow {
  eventId!: string;
  eventType!: string;
  aggregateId!: string;
  payload!: IntegrationEventEnvelope;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    eventId: { type: 'uuid', primary: true },
    eventType: { type: 'string', columnType: 'text' },
    aggregateId: { type: 'uuid' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    publishedAt: { type: 'datetime', nullable: true },
  },
});

/** `model.rehydrate-no-revalidation`: a stored row, pending or published. */
export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    eventId: row.eventId,
    eventType: row.eventType as IntegrationEventType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: row.publishedAt,
  });
}

export function toOutboxMessageRow(message: OutboxMessage): OutboxMessageRow {
  const row = new OutboxMessageRow();
  row.eventId = message.eventId;
  row.eventType = message.eventType;
  row.aggregateId = message.aggregateId;
  row.payload = message.payload;
  row.occurredAt = message.occurredAt;
  row.attempts = message.attempts;
  row.nextAttemptAt = message.nextAttemptAt;
  row.publishedAt = message.publishedAt;

  return row;
}
