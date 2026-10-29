/**
 * The eight demonstrations of [docs/demonstrations.md](../docs/demonstrations.md), run end to end
 * against the stack `make up` started: the deployed `api` instance over HTTP, the two `worker`
 * instances over `wager-transactions.fifo`, and the events they publish on
 * `wager-integration-events.fifo`.
 *
 * Usage: `make demo`, which starts the stack first. It is the one place in this repository that
 * drives the containers a reviewer runs rather than an application a suite boots, which is what it
 * is for: the suites prove each guarantee in isolation, and this shows the same guarantees holding
 * in the topology of `compose.yaml`.
 *
 * What it is not is a second test suite. Every assertion here is also an acceptance entry proven by
 * `make check` (docs/acceptance.yaml names the suite per entry); this walks the same ground in one
 * pass so the claims of the documentation can be watched happening. It asserts anyway, because a
 * demonstration that printed a wrong answer without saying so would be worse than none.
 *
 * It writes to the stack's database and queues and cleans nothing up: every wallet, transaction and
 * provider id it uses is minted for the run, so a second run shares nothing with the first and
 * `make down` discards all of it.
 */
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import type { IntegrationEventEnvelope } from '../src/domain/integration-events';
import { Money, type MoneyProps } from '../src/domain/money';
import { loadEnv } from '../src/infrastructure/config/env';
import type { LedgerEntryResponse } from '../src/infrastructure/http/ledger.dto';
import { queueUrlResolver, wagerQueues } from '../src/infrastructure/messaging/sqs';
import type { WagerOperationFields } from '../src/infrastructure/transport/wager-operation.dto';

const env = loadEnv(process.env);
const baseUrl = `http://localhost:${String(env.HTTP_PORT)}`;
const sqs = new SQSClient({
  region: env.AWS_REGION,
  ...(env.SQS_ENDPOINT !== undefined && { endpoint: env.SQS_ENDPOINT }),
});
const queues = wagerQueues(env.SQS_QUEUE_PREFIX);
const transactionsQueueUrl = queueUrlResolver(sqs, queues.input);
const eventsQueueUrl = queueUrlResolver(sqs, queues.events);

/**
 * One token per run, in the provider id and in every message id the walkthrough sends. Nothing it
 * writes may be shared with an earlier run, and a fixed id would be shared twice over: the
 * idempotency key of an operation, and — worse — the `(consumerName, messageId)` of a delivery,
 * which a second run would reuse with other content and have dead-lettered as a reused message id
 * (`msg.inbox-payload-conflict`). The deduplication ids follow the message ids, so a second run
 * started inside the broker's five-minute window is not silently swallowed either.
 */
const run = Bun.randomUUIDv7().slice(-12);
const providerId = `demo-${run}`;
const playerId = crypto.randomUUID();

/**
 * How long a demonstration waits for work the `worker` instances do on their own. It is generous
 * because a worker is in a 20-second long poll (`SQS_WAIT_TIME_SECONDS`) when a message arrives,
 * and LocalStack answers that poll on its own schedule rather than on the arrival: the wait is a
 * property of the broker, not of the service.
 */
const PATIENCE_MS = 120_000;
const POLL_MS = 250;

interface Answer {
  readonly status: number;
  readonly location: string | null;
  readonly body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  { body, idempotencyKey }: { body?: unknown; idempotencyKey?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(idempotencyKey !== undefined && { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }).catch(() => giveUp(`${baseUrl} did not answer`, 'make logs SERVICES=api'));
  const text = await response.text();

  return {
    status: response.status,
    location: response.headers.get('location'),
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The operation both entry points take, built once so the HTTP body and the message `data` agree. */
function operation(
  externalTransactionId: string,
  kind: WagerOperationFields['kind'],
  amount: string,
  reference?: string,
): WagerOperationFields {
  return {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'demo-round',
    gameId: 'demo-game',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference !== undefined && { referenceExternalTransactionId: reference }),
  };
}

function keyOf(fields: WagerOperationFields): string {
  return `${fields.providerId}:${fields.externalTransactionId}`;
}

function submit(fields: WagerOperationFields): Promise<Answer> {
  return call('POST', '/wagering/transactions', { body: fields, idempotencyKey: keyOf(fields) });
}

/**
 * Sends one `WagerTransactionRequested`. `messageId` is the inbox identity, assigned by the
 * producer and kept on a resend (`msg.inbox-identity`); `deduplicationId` is the broker's and
 * defaults to it, so a resend that passes a fresh one is a redelivery the broker will not filter —
 * which is the only way to watch the inbox do the absorbing instead of SQS's five-minute window.
 * `group` is the ordering unit: the wallet when a wallet's operations have to stay ordered, the
 * operation itself when they are independent, since a FIFO group admits one message in flight.
 */
async function enqueue(
  fields: WagerOperationFields,
  messageId: string,
  { group = fields.walletId, deduplicationId = messageId } = {},
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await transactionsQueueUrl(),
      MessageGroupId: group,
      MessageDeduplicationId: deduplicationId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        correlationId: `demo-${messageId}`,
        data: { ...fields, idempotencyKey: keyOf(fields) },
      }),
    }),
  );
}

