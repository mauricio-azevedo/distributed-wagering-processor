import type { IdGenerator } from '../application/ports/id-generator';

/**
 * The `IdGenerator` port over `Bun.randomUUIDv7`, chosen for the index locality of a
 * time-ordered key (ARCHITECTURE.md, section 6). Nothing orders rows by one: UUIDv7 is monotonic
 * within a process and not across instances, so the ledger orders by `walletVersion` and the outbox
 * by `(occurred_at, id)`.
 */
export const uuidV7IdGenerator: IdGenerator = {
  next: () => Bun.randomUUIDv7(),
};
