import { describe, expect, test } from 'bun:test';

import {
  MessageContractError,
  commandOf,
  deliveryOf,
  wagerTransactionRequestedOf,
} from '../../src/infrastructure/messaging/wager-transaction-message.dto';

const CONSUMER_NAME = 'wager-transactions-consumer';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';

/** The `bet` message example of [docs/asyncapi.yaml], which is the shape this module implements. */
const BET_MESSAGE = {
  messageId: 'acme-msg-000123',
  type: 'WagerTransactionRequested' as const,
  occurredAt: '2026-10-28T12:05:00.000Z',
  correlationId: 'acme-req-5f2c',
  data: {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    idempotencyKey: 'provider-acme:acme-tx-000123',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET' as const,
    money: { amount: '40.00', currency: 'BRL' },
  },
};

type Message = Record<string, unknown>;

const bodyOf = (message: Message): string => JSON.stringify(message);

const message = (overrides: Message = {}): Message => ({ ...BET_MESSAGE, ...overrides });

const data = (overrides: Message = {}): Message => ({ ...BET_MESSAGE.data, ...overrides });

/** The violations a refused body reported, or a failure saying it was not refused at all. */
function violationsOf(body: string): string {
  try {
    wagerTransactionRequestedOf(body);
  } catch (error) {
    if (error instanceof MessageContractError) {
      return error.violations;
    }

    throw error;
  }

  throw new Error('expected the message to be refused');
}

describe('message-contract-schema', () => {
  test('the documented example parses, with the optional members as sent', () => {
    expect(wagerTransactionRequestedOf(bodyOf(message()))).toEqual(BET_MESSAGE);
  });

  test('version is optional, and the only value it may carry is 1', () => {
    expect(wagerTransactionRequestedOf(bodyOf(message({ version: 1 }))).version).toBe(1);
    expect(wagerTransactionRequestedOf(bodyOf(message())).version).toBeUndefined();
    expect(violationsOf(bodyOf(message({ version: 2 })))).toContain('version');
  });

  test('a body that is not JSON is refused, like one that violates the schema', () => {
    expect(violationsOf('{ not json')).toContain('not JSON');
  });

  test('an unknown type is refused', () => {
    expect(violationsOf(bodyOf(message({ type: 'WalletOpeningRequested' })))).toContain('type');
  });

  test('a missing envelope member is refused by name', () => {
    expect(violationsOf(bodyOf(message({ messageId: undefined })))).toContain('messageId');
    expect(violationsOf(bodyOf(message({ occurredAt: undefined })))).toContain('occurredAt');
    expect(violationsOf(bodyOf(message({ data: undefined })))).toContain('data');
  });

  test('an occurredAt that is not a date and time is refused', () => {
    expect(violationsOf(bodyOf(message({ occurredAt: 'yesterday' })))).toContain('occurredAt');
  });

  test('an unknown member anywhere in the body is refused', () => {
    expect(violationsOf(bodyOf(message({ receiptHandle: 'AQEB' })))).toContain('receiptHandle');
    expect(violationsOf(bodyOf(message({ data: data({ stake: '40.00' }) })))).toContain('stake');
  });

  /** `idem.key-required` on the queue: the key is a member, so its absence is a violation. */
  test('a missing idempotency key is a validation failure, not a separate refusal', () => {
    expect(violationsOf(bodyOf(message({ data: data({ idempotencyKey: undefined }) })))).toContain(
      'idempotencyKey',
    );
  });

  test('a missing or malformed amount is refused by member', () => {
    expect(violationsOf(bodyOf(message({ data: data({ money: undefined }) })))).toContain('money');
    expect(
      violationsOf(bodyOf(message({ data: data({ money: { amount: '40', currency: 'BRL' } }) }))),
    ).toContain('amount');
    expect(
      violationsOf(bodyOf(message({ data: data({ money: { amount: 40, currency: 'BRL' } }) }))),
    ).toContain('amount');
  });

  test('the operation rules of the HTTP entry point hold on the queue too', () => {
    expect(violationsOf(bodyOf(message({ data: data({ providerId: 'system' }) })))).toContain(
      'providerId',
    );
    expect(violationsOf(bodyOf(message({ data: data({ kind: 'OPENING' }) })))).toContain('kind');
    expect(violationsOf(bodyOf(message({ data: data({ kind: 'ROLLBACK' }) })))).toContain(
      'is required when kind is ROLLBACK',
    );
    expect(
      violationsOf(
        bodyOf(message({ data: data({ referenceExternalTransactionId: 'acme-tx-000999' }) })),
      ),
    ).toContain('must be absent when kind is BET');
    expect(
      violationsOf(bodyOf(message({ data: data({ money: { amount: '0.00', currency: 'BRL' } }) }))),
    ).toContain('amount');
  });
});

describe('message-becomes-the-command-the-controller-builds', () => {
  const parsed = wagerTransactionRequestedOf(bodyOf(message()));

  test('the operation is the business fields, with the key where the header was', () => {
    expect(commandOf(parsed)).toEqual({
      operation: {
        providerId: 'provider-acme',
        externalTransactionId: 'acme-tx-000123',
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: 'round-7f3a',
        gameId: 'lucky-sevens',
        kind: 'BET' as const,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: null,
      },
      idempotencyKey: 'provider-acme:acme-tx-000123',
      correlationId: 'acme-req-5f2c',
    });
  });

  /** `msg.correlation`: the message id stands in, so every message has a correlation id. */
  test('a message without a correlation id is correlated by its message id', () => {
    const without = wagerTransactionRequestedOf(bodyOf(message({ correlationId: undefined })));

    expect(commandOf(without).correlationId).toBe('acme-msg-000123');
  });

  test('the delivery is the consumer, the body message id and the content', () => {
    expect(deliveryOf(parsed, CONSUMER_NAME)).toEqual({
      consumerName: CONSUMER_NAME,
      messageId: 'acme-msg-000123',
      content: { ...BET_MESSAGE.data, referenceExternalTransactionId: null },
    });
  });
});
