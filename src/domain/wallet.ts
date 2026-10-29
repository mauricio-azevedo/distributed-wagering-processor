import type { FailureCode } from './failure-code';
import { Money } from './money';
import {
  type CreditOperation,
  type DebitOperation,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

/** A wallet as the database holds it (`wallet.read-shape`). The currency is `balance.currency`. */
export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `wallet.opening-credit`: the initial balance, with the ids of the transaction that records it. */
export interface OpeningCredit {
  readonly transactionId: string;
  readonly entryId: string;
  readonly money: Money;
}

/** `openingCredit` is `null` for an initial balance of `0.00` (`wallet.zero-opening`). */
export interface NewWallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly openedAt: Date;
  readonly openingCredit: OpeningCredit | null;
}

/** A wallet and the `OPENING` entry it was opened with, absent when it opened at `0.00`. */
export interface OpenedWallet {
  readonly wallet: Wallet;
  readonly openingEntry: WalletLedgerEntry | null;
}

/**
 * An operation that moves no money, which is a `LOSS` (`tx.affects-balance`): it names the owner it
 * claims to act on and the amount it reports, and nothing else, because it produces neither a
 * balance nor an entry for an id or a moment to belong to.
 */
export interface WalletUnmovedOperation {
  readonly playerId: string;
  readonly money: Money;
}

/** What an operation asks a wallet to apply. `playerId` is the owner it claims to act on. */
interface WalletOperationRequest extends WalletUnmovedOperation {
  readonly transactionId: string;
  readonly entryId: string;
  readonly occurredAt: Date;
}

export interface WalletDebit extends WalletOperationRequest {
  readonly operation: DebitOperation;
}

export interface WalletCredit extends WalletOperationRequest {
  readonly operation: CreditOperation;
}

/** The failure codes the aggregate decides on its own, before any reference or reservation. */
export type WalletRefusalCode = Extract<
  FailureCode,
  | 'INSUFFICIENT_BALANCE'
  | 'REVERSAL_INSUFFICIENT_BALANCE'
  | 'BALANCE_LIMIT_EXCEEDED'
  | 'CURRENCY_MISMATCH'
  | 'WALLET_PLAYER_MISMATCH'
>;

/**
 * What an operation produced: the new wallet state with the entry that mirrors it
 * (`wallet.ledger-mirror`), or the refusal the caller persists as a `REJECTED` transaction. A
 * refusal carries no wallet because the one the caller holds is still current.
 */
export type WalletOperationOutcome =
  | { readonly applied: true; readonly wallet: Wallet; readonly entry: WalletLedgerEntry }
  | { readonly applied: false; readonly failureCode: WalletRefusalCode };

/**
 * The aggregate root: one wallet per player and currency, the only holder of a balance and the
 * unit of concurrency (ADR 0002).
 *
 * A refusal a provider can cause is a returned outcome, not an exception: the contract persists it
 * as a `REJECTED` transaction with its failure code and replays it forever
 * (`wallet.balance-limit`, `rule.rejected.no-effect`, `idem.replay-follows-persisted-outcome`), so
 * the aggregate answers with the code and the use case records it. Exceptions stay for what no
 * provider can cause: a currency that cannot be compared, an entry that does not balance.
 *
 * Operations return a new instance instead of mutating this one (ADR 0006). The balance and its
 * entry are therefore produced together or not at all, and the version each belongs to cannot
 * drift: there is no state in which the balance moved and the entry was refused.
 */
