import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';

import { GetWallet } from '../../application/use-cases/get-wallet';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { CorrelationId } from './correlation-id';
import { ZodValidationPipe } from './request-validation';
import {
  type OpenWalletRequest,
  type WalletResponse,
  openWalletRequestSchema,
  uuidSchema,
  walletResponse,
} from './wallet.dto';

/** The response members this controller sets, named structurally so it imports no HTTP framework. */
interface HeaderWritableResponse {
  setHeader(name: string, value: string): void;
}

/**
 * The wallet endpoints of [docs/openapi.yaml](../../../docs/openapi.yaml): opening and reading.
 * The controller translates a request into a command and a result into a response, and decides
 * nothing: the use cases own the outcome and the exception filter owns the problem details
 * (`api.wallet-create`, `api.wallet-read`).
 */
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
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
}
