import type { Money, MoneyProps } from './money';
import type { TransactionKind } from './transaction-kind';
import type { RejectionCode } from './wager-transaction';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/**
 * The public surface of the service: the committed facts it announces
 * ([docs/asyncapi.yaml](../../docs/asyncapi.yaml), section 13 of the system contract). Each type
 * is one class in this module; `(eventType, version)` is how a consumer selects a handler
 * (`event.versioning`).
 */
export type IntegrationEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WalletBalanceChanged'
  | 'WagerTransactionPendingReference';

/**
 * The serialized envelope (`event.envelope`), as the outbox row stores it and the publisher sends
 * it. Everything in it is JSON: timestamps are RFC 3339 strings and every amount is a
 * `MoneyProps` string (`event.money-props`).
 *
 * `causationId` is required here because every event of version 1 is caused by the processing of
 * one transaction (`event.correlation-causation`); the contract document admits its absence for
 * an event type that would have no transaction behind it, and this type relaxes when one exists.
 */
export interface IntegrationEventEnvelope<TData = unknown> {
  readonly eventId: string;
  readonly eventType: IntegrationEventType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: TData;
}

/**
 * What a caller supplies for every event: the id it was minted with, the correlation id of the
 * request or message being processed (`api.correlation-header`, `msg.correlation`) and the moment
 * the event is recorded. `aggregateId` and `causationId` are never supplied: each subclass reads
 * them off the fact it records, so no call site can aim an event at another aggregate
 * (`event.aggregate-is-wallet`).
 */
export interface NewIntegrationEvent {
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

/** The envelope fields the base class holds, with the two the subclass derives. */
interface IntegrationEventOrigin extends NewIntegrationEvent {
  readonly aggregateId: string;
  readonly causationId: string;
}

/**
 * An integration event: a committed fact, named by its class. `eventType` and `version` are fixed
 * in the subclass and cannot be passed as strings at a call site (`event.envelope`), and the
 * envelope is produced by `toJSON` from the domain values the event holds, so an amount reaches
 * the wire only through `Money.toJSON` (`event.money-props`).
 *
 * `TData` is the serialized `data` of the subclass, the shape its entry in
 * [docs/asyncapi.yaml](../../docs/asyncapi.yaml) defines.
 */
export abstract class IntegrationEvent<TData = unknown> {
  abstract readonly eventType: IntegrationEventType;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: Date;

  protected constructor(origin: IntegrationEventOrigin) {
    this.eventId = origin.eventId;
    this.aggregateId = origin.aggregateId;
    this.correlationId = origin.correlationId;
    this.causationId = origin.causationId;
    this.occurredAt = origin.occurredAt;
  }

  /** The envelope the outbox stores and the publisher sends, identical on every publication. */
  toJSON(): IntegrationEventEnvelope<TData> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.serializeData(),
    };
  }

  /** The `data` of this event type, with every amount already a `MoneyProps` string. */
  protected abstract serializeData(): TData;
}

/**
 * The identity of a transaction as the transaction events carry it (`TransactionIdentity` in
 * [docs/asyncapi.yaml](../../docs/asyncapi.yaml)). Every member is a `WagerTransaction` field, the
 * row's `id` under the name the contract gives it, so the use case that records an event names the
 * transaction once and the event derives its aggregate and its causation from it. The opening
 * credit carries `providerId` `system`, `kind` `OPENING` and the wallet id as its external
 * transaction id and round id (`tx.opening-internal`).
 */
export interface TransactionIdentity {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: Money;
}

/** `TransactionIdentity` serialized: the amount becomes a string, nothing else changes. */
export interface TransactionIdentityData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: MoneyProps;
}

function serializeIdentity(identity: TransactionIdentity): TransactionIdentityData {
  return {
    transactionId: identity.transactionId,
    providerId: identity.providerId,
    externalTransactionId: identity.externalTransactionId,
    walletId: identity.walletId,
    playerId: identity.playerId,
    roundId: identity.roundId,
    gameId: identity.gameId,
    kind: identity.kind,
    money: identity.money.toJSON(),
  };
}

