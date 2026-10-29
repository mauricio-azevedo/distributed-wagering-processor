import { describe, expect, test } from 'bun:test';

import { TransactionNotFoundError } from '../../src/application/errors';
import type { ProviderTransactionIdentity } from '../../src/application/ports/repositories';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { GetWagerTransaction } from '../../src/application/use-cases/get-wager-transaction';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';

const TRANSACTION_ID = '01a18266-39e0-758b-a289-fb48c2dd9c8b';
const WALLET_ID = '01a18261-a600-7589-8768-3d958460eced';
const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const AT = new Date('2026-10-28T12:05:00.000Z');

/**
 * `api.transaction-read`: the two ways a read names a transaction, and the one thing that must not
 * happen between them. A provider lookup resolves on `(providerId, externalTransactionId)` alone
 * (`tx.identity`), so a provider cannot reach another provider's row — or the service's own
 * `OPENING` credits — by sending a service id in the path a provider id guards.
 */

const processedBet = WagerTransaction.rehydrate({
  id: TRANSACTION_ID,
  providerId: 'provider-acme',
  externalTransactionId: 'acme-tx-000123',
  idempotencyKey: 'provider-acme:acme-tx-000123',
  payloadHash: `sha256:${'2b'.repeat(32)}`,
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-7f3a',
  gameId: 'lucky-sevens',
  kind: 'BET',
  money: Money.from('40.00', 'BRL'),
  status: 'PROCESSED',
  failureCode: null,
  observedBalance: Money.from('460.00', 'BRL'),
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  processedAt: AT,
  createdAt: AT,
});

interface Asked {
  readonly ids: string[];
  readonly identities: ProviderTransactionIdentity[];
}

function fakeUnitOfWork(stored: WagerTransaction | null): {
  readonly unitOfWork: UnitOfWork;
  readonly asked: Asked;
} {
  const asked: Asked = { ids: [], identities: [] };
  const unreachable = (port: string) => () => {
    throw new Error(`reading a transaction must not reach the ${port} port`);
  };
  const repositories: Repositories = {
    transactions: {
      findById: (transactionId) => {
        asked.ids.push(transactionId);

        return Promise.resolve(stored);
      },
      findByProviderTransaction: (identity) => {
        asked.identities.push(identity);

        return Promise.resolve(stored);
      },
      insert: unreachable('transaction insert'),
      reserve: unreachable('reservation'),
      recordOutcome: unreachable('outcome update'),
      hasProcessedReversal: unreachable('reversal lookup'),
    },
    wallets: {
      insert: unreachable('wallet insert'),
      findById: unreachable('wallet lookup'),
      lockById: unreachable('wallet lock'),
      update: unreachable('wallet update'),
    },
    ledger: {
      insert: unreachable('ledger insert'),
      findByTransactionId: unreachable('ledger lookup'),
      summarize: unreachable('ledger summary'),
      page: unreachable('ledger page'),
    },
    inbox: {
      claim: unreachable('inbox claim'),
      complete: unreachable('inbox completion'),
      findByIdentity: unreachable('inbox lookup'),
    },
    outbox: {
      insert: unreachable('outbox'),
      findByEventId: unreachable('outbox lookup'),
      claimPending: unreachable('outbox claim'),
      recordAttempt: unreachable('publication attempt'),
    },
    pendingReferences: {
      insert: unreachable('pending reference schedule'),
      claimNextDue: unreachable('pending reference claim'),
      update: unreachable('pending reference reschedule'),
    },
  };

  return {
    unitOfWork: {
      transactional() {
        throw new Error(
          'reading a transaction is a read, so it must not open a writable transaction',
        );
      },
      snapshot: (work) => work(repositories),
    },
    asked,
  };
}

/** The error of a rejection, as the suites assert refusals without `.rejects`. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a rejection');
}

describe('transaction-lookup-routing', () => {
  test('a service id resolves on the transaction row alone', async () => {
    const { unitOfWork, asked } = fakeUnitOfWork(processedBet);

    const transaction = await new GetWagerTransaction(unitOfWork).execute({
      transactionId: TRANSACTION_ID,
    });

    expect(transaction).toBe(processedBet);
    expect(asked.ids).toEqual([TRANSACTION_ID]);
    expect(asked.identities).toEqual([]);
  });

  test('provider ids resolve on the provider identity and never on a service id', async () => {
    const { unitOfWork, asked } = fakeUnitOfWork(processedBet);

    const transaction = await new GetWagerTransaction(unitOfWork).execute({
      providerId: 'provider-acme',
      externalTransactionId: 'acme-tx-000123',
    });

    expect(transaction).toBe(processedBet);
    expect(asked.identities).toEqual([
      { providerId: 'provider-acme', externalTransactionId: 'acme-tx-000123' },
    ]);
    expect(asked.ids).toEqual([]);
  });
});

describe('transaction-lookup-refusals', () => {
  test('an unknown service id is TRANSACTION_NOT_FOUND naming the id', async () => {
    const { unitOfWork } = fakeUnitOfWork(null);

    const refused = await refusal(
      new GetWagerTransaction(unitOfWork).execute({ transactionId: TRANSACTION_ID }),
    );

    expect(refused).toBeInstanceOf(TransactionNotFoundError);
    expect(refused as Error).toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
      message: `No transaction has id ${TRANSACTION_ID}.`,
    });
  });

  test('unknown provider ids are TRANSACTION_NOT_FOUND naming the provider and its id', async () => {
    const { unitOfWork } = fakeUnitOfWork(null);

    const refused = await refusal(
      new GetWagerTransaction(unitOfWork).execute({
        providerId: 'provider-acme',
        externalTransactionId: 'acme-tx-000999',
      }),
    );

    expect(refused).toBeInstanceOf(TransactionNotFoundError);
    expect(refused as Error).toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
      message: 'Provider provider-acme has no transaction acme-tx-000999.',
    });
  });
});
