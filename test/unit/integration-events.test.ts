import { describe, expect, test } from 'bun:test';

import {
  type IntegrationEvent,
  type IntegrationEventType,
  type TransactionIdentity,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const WALLET_ID = '0193f0c0-0000-7000-8000-00000000000a';
const PLAYER_ID = '0193f0c0-0000-7000-8000-00000000000b';
const TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000c';
const ENTRY_ID = '0193f0c0-0000-7000-8000-00000000000d';
const EVENT_ID = '0193f0c0-0000-7000-8000-00000000000e';
const REFERENCE_TRANSACTION_ID = '0193f0c0-0000-7000-8000-00000000000f';
const CORRELATION_ID = '01a18266-39e0-7597-812c-a89950b9acf2';
const OCCURRED_AT = new Date('2026-10-28T12:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-28T13:00:00.000Z');

/** `money.decimal-string`, as a consumer of the events reads it off the wire. */
const AMOUNT = /^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/;

const brl = (amount: string): Money => Money.from(amount, 'BRL');

/** A `BET` of 40.00, the identity every transaction event carries (`TransactionIdentity`). */
const IDENTITY: TransactionIdentity = {
  transactionId: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: brl('40.00'),
};

/** What the caller supplies for every event: its id, the correlation id and the moment. */
const ORIGIN = { eventId: EVENT_ID, correlationId: CORRELATION_ID, occurredAt: OCCURRED_AT };

/** The `DEBIT` the `BET` wrote, taking the wallet from 100.00 to 60.00 at version 4. */
const betEntry = (): WalletLedgerEntry =>
  WalletLedgerEntry.create({
    id: ENTRY_ID,
    walletId: WALLET_ID,
    transactionId: TRANSACTION_ID,
    operation: { kind: 'BET' },
    money: brl('40.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('60.00'),
    walletVersion: 4,
    createdAt: OCCURRED_AT,
  });

const processedEvent = (): WagerTransactionProcessed =>
  WagerTransactionProcessed.record({
    ...ORIGIN,
    identity: IDENTITY,
    balanceAfter: brl('60.00'),
    walletVersion: 4,
    processedAt: OCCURRED_AT,
    reference: null,
  });

const rejectedEvent = (): WagerTransactionRejected =>
  WagerTransactionRejected.record({
    ...ORIGIN,
    identity: IDENTITY,
    failureCode: 'INSUFFICIENT_BALANCE',
    observedBalance: brl('10.00'),
    rejectedAt: OCCURRED_AT,
    referenceExternalTransactionId: null,
  });

const balanceChangedEvent = (): WalletBalanceChanged =>
  WalletBalanceChanged.record({ ...ORIGIN, entry: betEntry() });

const pendingReferenceEvent = (): WagerTransactionPendingReference =>
  WagerTransactionPendingReference.record({
    ...ORIGIN,
    identity: { ...IDENTITY, kind: 'ROLLBACK' },
    referenceExternalTransactionId: 'acme-tx-000122',
    expiresAt: EXPIRES_AT,
  });

const everyEvent = (): [IntegrationEventType, IntegrationEvent][] => [
  ['WagerTransactionProcessed', processedEvent()],
  ['WagerTransactionRejected', rejectedEvent()],
  ['WalletBalanceChanged', balanceChangedEvent()],
  ['WagerTransactionPendingReference', pendingReferenceEvent()],
];

/** The money members of a serialized `data`, as the contract documents name them. */
const MONEY_MEMBERS = ['money', 'balanceBefore', 'balanceAfter', 'observedBalance'] as const;

const moneyMembersOf = (data: unknown): [string, unknown][] => {
  const members = data as Record<string, unknown>;

  return MONEY_MEMBERS.filter((member) => member in members).map((member) => [
    member,
    members[member],
  ]);
};

describe('event-envelope-typing', () => {
  test('WagerTransactionProcessed serializes the envelope and data of its contract entry', () => {
    expect(processedEvent().toJSON()).toEqual({
      eventId: EVENT_ID,
      eventType: 'WagerTransactionProcessed',
      aggregateId: WALLET_ID,
      correlationId: CORRELATION_ID,
      causationId: TRANSACTION_ID,
      occurredAt: '2026-10-28T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: TRANSACTION_ID,
        providerId: 'provider-acme',
        externalTransactionId: 'acme-tx-000123',
        walletId: WALLET_ID,
        playerId: PLAYER_ID,
        roundId: 'round-7f3a',
        gameId: 'lucky-sevens',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
        balanceAfter: { amount: '60.00', currency: 'BRL' },
        walletVersion: 4,
        processedAt: '2026-10-28T12:00:00.000Z',
      },
    });
  });

  test('a resolved reference adds both of its members to WagerTransactionProcessed', () => {
    const resolved = WagerTransactionProcessed.record({
      ...ORIGIN,
      identity: { ...IDENTITY, kind: 'REFUND' },
      balanceAfter: brl('140.00'),
      walletVersion: 5,
      processedAt: OCCURRED_AT,
      reference: {
        transactionId: REFERENCE_TRANSACTION_ID,
        externalTransactionId: 'acme-tx-000122',
      },
    });

    expect(resolved.toJSON().data).toMatchObject({
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
      referenceExternalTransactionId: 'acme-tx-000122',
    });
    expect(Object.keys(processedEvent().toJSON().data)).not.toContain('referenceTransactionId');
    expect(Object.keys(processedEvent().toJSON().data)).not.toContain(
      'referenceExternalTransactionId',
    );
  });

  test('WagerTransactionRejected serializes the failure, the observed balance and the moment', () => {
    expect(rejectedEvent().toJSON()).toEqual({
      eventId: EVENT_ID,
      eventType: 'WagerTransactionRejected',
      aggregateId: WALLET_ID,
      correlationId: CORRELATION_ID,
      causationId: TRANSACTION_ID,
      occurredAt: '2026-10-28T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: TRANSACTION_ID,
        providerId: 'provider-acme',
        externalTransactionId: 'acme-tx-000123',
        walletId: WALLET_ID,
        playerId: PLAYER_ID,
        roundId: 'round-7f3a',
        gameId: 'lucky-sevens',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_BALANCE',
        observedBalance: { amount: '10.00', currency: 'BRL' },
        rejectedAt: '2026-10-28T12:00:00.000Z',
      },
    });
    expect(Object.keys(rejectedEvent().toJSON().data)).not.toContain(
      'referenceExternalTransactionId',
    );
  });

  test('a rejection that carried a reference serializes the reference it could not use', () => {
    const rejected = WagerTransactionRejected.record({
      ...ORIGIN,
      identity: { ...IDENTITY, kind: 'ROLLBACK' },
      failureCode: 'REFERENCE_NOT_FOUND',
      observedBalance: brl('60.00'),
      rejectedAt: OCCURRED_AT,
      referenceExternalTransactionId: 'acme-tx-000122',
    });

    expect(rejected.toJSON().data).toMatchObject({
      failureCode: 'REFERENCE_NOT_FOUND',
      referenceExternalTransactionId: 'acme-tx-000122',
    });
  });

  test('WalletBalanceChanged serializes the ledger entry that changed the balance', () => {
    expect(balanceChangedEvent().toJSON()).toEqual({
      eventId: EVENT_ID,
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      correlationId: CORRELATION_ID,
      causationId: TRANSACTION_ID,
      occurredAt: '2026-10-28T12:00:00.000Z',
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: TRANSACTION_ID,
        direction: 'DEBIT',
        money: { amount: '40.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '60.00', currency: 'BRL' },
        walletVersion: 4,
      },
    });
  });

  test('WagerTransactionPendingReference serializes the reference awaited and its window', () => {
    expect(pendingReferenceEvent().toJSON()).toEqual({
      eventId: EVENT_ID,
      eventType: 'WagerTransactionPendingReference',
      aggregateId: WALLET_ID,
      correlationId: CORRELATION_ID,
      causationId: TRANSACTION_ID,
      occurredAt: '2026-10-28T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: TRANSACTION_ID,
        providerId: 'provider-acme',
        externalTransactionId: 'acme-tx-000123',
        walletId: WALLET_ID,
        playerId: PLAYER_ID,
        roundId: 'round-7f3a',
        gameId: 'lucky-sevens',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'acme-tx-000122',
        expiresAt: '2026-10-28T13:00:00.000Z',
      },
    });
  });

  test('eventType and version come from the class and cannot be passed at the call site', () => {
    const event = processedEvent();
    const eventType: 'WagerTransactionProcessed' = event.eventType;
    const version: 1 = event.version;

    const recordWithAnotherType = (): WagerTransactionProcessed =>
      WagerTransactionProcessed.record({
        ...ORIGIN,
        identity: IDENTITY,
        balanceAfter: brl('60.00'),
        walletVersion: 4,
        processedAt: OCCURRED_AT,
        reference: null,
        // @ts-expect-error - eventType is fixed by the subclass (`event.envelope`).
        eventType: 'WalletBalanceChanged',
      });

    expect(eventType).toBe('WagerTransactionProcessed');
    expect(version).toBe(1);
    expect(recordWithAnotherType().eventType).toBe('WagerTransactionProcessed');
  });

  test('every event is built by its factory; no constructor is reachable', () => {
    const attempts = [
      (): void => {
        // @ts-expect-error - the constructor is private (`model.private-constructors`).
        new WagerTransactionProcessed();
      },
      (): void => {
        // @ts-expect-error - the constructor is private (`model.private-constructors`).
        new WagerTransactionRejected();
      },
      (): void => {
        // @ts-expect-error - the constructor is private (`model.private-constructors`).
        new WalletBalanceChanged();
      },
      (): void => {
        // @ts-expect-error - the constructor is private (`model.private-constructors`).
        new WagerTransactionPendingReference();
      },
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(TypeError);
    }

    expect(processedEvent()).toBeInstanceOf(WagerTransactionProcessed);
  });

  test.each(everyEvent())('%s cannot be reassigned after it is recorded', (_type, event) => {
    const assignEventId = (): void => {
      // @ts-expect-error - an event is a recorded fact; its envelope is readonly.
      event.eventId = 'another-id';
    };

    expect(assignEventId).toThrow(TypeError);
    expect(event.toJSON().eventId).toBe(EVENT_ID);
  });
});

