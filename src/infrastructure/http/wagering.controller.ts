import { Body, Controller, Post, Res } from '@nestjs/common';

import { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import { submittedOperationOf } from '../transport/wager-operation.dto';
import { CorrelationId } from './correlation-id';
import { ZodValidationPipe } from './request-validation';
import {
  IdempotencyKey,
  type SubmitWagerTransactionRequest,
  statusOfOutcome,
  submitWagerTransactionRequestSchema,
  transactionOutcomeResponse,
} from './wager-transaction.dto';

/**
 * The response members this controller writes, named structurally so it imports no HTTP framework,
 * the same way the problem details filter names the ones it writes.
 */
interface OutcomeResponse {
  status(code: number): OutcomeResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * The submission endpoint of [docs/openapi.yaml](../../../docs/openapi.yaml). The controller
 * translates a request into a command and a recorded outcome into a response, and decides nothing:
 * the use case owns the outcome, the DTO owns what a request has to look like and which status each
 * outcome answers with, and the exception filter owns the problem details.
 *
 * It writes the response itself rather than returning a body, because the status is the outcome's:
 * one body serves `200`, `202`, `422` and `500` (`api.outcome-shape`) and which one it is depends on
 * the status the operation recorded or replayed (`idem.replay-follows-persisted-outcome`), while a
 * returned body would be sent with the one status the route declares. The same path serves a first
 * arrival and a replay, so a duplicate cannot take a route of its own.
 */
@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly submitWagerTransaction: SubmitWagerTransaction) {}

  @Post()
  async submit(
    @Body(new ZodValidationPipe(submitWagerTransactionRequestSchema, '/body'))
    request: SubmitWagerTransactionRequest,
    @IdempotencyKey() idempotencyKey: string,
    @CorrelationId() correlationId: string,
    @Res() response: OutcomeResponse,
  ): Promise<void> {
    const outcome = await this.submitWagerTransaction.execute({
      operation: submittedOperationOf(request),
      idempotencyKey,
      correlationId,
    });

    // `api.location-on-pending`: a parked transaction is answered with where to read it. Only a
    // submission whose reference has not resolved parks (`rule.reference.missing-is-pending`); a
    // `BET` carries none and never does.
    if (outcome.transaction.status === 'PENDING_REFERENCE') {
      response.setHeader('Location', `/wagering/transactions/${outcome.transaction.id}`);
    }

    response.status(statusOfOutcome(outcome.transaction)).json(transactionOutcomeResponse(outcome));
  }
}
