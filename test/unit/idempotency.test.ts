import { describe, expect, test } from 'bun:test';

import { sha256Hex } from '../../src/application/sha256';
import { canonicalJson } from '../../src/domain/canonical-json';
import { CanonicalHashError, MoneyValidationError } from '../../src/domain/errors';
import {
  type SubmittedOperation,
  canonicalOperationPayload,
  classifyReservationConflict,
  contentHashOf,
  isIdempotencyKey,
  isPayloadHash,
  payloadHashOf,
  recommendedIdempotencyKey,
} from '../../src/domain/idempotency';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';

const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const TRANSACTION_ID = '01a18266-39e0-758b-a289-fb48c2dd9c8b';
const CREATED_AT = new Date('2026-10-28T12:05:00.000Z');

/** The `bet` request example of `POST /wagering/transactions` in [docs/openapi.yaml]. */
const BET: SubmittedOperation = {
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: { amount: '40.00', currency: 'BRL' },
};

/** The canonical JSON of that example: the business fields, sorted, with `money` nested. */
const BET_CANONICAL =
  '{"externalTransactionId":"acme-tx-000123","gameId":"lucky-sevens","kind":"BET",' +
  '"money":{"amount":"40.00","currency":"BRL"},' +
  '"playerId":"01a17cb1-f5c0-7588-9a61-47a9444c049e","providerId":"provider-acme",' +
  '"roundId":"round-7f3a","walletId":"01a18261-a600-7589-8768-3d958460eced"}';

/** The fixed vector: the `payloadHash` the `processedBet` example records for that submission. */
const BET_HASH = 'sha256:2bba54ed2c9b88952dc90ee0d38bd41bee09fef0fcf7ab87e47e67d8be05bfa9';

/**
 * The `openingCredit` example: the internal opening credit of a wallet (`wallet.opening-credit`)
 * hashes by the same rule, with the reserved `system` provider id and the wallet id as its
 * external transaction id.
 */
const OPENING: SubmittedOperation = {
  providerId: 'system',
  externalTransactionId: WALLET_ID,
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: WALLET_ID,
  gameId: 'wallet-opening',
  kind: 'OPENING',
  money: { amount: '500.00', currency: 'BRL' },
};

const OPENING_HASH = 'sha256:c46c859a96f4c632f271b0f11690b0846e48817e9c15d17bd9d56ed162e593fd';

const hashOf = (operation: SubmittedOperation): string => payloadHashOf(operation, sha256Hex);

/** One business field changed at a time: each one has to move the hash (`idem.payload-hash`). */
const DIVERGENT: readonly (readonly [string, SubmittedOperation])[] = [
  ['providerId', { ...BET, providerId: 'provider-other' }],
  ['externalTransactionId', { ...BET, externalTransactionId: 'acme-tx-000124' }],
  ['playerId', { ...BET, playerId: '01a17cb1-f5c0-7588-9a61-47a9444c049f' }],
  ['walletId', { ...BET, walletId: '01a18261-a600-7589-8768-3d958460ecee' }],
  ['roundId', { ...BET, roundId: 'round-7f3b' }],
  ['gameId', { ...BET, gameId: 'unlucky-sevens' }],
  ['kind', { ...BET, kind: 'LOSS' }],
  ['money.amount', { ...BET, money: { ...BET.money, amount: '40.01' } }],
  ['money.currency', { ...BET, money: { ...BET.money, currency: 'EUR' } }],
];

const storedBet = (payloadHash: string): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: TRANSACTION_ID,
    providerId: BET.providerId,
    externalTransactionId: BET.externalTransactionId,
    idempotencyKey: recommendedIdempotencyKey(BET.providerId, BET.externalTransactionId),
    payloadHash,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: BET.roundId,
    gameId: BET.gameId,
    kind: 'BET',
    money: Money.from('40.00', 'BRL'),
    status: 'PROCESSED',
    failureCode: null,
    observedBalance: Money.from('460.00', 'BRL'),
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    processedAt: CREATED_AT,
    createdAt: CREATED_AT,
  });

