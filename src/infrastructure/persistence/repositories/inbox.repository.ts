import type { EntityManager, QueryResult } from '@mikro-orm/postgresql';

import type {
  InboxClaim,
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

  /**
   * `INSERT ... ON CONFLICT DO NOTHING` and, when it loses, a read of the row that holds the
   * identity — the same shape as the idempotency reservation and for the same reason (ADR 0004): a
   * plain insert that violates the primary key would abort the database transaction the delivery
   * is about to do its financial work in.
   *
   * A concurrent delivery of one message id is what the statement orders: the second insert waits
   * on the primary key until the first transaction ends, and then either writes the row, because
   * that transaction rolled back, or loses and reads what it committed. A lost claim with no row
   * behind it is therefore impossible and raised as the defect it would be.
   */
  async claim(message: InboxMessage): Promise<InboxClaim> {
    const claim = await this.em
      .createQueryBuilder(InboxMessageRow)
      .insert(toInboxMessageRow(message))
      .onConflict()
      .ignore()
      .execute<QueryResult<InboxMessageRow>>('run');

    if (claim.affectedRows === 1) {
      return { claimed: true };
    }

    const stored = await this.findRow(message);

    if (stored === null) {
      throw new Error(
        `claiming message ${message.messageId} of consumer ${message.consumerName} conflicted with a row that is not there`,
      );
    }

    return { claimed: false, stored: toInboxMessage(stored) };
  }

  /**
   * The completion column alone, written onto the row the claim inserted. It names the column
   * rather than flushing a managed entity, because the claim was issued through the query builder
   * and the completion happened on a domain object the entity manager never loaded.
   *
   * No row updated means the row this completes is not there, which cannot happen inside the
   * transaction that claimed it, so it is raised rather than reported.
   */
  async complete(message: InboxMessage): Promise<void> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRow)
      .update({ processedAt: message.processedAt })
      .where({ consumerName: message.consumerName, messageId: message.messageId })
      .execute<QueryResult<InboxMessageRow>>('run');

    if (result.affectedRows !== 1) {
      throw new Error(
        `completing message ${message.messageId} of consumer ${message.consumerName} matched no row`,
      );
    }
  }

  async findByIdentity(identity: InboxMessageIdentity): Promise<InboxMessage | null> {
    const row = await this.findRow(identity);

    return row === null ? null : toInboxMessage(row);
  }

  private findRow(identity: InboxMessageIdentity): Promise<InboxMessageRow | null> {
    return this.em.findOne(InboxMessageRow, {
      consumerName: identity.consumerName,
      messageId: identity.messageId,
    });
  }
}
