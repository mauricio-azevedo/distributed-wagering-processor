import { z } from 'zod';

import { ApplicationError } from '../../application/errors';
import type { WalletLedgerPage } from '../../application/use-cases/page-wallet-ledger';
import type { MoneyProps } from '../../domain/money';
import type { BalanceChangingKind } from '../../domain/transaction-kind';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/**
 * The query and response shapes of `GET /wallets/{walletId}/ledger`, implementing `Cursor`,
 * `Limit`, `LedgerEntry` and `LedgerPage` of [docs/openapi.yaml](../../../docs/openapi.yaml)
 * (`model.contract-first`).
 *
 * The cursor lives here, with the transport, because it is an encoding and not a position: the
 * ledger is ordered by `walletVersion` and the use case speaks in versions, while base64url, the
 * `v1` prefix and the refusal of anything else are what a caller sees. Encoding it in the adapter
 * is also what keeps the cursor opaque — nothing inside the service ever parses one back into a
 * query — so its form can change behind the `v1` prefix without a stored value to migrate.
 */

/** `Limit`: 1 to 200, default 50 (`ledger.cursor`). */
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

/** The version of the cursor format, so a later one is distinguishable rather than ambiguous. */
const CURSOR_VERSION = 'v1';

/** `Cursor` of the contract: what a cursor may look like before it is decoded at all. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The content a `v1` cursor decodes to, with no leading zero and no wallet version below 1. */
const CURSOR_CONTENT = /^v1:([1-9][0-9]{0,18})$/;

const LIMIT_MESSAGE = `must be between ${MIN_PAGE_LIMIT.toString()} and ${MAX_PAGE_LIMIT.toString()}`;

/**
 * `INVALID_CURSOR`: the value is not a cursor this service issued. It is its own `ErrorCode` rather
 * than one more validation violation because the caller's next step differs — restart from the
 * first page, rather than fix a member of the request — and because there is nothing to name: the
 * cursor is opaque, so a pointer into its content would describe an encoding the caller is not
 * supposed to know.
 *
 * It refuses rather than falling back to the first page: a caller that received a page it did not
 * ask for would read the beginning of the ledger again and never learn that its cursor was wrong.
 */
export class InvalidCursorError extends ApplicationError {
  override readonly code = 'INVALID_CURSOR' as const;

  constructor() {
    super('The cursor is malformed; restart pagination from the first page.');
  }
}

/** `ledger.cursor`: the unpadded base64url encoding of `v1:<walletVersion>`. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(`${CURSOR_VERSION}:${walletVersion.toString()}`, 'utf8').toString('base64url');
}

/**
 * The position a cursor names, or `null` when the caller sent none. Anything else is
 * `InvalidCursorError`.
 *
 * The decoder is strict in both directions: the value has to match the contract's pattern, its
 * content has to be exactly a `v1` wallet version, and re-encoding that version has to reproduce
 * the value it came from. The last check is the one that matters, because base64 decoding is
 * lenient — padded spellings and trailing bits decode to the same bytes — and a tolerant reader
 * would answer a crafted value with a page taken from a position nothing issued.
 */
export function afterWalletVersionOf(cursor: string | undefined): number | null {
  if (cursor === undefined) {
    return null;
  }

  const walletVersion = positionOf(cursor);

  if (walletVersion === null) {
    throw new InvalidCursorError();
  }

  return walletVersion;
}

function positionOf(cursor: string): number | null {
  if (!CURSOR_PATTERN.test(cursor)) {
    return null;
  }

  const content = CURSOR_CONTENT.exec(Buffer.from(cursor, 'base64url').toString('utf8'));

  if (content?.[1] === undefined) {
    return null;
  }

  const walletVersion = Number(content[1]);

  return Number.isSafeInteger(walletVersion) && encodeLedgerCursor(walletVersion) === cursor
    ? walletVersion
    : null;
}

/**
 * The `cursor` and `limit` parameters of the endpoint. `limit` arrives as text and every way of
 * getting it wrong — a value out of range, a fraction, a word, nothing at all — reports the same
 * message, because the caller's correction is the same in each case; the cursor is carried through
 * unparsed, so its refusal stays `INVALID_CURSOR` instead of being folded into this one.
 *
 * Unknown query members are left alone rather than refused, unlike the members of a body: the
 * contract fixes what a body may contain and says nothing about what else may ride on a URL.
 */
export const ledgerPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string({ error: LIMIT_MESSAGE })
    .optional()
    .refine((limit) => limit === undefined || isPageLimit(limit), { error: LIMIT_MESSAGE })
    .transform((limit) => (limit === undefined ? DEFAULT_PAGE_LIMIT : Number(limit))),
});

export type LedgerPageQueryParameters = z.infer<typeof ledgerPageQuerySchema>;

function isPageLimit(limit: string): boolean {
  return (
    /^[0-9]{1,3}$/.test(limit) && Number(limit) >= MIN_PAGE_LIMIT && Number(limit) <= MAX_PAGE_LIMIT
  );
}

/** `LedgerEntry`: the ten members of `ledger.read-shape`, with every amount as `MoneyProps`. */
export interface LedgerEntryResponse {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly kind: BalanceChangingKind;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

/** `LedgerPage`: the entries, and where to continue or that there is nowhere to continue. */
export interface LedgerPageResponse {
  readonly items: readonly LedgerEntryResponse[];
  readonly nextCursor: string | null;
}

export function ledgerPageResponse(page: WalletLedgerPage): LedgerPageResponse {
  return {
    items: page.items.map(ledgerEntryResponse),
    nextCursor: page.nextWalletVersion === null ? null : encodeLedgerCursor(page.nextWalletVersion),
  };
}

function ledgerEntryResponse(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    kind: entry.kind,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
