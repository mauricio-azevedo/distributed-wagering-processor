import { EntitySchema } from '@mikro-orm/postgresql';

import { PendingReferenceSchedule } from '../../../domain/pending-reference-schedule';

/**
 * The `pending_reference_schedule` row (ADR 0011): one per parked transaction, carrying when the
 * next attempt is due and when waiting for its reference stops.
 *
 * `transactionId` is both the primary key and the foreign key, so a schedule cannot exist without
 * its transaction and a transaction cannot be in the claim list twice. The row holds no copy of the
 * transaction's state: whether it is still waiting is the `status` of the transaction row, which is
 * what the claim query reads (`tx.row-append-only`).
 */
export class PendingReferenceScheduleRow {
  transactionId!: string;
  attempts!: number;
  nextAttemptAt!: Date;
  expiresAt!: Date;
}

export const pendingReferenceScheduleSchema = new EntitySchema<PendingReferenceScheduleRow>({
  class: PendingReferenceScheduleRow,
  tableName: 'pending_reference_schedule',
  properties: {
    transactionId: { type: 'uuid', primary: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    expiresAt: { type: 'datetime' },
  },
});

/**
 * The row as the claim statement reads it. The ORM converts the columns it hydrates itself, and
 * the claim is one explicit statement, so its timestamps arrive as the strings PostgreSQL rendered
 * and its `integer` as whatever the driver made of it: the mapping is where both become the values
 * the domain reasons about, exactly as `MoneyType` is for an amount.
 */
export interface ClaimedPendingReferenceScheduleRow {
  readonly transactionId: string;
  readonly attempts: number | string;
  readonly nextAttemptAt: Date | string;
  readonly expiresAt: Date | string;
}

/** `model.rehydrate-no-revalidation`: the stored row, trusting the database. */
export function toPendingReferenceSchedule(
  row: ClaimedPendingReferenceScheduleRow,
): PendingReferenceSchedule {
  return PendingReferenceSchedule.rehydrate({
    transactionId: row.transactionId,
    attempts: Number(row.attempts),
    nextAttemptAt: new Date(row.nextAttemptAt),
    expiresAt: new Date(row.expiresAt),
  });
}

export function toPendingReferenceScheduleRow(
  schedule: PendingReferenceSchedule,
): PendingReferenceScheduleRow {
  const row = new PendingReferenceScheduleRow();
  row.transactionId = schedule.transactionId;
  row.attempts = schedule.attempts;
  row.nextAttemptAt = schedule.nextAttemptAt;
  row.expiresAt = schedule.expiresAt;

  return row;
}
