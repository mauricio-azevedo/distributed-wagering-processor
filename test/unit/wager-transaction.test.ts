import { describe, expect, test } from 'bun:test';

import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../src/domain/errors';
import type { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { type TransactionKind, affectsBalance } from '../../src/domain/transaction-kind';
import {
  type NewWagerTransaction,
  type RejectionCode,
  type TransactionStatus,
  WagerTransaction,
  type WagerTransactionState,
  allowsReference,
  requiresReference,
} from '../../src/domain/wager-transaction';
import {
  type LedgerDirection,
  type LedgerOperation,
  type ReversibleKind,
  ledgerDirectionFor,
} from '../../src/domain/wallet-ledger-entry';

const TRANSACTION_ID = '01a18266-39e0-758b-a289-fb48c2dd9c8b';
const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const OTHER_WALLET_ID = '01a18261-a600-7589-8768-3d958460ecee';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const OTHER_PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049f';
const REFERENCE_TRANSACTION_ID = '01a18265-1d00-758a-9f4c-6a1b2c3d4e5f';
const EXTERNAL_TRANSACTION_ID = 'acme-tx-000123';
const REFERENCE_EXTERNAL_ID = 'acme-tx-000099';
const PAYLOAD_HASH = 'sha256:2bba54ed2c9b88952dc90ee0d38bd41bee09fef0fcf7ab87e47e67d8be05bfa9';
const CREATED_AT = new Date('2026-10-28T12:05:00.000Z');
const PROCESSED_AT = new Date('2026-10-28T12:05:00.012Z');

const brl = (amount: string): Money => Money.from(amount, 'BRL');

/** The balance observed when an outcome is recorded (`tx.observed-balance`). */
const OBSERVED_BALANCE = brl('460.00');

const KINDS: readonly TransactionKind[] = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];

const STATUSES: readonly TransactionStatus[] = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
];

const TERMINAL_STATUSES: readonly TransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

/** The identity and context every fixture shares; none of it changes after insertion. */
const SUBMISSION = {
  id: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: EXTERNAL_TRANSACTION_ID,
  idempotencyKey: `provider-acme:${EXTERNAL_TRANSACTION_ID}`,
  payloadHash: PAYLOAD_HASH,
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  createdAt: CREATED_AT,
} as const;

/** A `BET` of 40.00 as a provider submitted it, before any outcome was recorded. */
const betOf = (overrides: Partial<NewWagerTransaction> = {}): WagerTransaction =>
  WagerTransaction.create({
    ...SUBMISSION,
    kind: 'BET',
    money: brl('40.00'),
    referenceExternalTransactionId: null,
    ...overrides,
  });

/** The same submission under another kind, carrying a reference wherever the kind allows one. */
const transactionOf = (kind: TransactionKind): WagerTransaction =>
  betOf({
    kind,
    referenceExternalTransactionId: allowsReference(kind) ? REFERENCE_EXTERNAL_ID : null,
  });

const STORED_FAILURE_CODE: Partial<Record<TransactionStatus, FailureCode>> = {
  REJECTED: 'INSUFFICIENT_BALANCE',
  FAILED: 'PROCESSING_FAILED',
};

/**
 * A stored `ROLLBACK` in any status, built through `rehydrate` so that the transition tests start
 * from the status under test instead of from whatever the transitions happen to produce. It
 * carries a reference, so no transition is refused for a reason other than the status.
 */
const storedIn = (status: TransactionStatus): WagerTransaction =>
  WagerTransaction.rehydrate({
    ...SUBMISSION,
    kind: 'ROLLBACK',
    money: brl('40.00'),
    status,
    failureCode: STORED_FAILURE_CODE[status] ?? null,
    observedBalance: status === 'PENDING' ? null : OBSERVED_BALANCE,
    referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
    referenceTransactionId: null,
    processedAt: status === 'PROCESSED' ? PROCESSED_AT : null,
  });

