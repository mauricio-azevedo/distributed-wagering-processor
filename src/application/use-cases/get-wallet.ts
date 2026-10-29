import type { Wallet } from '../../domain/wallet';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';

/**
 * Reads one wallet (`api.wallet-read`, `wallet.read-shape`). An unknown id is
 * `WalletNotFoundError`, so the absence is decided here rather than by a controller reading a
 * `null`, and the same decision serves every entry point.
 *
 * The read runs inside a transaction because the `UnitOfWork` is the only way to a repository, and
 * that is deliberate: the wallet row is written together with its ledger and its outbox rows, so a
 * read outside a transaction could see the balance of one commit and, in a later slice, the ledger
 * of another. It takes no lock and never blocks an operation on the wallet.
 */
export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.unitOfWork.transactional(({ wallets }) => wallets.findById(walletId));

    if (wallet === null) {
      throw new WalletNotFoundError(walletId);
    }

    return wallet;
  }
}