/** Waits until the input queue holds nothing, available or in flight, so nothing is still pending. */
async function queueDrained(): Promise<void> {
  const queueUrl = await transactionsQueueUrl();

  await until('the input queue to be empty', async () => {
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    const waiting = Object.values(Attributes).reduce((sum, count) => sum + Number(count), 0);

    return waiting === 0 ? true : null;
  });
}

/**
 * The walkthrough is the only consumer of `wager-integration-events.fifo` in the stack, so it
 * receives and deletes like one: the events of this run's wallet are kept, and the rest are
 * discarded rather than left to grow for the next run.
 */
const publishedForThisWallet: IntegrationEventEnvelope[] = [];

async function takeEvents(): Promise<void> {
  const queueUrl = await eventsQueueUrl();

  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }),
    );
    if (Messages.length === 0) {
      return;
    }

    for (const { Body = '{}' } of Messages) {
      const envelope = JSON.parse(Body) as IntegrationEventEnvelope;
      if (envelope.aggregateId === walletId) {
        publishedForThisWallet.push(envelope);
      }
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Messages.map(({ MessageId, ReceiptHandle }) => ({
          Id: MessageId ?? '',
          ReceiptHandle: ReceiptHandle ?? '',
        })),
      }),
    );
  }
}

/** Waits for work an instance does on its own, so nothing here depends on a sleep being long enough. */
async function until<T>(what: string, answer: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + PATIENCE_MS;

  for (;;) {
    const found = await answer();
    if (found !== null) {
      return found;
    }
    if (Date.now() > deadline) {
      giveUp(
        `gave up waiting for ${what} after ${(PATIENCE_MS / 1000).toString()}s`,
        'make logs SERVICES=worker',
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

/**
 * The one way this walkthrough ends early: what it was waiting for, and the command that shows why
 * it never came. Everything it waits for is work an instance does on its own, so the answer is
 * always in that instance's log.
 */
function giveUp(reason: string, next: string): never {
  console.log(`  ✗ ${reason}`);
  console.log(`Next: ${next}`);
  sqs.destroy();
  process.exit(1);
}

let failures = 0;

function shows(claim: string, actual: unknown, expected: unknown): void {
  const got = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);

  if (got === wanted) {
    console.log(`  ✓ ${claim}: ${got}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${claim}: expected ${wanted}, got ${got}`);
  }
}

/**
 * The answer as it came back. The refusals are what a reviewer came to read, so they are printed
 * whole rather than described: a status and the body the service sent under it.
 */
function answers({ status, body }: Answer): void {
  console.log(`  ${String(status)} ${JSON.stringify(body)}`);
}

function heading(number: number, title: string): void {
  console.log(`\n${String(number)}. ${title}`);
}

// ----------------------------------------------------------------- 1. HTTP submission

heading(1, 'HTTP submission — a wallet, a bet, and the ledger entry that explains the balance');

const opened = await call('POST', '/wallets', {
  body: { playerId, initialBalance: { amount: '500.00', currency: 'BRL' } },
});
const walletId = String(opened.body['id']);

shows('the wallet is created', opened.status, 201);
shows('Location names it', opened.location, `/wallets/${walletId}`);
shows('it opens at version 1 with its opening credit', opened.body['version'], 1);

const bet = operation('demo-bet-1', 'BET', '40.00');
const applied = await submit(bet);

shows('the bet is applied', [applied.status, applied.body['status']], [200, 'PROCESSED']);
shows('the balance it observed', applied.body['balance'], { amount: '460.00', currency: 'BRL' });
shows('it is not a replay', applied.body['idempotentReplay'], false);

const ledger = await call('GET', `/wallets/${walletId}/ledger?limit=10`);
const entries = ledger.body['items'] as { kind: string; walletVersion: number }[];

shows(
  'the ledger is the opening credit and the debit, in wallet version order',
  entries.map(({ kind, walletVersion }) => `${kind}@${String(walletVersion)}`),
  ['OPENING@1', 'BET@2'],
);
shows('the page is the last one', ledger.body['nextCursor'], null);

// ----------------------------------------------------------------- 2. Replay

heading(2, 'Replay — the same operation again, and the same key with another payload');

const replayed = await submit(bet);

shows(
  'the stored outcome comes back',
  [replayed.status, replayed.body['status']],
  [200, 'PROCESSED'],
);
shows('marked as a replay', replayed.body['idempotentReplay'], true);
shows(
  'with the transaction that applied',
  replayed.body['transactionId'],
  applied.body['transactionId'],
);
shows('and the balance that outcome observed', replayed.body['balance'], applied.body['balance']);

const mismatch = await call('POST', '/wagering/transactions', {
  body: { ...bet, money: { amount: '41.00', currency: 'BRL' } },
  idempotencyKey: keyOf(bet),
});

answers(mismatch);
shows('the key with another payload is a conflict', mismatch.status, 409);
shows('with its own code', mismatch.body['code'], 'IDEMPOTENCY_PAYLOAD_MISMATCH');

// ----------------------------------------------------------------- 3. Rejection

heading(3, 'Rejection — a refusal the wallet decides is persisted, not an error');

const rejected = await submit(operation('demo-bet-2', 'BET', '10000.00'));
const rejectedId = String(rejected.body['transactionId']);

answers(rejected);
shows('an uncovered bet is refused', rejected.status, 422);
shows('as a recorded outcome', rejected.body['status'], 'REJECTED');
shows('with its failure code', rejected.body['failureCode'], 'INSUFFICIENT_BALANCE');

const audit = await call('GET', `/wagering/transactions/${rejectedId}`);
const afterRejection = await call('GET', `/wallets/${walletId}`);

shows('the rejection is readable', [audit.status, audit.body['status']], [200, 'REJECTED']);
shows('the balance is untouched', afterRejection.body['balance'], {
  amount: '460.00',
  currency: 'BRL',
});
shows('and so is the version', afterRejection.body['version'], 2);

// ----------------------------------------------------------------- 4. Reversal

heading(4, 'Reversal — a refund of the bet, and the second reversal of one target');

const refund = await submit(operation('demo-refund-1', 'REFUND', '40.00', 'demo-bet-1'));

shows('the refund is applied', [refund.status, refund.body['status']], [200, 'PROCESSED']);
shows('the stake is back', refund.body['balance'], { amount: '500.00', currency: 'BRL' });

const second = await submit(operation('demo-rollback-1', 'ROLLBACK', '40.00', 'demo-bet-1'));

answers(second);
shows('a second reversal of the same bet is refused', second.status, 422);
shows('whatever its kind', second.body['failureCode'], 'REFERENCE_ALREADY_REVERSED');

// ----------------------------------------------------------------- 5. Reversal before its bet

heading(5, 'Out of order — a reversal that arrives before the bet it reverses');

/**
 * `ref.parked-state`: a reversal whose reference has not arrived is neither applied nor refused.
 * It is persisted as `PENDING_REFERENCE` and answered `202`, and a worker's scheduler attempts it
 * again until the reference lands or the window closes (ADR 0011). Nothing here drives that sweep.
 */
const parked = await submit(operation('demo-rollback-2', 'ROLLBACK', '30.00', 'demo-bet-3'));
const parkedId = String(parked.body['transactionId']);

answers(parked);
shows(
  'the reversal is parked, not refused',
  [parked.status, parked.body['status']],
  [202, 'PENDING_REFERENCE'],
);
shows(
  'Location names the transaction to poll',
  parked.location,
  `/wagering/transactions/${parkedId}`,
);

const target = await submit(operation('demo-bet-3', 'BET', '30.00'));

shows('the bet it was waiting for applies', target.body['balance'], {
  amount: '470.00',
  currency: 'BRL',
});

const swept = await until('a worker to apply the parked reversal', async () => {
  const found = await call('GET', `/wagering/transactions/${parkedId}`);

  return found.body['status'] === 'PROCESSED' ? found : null;
});

shows('a sweep applied it once the reference existed', swept.body['status'], 'PROCESSED');
shows('crediting the stake back', (await call('GET', `/wallets/${walletId}`)).body['balance'], {
  amount: '500.00',
  currency: 'BRL',
});

// ----------------------------------------------------------------- 6. Queue submission

heading(6, 'Queue submission — the same use case, reached by a message, and its redelivery');

const win = operation('demo-win-1', 'WIN', '25.00');
await enqueue(win, `${run}-msg-1`);

const fromQueue = await until('the worker to apply the message', async () => {
  const found = await call(
    'GET',
    `/providers/${providerId}/wagering/transactions/${win.externalTransactionId}`,
  );

  return found.status === 200 ? found : null;
});

shows('a worker applied it', fromQueue.body['status'], 'PROCESSED');
shows('crediting the wallet', fromQueue.body['observedBalance'], {
  amount: '525.00',
  currency: 'BRL',
});

console.log('  … the same messageId again, under a deduplication id the broker has never seen');
await enqueue(win, `${run}-msg-1`, { deduplicationId: `${run}-resent` });
await queueDrained();

const afterRedelivery = await call('GET', `/wallets/${walletId}`);

shows('the redelivery changed nothing', afterRedelivery.body['balance'], {
  amount: '525.00',
  currency: 'BRL',
});
shows('and added no version', afterRedelivery.body['version'], 6);

// ----------------------------------------------------------------- 7. Reconciliation

heading(7, 'Reconciliation — the stored balance against the ledger that explains it');

/**
 * The invariant of this service, printed rather than asserted: every entry of the wallet, and the
 * balance added up from them beside the balance the wallet row carries. `recon.calculation` is the
 * same sum, run inside one snapshot by the endpoint below; what this adds is that the reader does
 * the arithmetic too, from the rows the ledger endpoint serves anyone.
 */
const history = await call('GET', `/wallets/${walletId}/ledger?limit=50`);
const entriesSoFar = history.body['items'] as LedgerEntryResponse[];
const rebuilt = entriesSoFar.reduce((balance, { direction, money }) => {
  const entry = Money.from(money.amount, money.currency);

  return direction === 'CREDIT' ? balance.add(entry) : balance.subtract(entry);
}, Money.zero('BRL'));
const stored = await call('GET', `/wallets/${walletId}`);

console.log('  version  direction  amount  balance after');
for (const { walletVersion, direction, money, balanceAfter } of entriesSoFar) {
  console.log(
    `  ${String(walletVersion).padStart(7)}  ${direction.padEnd(9)}  ${money.amount.padStart(6)}  ${balanceAfter.amount.padStart(13)}`,
  );
}
// The two totals land under `balance after`, because that is the column they are a claim about.
const total = (label: string, amount: string): string =>
  `  ${label.padEnd(28)}${amount.padStart(13)}`;

console.log(total('rebuilt from the ledger', rebuilt.toString()));
console.log(total('stored on the wallet', (stored.body['balance'] as MoneyProps).amount));

const report = await call('POST', `/wallets/${walletId}/reconciliation`);

shows(
  'the entries add up to the balance the wallet carries',
  rebuilt.toJSON(),
  stored.body['balance'],
);
shows('the report is an answer, not a refusal', report.status, 200);
shows(
  'stored and calculated agree',
  [report.body['storedBalance'], report.body['calculatedBalance']],
  [
    { amount: '525.00', currency: 'BRL' },
    { amount: '525.00', currency: 'BRL' },
  ],
);
shows('the difference is zero', report.body['difference'], { amount: '0.00', currency: 'BRL' });
shows('it is consistent', report.body['consistent'], true);
shows('over every entry', report.body['checkedEntries'], 6);

/**
 * The six processed operations — the opening credit, the bet, the refund, the late bet, the
 * reversal that waited for it and the queued win — each announced twice, the two refusals
 * announced once, and the parking of the reversal announced once (`event.*-when`). The wait is the
 * publisher's poll interval, not a race: the rows were committed by the operations above.
 */
const ANNOUNCED = [
  'WagerTransactionPendingReference',
  'WagerTransactionProcessed',
  'WagerTransactionProcessed',
  'WagerTransactionProcessed',
  'WagerTransactionProcessed',
  'WagerTransactionProcessed',
  'WagerTransactionProcessed',
  'WagerTransactionRejected',
  'WagerTransactionRejected',
  'WalletBalanceChanged',
  'WalletBalanceChanged',
  'WalletBalanceChanged',
  'WalletBalanceChanged',
  'WalletBalanceChanged',
  'WalletBalanceChanged',
];

const announced = await until('the outbox publisher to deliver every event', async () => {
  await takeEvents();

  return publishedForThisWallet.length >= ANNOUNCED.length ? publishedForThisWallet : null;
});

shows(
  'the outbox published what the operations announced',
  announced.map(({ eventType }) => eventType).toSorted(),
  ANNOUNCED,
);
shows(
  'each one on the wallet, caused by its transaction, under the arrival that asked for it',
  announced.every(
    ({ aggregateId, causationId, correlationId }) =>
      aggregateId === walletId && causationId !== '' && correlationId !== '',
  ),
  true,
);

// ----------------------------------------------------------------- 8. Recovery

heading(8, 'Recovery — both workers killed mid-flight, and nothing lost or doubled');

/**
 * Enough queued operations that the drain takes long enough to be interrupted on purpose. Each one
 * gets a message group of its own: they are independent, and one FIFO group would admit one message
 * in flight at a time, which would turn the batch into a queue of sixty round trips.
 */
const QUEUED = 60;
const VERSION_BEFORE = 6;

const inFlight = Array.from({ length: QUEUED }, (_, index) =>
  operation(`demo-queued-${String(index)}`, 'BET', '1.00'),
);
await Promise.all(
  inFlight.map((fields, index) =>
    enqueue(fields, `${run}-recovery-${String(index)}`, { group: fields.externalTransactionId }),
  ),
);

/** How far the drain has got, in one request: a bet applied is a wallet version (LEDGER-007). */
async function applications(): Promise<number> {
  const wallet = await call('GET', `/wallets/${walletId}`);

  return Number(wallet.body['version']) - VERSION_BEFORE;
}

/** `make` exports the project, the image and the ports of this checkout's stack; Bun inherits them. */
const compose = (...args: string[]): void => {
  const { success } = Bun.spawnSync(['docker', 'compose', ...args], { stderr: 'inherit' });
  if (!success) {
    giveUp(`docker compose ${args.join(' ')} failed`, 'make logs');
  }
};

// The kill is taken while the drain is demonstrably in progress — some applied, some not yet — so
// that it interrupts work rather than an idle poll. Which failure window it lands in is the broker's
// business; that every one of them is survived is the drill's, in
// test/concurrency/crash-recovery.test.ts.
const drained = await until('the drain to be under way', async () => {
  const done = await applications();

  return done > 0 && done < QUEUED ? done : null;
});

compose('kill', '--signal', 'SIGKILL', 'worker');
shows('the kill interrupted a drain in progress', drained > 0 && drained < QUEUED, true);
console.log(
  `  … both workers SIGKILLed with ${String(QUEUED - drained)} of ${String(QUEUED)} not yet applied`,
);
compose('up', '--detach', '--wait', 'worker');
console.log('  … restarted, and left alone from here');

await until('the restarted workers to finish the drain', async () =>
  (await applications()) === QUEUED ? true : null,
);

const settled = await Promise.all(
  inFlight.map(({ externalTransactionId }) =>
    call('GET', `/providers/${providerId}/wagering/transactions/${externalTransactionId}`),
  ),
);

shows(
  'every operation that was in flight is readable and PROCESSED',
  [...new Set(settled.map(({ status, body }) => `${String(status)} ${String(body['status'])}`))],
  ['200 PROCESSED'],
);
shows(
  'each one applied exactly once, so the wallet took sixty versions',
  Number((await call('GET', `/wallets/${walletId}`)).body['version']),
  VERSION_BEFORE + QUEUED,
);

const recovered = await call('POST', `/wallets/${walletId}/reconciliation`);

shows('the wallet still equals its ledger', recovered.body['consistent'], true);
shows('having paid each bet exactly once', recovered.body['storedBalance'], {
  amount: '465.00',
  currency: 'BRL',
});

// -----------------------------------------------------------------

sqs.destroy();

if (failures === 0) {
  console.log(`\nEvery demonstration answered as docs/demonstrations.md says. Wallet ${walletId}.`);
  console.log('\nNext:');
  console.log(`  ${'make drill'.padEnd(31)}break the wallet lock on purpose; three cases catch it`);
  console.log(`  ${'make check'.padEnd(31)}the whole gate: every suite, real PostgreSQL and SQS`);
  console.log(`  ${`${baseUrl}/docs`.padEnd(31)}the HTTP contract this ran against`);
} else {
  console.log(`\n${String(failures)} claim(s) did not hold. Wallet ${walletId}.`);
  console.log('Next: make logs');
}
process.exit(failures === 0 ? 0 : 1);
