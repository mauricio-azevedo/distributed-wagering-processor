import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';

import { ApplicationError, ServiceUnavailableError } from '../../application/errors';
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
 * but a defect, and answering it as a problem would claim a status class the contract reserves for
 * something else; it reaches the framework's own handler as a `500` instead. An unavailable
 * dependency is not in that set: the unit of work classifies it as `ServiceUnavailableError`, which
 * arrives here as the `503` of `api.transient-failure` like any other refusal a use case raises.
 */
@Catch(ApplicationError, RequestValidationError, BadRequestException)
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<ProblemResponse>();
    const problem = problemOf(exception, correlationIdFor(http.getRequest(), response));

    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);

    /*
     * `api.retry-after`: a transient refusal says when to resend, and it is the only problem that
     * carries the header — the readiness `503` is a health signal and carries none. The seconds come
     * from the error, because what the caller should wait for is a property of the failure and not
     * of the endpoint that reported it.
     */
    if (exception instanceof ServiceUnavailableError) {
      response.setHeader('Retry-After', exception.retryAfterSeconds.toString());
    }

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
