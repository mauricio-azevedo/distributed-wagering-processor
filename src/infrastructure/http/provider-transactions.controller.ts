import { Controller, Get, Param } from '@nestjs/common';

import { GetWagerTransaction } from '../../application/use-cases/get-wager-transaction';
import { externalIdSchema } from '../transport/contract.dto';
import { ZodValidationPipe } from './request-validation';
import { type WagerTransactionResponse, wagerTransactionResponse } from './wager-transaction.dto';

/**
 * `GET /providers/{providerId}/wagering/transactions/{externalTransactionId}` of
 * [docs/openapi.yaml](../../../docs/openapi.yaml): a transaction read by the identity its provider
 * minted (`tx.identity`, `api.transaction-read`).
 *
 * It is a controller of its own because the route is rooted at the provider and not at the
 * service's transactions, and the same read model answers both paths. Unlike a submission, the
 * provider id is not refused for being `system`: the reserved provider is the one that owns the
 * internal `OPENING` credits, whose `externalTransactionId` is the wallet id, and reading them is
 * the point of accepting it here (`tx.opening-internal`).
 */
@Controller('providers')
export class ProviderTransactionsController {
  constructor(private readonly getWagerTransaction: GetWagerTransaction) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async read(
    @Param('providerId', new ZodValidationPipe(externalIdSchema, '/path/providerId'))
    providerId: string,
    @Param(
      'externalTransactionId',
      new ZodValidationPipe(externalIdSchema, '/path/externalTransactionId'),
    )
    externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    return wagerTransactionResponse(
      await this.getWagerTransaction.execute({ providerId, externalTransactionId }),
    );
  }
}
