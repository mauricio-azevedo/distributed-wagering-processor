import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
  transactionIdentity,
} from '../../domain/integration-events';
import type { Sha256Hex } from '../../domain/idempotency';
import { Money, type MoneyProps } from '../../domain/money';
import { openingCreditSubmission } from '../../domain/opening-credit';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

/** `api.wallet-create`: the owner, the amount it opens with and the correlation id of the request. */
export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

export interface OpenWalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sha256Hex: Sha256Hex;
}

/**
 * Opens the wallet of a player in the currency of its initial balance, with the opening credit when
 * that balance is positive (`wallet.opening-credit`) and alone when it is `0.00`
 * (`wallet.zero-opening`). Either way the wallet starts at version 1
 * (`wallet.version-starts-at-one`).
 *
 * Everything one opening writes commits together or not at all (`outbox.single-transaction`): the
 * wallet row, the internal `OPENING` transaction already `PROCESSED`, the `CREDIT` entry that
 * mirrors the balance and the two outbox rows that announce it. The aggregate decides the state
 * first and the transaction only records it, so there is no window in which a balance exists
 * without the entry that explains it — the deferred triggers of ADR 0003 would refuse that commit
 * anyway, whatever issued the write.
 *
 * A duplicate is not checked for: the unique key on `(player_id, currency)` is what decides it, so
 * the answer is the same whether the duplicate arrives a day later or from another instance at the
 * same moment (`wallet.duplicate-is-conflict`, WALLET-001). The wallet port raises
 * `WalletAlreadyExistsError` and the transaction rolls back, leaving the existing wallet untouched.
 *
 * This endpoint carries no idempotency key, so the opening credit reserves nothing: it is the
 * service's own submission, its key is derived from the wallet id it just minted
 * (`idem.recommended-default`), and a repeat of the call is the `409` above rather than a replay.
 */
export class OpenWallet {
  constructor(private readonly dependencies: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const openedAt = this.dependencies.clock.now();
    const money = Money.from(command.initialBalance.amount, command.initialBalance.currency);
    const walletId = this.dependencies.ids.next();

    // `0.00` is an initial balance and not a credit (`money.zero-only-initial-balance`): a ledger
    // entry records a movement, so there is none to write and no transaction to record it.
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      currency: money.currency,
      openedAt,
      openingCredit: money.isPositive()
        ? {
            transactionId: this.dependencies.ids.next(),
            entryId: this.dependencies.ids.next(),
            money,
          }
        : null,
    });

    return this.dependencies.unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insert(wallet);

      if (openingEntry !== null) {
        await this.recordOpeningCredit(repositories, wallet, openingEntry, command.correlationId);
      }

      return wallet;
    });
  }

  /**
   * The credit as an auditable transaction: the row a provider would have submitted, born
   * `PROCESSED` with the balance it produced as its observed balance (`tx.observed-balance`), its
   * single `CREDIT` entry, and the two events every processed balance change emits
   * (`event.processed-when`, `event.balance-changed-when`).
   *
   * The wallet row is written first because the entry's currency is tied to it by a composite
   * foreign key and the transaction row refers to it (ADR 0003).
   */
  private async recordOpeningCredit(
    repositories: Repositories,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    correlationId: string,
  ): Promise<void> {
    const transaction = WagerTransaction.create(
      openingCreditSubmission(
        {
          transactionId: entry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: entry.money,
          openedAt: wallet.createdAt,
        },
        this.dependencies.sha256Hex,
      ),
    );
    transaction.markProcessed({
      observedBalance: entry.balanceAfter,
      processedAt: wallet.createdAt,
    });

    await repositories.transactions.insert(transaction);
    await repositories.ledger.insert(entry);

    const identity = transactionIdentity(transaction);
    const events = [
      WagerTransactionProcessed.record({
        eventId: this.dependencies.ids.next(),
        correlationId,
        occurredAt: wallet.createdAt,
        identity,
        balanceAfter: wallet.balance,
        walletVersion: wallet.version,
        processedAt: wallet.createdAt,
        reference: null,
      }),
      WalletBalanceChanged.record({
        eventId: this.dependencies.ids.next(),
        correlationId,
        occurredAt: wallet.createdAt,
        entry,
      }),
    ];

    for (const event of events) {
      await repositories.outbox.insert(OutboxMessage.enqueue(event));
    }
  }
}
