import { type CanonicalValue, canonicalJson } from './canonical-json';
import type { ErrorCode } from './error-code';
import { CanonicalHashError } from './errors';
import { Money, type MoneyProps } from './money';
import type { TransactionKind } from './transaction-kind';
import type { WagerTransaction } from './wager-transaction';

/**
 * Operation identity: what makes two arrivals the same operation, and what a key already taken
 * means. Both are decided here and nowhere else, so the HTTP entry point, the queue consumer and
 * the database all work from one definition (`idem.persistent`).
 *
 * `IdempotencyKey` and `PayloadHash` of [docs/openapi.yaml](../../docs/openapi.yaml) are the
 * authoritative definitions these patterns mirror (`model.contract-first`).
 */

/** `idem.key-format`: 1 to 255 printable ASCII characters, so no space and no control character. */
const IDEMPOTENCY_KEY = /^[!-~]{1,255}$/;

/** `idem.payload-hash`: the stored form of a payload hash. */
const PAYLOAD_HASH = /^sha256:[0-9a-f]{64}$/;

/** The digest a `Sha256Hex` has to return: 32 bytes as lowercase hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value);
}

export function isPayloadHash(value: string): boolean {
  return PAYLOAD_HASH.test(value);
}

/**
 * `idem.recommended-default`: the key a provider should send, and the key the service itself uses
 * for the internal opening credit (`system:<walletId>`). External identifiers are capped at 120
 * characters, so this key is at most 241 and always inside the limit of `idem.key-format`.
 */
export function recommendedIdempotencyKey(
  providerId: string,
  externalTransactionId: string,
): string {
  return `${providerId}:${externalTransactionId}`;
}

/**
 * Exactly the business fields that identify an operation (`idem.payload-hash`), as a provider
 * submitted them: the HTTP request body, or the queue message's `data` without its idempotency
 * key. Transport carries more than this, and none of it belongs to the operation.
 */
export interface SubmittedOperation {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | null;
}

/**
 * SHA-256 of a UTF-8 string as lowercase hex. The domain states the bytes to digest and the form
 * of the result; the primitive itself is passed in, because the domain imports no runtime module
 * (`model.framework-free-domain`). `sha256Hex` in the application layer is the implementation.
 */
export type Sha256Hex = (utf8: string) => string;

/**
 * The bytes a payload hash is taken over: the canonical JSON of the business fields, with `money`
 * nested as submitted and the reference omitted when it is absent.
 *
 * The projection is explicit, so a wider object loses its extra members here rather than in a
 * validator upstream: a correlation id, a message id or an idempotency key added to the
 * submission cannot change the hash. The amount passes through the domain parser, which is what
 * makes the one spelling per value of `money.decimal-string` a property of the hash instead of a
 * promise made by whichever validator ran first.
 */
export function canonicalOperationPayload(operation: SubmittedOperation): string {
  const money = Money.from(operation.money.amount, operation.money.currency);
  const reference = operation.referenceExternalTransactionId ?? null;

  return canonicalJson({
    providerId: operation.providerId,
    externalTransactionId: operation.externalTransactionId,
    playerId: operation.playerId,
    walletId: operation.walletId,
    roundId: operation.roundId,
    gameId: operation.gameId,
    kind: operation.kind,
    money: { amount: money.toString(), currency: money.currency },
    ...(reference === null ? {} : { referenceExternalTransactionId: reference }),
  });
}

/** `idem.payload-hash`: the value stored in `payload_hash` and compared on every arrival. */
export function payloadHashOf(operation: SubmittedOperation, sha256Hex: Sha256Hex): string {
  return storedHash(canonicalOperationPayload(operation), sha256Hex);
}

/**
 * `msg.inbox-payload-conflict`: the hash a delivery is recorded with, over whatever the transport
 * calls the content of one message — the `data` of a `WagerTransactionRequested`, which is the
 * operation plus its idempotency key (ADR 0010).
 *
 * It is the same canonical form and the same stored spelling as an operation's payload hash and a
 * deliberately different projection: an operation is identified by its business fields, so the key
 * is outside that hash, while a delivery is identified by the message, so the key is inside this
 * one. The two therefore answer different questions about the same arrival, and neither can be
 * used for the other's.
 */
export function contentHashOf(content: CanonicalValue, sha256Hex: Sha256Hex): string {
  return storedHash(canonicalJson(content), sha256Hex);
}

/** The one spelling of a stored hash: `sha256:` and the digest, refused unless it is one. */
function storedHash(canonical: string, sha256Hex: Sha256Hex): string {
  const digest = sha256Hex(canonical);

  if (!SHA256_HEX.test(digest)) {
    throw new CanonicalHashError(
      `a payload hash is the lowercase hex SHA-256 of the canonical payload, got ${JSON.stringify(digest)}`,
    );
  }

  return `sha256:${digest}`;
}

/**
 * The two conflicts a taken key can be. They are request errors rather than transaction outcomes,
 * so they carry no `FailureCode`: `ErrorCode` of [docs/openapi.yaml](../../docs/openapi.yaml)
 * enumerates them, and both are answered with `409` and nothing persisted
 * (`idem.payload-mismatch-conflict`, `idem.external-id-bound`).
 */
export type IdempotencyConflictCode = Extract<
  ErrorCode,
  'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'EXTERNAL_TRANSACTION_ALREADY_BOUND'
>;

export type ReservationDecision =
  | { readonly replay: true; readonly stored: WagerTransaction }
  | { readonly replay: false; readonly code: IdempotencyConflictCode };

/**
 * What a lost reservation means (IDEM-012). The reservation insert fails on one of the two unique
 * keys of a submission, and which one it was is the whole decision:
 *
 * - `(provider_id, idempotency_key)` is taken by the same payload: the operation already ran, so
 *   this arrival is a replay of the stored outcome (`idem.replay-same-outcome`).
 * - the same key is taken by a different payload: the provider reused a key for another
 *   operation, which is a conflict, never a replay (`idem.payload-mismatch-conflict`).
 * - the key was free, so `(provider_id, external_transaction_id)` is what collided: the provider
 *   transaction id is bound to the key that first used it (`idem.external-id-bound`).
 *
 * Canonical hashes decide the first two, so the decision needs no second read of the payload and
 * no transport in sight.
 */
export function classifyReservationConflict(
  keyHolder: WagerTransaction | null,
  payloadHash: string,
): ReservationDecision {
  if (keyHolder === null) {
    return { replay: false, code: 'EXTERNAL_TRANSACTION_ALREADY_BOUND' };
  }

  return keyHolder.matchesPayload(payloadHash)
    ? { replay: true, stored: keyHolder }
    : { replay: false, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
}
