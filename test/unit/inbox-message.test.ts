import { describe, expect, test } from 'bun:test';

import { InvalidMessageStateError } from '../../src/domain/errors';
import { InboxMessage } from '../../src/domain/inbox-message';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MESSAGE_ID = 'acme-msg-000123';
const PAYLOAD_HASH = `sha256:${'a1b2c3d4'.repeat(8)}`;
const RECEIVED_AT = new Date('2026-10-28T12:00:00.000Z');
const PROCESSED_AT = new Date('2026-10-28T12:00:00.250Z');

const received = (): InboxMessage =>
  InboxMessage.receive({
    consumerName: CONSUMER_NAME,
    messageId: MESSAGE_ID,
    payloadHash: PAYLOAD_HASH,
    receivedAt: RECEIVED_AT,
  });

describe('domain-factories-are-the-only-entry', () => {
  test('the InboxMessage constructor is not reachable', () => {
    const construct = (): void => {
      // @ts-expect-error - the constructor is private (`model.private-constructors`).
      new InboxMessage();
    };

    expect(construct).toThrow(TypeError);
  });

  test('receive returns a row that identifies the message and is not yet processed', () => {
    const message = received();

    expect(message).toBeInstanceOf(InboxMessage);
    expect(message.consumerName).toBe(CONSUMER_NAME);
    expect(message.messageId).toBe(MESSAGE_ID);
    expect(message.payloadHash).toBe(PAYLOAD_HASH);
    expect(message.receivedAt).toEqual(RECEIVED_AT);
    expect(message.processedAt).toBeNull();
    expect(message.isProcessed()).toBe(false);
  });

  test('the identity is the body message id, so a producer resend is the same row', () => {
    const resend = InboxMessage.receive({
      consumerName: CONSUMER_NAME,
      messageId: MESSAGE_ID,
      payloadHash: PAYLOAD_HASH,
      receivedAt: new Date('2026-10-28T12:05:00.000Z'),
    });

    expect([resend.consumerName, resend.messageId]).toEqual([CONSUMER_NAME, MESSAGE_ID]);
    expect(resend.receivedAt).not.toEqual(received().receivedAt);
  });
});

describe('rehydrate-trusts-stored-state', () => {
  test('a processed row is rebuilt as the database holds it', () => {
    const stored = InboxMessage.rehydrate({
      consumerName: CONSUMER_NAME,
      messageId: MESSAGE_ID,
      payloadHash: PAYLOAD_HASH,
      receivedAt: RECEIVED_AT,
      processedAt: PROCESSED_AT,
    });

    expect(stored.processedAt).toEqual(PROCESSED_AT);
    expect(stored.isProcessed()).toBe(true);
  });

  test('a row still in flight is rebuilt unprocessed and completes from there', () => {
    const stored = InboxMessage.rehydrate({
      consumerName: CONSUMER_NAME,
      messageId: MESSAGE_ID,
      payloadHash: PAYLOAD_HASH,
      receivedAt: RECEIVED_AT,
      processedAt: null,
    });

    stored.markProcessed(PROCESSED_AT);

    expect(stored.processedAt).toEqual(PROCESSED_AT);
  });
});

/**
 * `msg.inbox-payload-conflict`: a message id that arrives again either carries what it carried the
 * first time, and is a redelivery, or it does not, and the delivery is refused (ADR 0010).
 */
describe('delivery-identity-compares-content', () => {
  test('the same content under one identity is a redelivery', () => {
    expect(received().matchesPayload(PAYLOAD_HASH)).toBe(true);
  });

  test('another hash under one identity is not the same delivery', () => {
    expect(received().matchesPayload(`sha256:${'f'.repeat(64)}`)).toBe(false);
  });
});

describe('inbox-completion-is-explicit', () => {
  test('a completed row exposes its completion, so a redelivery can be absorbed', () => {
    const message = received();

    message.markProcessed(PROCESSED_AT);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });

  test('completing a completed row is a programming error and changes nothing', () => {
    const message = received();
    message.markProcessed(PROCESSED_AT);

    const completeAgain = (): void => {
      message.markProcessed(new Date('2026-10-28T13:00:00.000Z'));
    };

    expect(completeAgain).toThrow(InvalidMessageStateError);
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });

  test('markProcessed is the only member that changes a row', () => {
    const message = received();
    const assignProcessedAt = (): void => {
      // @ts-expect-error - completion happens through markProcessed (`model.explicit-transitions`).
      message.processedAt = PROCESSED_AT;
    };
    const surface = Object.getOwnPropertyNames(InboxMessage.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(assignProcessedAt).toThrow(TypeError);
    expect(message.processedAt).toBeNull();
    expect(surface.toSorted()).toEqual([
      'isProcessed',
      'markProcessed',
      'matchesPayload',
      'processedAt',
    ]);
  });
});
