import { z } from 'zod';

import type {
  MessageDelivery,
  SubmitWagerTransactionCommand,
} from '../../application/use-cases/submit-wager-transaction';
import { isIdempotencyKey } from '../../domain/idempotency';
import {
  checkWagerOperationRules,
  submittedOperationOf,
  wagerOperationFieldsSchema,
} from '../transport/wager-operation.dto';

/**
 * `WagerTransactionRequested` of [docs/asyncapi.yaml](../../../docs/asyncapi.yaml), as the
 * validation a message passes before the use case sees it (`msg.message-contract`,
 * `model.contract-first`).
 *
 * `data` is the operation of the HTTP body plus `idempotencyKey`, so it is validated by the schema
 * and the rules the HTTP entry point uses, extended by the one member a request carries in a header
 * instead: the two entry points therefore admit exactly the same operations (`msg.same-use-case`),
 * and the key is validated by the same predicate the stored key satisfies (`idem.key-format`).
 *
 * Everything this module refuses is a permanent failure: a body that is not JSON, a body that
 * violates the schema, an unknown `type` and an unsupported `version` cannot become valid by being
 * delivered again (`msg.classification`).
 */

/** `MessageId` and `CorrelationId`: 1 to 128 printable ASCII characters without spaces. */
const MESSAGE_ID = /^[!-~]{1,128}$/;

const messageIdSchema = z.string().regex(MESSAGE_ID, {
  error: 'must be 1 to 128 printable ASCII characters without spaces',
});

/** `idem.key-required` on the queue: the key is a member, because a message has no headers. */
const idempotencyKeySchema = z.string().refine(isIdempotencyKey, {
  error: 'must be 1 to 255 printable ASCII characters without spaces',
});

/**
 * The envelope. `version` is optional and absent means 1 (`msg.message-contract`), so the only
 * value a producer may spell is the one it defaults to; a second version arrives as a second
 * accepted literal, which is what makes an unsupported one a refusal rather than a surprise.
 */
export const wagerTransactionRequestedSchema = z.strictObject({
  messageId: messageIdSchema,
  type: z.literal('WagerTransactionRequested', {
    error: 'must be WagerTransactionRequested',
  }),
  version: z.literal(1, { error: 'must be 1, the one version of this message' }).optional(),
  occurredAt: z.iso.datetime({ offset: true, error: 'must be an RFC 3339 date and time' }),
  correlationId: messageIdSchema.optional(),
  data: wagerOperationFieldsSchema
    .extend({ idempotencyKey: idempotencyKeySchema })
    .check(checkWagerOperationRules),
});

export type WagerTransactionRequested = z.infer<typeof wagerTransactionRequestedSchema>;

/**
 * A message that does not satisfy the contract. The violations are kept out of the message, so a
 * log line about one carries no payload (`obs.no-sensitive-data`); the body itself reaches the
 * operator through the dead-letter queue, where the contract says to look for it.
 */
export class MessageContractError extends Error {
  constructor(readonly violations: string) {
    super('The message does not satisfy WagerTransactionRequested.');
    this.name = 'MessageContractError';
  }
}

/** The message a body is, or `MessageContractError`, which is permanent whatever its cause. */
export function wagerTransactionRequestedOf(body: string | undefined): WagerTransactionRequested {
  const result = wagerTransactionRequestedSchema.safeParse(jsonOf(body));

  if (!result.success) {
    throw new MessageContractError(z.prettifyError(result.error));
  }

  return result.data;
}

/**
 * The command the consumer hands over: the same one the controller builds from a request, with
 * `data.idempotencyKey` where the header was, and the message's correlation id — `messageId` when
 * it carries none, so everything one message produces is searchable by something the producer
 * knows (`msg.correlation`).
 */
export function commandOf(message: WagerTransactionRequested): SubmitWagerTransactionCommand {
  return {
    operation: submittedOperationOf(message.data),
    idempotencyKey: message.data.idempotencyKey,
    correlationId: message.correlationId ?? message.messageId,
  };
}

/**
 * The delivery the message is: the consumer, the body `messageId` and `data` as the content the
 * inbox hash is taken over (`msg.inbox-identity`, `msg.inbox-payload-conflict`). The broker's own
 * message id and receipt handle are not here, because neither is an identity.
 *
 * An absent reference becomes `null`, the same normalization the operation payload makes, so one
 * message has one canonical content whatever a later version of the schema does with the member.
 */
export function deliveryOf(
  message: WagerTransactionRequested,
  consumerName: string,
): MessageDelivery {
  return {
    consumerName,
    messageId: message.messageId,
    content: {
      ...message.data,
      referenceExternalTransactionId: message.data.referenceExternalTransactionId ?? null,
    },
  };
}

function jsonOf(body: string | undefined): unknown {
  if (body === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new MessageContractError(
      `the body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