export class Wallet implements WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.balance = state.balance;
    this.version = state.version;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
    Object.freeze(this);
  }

  /**
   * Opens a wallet at `version` 1, whether or not it received an opening credit
   * (`wallet.version-starts-at-one`). A positive `openingCredit` becomes the balance and its
   * `OPENING` entry at `walletVersion` 1, both of which the use case commits with the wallet row
   * (`wallet.opening-credit`); `null` opens the wallet alone at `0.00` (`wallet.zero-opening`).
   * An amount of `0.00` is not an opening credit and is refused as an entry without a movement.
   */
  static open(wallet: NewWallet): OpenedWallet {
    const zero = Money.zero(wallet.currency);

    if (wallet.openingCredit === null) {
      return {
        wallet: new Wallet({
          id: wallet.id,
          playerId: wallet.playerId,
          balance: zero,
          version: 1,
          createdAt: wallet.openedAt,
          updatedAt: wallet.openedAt,
        }),
        openingEntry: null,
      };
    }

    const balance = zero.add(wallet.openingCredit.money);
    const openingEntry = WalletLedgerEntry.create({
      id: wallet.openingCredit.entryId,
      walletId: wallet.id,
      transactionId: wallet.openingCredit.transactionId,
      operation: { kind: 'OPENING' },
      money: wallet.openingCredit.money,
      balanceBefore: zero,
      balanceAfter: balance,
      walletVersion: 1,
      createdAt: wallet.openedAt,
    });

    return {
      wallet: new Wallet({
        id: wallet.id,
        playerId: wallet.playerId,
        balance,
        version: 1,
        createdAt: wallet.openedAt,
        updatedAt: wallet.openedAt,
      }),
      openingEntry,
    };
  }

  /** `model.rehydrate-no-revalidation`: rebuilds a stored wallet, trusting the database. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get currency(): string {
    return this.balance.currency;
  }

  /**
   * Removes money. Refused when the operation names another owner (`wallet.owner-match`), carries
   * another currency (`wallet.currency-match`) or asks for more than the balance covers
   * (`wallet.non-negative`); a reversal that the balance cannot absorb carries its own code
   * (`rule.reversal.insufficient-balance`).
   */
  debit(debit: WalletDebit): WalletOperationOutcome {
    const refusal = this.refuseForeign(debit);

    if (refusal !== null) {
      return refusal;
    }

    if (this.balance.isLessThan(debit.money)) {
      return {
        applied: false,
        failureCode:
          debit.operation.kind === 'ROLLBACK'
            ? 'REVERSAL_INSUFFICIENT_BALANCE'
            : 'INSUFFICIENT_BALANCE',
      };
    }

    return this.apply(debit, this.balance.subtract(debit.money));
  }

  /**
   * Adds money. Refused when the operation names another owner (`wallet.owner-match`), carries
   * another currency (`wallet.currency-match`) or would take the balance past the largest amount
   * the service stores (`wallet.balance-limit`). The headroom is measured against `money.bound`,
   * so the bound is a persisted rejection and never a numeric overflow.
   */
  credit(credit: WalletCredit): WalletOperationOutcome {
    const refusal = this.refuseForeign(credit);

    if (refusal !== null) {
      return refusal;
    }

    if (Money.bound(this.currency).subtract(this.balance).isLessThan(credit.money)) {
      return { applied: false, failureCode: 'BALANCE_LIMIT_EXCEEDED' };
    }

    return this.apply(credit, this.balance.add(credit.money));
  }

  /**
   * `rule.loss.no-effect`: what an operation that moves no money is answered with. A `LOSS` is
   * still an operation on this wallet, so the refusals that do not depend on a movement apply to it
   * (`wallet.owner-match`, `wallet.currency-match`); its amount is never compared, which is why
   * `0.00` and an amount larger than the balance are both accepted
   * (`money.positive-in-operations`).
   *
   * It answers with a code or with `null` rather than with a `WalletOperationOutcome`, because
   * there is no outcome to carry: no balance was produced and no entry exists
   * (`ledger.no-entry-without-effect`). The wallet this was asked of stays current either way, so
   * the caller records the transaction against the balance it already holds.
   */
  refuseUnmoved(operation: WalletUnmovedOperation): WalletRefusalCode | null {
    return this.refuseForeign(operation)?.failureCode ?? null;
  }

  /**
   * The refusals that depend on neither direction nor amount, checked first so that an operation
   * aimed at the wrong wallet is never answered with a reason about its amount.
   */
  private refuseForeign(
    request: WalletUnmovedOperation,
  ): { applied: false; failureCode: WalletRefusalCode } | null {
    if (request.playerId !== this.playerId) {
      return { applied: false, failureCode: 'WALLET_PLAYER_MISMATCH' };
    }

    if (request.money.currency !== this.currency) {
      return { applied: false, failureCode: 'CURRENCY_MISMATCH' };
    }

    return null;
  }

  /**
   * One balance change: the next version, the new balance and the single entry that mirrors it
   * (`wallet.version-increments-on-balance-change`, `wallet.ledger-mirror`).
   */
  private apply(request: WalletDebit | WalletCredit, balanceAfter: Money): WalletOperationOutcome {
    const version = this.version + 1;
    const entry = WalletLedgerEntry.create({
      id: request.entryId,
      walletId: this.id,
      transactionId: request.transactionId,
      operation: request.operation,
      money: request.money,
      balanceBefore: this.balance,
      balanceAfter,
      walletVersion: version,
      createdAt: request.occurredAt,
    });

    return {
      applied: true,
      wallet: new Wallet({
        id: this.id,
        playerId: this.playerId,
        balance: balanceAfter,
        version,
        createdAt: this.createdAt,
        updatedAt: request.occurredAt,
      }),
      entry,
    };
  }
}