type TransitionName = 'markProcessed' | 'markPendingReference' | 'reject' | 'fail';

const TRANSITIONS: readonly TransitionName[] = [
  'markProcessed',
  'markPendingReference',
  'reject',
  'fail',
];

/** The status each transition records, so the matrix can be read against `tx.transitions`. */
const TARGET_OF: Record<TransitionName, TransactionStatus> = {
  markProcessed: 'PROCESSED',
  markPendingReference: 'PENDING_REFERENCE',
  reject: 'REJECTED',
  fail: 'FAILED',
};

/** `tx.transitions`, as the contract words it. Nothing reaches `PENDING` a second time. */
const ALLOWED_TARGETS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  PENDING: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

/** Applies a transition by name, so one case covers every (status, transition) pair. */
const applyTransition = (transaction: WagerTransaction, transition: TransitionName): void => {
  switch (transition) {
    case 'markProcessed':
      transaction.markProcessed({ observedBalance: OBSERVED_BALANCE, processedAt: PROCESSED_AT });
      break;
    case 'markPendingReference':
      transaction.markPendingReference({ observedBalance: OBSERVED_BALANCE });
      break;
    case 'reject':
      transaction.reject({
        failureCode: 'INSUFFICIENT_BALANCE',
        observedBalance: OBSERVED_BALANCE,
      });
      break;
    case 'fail':
      transaction.fail({ observedBalance: OBSERVED_BALANCE });
      break;
  }
};

/** The four fields a terminal transaction freezes (`tx.terminal-immutable`). */
const outcomeOf = (
  transaction: WagerTransaction,
): Pick<WagerTransactionState, 'status' | 'failureCode' | 'processedAt' | 'observedBalance'> => ({
  status: transaction.status,
  failureCode: transaction.failureCode,
  processedAt: transaction.processedAt,
  observedBalance: transaction.observedBalance,
});

const pairsOf = (statuses: readonly TransactionStatus[]): [TransactionStatus, TransitionName][] =>
  statuses.flatMap((status) =>
    TRANSITIONS.map((transition) => [status, transition] as [TransactionStatus, TransitionName]),
  );

/**
 * A transaction a reference resolved to, as the database handed it back: a `PROCESSED` `BET` of
 * 80.00 in the same context as the submission above (`rule.reference.resolution`). Overrides are
 * what a case differs in, one at a time.
 */
const resolvedReference = (overrides: Partial<WagerTransactionState> = {}): WagerTransaction =>
  WagerTransaction.rehydrate({
    ...SUBMISSION,
    id: REFERENCE_TRANSACTION_ID,
    externalTransactionId: REFERENCE_EXTERNAL_ID,
    idempotencyKey: `provider-acme:${REFERENCE_EXTERNAL_ID}`,
    kind: 'BET',
    money: brl('80.00'),
    status: 'PROCESSED',
    failureCode: null,
    observedBalance: brl('20.00'),
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    processedAt: PROCESSED_AT,
    ...overrides,
  });

/** The same reference in another status, with the outcome columns that status admits. */
const referenceIn = (status: TransactionStatus): WagerTransaction =>
  resolvedReference({
    status,
    failureCode: STORED_FAILURE_CODE[status] ?? null,
    processedAt: status === 'PROCESSED' ? PROCESSED_AT : null,
  });

/** The direction a movement takes, or `null` when the kind applies none (`rule.loss.no-effect`). */
const directionOf = (movement: LedgerOperation | null): LedgerDirection | null =>
  movement === null ? null : ledgerDirectionFor(movement);

/** The submission under test, of 80.00, carrying the reference the fixtures above resolve. */
const reversalOf = (
  kind: TransactionKind,
  overrides: Partial<NewWagerTransaction> = {},
): WagerTransaction =>
  betOf({
    kind,
    money: brl('80.00'),
    referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
    ...overrides,
  });