/**
 * The reference a reversal resolved: both members are serialized together or not at all, because
 * the contract entry names them as one pair (`event.processed-when`).
 */
export interface ResolvedReference {
  readonly transactionId: string;
  readonly externalTransactionId: string;
}

export interface NewWagerTransactionProcessed extends NewIntegrationEvent {
  readonly identity: TransactionIdentity;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly processedAt: Date;
  readonly reference: ResolvedReference | null;
}

export interface WagerTransactionProcessedData extends TransactionIdentityData {
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly processedAt: string;
  readonly referenceTransactionId?: string;
  readonly referenceExternalTransactionId?: string;
}

/**
 * A transaction reached `PROCESSED` (`event.processed-when`), including a `LOSS`, which moves no
 * money, and the internal `OPENING` credit. `balanceAfter` and `walletVersion` are the wallet as
 * the transaction left it, unchanged for a `LOSS`.
 */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed' as const;
  override readonly version = 1 as const;

  private readonly identity: TransactionIdentity;
  private readonly balanceAfter: Money;
  private readonly walletVersion: number;
  private readonly processedAt: Date;
  private readonly reference: ResolvedReference | null;

  private constructor(event: NewWagerTransactionProcessed) {
    super({
      eventId: event.eventId,
      aggregateId: event.identity.walletId,
      correlationId: event.correlationId,
      causationId: event.identity.transactionId,
      occurredAt: event.occurredAt,
    });
    this.identity = event.identity;
    this.balanceAfter = event.balanceAfter;
    this.walletVersion = event.walletVersion;
    this.processedAt = event.processedAt;
    this.reference = event.reference;
    Object.freeze(this);
  }

  static record(event: NewWagerTransactionProcessed): WagerTransactionProcessed {
    return new WagerTransactionProcessed(event);
  }

  protected override serializeData(): WagerTransactionProcessedData {
    return {
      ...serializeIdentity(this.identity),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      processedAt: this.processedAt.toISOString(),
      ...(this.reference === null
        ? {}
        : {
            referenceTransactionId: this.reference.transactionId,
            referenceExternalTransactionId: this.reference.externalTransactionId,
          }),
    };
  }
}

export interface NewWagerTransactionRejected extends NewIntegrationEvent {
  readonly identity: TransactionIdentity;
  readonly failureCode: RejectionCode;
  readonly observedBalance: Money;
  readonly rejectedAt: Date;
  readonly referenceExternalTransactionId: string | null;
}

export interface WagerTransactionRejectedData extends TransactionIdentityData {
  readonly failureCode: RejectionCode;
  readonly observedBalance: MoneyProps;
  readonly rejectedAt: string;
  readonly referenceExternalTransactionId?: string;
}

/**
 * A transaction reached `REJECTED` (`event.rejected-when`), including a pending reference that
 * expired. `observedBalance` is the balance observed when the outcome was recorded
 * (`tx.observed-balance`), the one every replay of it reports. The failure code is the
 * `RejectionCode` of the transaction, so `PROCESSING_FAILED` is unrepresentable here: it belongs
 * to `fail`, and a `FAILED` transaction emits no event (`event.failed-no-event`).
 */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected' as const;
  override readonly version = 1 as const;

  private readonly identity: TransactionIdentity;
  private readonly failureCode: RejectionCode;
  private readonly observedBalance: Money;
  private readonly rejectedAt: Date;
  private readonly referenceExternalTransactionId: string | null;

  private constructor(event: NewWagerTransactionRejected) {
    super({
      eventId: event.eventId,
      aggregateId: event.identity.walletId,
      correlationId: event.correlationId,
      causationId: event.identity.transactionId,
      occurredAt: event.occurredAt,
    });
    this.identity = event.identity;
    this.failureCode = event.failureCode;
    this.observedBalance = event.observedBalance;
    this.rejectedAt = event.rejectedAt;
    this.referenceExternalTransactionId = event.referenceExternalTransactionId;
    Object.freeze(this);
  }

  static record(event: NewWagerTransactionRejected): WagerTransactionRejected {
    return new WagerTransactionRejected(event);
  }

  protected override serializeData(): WagerTransactionRejectedData {
    return {
      ...serializeIdentity(this.identity),
      failureCode: this.failureCode,
      observedBalance: this.observedBalance.toJSON(),
      rejectedAt: this.rejectedAt.toISOString(),
      ...(this.referenceExternalTransactionId === null
        ? {}
        : { referenceExternalTransactionId: this.referenceExternalTransactionId }),
    };
  }
}

