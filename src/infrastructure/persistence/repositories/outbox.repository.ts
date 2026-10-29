import type { EntityManager } from '@mikro-orm/postgresql';

import type { OutboxRepository } from '../../../application/ports/repositories';
import type { OutboxMessage } from '../../../domain/outbox-message';
import {
  OutboxMessageRow,
  toOutboxMessage,
  toOutboxMessageRow,
} from '../mappings/outbox-message.mapping';

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
}
