import { type Sha256Hex, payloadHashOf, recommendedIdempotencyKey } from './idempotency';
import type { Money } from './money';
import type { NewWagerTransaction } from './wager-transaction';

/**
 * The identity of the internal transaction that records a wallet's opening credit
 * (`wallet.opening-credit`, `tx.opening-internal`, interpretation 8 of the system contract).
 *
 * It lives here rather than in the use case because both sides of the reservation need it: the
 * opening path writes a transaction under it, and the submission path has to refuse a provider that
 * claims it. One module states the six fields the interpretation fixes, so the row the service
 * writes and the row it refuses cannot be described differently.
 */

/** `tx.opening-internal`: the reserved provider id, which no submission may carry. */
export const SYSTEM_PROVIDER_ID = 'system';

/** The game id every opening credit records, the operation being the opening itself. */
export const WALLET_OPENING_GAME_ID = 'wallet-opening';

/** What an opening credit is: a wallet, its owner, the amount and the moment it opened. */
export interface NewOpeningCredit {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly openedAt: Date;
}

/**
 * The submission the service makes to itself for an opening credit: `providerId` `system`, the
 * wallet id as both the provider transaction id and the round id, `wallet-opening` as the game,
 * and the recommended key over the two (`idem.recommended-default`), so the credit is readable at
 * `GET /providers/system/wagering/transactions/{walletId}` like any provider transaction and
 * occupies the unique keys of the table the same way.
 *
 * The payload hash is taken over the same business fields as any other operation
 * (`idem.payload-hash`), so the one definition of operation identity covers the internal credit
 * too and nothing special-cases it.
 */
export function openingCreditSubmission(
  credit: NewOpeningCredit,
  sha256Hex: Sha256Hex,
): NewWagerTransaction {
  const operation = {
    providerId: SYSTEM_PROVIDER_ID,
    externalTransactionId: credit.walletId,
    playerId: credit.playerId,
    walletId: credit.walletId,
    roundId: credit.walletId,
    gameId: WALLET_OPENING_GAME_ID,
    kind: 'OPENING',
    money: credit.money.toJSON(),
  } as const;

  return {
    ...operation,
    id: credit.transactionId,
    idempotencyKey: recommendedIdempotencyKey(SYSTEM_PROVIDER_ID, credit.walletId),
    payloadHash: payloadHashOf(operation, sha256Hex),
    money: credit.money,
    referenceExternalTransactionId: null,
    createdAt: credit.openedAt,
  };
}
