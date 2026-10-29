import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';

import { ApplicationError } from '../../application/errors';
import { correlationIdFor } from './correlation-id';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails, problemDetails } from './problem-details';
import { RequestValidationError } from './request-validation';

/**
 * The response members this filter uses, named structurally so the adapter imports no HTTP
 * framework. `ServerResponse` covers what `correlationIdFor` writes; `status` and `json` are the
 * platform's own.
 */
type ProblemResponse = ServerResponse & {
  status(code: number): ProblemResponse;
  json(body: unknown): void;
};

/**
 * Turns the refusals of a request into RFC 9457 problem details (`api.problem-details`): the
 * violations a pipe reported, the conflicts and absences a use case raised, and the body the
 * framework could not parse.
 *
 * Nothing else is caught. An error this filter does not recognise is not a refusal of the request
 * but a defect or an unavailable dependency, and answering it as a problem would claim a status
 * class the contract reserves for something else; it reaches the framework's own handler instead,
 * until the transient classification of API-006 gives it `503 SERVICE_UNAVAILABLE`.
 */
@Catch(ApplicationError, RequestValidationError, BadRequestException)
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<ProblemResponse>();
    const problem = problemOf(exception, correlationIdFor(http.getRequest(), response));

    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    response.status(problem.status).json(problem);
  }
}

function problemOf(exception: unknown, correlationId: string): ProblemDetails {
  if (exception instanceof ApplicationError) {
    return problemDetails({ code: exception.code, detail: exception.message, correlationId });
  }

  if (exception instanceof RequestValidationError) {
    return problemDetails({
      code: 'VALIDATION_FAILED',
      detail: exception.message,
      correlationId,
      errors: exception.errors,
    });
  }

  /*
   * The body parser refused the payload before any schema saw it, so there is no member to name:
   * the request part itself is the violation. Express reports a malformed JSON body this way, and
   * the contract answers it as a malformed body like any other (`api.status-classes`).
   */
  return problemDetails({
    code: 'VALIDATION_FAILED',
    detail: 'The request violates the contract in 1 place.',
    correlationId,
    errors: [{ path: '/body', message: 'must be a JSON object matching the request schema' }],
  });
}
