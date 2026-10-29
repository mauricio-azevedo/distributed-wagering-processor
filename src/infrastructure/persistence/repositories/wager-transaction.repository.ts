import type { EntityManager, QueryResult } from '@mikro-orm/postgresql';

import { WalletNotFoundError } from '../../../application/errors';
import type {
  ProviderTransactionIdentity,
  Reservation,
  WagerTransactionRepository,
} from '../../../application/ports/repositories';
import type { WagerTransaction } from '../../../domain/wager-transaction';
import {
  WagerTransactionRow,
  toWagerTransaction,
  toWagerTransactionRow,
} from '../mappings/wager-transaction.mapping';

/**
 * The key that makes a submission for an unknown wallet impossible to write. It is named rather
 * than inferred from the exception class, because the table carries a second foreign key, the
 * resolved `reference_transaction_id`, whose violation would mean the service recorded a reference
 * to a transaction it never wrote, which is a defect and not a provider's mistake.
 */
const WALLET_FOREIGN_KEY = 'wager_transactions_wallet_id_foreign';

/** SQLSTATE `foreign_key_violation`, the class a reference to a row that is not there raises. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * `tx.reference-matrix`: the kinds that reverse the transaction they reference, which are the ones
 * the partial unique index of `rule.reference.reversed-once` covers. It is the schema's own
 * vocabulary, spelled where the statement that reads the index lives.
 */
const REVERSAL_KINDS = ['REFUND', 'ROLLBACK'];

/** `WagerTransactionRepository` over the entity manager of one open transaction (ADR 0008). */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    this.em.persist(toWagerTransactionRow(transaction));
    await this.em.flush();
  }

  /**
   * `INSERT ... ON CONFLICT DO NOTHING`, because a plain insert that violates a unique key aborts
   * the whole database transaction: the reservation has to be able to lose and then read, inside
   * the transaction that is about to do the financial work.
   *
   * The conflict target is left open, so either unique key of the submission can be the one that
   * loses, and the row that holds the submitted idempotency key is then read back. One statement
   * asks about both keys: the key holder answers the replay-or-conflict question
   * (`idem.payload-mismatch-conflict`), and its absence is what identifies the provider
   * transaction id as the key that collided (`idem.external-id-bound`). A conflict attributable to
   * neither is a defect rather than a provider error, so it is raised instead of being reported as
   * the conflict that happens to be left.
   */
  async reserve(transaction: WagerTransaction): Promise<Reservation> {
    const reservation = await this.insertIgnoringConflicts(transaction);

    if (reservation.affectedRows === 1) {
      return { reserved: true };
    }

    const holders = await this.em.find(WagerTransactionRow, {
      providerId: transaction.providerId,
      $or: [
        { idempotencyKey: transaction.idempotencyKey },
        { externalTransactionId: transaction.externalTransactionId },
      ],
    });

    const keyHolder = holders.find((row) => row.idempotencyKey === transaction.idempotencyKey);

    if (keyHolder !== undefined) {
      return { reserved: false, keyHolder: toWagerTransaction(keyHolder) };
    }

    if (holders.some((row) => row.externalTransactionId === transaction.externalTransactionId)) {
      return { reserved: false, keyHolder: null };
    }

    throw new Error(
      `reserving transaction ${transaction.id} conflicted with a row holding neither its idempotency key nor its provider transaction id`,
    );
  }

  /**
   * The outcome columns of `tx.row-append-only` and nothing else, written onto the row the
   * reservation claimed. The statement names the columns explicitly instead of flushing a managed
   * entity, because the reservation inserted the row with a query builder and the transition
   * happened on a domain object the entity manager never loaded; naming them is also what keeps the
   * write inside what the append-only trigger of ADR 0003 admits.
   *
   * No row updated means the row this is the outcome of is not there, which cannot happen inside
   * the transaction that reserved it, so it is raised rather than reported.
   */
  async recordOutcome(transaction: WagerTransaction): Promise<void> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionRow)
      .update({
        status: transaction.status,
        failureCode: transaction.failureCode,
        observedBalance: transaction.observedBalance?.toString() ?? null,
        observedBalanceCurrency: transaction.observedBalance?.currency ?? null,
        referenceTransactionId: transaction.referenceTransactionId,
        processedAt: transaction.processedAt,
      })
      .where({ id: transaction.id })
      .execute<QueryResult<WagerTransactionRow>>('run');

    if (result.affectedRows !== 1) {
      throw new Error(
        `recording the ${transaction.status} outcome of transaction ${transaction.id} matched no row`,
      );
    }
  }

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, { id: transactionId });

    return row === null ? null : toWagerTransaction(row);
  }

  /**
   * `rule.reference.resolution`: the unique key of a provider transaction (`tx.identity`), which
   * is the only way a reference names one. The service id is never a lookup key here, so a
   * provider cannot reach a row by guessing one.
   */
  async findByProviderTransaction(
    identity: ProviderTransactionIdentity,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, {
      providerId: identity.providerId,
      externalTransactionId: identity.externalTransactionId,
    });

    return row === null ? null : toWagerTransaction(row);
  }

  /**
   * `rule.reference.reversed-once`, as the question the decision under the lock asks: the predicate
   * of the partial unique index of SCHEMA-015, read instead of waited for. Counting the rows that
   * index admits is what lets the second reversal of a target be recorded as the `REJECTED`
   * outcome the contract promises; letting the index raise the violation would abort the
   * transaction that was about to persist it.
   */
  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionRow, {
      referenceTransactionId: transactionId,
      kind: { $in: REVERSAL_KINDS },
      status: 'PROCESSED',
    });

    return reversals > 0;
  }

  /**
   * The reservation statement, with the one failure that is a provider's mistake rather than a
   * defect: the row refers to its wallet, so a submission for a wallet that does not exist cannot
   * be written at all (`msg.unknown-wallet-permanent`). The foreign key is what detects it, which
   * is also why nothing checks the wallet beforehand — a `SELECT` before the insert would answer
   * for the moment it ran, and the reservation has to stay the first statement of the operation
   * (`conc.lock-order`).
   *
   * Unlike a unique-key conflict, which `ON CONFLICT DO NOTHING` turns into zero rows affected, a
   * foreign-key violation aborts the database transaction. That is exactly right here: the
   * submission has nothing left to do, and the refusal reaches the caller as the `404` of
   * `api.validation-stateless` with nothing persisted.
   */
  private async insertIgnoringConflicts(
    transaction: WagerTransaction,
  ): Promise<QueryResult<WagerTransactionRow>> {
    try {
      return await this.em
        .createQueryBuilder(WagerTransactionRow)
        .insert(toWagerTransactionRow(transaction))
        .onConflict()
        .ignore()
        .execute<QueryResult<WagerTransactionRow>>('run');
    } catch (error) {
      if (isUnknownWalletReference(error)) {
        throw new WalletNotFoundError(transaction.walletId);
      }

      throw error;
    }
  }
}

/**
 * The violation is recognised by SQLSTATE and constraint name rather than by the ORM's exception
 * class: a statement issued through the query builder raises the driver's own error, which the
 * `ExceptionConverter` of a managed flush would have wrapped. Both carry `code` and `constraint`,
 * so reading them covers either path.
 */
function isUnknownWalletReference(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };

  return code === FOREIGN_KEY_VIOLATION && constraint === WALLET_FOREIGN_KEY;
}
