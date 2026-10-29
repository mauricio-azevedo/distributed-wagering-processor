import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  InboxMessageIdentity,
  InboxRepository,
} from '../../../application/ports/repositories';
import type { InboxMessage } from '../../../domain/inbox-message';
import {
  InboxMessageRow,
  toInboxMessage,
  toInboxMessageRow,
} from '../mappings/inbox-message.mapping';

/** `InboxRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    this.em.persist(toInboxMessageRow(message));
    await this.em.flush();
  }

  async findByIdentity(identity: InboxMessageIdentity): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxMessageRow, {
      consumerName: identity.consumerName,
      messageId: identity.messageId,
    });

    return row === null ? null : toInboxMessage(row);
  }
}
