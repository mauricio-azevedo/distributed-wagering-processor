import type {
  IntegrationEventEnvelope,
  WalletBalanceChangedData,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';

/** What the consumer did with an envelope it was handed. */
export type Application = 'applied' | 'duplicate';

/**
 * The downstream consumer the messaging contract describes, as little of one as the guarantees
 * need: it deduplicates by `eventId` (`event.at-least-once`, `outbox.duplicate-safe`) and orders a
 * wallet's balance events by `walletVersion` rather than by arrival (`event.ordering`).
 *
 * It exists so that "a duplicate is safe" and "ordering is not guaranteed" are assertions about an
 * actual consumer instead of statements in a document: the suites hand it every copy of every
 * event the publisher produced, in whatever order the broker and the publishers happened to
 * deliver them, and ask it what it applied.
 *
 * Deduplication is by event id alone, which is what the contract promises a consumer is enough:
 * nothing here inspects the payload to decide whether two arrivals are the same event.
 */
export class ReferenceConsumer {
  private readonly applied = new Map<string, IntegrationEventEnvelope>();
  private readonly copies = new Map<string, number>();

  /**
   * Applies an envelope once. A second arrival of an event id is counted and ignored, however the
   * copy reached the consumer: redelivery by the broker, or a republication after a publisher
   * crashed between its send and the commit that would have recorded it.
   */
  apply(envelope: IntegrationEventEnvelope): Application {
    this.copies.set(envelope.eventId, (this.copies.get(envelope.eventId) ?? 0) + 1);

    if (this.applied.has(envelope.eventId)) {
      return 'duplicate';
    }
    this.applied.set(envelope.eventId, envelope);

    return 'applied';
  }

  /** How many distinct events the consumer applied, whatever the number of copies it received. */
  get appliedCount(): number {
    return this.applied.size;
  }

  /** How many copies of one event reached the consumer; `0` for an event it never saw. */
  copiesOf(eventId: string): number {
    return this.copies.get(eventId) ?? 0;
  }

  /** The event ids the consumer applied, in no particular order. */
  appliedEventIds(): string[] {
    return [...this.applied.keys()];
  }

  /** The envelope the consumer applied under an event id, or `undefined` for an unseen one. */
  appliedEvent(eventId: string): IntegrationEventEnvelope | undefined {
    return this.applied.get(eventId);
  }

  /**
   * One wallet's balance events in the order `event.ordering` tells a consumer to put them: by
   * `walletVersion`, the version the entry produced, never by the order they arrived in.
   */
  balanceChangesOf(walletId: string): WalletBalanceChangedData[] {
    return [...this.applied.values()]
      .filter((envelope) => envelope.eventType === 'WalletBalanceChanged')
      .map((envelope) => envelope.data as WalletBalanceChangedData)
      .filter((data) => data.walletId === walletId)
      .toSorted((left, right) => left.walletVersion - right.walletVersion);
  }

  /**
   * The balance a consumer rebuilds for a wallet from the balance events it applied, by walking
   * them in `walletVersion` order and checking each link: every event's `balanceBefore` has to be
   * the previous event's `balanceAfter`, and its own arithmetic has to hold. A break means the
   * ordering key does not reconstruct the chain, which is the promise `event.ordering` makes, so
   * it is raised rather than smoothed over.
   */
  rebuiltBalanceOf(walletId: string, openingBalance: Money): Money {
    let balance = openingBalance;

    for (const change of this.balanceChangesOf(walletId)) {
      const before = Money.from(change.balanceBefore.amount, change.balanceBefore.currency);
      const after = Money.from(change.balanceAfter.amount, change.balanceAfter.currency);
      const money = Money.from(change.money.amount, change.money.currency);

      if (!before.equals(balance)) {
        throw new Error(
          `event at wallet version ${change.walletVersion.toString()} of wallet ${walletId} starts at ${before.toString()}, but the chain reached ${balance.toString()}`,
        );
      }

      const expected = change.direction === 'CREDIT' ? before.add(money) : before.subtract(money);
      if (!expected.equals(after)) {
        throw new Error(
          `event at wallet version ${change.walletVersion.toString()} of wallet ${walletId} records ${before.toString()} ${change.direction} ${money.toString()} as ${after.toString()}`,
        );
      }

      balance = after;
    }

    return balance;
  }
}
