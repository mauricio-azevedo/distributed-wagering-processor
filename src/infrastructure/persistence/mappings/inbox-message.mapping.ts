import { EntitySchema } from '@mikro-orm/postgresql';

import { InboxMessage } from '../../../domain/inbox-message';

/**
 * The `inbox_messages` row (ADR 0008). Its primary key is the pair the consumer deduplicates by,
 * so the database, not an instance, decides whether a message is new (`msg.inbox-identity`).
 */
export class InboxMessageRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const inboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 64, primary: true },
    messageId: { type: 'string', length: 128, primary: true },
    payloadHash: { type: 'string', length: 71 },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

/** `model.rehydrate-no-revalidation`: a stored row, complete or still in flight. */
export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  });
}

export function toInboxMessageRow(message: InboxMessage): InboxMessageRow {
  const row = new InboxMessageRow();
  row.consumerName = message.consumerName;
  row.messageId = message.messageId;
  row.payloadHash = message.payloadHash;
  row.receivedAt = message.receivedAt;
  row.processedAt = message.processedAt;

  return row;
}
