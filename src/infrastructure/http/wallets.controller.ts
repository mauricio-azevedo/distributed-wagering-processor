import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';

import { GetWallet } from '../../application/use-cases/get-wallet';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { PageWalletLedger } from '../../application/use-cases/page-wallet-ledger';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet';
import { uuidSchema } from '../transport/contract.dto';
import { CorrelationId } from './correlation-id';
import {
  type LedgerPageQueryParameters,
  type LedgerPageResponse,
  afterWalletVersionOf,
  ledgerPageQuerySchema,
  ledgerPageResponse,
} from './ledger.dto';
import { ZodValidationPipe } from './request-validation';
import {
  type OpenWalletRequest,
  type ReconciliationReportResponse,
  type WalletResponse,
  openWalletRequestSchema,
  reconciliationReportResponse,
  walletResponse,
} from './wallet.dto';

/** The response members this controller sets, named structurally so it imports no HTTP framework. */
interface HeaderWritableResponse {
  setHeader(name: string, value: string): void;
}

/**
 * The wallet endpoints of [docs/openapi.yaml](../../../docs/openapi.yaml): opening, reading and
 * reconciling. The controller translates a request into a command and a result into a response, and
 * decides nothing: the use cases own the outcome and the exception filter owns the problem details
 * (`api.wallet-create`, `api.wallet-read`, `api.reconciliation`).
 */
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly pageWalletLedger: PageWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /**
   * `201` with the wallet and its `Location`. The endpoint carries no idempotency key, so repeating
   * a successful call is the `409` of `wallet.duplicate-is-conflict` and never a replay.
   */
  @Post()
  @HttpCode(201)
  async open(
    @Body(new ZodValidationPipe(openWalletRequestSchema, '/body')) request: OpenWalletRequest,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: HeaderWritableResponse,
  ): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute({ ...request, correlationId });

    response.setHeader('Location', `/wallets/${wallet.id}`);

    return walletResponse(wallet);
  }

  /** `200` with the current wallet, or `404 WALLET_NOT_FOUND` raised by the use case. */
  @Get(':walletId')
  async read(
    @Param('walletId', new ZodValidationPipe(uuidSchema, '/path/walletId')) walletId: string,
  ): Promise<WalletResponse> {
    return walletResponse(await this.getWallet.execute(walletId));
  }

  /**
   * `200` with one page of the wallet's ledger (`api.ledger-read`). The controller decodes the
   * cursor into the position the use case takes and encodes the next one back, which is the whole
   * of its share: the two refusals are different codes — a `limit` outside the contract is the
   * `VALIDATION_FAILED` the pipe reports at `/query/limit`, a cursor the service did not issue is
   * `INVALID_CURSOR` — so the cursor is carried past the schema unparsed and refused by its own
   * decoder.
   */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ZodValidationPipe(uuidSchema, '/path/walletId')) walletId: string,
    @Query(new ZodValidationPipe(ledgerPageQuerySchema, '/query'))
    query: LedgerPageQueryParameters,
  ): Promise<LedgerPageResponse> {
    return ledgerPageResponse(
      await this.pageWalletLedger.execute({
        walletId,
        afterWalletVersion: afterWalletVersionOf(query.cursor),
        limit: query.limit,
      }),
    );
  }

  /**
   * `200` with the report whether or not the wallet is consistent (`api.reconciliation`): a
   * divergence is an answer about the wallet and not a refusal of the request, and a caller that
   * learned of it from a status class would have no report to act on. An unknown id is the `404`
   * the use case raises. The request has no body; `POST` is the method because the reconciliation is
   * a run, with a log record and a counter behind it, rather than a resource to cache.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId', new ZodValidationPipe(uuidSchema, '/path/walletId')) walletId: string,
  ): Promise<ReconciliationReportResponse> {
    return reconciliationReportResponse(await this.reconcileWallet.execute(walletId));
  }
}
