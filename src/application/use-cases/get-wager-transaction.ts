import type { WagerTransaction } from '../../domain/wager-transaction';
import { TransactionNotFoundError } from '../errors';
import type { WagerTransactionLookup } from '../ports/repositories';
import type { UnitOfWork } from '../ports/unit-of-work';

/**
 * Reads one recorded transaction, by the service id or by the provider identity of `tx.identity`
 * (`api.transaction-read`, `tx.read-shape`). An unknown lookup is `TransactionNotFoundError`, so
 * the absence is decided here rather than by a controller reading a `null`, and both endpoints
 * answer it the same way.
 *
 * The two identities are one use case because they return one read model: a transaction is not a
 * different thing for having been reached by the id its provider minted. What the provider path
 * does not do is accept a service id — the lookup it builds has no place for one — so a provider
 * cannot reach another provider's row, or the service's own `OPENING` credits, by guessing an id.
 *
 * It runs in a read-only snapshot: the `UnitOfWork` is the only way to a repository, the read takes
 * no lock, and the boundary itself is what guarantees that reading a transaction cannot write one
 * (`recon.snapshot` as a property, not as a promise about this code).
 */
export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(lookup: WagerTransactionLookup): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.snapshot(({ transactions }) =>
      'transactionId' in lookup
        ? transactions.findById(lookup.transactionId)
        : transactions.findByProviderTransaction(lookup),
    );

    if (transaction === null) {
      throw new TransactionNotFoundError(lookup);
    }

    return transaction;
  }
}