describe('payload-hash-canonical', () => {
  test('the documented example hashes to the documented vector', () => {
    expect(canonicalOperationPayload(BET)).toBe(BET_CANONICAL);
    expect(hashOf(BET)).toBe(BET_HASH);
    expect(isPayloadHash(hashOf(BET))).toBe(true);
  });

  test('the internal opening credit hashes by the same rule', () => {
    expect(hashOf(OPENING)).toBe(OPENING_HASH);
  });

  test('the order the fields were submitted in does not reach the hash', () => {
    const reordered: SubmittedOperation = {
      money: { currency: BET.money.currency, amount: BET.money.amount },
      kind: BET.kind,
      gameId: BET.gameId,
      roundId: BET.roundId,
      walletId: BET.walletId,
      playerId: BET.playerId,
      externalTransactionId: BET.externalTransactionId,
      providerId: BET.providerId,
    };

    expect(hashOf(reordered)).toBe(BET_HASH);
  });

  /**
   * `idem.cross-entry-point`: the queue carries the same business fields plus the key the HTTP
   * entry point reads from a header, inside an envelope of transport metadata. None of that may
   * change the hash, or one operation would be two.
   */
  test('the same operation hashes equal through both entry points', () => {
    const queueData = {
      ...BET,
      idempotencyKey: recommendedIdempotencyKey(BET.providerId, BET.externalTransactionId),
      messageId: 'acme-msg-000123',
      occurredAt: '2026-10-28T12:05:00.000Z',
      correlationId: 'acme-req-5f2c',
      type: 'WagerTransactionRequested',
      version: 1,
    };

    expect(hashOf(queueData)).toBe(BET_HASH);
  });

  test.each(DIVERGENT)('a different %s is a different hash', (_field, operation) => {
    expect(hashOf(operation)).not.toBe(BET_HASH);
  });

  test('no two of the divergent payloads collide', () => {
    const hashes = [BET, ...DIVERGENT.map(([, operation]) => operation)].map(hashOf);

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('an absent reference and an explicit null are the same payload', () => {
    expect(hashOf({ ...BET, referenceExternalTransactionId: null })).toBe(BET_HASH);
  });

  test('a reference is part of the payload when it is there', () => {
    const win: SubmittedOperation = { ...BET, kind: 'WIN' };

    expect(hashOf({ ...win, referenceExternalTransactionId: 'acme-tx-000099' })).not.toBe(
      hashOf(win),
    );
  });

  /**
   * The amount reaches the hash through the domain parser, so the one spelling per value of
   * `money.decimal-string` is a property of the hash rather than a promise made by whichever
   * validator ran first.
   */
  test.each(['40.0', '40.000', '4e1', ' 40.00'])('refuses the amount %p', (amount) => {
    expect(() => hashOf({ ...BET, money: { ...BET.money, amount } })).toThrow(MoneyValidationError);
  });

  test('refuses a currency that is not an ISO 4217 code', () => {
    expect(() => hashOf({ ...BET, money: { ...BET.money, currency: 'brl' } })).toThrow(
      MoneyValidationError,
    );
  });
});

/**
 * `msg.inbox-payload-conflict`: the hash a delivery stores is taken over the message's `data`, so
 * it answers a different question than the operation's — whether this `messageId` carries the
 * content it carried before — while sharing the canonical form and the stored spelling (ADR 0010).
 */
describe('content-hash-identifies-a-delivery', () => {
  /** The `data` of the `bet` message example of [docs/asyncapi.yaml]: the operation plus its key. */
  const CONTENT = {
    providerId: 'provider-acme',
    externalTransactionId: 'acme-tx-000123',
    idempotencyKey: 'provider-acme:acme-tx-000123',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-7f3a',
    gameId: 'lucky-sevens',
    kind: 'BET' as const,
    money: { amount: '40.00', currency: 'BRL' },
  };

  test('the hash is the stored spelling of the canonical JSON of the content', () => {
    expect(contentHashOf(CONTENT, sha256Hex)).toBe(`sha256:${sha256Hex(canonicalJson(CONTENT))}`);
    expect(isPayloadHash(contentHashOf(CONTENT, sha256Hex))).toBe(true);
  });

  test('the member order of the content does not change the hash', () => {
    const reordered = {
      money: { currency: CONTENT.money.currency, amount: CONTENT.money.amount },
      kind: CONTENT.kind,
      gameId: CONTENT.gameId,
      roundId: CONTENT.roundId,
      walletId: CONTENT.walletId,
      playerId: CONTENT.playerId,
      idempotencyKey: CONTENT.idempotencyKey,
      externalTransactionId: CONTENT.externalTransactionId,
      providerId: CONTENT.providerId,
    };

    expect(contentHashOf(reordered, sha256Hex)).toBe(contentHashOf(CONTENT, sha256Hex));
  });

  test('the idempotency key belongs to a delivery, unlike to an operation payload', () => {
    const underAnotherKey = { ...CONTENT, idempotencyKey: 'provider-acme:another-key' };

    expect(contentHashOf(underAnotherKey, sha256Hex)).not.toBe(contentHashOf(CONTENT, sha256Hex));
    expect(payloadHashOf(underAnotherKey, sha256Hex)).toBe(payloadHashOf(CONTENT, sha256Hex));
  });

  test('other content under one delivery identity hashes differently', () => {
    const otherAmount = { ...CONTENT, money: { amount: '41.00', currency: 'BRL' } };

    expect(contentHashOf(otherAmount, sha256Hex)).not.toBe(contentHashOf(CONTENT, sha256Hex));
  });

  test('a digest that is not a SHA-256 hex string is refused, as for an operation', () => {
    const hashWith = (): string => contentHashOf(CONTENT, () => 'not-a-digest');

    expect(hashWith).toThrow(CanonicalHashError);
  });
});

describe('recommended-key-fits', () => {
  /** `idem.recommended-default`: 120 + 1 + 120 characters, inside the 255 of `idem.key-format`. */
  test('the recommended key built from two capped identifiers fits the key limit', () => {
    const key = recommendedIdempotencyKey('p'.repeat(120), 'x'.repeat(120));

    expect(key).toHaveLength(241);
    expect(isIdempotencyKey(key)).toBe(true);
  });

  test('the recommended key of the documented example is the documented one', () => {
    expect(recommendedIdempotencyKey(BET.providerId, BET.externalTransactionId)).toBe(
      'provider-acme:acme-tx-000123',
    );
  });
});

describe('idempotency-key-format', () => {
  test.each([
    'a',
    'provider-acme:acme-tx-000123',
    '!~',
    'x'.repeat(255),
    'system:01a18261-a600-7589-8768-3d958460eced',
  ])('accepts %p', (key) => {
    expect(isIdempotencyKey(key)).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['too long', 'x'.repeat(256)],
    ['a space', 'provider acme'],
    ['a tab', 'provider\tacme'],
    ['a newline', 'provider-acme\n'],
    ['a non-ASCII character', 'provider-açme'],
    ['a control character', 'provider-acme'],
    ['a delete character', 'provider-acme'],
  ])('refuses a key with %s', (_what, key) => {
    expect(isIdempotencyKey(key)).toBe(false);
  });
});

/**
 * IDEM-012: a key that is already taken is a replay or a conflict, and the domain decides which
 * by comparing canonical hashes. No database and no transport takes part: the inputs are the
 * stored transaction and the hash of the submission.
 */
describe('payload-match-decides-replay-or-conflict', () => {
  test('the stored transaction recognises the payload it recorded', () => {
    const stored = storedBet(hashOf(BET));

    expect(stored.matchesPayload(hashOf(BET))).toBe(true);
    expect(
      stored.matchesPayload(hashOf({ ...BET, money: { ...BET.money, amount: '41.00' } })),
    ).toBe(false);
    expect(stored.matchesPayload(hashOf({ ...BET, roundId: 'round-7f3b' }))).toBe(false);
  });

  test('the same fields in another order are the same payload', () => {
    const stored = storedBet(BET_HASH);
    const reordered: SubmittedOperation = {
      kind: BET.kind,
      money: { currency: BET.money.currency, amount: BET.money.amount },
      gameId: BET.gameId,
      roundId: BET.roundId,
      playerId: BET.playerId,
      walletId: BET.walletId,
      externalTransactionId: BET.externalTransactionId,
      providerId: BET.providerId,
    };

    expect(stored.matchesPayload(hashOf(reordered))).toBe(true);
  });

  test('a key held by the same payload is a replay of the stored transaction', () => {
    const stored = storedBet(BET_HASH);

    expect(classifyReservationConflict(stored, BET_HASH)).toEqual({ replay: true, stored });
  });

  test('a key held by another payload is a payload mismatch', () => {
    const stored = storedBet(BET_HASH);

    expect(classifyReservationConflict(stored, hashOf({ ...BET, gameId: 'other-game' }))).toEqual({
      replay: false,
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
  });

  /** `idem.external-id-bound`: the key was free, so the provider transaction id is what collided. */
  test('a free key means the provider transaction id is already bound', () => {
    expect(classifyReservationConflict(null, BET_HASH)).toEqual({
      replay: false,
      code: 'EXTERNAL_TRANSACTION_ALREADY_BOUND',
    });
  });
});