export interface NewWalletBalanceChanged extends NewIntegrationEvent {
  readonly entry: WalletLedgerEntry;
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/**
 * The balance moved (`event.balance-changed-when`): one event per ledger entry and never
 * otherwise, so the event is built from the entry itself rather than from fields restated at the
 * call site. `walletVersion` is the version the entry produced, the ordering key of one wallet's
 * balance events (`event.ordering`).
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = 'WalletBalanceChanged' as const;
  override readonly version = 1 as const;

  private readonly entry: WalletLedgerEntry;

  private constructor(event: NewWalletBalanceChanged) {
    super({
      eventId: event.eventId,
      aggregateId: event.entry.walletId,
      correlationId: event.correlationId,
      causationId: event.entry.transactionId,
      occurredAt: event.occurredAt,
    });
    this.entry = event.entry;
    Object.freeze(this);
  }

  static record(event: NewWalletBalanceChanged): WalletBalanceChanged {
    return new WalletBalanceChanged(event);
  }

  protected override serializeData(): WalletBalanceChangedData {
    return {
      walletId: this.entry.walletId,
      transactionId: this.entry.transactionId,
      direction: this.entry.direction,
      money: this.entry.money.toJSON(),
      balanceBefore: this.entry.balanceBefore.toJSON(),
      balanceAfter: this.entry.balanceAfter.toJSON(),
      walletVersion: this.entry.walletVersion,
    };
  }
}

export interface NewWagerTransactionPendingReference extends NewIntegrationEvent {
  readonly identity: TransactionIdentity;
  readonly referenceExternalTransactionId: string;
  readonly expiresAt: Date;
}

export interface WagerTransactionPendingReferenceData extends TransactionIdentityData {
  readonly referenceExternalTransactionId: string;
  readonly expiresAt: string;
}

/**
 * A transaction first became `PENDING_REFERENCE` (`event.pending-reference-when`); the retry
 * attempts that follow emit nothing. `expiresAt` closes the waiting window, after which the
 * transaction is rejected with `REFERENCE_NOT_FOUND` (`ref.ttl`, `ref.expiry`).
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference' as const;
  override readonly version = 1 as const;

  private readonly identity: TransactionIdentity;
  private readonly referenceExternalTransactionId: string;
  private readonly expiresAt: Date;

  private constructor(event: NewWagerTransactionPendingReference) {
    super({
      eventId: event.eventId,
      aggregateId: event.identity.walletId,
      correlationId: event.correlationId,
      causationId: event.identity.transactionId,
      occurredAt: event.occurredAt,
    });
    this.identity = event.identity;
    this.referenceExternalTransactionId = event.referenceExternalTransactionId;
    this.expiresAt = event.expiresAt;
    Object.freeze(this);
  }

  static record(event: NewWagerTransactionPendingReference): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(event);
  }

  protected override serializeData(): WagerTransactionPendingReferenceData {
    return {
      ...serializeIdentity(this.identity),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      expiresAt: this.expiresAt.toISOString(),
    };
  }
}