describe('reference-requirement-by-kind', () => {
  test.each<[TransactionKind, boolean, boolean]>([
    ['OPENING', false, false],
    ['BET', false, false],
    ['WIN', false, true],
    ['LOSS', false, true],
    ['REFUND', true, true],
    ['ROLLBACK', true, true],
  ])('a %s requires a reference: %p, allows one: %p', (kind, required, allowed) => {
    expect(requiresReference(kind)).toBe(required);
    expect(allowsReference(kind)).toBe(allowed);
  });

  test.each<TransactionKind>(['REFUND', 'ROLLBACK'])(
    'a %s without a reference is refused',
    (kind) => {
      expect(() => betOf({ kind, referenceExternalTransactionId: null })).toThrow(
        InvalidWagerTransactionError,
      );
    },
  );

  test.each<TransactionKind>(['BET', 'OPENING'])('a %s carrying a reference is refused', (kind) => {
    expect(() => betOf({ kind, referenceExternalTransactionId: REFERENCE_EXTERNAL_ID })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each<TransactionKind>(['WIN', 'LOSS'])(
    'a %s is created with and without a reference',
    (kind) => {
      expect(betOf({ kind, referenceExternalTransactionId: null }).status).toBe('PENDING');
      expect(
        betOf({ kind, referenceExternalTransactionId: REFERENCE_EXTERNAL_ID })
          .referenceExternalTransactionId,
      ).toBe(REFERENCE_EXTERNAL_ID);
    },
  );

  test('the message names the kind whose reference requirement it refused', () => {
    expect(() => betOf({ kind: 'REFUND', referenceExternalTransactionId: null })).toThrow(
      /REFUND.*reference/,
    );
    expect(() => betOf({ referenceExternalTransactionId: REFERENCE_EXTERNAL_ID })).toThrow(
      /BET.*reference/,
    );
  });

  test('create yields a PENDING transaction with no outcome recorded yet', () => {
    const transaction = betOf();

    expect(transaction.status).toBe('PENDING');
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.failureCode).toBeNull();
    expect(transaction.observedBalance).toBeNull();
    expect(transaction.processedAt).toBeNull();
    expect(transaction.referenceTransactionId).toBeNull();
    expect(transaction.id).toBe(TRANSACTION_ID);
    expect(transaction.kind).toBe('BET');
    expect(transaction.money.toString()).toBe('40.00');
    expect(transaction.createdAt).toEqual(CREATED_AT);
  });
});

describe('affects-balance-by-kind', () => {
  test.each<[TransactionKind, boolean]>([
    ['OPENING', true],
    ['BET', true],
    ['WIN', true],
    ['LOSS', false],
    ['REFUND', true],
    ['ROLLBACK', true],
  ])('a %s affects the balance: %p', (kind, expected) => {
    expect(affectsBalance(kind)).toBe(expected);
    expect(transactionOf(kind).affectsBalance()).toBe(expected);
  });

  test('LOSS is the only kind that moves no money', () => {
    expect(KINDS.filter((kind) => !affectsBalance(kind))).toEqual(['LOSS']);
  });
});

describe('status-transition-table', () => {
  test.each(pairsOf(STATUSES))('a %s transaction and %s', (status, transition) => {
    const transaction = storedIn(status);
    const target = TARGET_OF[transition];

    if (ALLOWED_TARGETS[status].includes(target)) {
      applyTransition(transaction, transition);

      expect(transaction.status).toBe(target);

      return;
    }

    expect(() => {
      applyTransition(transaction, transition);
    }).toThrow(InvalidTransactionStateError);
    expect(transaction.status).toBe(status);
  });

  test('a pending reference records another attempt without leaving its status', () => {
    const transaction = storedIn('PENDING_REFERENCE');

    transaction.markPendingReference({ observedBalance: brl('525.00') });

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.observedBalance?.toString()).toBe('525.00');
    expect(transaction.processedAt).toBeNull();
  });

  test('the message names the status it refused to leave and the one it was asked for', () => {
    expect(() => {
      storedIn('PROCESSED').reject({
        failureCode: 'INSUFFICIENT_BALANCE',
        observedBalance: OBSERVED_BALANCE,
      });
    }).toThrow(/PROCESSED.*REJECTED/);
  });

  test('the only mutators are the four named transitions', () => {
    const members = Object.entries(Object.getOwnPropertyDescriptors(WagerTransaction.prototype));
    const methods = members
      .filter(
        ([name, descriptor]) => name !== 'constructor' && typeof descriptor.value === 'function',
      )
      .map(([name]) => name);
    const setters = members.filter(([, descriptor]) => descriptor.set !== undefined);

    expect(setters).toEqual([]);
    expect(methods.toSorted()).toEqual([
      'affectsBalance',
      'fail',
      'isTerminal',
      'markPendingReference',
      'markProcessed',
      'matchesPayload',
      'movement',
      'refuseReference',
      'reject',
    ]);
  });
});

describe('failure-code-by-transition', () => {
  test('fail carries PROCESSING_FAILED, the code only it owns', () => {
    const transaction = betOf();

    transaction.fail({ observedBalance: OBSERVED_BALANCE });

    expect(transaction.status).toBe('FAILED');
    expect(transaction.failureCode).toBe('PROCESSING_FAILED');
  });

  test('PROCESSING_FAILED is the one failure code a rejection cannot carry', () => {
    const transaction = betOf();
    // @ts-expect-error - PROCESSING_FAILED belongs to fail alone (`tx.failed-semantics`).
    const refusedAsRejection: RejectionCode = 'PROCESSING_FAILED';

    transaction.fail({ observedBalance: OBSERVED_BALANCE });

    expect(transaction.failureCode).toBe(refusedAsRejection);
  });

  test.each<RejectionCode>(['INSUFFICIENT_BALANCE', 'REFERENCE_NOT_FOUND', 'CURRENCY_MISMATCH'])(
    'a rejection carries %s',
    (failureCode) => {
      const transaction = betOf();

      transaction.reject({ failureCode, observedBalance: OBSERVED_BALANCE });

      expect(transaction.status).toBe('REJECTED');
      expect(transaction.failureCode).toBe(failureCode);
    },
  );

  test('a processed or parked transaction carries no failure code', () => {
    const processed = betOf();
    const parked = transactionOf('ROLLBACK');

    processed.markProcessed({ observedBalance: OBSERVED_BALANCE, processedAt: PROCESSED_AT });
    parked.markPendingReference({ observedBalance: OBSERVED_BALANCE });

    expect(processed.failureCode).toBeNull();
    expect(parked.failureCode).toBeNull();
  });
});

describe('observed-balance-is-recorded', () => {
  test.each(TRANSITIONS)('%s records the balance observed at that moment', (transition) => {
    const transaction = transactionOf('ROLLBACK');

    applyTransition(transaction, transition);

    expect(transaction.observedBalance?.toString()).toBe('460.00');
    expect(transaction.observedBalance?.currency).toBe('BRL');
  });

  test('only a processed transaction carries a processed time', () => {
    const processed = betOf();
    const rejected = betOf();
    const failed = betOf();
    const parked = transactionOf('ROLLBACK');

    processed.markProcessed({ observedBalance: OBSERVED_BALANCE, processedAt: PROCESSED_AT });
    rejected.reject({ failureCode: 'INSUFFICIENT_BALANCE', observedBalance: OBSERVED_BALANCE });
    failed.fail({ observedBalance: OBSERVED_BALANCE });
    parked.markPendingReference({ observedBalance: OBSERVED_BALANCE });

    expect(processed.processedAt).toEqual(PROCESSED_AT);
    expect(rejected.processedAt).toBeNull();
    expect(failed.processedAt).toBeNull();
    expect(parked.processedAt).toBeNull();
  });

  test('an outcome binds the reference it resolved, and the next one never clears it', () => {
    const refund = transactionOf('REFUND');

    refund.markPendingReference({ observedBalance: OBSERVED_BALANCE });

    expect(refund.referenceTransactionId).toBeNull();

    refund.markProcessed({
      observedBalance: brl('500.00'),
      processedAt: PROCESSED_AT,
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
    });

    expect(refund.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
  });

  test('a rejection binds the reference it resolved before refusing it', () => {
    const rollback = transactionOf('ROLLBACK');

    rollback.reject({
      failureCode: 'REFERENCE_KIND_NOT_ALLOWED',
      observedBalance: OBSERVED_BALANCE,
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
    });

    expect(rollback.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
  });

  test.each<TransactionKind>(['BET', 'WIN'])(
    'a %s submitted without a reference can neither wait for one nor be bound to one',
    (kind) => {
      const unreferenced = betOf({ kind, referenceExternalTransactionId: null });

      expect(() => {
        unreferenced.markPendingReference({ observedBalance: OBSERVED_BALANCE });
      }).toThrow(InvalidWagerTransactionError);
      expect(() => {
        unreferenced.markProcessed({
          observedBalance: OBSERVED_BALANCE,
          processedAt: PROCESSED_AT,
          referenceTransactionId: REFERENCE_TRANSACTION_ID,
        });
      }).toThrow(InvalidWagerTransactionError);
      expect(unreferenced.status).toBe('PENDING');
      expect(unreferenced.referenceTransactionId).toBeNull();
    },
  );

  test('an outcome field cannot be assigned: a transition is the only way to record one', () => {
    const transaction = betOf();
    const assignStatus = (): void => {
      // @ts-expect-error - status is read-only; markProcessed records it (model.explicit-transitions).
      transaction.status = 'PROCESSED';
    };

    expect(assignStatus).toThrow(TypeError);
    expect(transaction.status).toBe('PENDING');
  });
});

describe('terminal-status-is-final', () => {
  test('the terminal statuses are exactly PROCESSED, REJECTED and FAILED', () => {
    expect(STATUSES.filter((status) => storedIn(status).isTerminal())).toEqual([
      ...TERMINAL_STATUSES,
    ]);
  });

  test.each(pairsOf(TERMINAL_STATUSES))(
    'a %s transaction refuses %s and keeps its outcome',
    (status, transition) => {
      const transaction = storedIn(status);
      const before = outcomeOf(transaction);

      expect(() => {
        applyTransition(transaction, transition);
      }).toThrow(InvalidTransactionStateError);
      expect(outcomeOf(transaction)).toEqual(before);
    },
  );
});

describe('terminal-transaction-refuses-transitions', () => {
  test('a transaction moved to PROCESSED refuses a later rejection and stays PROCESSED', () => {
    const transaction = betOf();

    transaction.markProcessed({ observedBalance: OBSERVED_BALANCE, processedAt: PROCESSED_AT });

    expect(() => {
      transaction.reject({ failureCode: 'INSUFFICIENT_BALANCE', observedBalance: brl('0.00') });
    }).toThrow(InvalidTransactionStateError);
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.failureCode).toBeNull();
    expect(transaction.observedBalance?.toString()).toBe('460.00');
    expect(transaction.processedAt).toEqual(PROCESSED_AT);
  });

  test('the balance observed with the outcome survives a second attempt to record one', () => {
    const transaction = betOf();

    transaction.markProcessed({ observedBalance: OBSERVED_BALANCE, processedAt: PROCESSED_AT });

    expect(() => {
      transaction.markProcessed({
        observedBalance: brl('1000.00'),
        processedAt: new Date('2026-10-28T13:00:00.000Z'),
      });
    }).toThrow(InvalidTransactionStateError);
    expect(transaction.observedBalance?.toString()).toBe('460.00');
    expect(transaction.processedAt).toEqual(PROCESSED_AT);
  });
});

describe('domain-factories-are-the-only-entry', () => {
  test('the WagerTransaction constructor is not reachable', () => {
    const construct = (): void => {
      // @ts-expect-error - the constructor is private (model.private-constructors).
      new WagerTransaction();
    };

    expect(construct).toThrow(TypeError);
  });

  test('create returns a transaction in its initial state', () => {
    expect(betOf()).toBeInstanceOf(WagerTransaction);
    expect(betOf().status).toBe('PENDING');
  });
});

describe('rehydrate-trusts-stored-state', () => {
  test('a stored PROCESSED row with a resolved reference is rebuilt as it stands', () => {
    const stored = WagerTransaction.rehydrate({
      ...SUBMISSION,
      kind: 'REFUND',
      money: brl('65.00'),
      status: 'PROCESSED',
      failureCode: null,
      observedBalance: brl('525.00'),
      referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
      referenceTransactionId: REFERENCE_TRANSACTION_ID,
      processedAt: PROCESSED_AT,
    });

    expect(stored.status).toBe('PROCESSED');
    expect(stored.isTerminal()).toBe(true);
    expect(stored.observedBalance?.toString()).toBe('525.00');
    expect(stored.referenceTransactionId).toBe(REFERENCE_TRANSACTION_ID);
    expect(stored.processedAt).toEqual(PROCESSED_AT);
  });

  test('a stored row is not re-validated against the reference matrix', () => {
    const stored = WagerTransaction.rehydrate({
      ...SUBMISSION,
      kind: 'BET',
      money: brl('40.00'),
      status: 'PENDING',
      failureCode: null,
      observedBalance: null,
      referenceExternalTransactionId: REFERENCE_EXTERNAL_ID,
      referenceTransactionId: null,
      processedAt: null,
    });

    expect(stored.kind).toBe('BET');
    expect(stored.referenceExternalTransactionId).toBe(REFERENCE_EXTERNAL_ID);
  });

  test('a rehydrated non-terminal row still moves through the transition table', () => {
    const stored = storedIn('PENDING_REFERENCE');

    stored.markProcessed({ observedBalance: brl('525.00'), processedAt: PROCESSED_AT });

    expect(stored.status).toBe('PROCESSED');
    expect(stored.observedBalance?.toString()).toBe('525.00');
  });
});

describe('reversal-eligibility-is-a-domain-decision', () => {
  test('a REFUND of the exact amount of a PROCESSED BET in the same context is refused by nothing', () => {
    expect(reversalOf('REFUND').refuseReference(resolvedReference())).toBeNull();
  });

  test.each<[TransactionKind, TransactionKind]>([
    ['WIN', 'BET'],
    ['LOSS', 'BET'],
    ['REFUND', 'BET'],
    ['ROLLBACK', 'BET'],
    ['ROLLBACK', 'WIN'],
    ['ROLLBACK', 'REFUND'],
  ])('a %s may reference a %s', (kind, referenced) => {
    expect(reversalOf(kind).refuseReference(resolvedReference({ kind: referenced }))).toBeNull();
  });

  test.each<[TransactionKind, TransactionKind]>([
    ['REFUND', 'WIN'],
    ['REFUND', 'LOSS'],
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['REFUND', 'OPENING'],
    ['ROLLBACK', 'ROLLBACK'],
    ['ROLLBACK', 'LOSS'],
    ['ROLLBACK', 'OPENING'],
    ['WIN', 'WIN'],
    ['WIN', 'ROLLBACK'],
    ['LOSS', 'LOSS'],
  ])('a %s may not reference a %s', (kind, referenced) => {
    expect(reversalOf(kind).refuseReference(resolvedReference({ kind: referenced }))).toBe(
      'REFERENCE_KIND_NOT_ALLOWED',
    );
  });

  test.each<TransactionStatus>(['PENDING', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'])(
    'a reference that is %s is not processed',
    (status) => {
      expect(reversalOf('REFUND').refuseReference(referenceIn(status))).toBe(
        'REFERENCE_NOT_PROCESSED',
      );
    },
  );

  test.each<[string, Partial<WagerTransactionState>]>([
    ['provider', { providerId: 'provider-other' }],
    ['player', { playerId: OTHER_PLAYER_ID }],
    ['wallet', { walletId: OTHER_WALLET_ID }],
    ['currency', { money: Money.from('80.00', 'USD') }],
    ['round', { roundId: 'round-other' }],
  ])('a reference in another %s is a mismatch', (_context, difference) => {
    expect(reversalOf('REFUND').refuseReference(resolvedReference(difference))).toBe(
      'REFERENCE_MISMATCH',
    );
  });

  test('the currency is compared as context, so no amount is ever compared across currencies', () => {
    const reversal = reversalOf('REFUND', { money: Money.from('80.00', 'USD') });

    expect(reversal.refuseReference(resolvedReference())).toBe('REFERENCE_MISMATCH');
  });

  test('a reference of another game is still the same context, because the round decides it', () => {
    expect(
      reversalOf('REFUND').refuseReference(resolvedReference({ gameId: 'another-game' })),
    ).toBeNull();
  });

  test.each<TransactionKind>(['REFUND', 'ROLLBACK'])(
    'a %s of an amount other than the referenced one is refused',
    (kind) => {
      const reversal = reversalOf(kind, { money: brl('50.00') });

      expect(reversal.refuseReference(resolvedReference())).toBe('REFERENCE_AMOUNT_MISMATCH');
    },
  );

  test.each<TransactionKind>(['WIN', 'LOSS'])(
    'the amount of a %s is independent of the amount it references',
    (kind) => {
      const reported = reversalOf(kind, { money: brl('50.00') });

      expect(reported.refuseReference(resolvedReference())).toBeNull();
    },
  );

  test('the kind matrix is read before the context, so an OPENING is refused for what it is', () => {
    const opening = resolvedReference({
      kind: 'OPENING',
      providerId: 'system',
      roundId: WALLET_ID,
      externalTransactionId: WALLET_ID,
    });

    expect(reversalOf('ROLLBACK').refuseReference(opening)).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });
});

describe('reversal-movement-inverts-its-reference', () => {
  test.each<[ReversibleKind, LedgerDirection]>([
    ['BET', 'DEBIT'],
    ['WIN', 'CREDIT'],
    ['REFUND', 'CREDIT'],
  ])('a %s moves money as a %s of its own amount', (kind, direction) => {
    const movement = transactionOf(kind).movement(resolvedReference());

    expect(movement).toMatchObject({ kind });
    expect(directionOf(movement)).toBe(direction);
  });

  test.each<[ReversibleKind, LedgerDirection]>([
    ['BET', 'CREDIT'],
    ['WIN', 'DEBIT'],
    ['REFUND', 'DEBIT'],
  ])('a ROLLBACK of a %s is the opposite %s', (referenced, direction) => {
    const movement = transactionOf('ROLLBACK').movement(resolvedReference({ kind: referenced }));

    expect(movement).toMatchObject({ kind: 'ROLLBACK', reverses: referenced });
    expect(directionOf(movement)).toBe(direction);
  });

  test('a LOSS moves nothing, so it has no movement to apply', () => {
    expect(transactionOf('LOSS').movement(resolvedReference())).toBeNull();
  });

  test('a WIN keeps its own movement whether or not it resolved a reference', () => {
    expect(transactionOf('WIN').movement(null)).toEqual({ kind: 'WIN' });
  });

  test('a ROLLBACK without a resolved reference has no direction, which is a defect', () => {
    expect(() => transactionOf('ROLLBACK').movement(null)).toThrow(InvalidWagerTransactionError);
  });

  test('a ROLLBACK of a kind the matrix refuses has no inverse either', () => {
    expect(() => transactionOf('ROLLBACK').movement(resolvedReference({ kind: 'LOSS' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});
