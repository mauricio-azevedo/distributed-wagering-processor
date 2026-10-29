import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import type { ValidationError } from './problem-details';

/**
 * Request validation: the strict-input half of the contract. A body or parameter that violates
 * [docs/openapi.yaml](../../../docs/openapi.yaml) is `400 VALIDATION_FAILED` with one entry per
 * violation, and an unknown member is a violation rather than an ignored extra.
 *
 * The schemas are zod, matching the loader of the environment, and every violation is reported at a
 * JSON Pointer whose first segment names the request part: `/body/...`, `/path/<name>`,
 * `/query/<name>` or `/header/<name>`.
 */
export class RequestValidationError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(
      `The request violates the contract in ${errors.length.toString()} ${errors.length === 1 ? 'place' : 'places'}.`,
    );
    this.name = 'RequestValidationError';
  }
}

/**
 * Parses one part of a request with a schema, reporting every violation at once rather than the
 * first: a provider fixes one payload instead of one member per round trip
 * (`api.problem-details`).
 *
 * `pointer` is the part this pipe validates — `/body` for a body, `/path/walletId` for a path
 * parameter — and a violation inside it appends the member path zod reports.
 */
export class ZodValidationPipe<Schema extends z.ZodType> implements PipeTransform {
  constructor(
    private readonly schema: Schema,
    private readonly pointer: string,
  ) {}

  transform(value: unknown): z.output<Schema> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.flatMap((issue) => violationsOf(issue, this.pointer)),
      );
    }

    return result.data;
  }
}

/**
 * One zod issue as the contract's violations. An unrecognized key reports no path of its own but
 * names the keys, so each one becomes a violation at the member it was sent as; a missing member
 * reports the type it was expected to be, which is not what the caller has to do about it.
 */
function violationsOf(issue: z.core.$ZodIssue, pointer: string): ValidationError[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: pointerTo(pointer, [...issue.path, key]),
      message: 'is not a member of this request',
    }));
  }

  return [
    {
      path: pointerTo(pointer, issue.path),
      message:
        issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message,
    },
  ];
}

function pointerTo(pointer: string, path: readonly PropertyKey[]): string {
  return [pointer, ...path.map(String)].join('/');
}
