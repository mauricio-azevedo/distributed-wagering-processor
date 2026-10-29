import { describe, expect, test } from 'bun:test';

import {
  InvalidCursorError,
  afterWalletVersionOf,
  encodeLedgerCursor,
} from '../../src/infrastructure/http/ledger.dto';

/**
 * `ledger.cursor`: the cursor is the unpadded base64url encoding of `v1:<walletVersion>`, opaque to
 * clients, and a value the service did not issue is `400 INVALID_CURSOR` rather than a page taken
 * from whatever it happened to decode to.
 *
 * The decoder is tested against spellings that decode to something and still are not cursors,
 * because base64 is lenient: a tolerant reader would answer a crafted value with a page of someone
 * else's ledger position instead of refusing it.
 */

/** The `Cursor` example of [docs/openapi.yaml]: the second page of the three-entry ledger. */
const SECOND_PAGE = 'djE6Mg';

const base64url = (content: string) => Buffer.from(content, 'utf8').toString('base64url');

describe('ledger-cursor-encoding', () => {
  test('a cursor is the unpadded base64url of v1 and the wallet version', () => {
    expect(encodeLedgerCursor(2)).toBe(SECOND_PAGE);
    expect(Buffer.from(SECOND_PAGE, 'base64url').toString('utf8')).toBe('v1:2');
  });

  test('every wallet version a ledger can reach round-trips', () => {
    for (const walletVersion of [1, 2, 50, 200, 999, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(afterWalletVersionOf(encodeLedgerCursor(walletVersion))).toBe(walletVersion);
    }
  });

  test('a cursor carries no padding and nothing outside the contract pattern', () => {
    for (const walletVersion of [1, 7, 64, 123_456]) {
      expect(encodeLedgerCursor(walletVersion)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  test('an absent cursor is the first page rather than a refusal', () => {
    expect(afterWalletVersionOf(undefined)).toBeNull();
  });
});

describe('ledger-cursor-refusals', () => {
  const refused: Record<string, string> = {
    'an empty value': '',
    'a value that is not base64url at all': 'not a cursor',
    'a padded encoding of the same content': 'djE6Mg==',
    'a content without the version prefix': base64url('2'),
    'a content of a version this service never issued': base64url('v2:2'),
    'a wallet version of zero, which no entry carries': base64url('v1:0'),
    'a negative wallet version': base64url('v1:-1'),
    'a wallet version with a leading zero': base64url('v1:01'),
    'a wallet version that is not a number': base64url('v1:latest'),
    'a content carrying more than the wallet version': base64url('v1:2:3'),
    'a wallet version above what an integer represents exactly': base64url('v1:9007199254740993'),
    'a value longer than the contract admits': 'a'.repeat(65),
  };

  for (const [description, cursor] of Object.entries(refused)) {
    test(`${description} is INVALID_CURSOR`, () => {
      expect(() => afterWalletVersionOf(cursor)).toThrow(InvalidCursorError);
      expect(new InvalidCursorError().code).toBe('INVALID_CURSOR');
    });
  }

  test('the refusal says to restart from the first page, naming nothing of the ledger', () => {
    expect(new InvalidCursorError().message).toBe(
      'The cursor is malformed; restart pagination from the first page.',
    );
  });
});