describe('event-aggregate-is-wallet', () => {
  test.each(everyEvent())('%s carries the wallet as aggregateId', (_type, event) => {
    expect(event.toJSON().aggregateId).toBe(WALLET_ID);
  });

  test.each(everyEvent())(
    '%s carries the transaction as causationId and the request correlation id',
    (_type, event) => {
      const envelope = event.toJSON();

      expect(envelope.causationId).toBe(TRANSACTION_ID);
      expect(envelope.correlationId).toBe(CORRELATION_ID);
    },
  );

  test('the aggregate is the wallet of the identity, never a value the caller chose', () => {
    const otherWallet = '0193f0c0-0000-7000-8000-0000000000aa';
    const event = WagerTransactionProcessed.record({
      ...ORIGIN,
      identity: { ...IDENTITY, walletId: otherWallet },
      balanceAfter: brl('60.00'),
      walletVersion: 4,
      processedAt: OCCURRED_AT,
      reference: null,
    });

    expect(event.toJSON().aggregateId).toBe(otherWallet);
  });
});

describe('event-money-props', () => {
  test.each(everyEvent())('%s serializes every amount as a string', (_type, event) => {
    const members = moneyMembersOf(event.toJSON().data);

    expect(members.length).toBeGreaterThan(0);
    for (const [member, value] of members) {
      const money = value as { amount: unknown; currency: unknown };

      expect(typeof money.amount, member).toBe('string');
      expect(money.amount as string).toMatch(AMOUNT);
      expect(money.currency).toBe('BRL');
      expect(value).not.toBeInstanceOf(Money);
    }
  });

  test.each(everyEvent())('%s survives JSON serialization unchanged', (_type, event) => {
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });
});
