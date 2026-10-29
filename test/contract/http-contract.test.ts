/**
 * The service held to [docs/openapi.yaml](../../docs/openapi.yaml) and
 * [docs/asyncapi.yaml](../../docs/asyncapi.yaml): the surface it registers, the document it serves
 * and every payload it produces, checked against the documents themselves rather than against a
 * copy of them written here (`api.contract-document`, `model.contract-first`).
 *
 * The oracle is the document, so these cases fail when the code drifts from it and when the
 * document drifts from the code, which is the only arrangement that makes a hand-written contract
 * authoritative (API-011, API-012, MODEL-006).
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { AppModule } from '../../src/app.module';
import { loadEnv, loadMigrationEnv } from '../../src/infrastructure/config/env';
import { ormConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import {
  type Method,
  type Operation,
  asyncApi,
  numericMoney,
  openApiBytes,
  openApiOperations,
  responseSchemaPointer,
  schemaExamples,
  schemaPointer,
  validator,
} from '../helpers/contract-documents';
import { TouchedWallets } from '../helpers/wallet-reconciliation';

// Runs against the Compose dependencies (make infra); .env carries their addresses.
const env = loadEnv(process.env);
const migrationEnv = loadMigrationEnv(process.env);

const PLAYER_ID = '01a17cb1-f5c0-7588-9a61-47a9444c049e';
const UNKNOWN_WALLET_ID = '01a18261-a600-7589-8768-3d9584600000';
const PROVIDER_ID = 'provider-acme';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_schedule',
];

/**
 * The two documentation routes. They are documentation and not API, so the document does not
 * describe them and the inventory below leaves them out of both directions
 * (`api.contract-document`).
 */
const DOCUMENTATION_ROUTES = ['/docs', '/docs-json'];

/** The event payload of `docs/asyncapi.yaml` each `eventType` is published as. */
const EVENT_PAYLOADS: Record<string, string> = {
  WagerTransactionProcessed: 'WagerTransactionProcessedPayload',
  WagerTransactionRejected: 'WagerTransactionRejectedPayload',
  WagerTransactionPendingReference: 'WagerTransactionPendingReferencePayload',
  WalletBalanceChanged: 'WalletBalanceChangedPayload',
};

const touched = new TouchedWallets();

let schema: MikroORM;
let runtime: MikroORM;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  schema = await MikroORM.init(ormConfig(migrationEnv.MIGRATION_DATABASE_URL));
  await schema.migrator.up();
  runtime = await MikroORM.init(ormConfig(env.DATABASE_URL));
  app = await NestFactory.create(AppModule.create(env), {
    logger: false,
    abortOnError: false, // a bootstrap error must fail the test, not exit the runner
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await runtime.close(true);
  await schema.close(true);
});

// The migrator owns the tables, so it is the role that may truncate them (ADR 0003).
beforeEach(async () => {
  await schema.em.getConnection().execute(`truncate table ${TABLES.join(', ')}`);
});

// `recon.final-invariant` (RECON-004): this suite moves money, so every test ends by rebuilding the
// balance of each wallet it touched from its ledger.
afterEach(async () => {
  await touched.expectReconciled(runtime);
});

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  readonly body: unknown;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  return {
    status: response.status,
    contentType,
    text,
    body: contentType.includes('json') ? (JSON.parse(text) as unknown) : text,
  };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(initialBalance: string): Promise<string> {
  const answer = await request('POST', '/wallets', {
    body: { playerId: PLAYER_ID, initialBalance: brl(initialBalance) },
  });
  const { id } = answer.body as { id?: string };

  if (answer.status !== 201 || id === undefined) {
    throw new Error(`opening a wallet answered ${answer.status.toString()}`);
  }

  return touched.add(id);
}

/** One operation of the document, by its `operationId`. */
function operation(operationId: string): Operation {
  const found = openApiOperations().find((each) => each.operationId === operationId);

  if (found === undefined) {
    throw new Error(`docs/openapi.yaml has no operation ${operationId}`);
  }

  return found;
}

/** The violations of one answer against the schema the document declares for it. */
function violations(operationId: string, answer: Answer): string[] {
  const subject = operation(operationId);
  const status = answer.status.toString();
  const contentType = answer.contentType.split(';')[0] ?? '';
  const pointer = responseSchemaPointer(subject, status, contentType);

  if (pointer === null) {
    return [
      `docs/openapi.yaml declares no ${contentType} body for ${operationId} ${status}; ` +
        `it declares ${subject.statuses.join(', ')}`,
    ];
  }

  return [...validator('openapi', pointer)(answer.body), ...numericMoney(answer.body)];
}

/** One registered route of the running application, as Express holds it. */
interface RegisteredRoute {
  readonly path: string;
  readonly method: Method;
}

interface ExpressLayer {
  readonly route?: { readonly path: string; readonly methods: Record<string, boolean> };
}

/**
 * The routes the running application answers on, read off the router it registered them in rather
 * than off the decorators that declared them: what the document is compared with has to be what a
 * caller can reach (API-011).
 *
 * The middleware every request runs through is mounted as a route of its own on every method, so a
 * templated catch-all is not an operation; no operation of the document carries a wildcard, which is
 * what makes the shape of the path the way to tell the two apart.
 */
function registeredRoutes(): readonly RegisteredRoute[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack?: readonly ExpressLayer[] };
  };
  const stack = instance.router?.stack ?? [];

  return stack.flatMap((layer) =>
    layer.route === undefined || layer.route.path.includes('*')
      ? []
      : Object.keys(layer.route.methods).map((method) => ({
          path: layer.route?.path ?? '',
          method: method as Method,
        })),
  );
}

/** A registered path as the document spells it: `/wallets/:walletId` is `/wallets/{walletId}`. */
const templated = (path: string): string =>
  path.replaceAll(/:([A-Za-z0-9_]+)/g, (_match, name: string) => `{${name}}`);

const asLines = (routes: readonly { path: string; method: string }[]): string[] =>
  routes.map((route) => `${route.method.toUpperCase()} ${route.path}`).sort();

describe('openapi-document-served-and-complete', () => {
  test('/docs-json serves the repository document, byte for byte', async () => {
    const answer = await request('GET', '/docs-json');

    expect(answer.status).toBe(200);
    expect(answer.text).toBe(openApiBytes);
  });

  test('/docs renders the document the service serves', async () => {
    const answer = await request('GET', '/docs');

    expect(answer.status).toBe(200);
    expect(answer.contentType).toStartWith('text/html');
    expect(answer.text).toContain('/docs-json');
  });

  test('every route the application registers is an operation of the document', () => {
    const registered = registeredRoutes().filter(
      (route) => !DOCUMENTATION_ROUTES.includes(route.path),
    );

    expect(asLines(registered.map((route) => ({ ...route, path: templated(route.path) })))).toEqual(
      asLines(openApiOperations()),
    );
  });

  test('every operation of the document is a route the application registers', () => {
    const documented = asLines(openApiOperations());
    const registered = new Set(
      asLines(registeredRoutes().map((route) => ({ ...route, path: templated(route.path) }))),
    );

    expect(documented.filter((line) => !registered.has(line))).toEqual([]);
  });

  test('the documentation routes are the only routes outside the document', () => {
    const paths = registeredRoutes().map((route) => route.path);

    expect(paths.filter((path) => DOCUMENTATION_ROUTES.includes(path)).sort()).toEqual(
      DOCUMENTATION_ROUTES,
    );
  });
});

describe('payloads-validate-against-contracts', () => {
  test('every response of every operation validates against its schema in the document', async () => {
    const walletId = await openWallet('100.00');
    const bet = {
      providerId: PROVIDER_ID,
      externalTransactionId: 'acme-tx-000123',
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl('40.00'),
    };
    const applied = await request('POST', '/wagering/transactions', {
      body: bet,
      idempotencyKey: `${PROVIDER_ID}:${bet.externalTransactionId}`,
    });
    const rejected = await request('POST', '/wagering/transactions', {
      body: { ...bet, externalTransactionId: 'acme-tx-000124', money: brl('500.00') },
      idempotencyKey: `${PROVIDER_ID}:acme-tx-000124`,
    });
    const parked = await request('POST', '/wagering/transactions', {
      body: {
        ...bet,
        externalTransactionId: 'acme-tx-000125',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'acme-tx-999999',
      },
      idempotencyKey: `${PROVIDER_ID}:acme-tx-000125`,
    });
    const { transactionId } = applied.body as { transactionId: string };

    const answers: readonly (readonly [string, Answer])[] = [
      [
        'openWallet',
        await request('POST', '/wallets', {
          body: {
            playerId: '01a17cb1-f5c0-7588-9a61-47a9444c049f',
            initialBalance: brl('0.00'),
          },
        }),
      ],
      ['getWallet', await request('GET', `/wallets/${walletId}`)],
      ['getWallet', await request('GET', `/wallets/${UNKNOWN_WALLET_ID}`)],
      ['listWalletLedger', await request('GET', `/wallets/${walletId}/ledger?limit=2`)],
      ['reconcileWallet', await request('POST', `/wallets/${walletId}/reconciliation`)],
      ['submitWagerTransaction', applied],
      ['submitWagerTransaction', rejected],
      ['submitWagerTransaction', parked],
      ['getWagerTransaction', await request('GET', `/wagering/transactions/${transactionId}`)],
      [
        'getWagerTransactionByProvider',
        await request(
          'GET',
          `/providers/${PROVIDER_ID}/wagering/transactions/${bet.externalTransactionId}`,
        ),
      ],
      ['getLiveness', await request('GET', '/health/live')],
      ['getReadiness', await request('GET', '/health/ready')],
      ['getMetrics', await request('GET', '/metrics')],
    ];

    expect(
      answers.flatMap(([operationId, answer]) =>
        violations(operationId, answer).map(
          (violation) => `${operationId} ${answer.status.toString()}: ${violation}`,
        ),
      ),
    ).toEqual([]);

    // The sweep is over the whole surface: no operation of the document is left unexercised.
    expect([...new Set(answers.map(([operationId]) => operationId))].sort()).toEqual(
      openApiOperations()
        .map((documented) => documented.operationId)
        .sort(),
    );

    // The outcomes the submissions recorded, which is what makes the three bodies above the three
    // status classes of `api.outcome-shape` and not three copies of one.
    expect([applied.status, rejected.status, parked.status]).toEqual([200, 422, 202]);
  });

  test('every event the service publishes validates against its payload schema', async () => {
    const walletId = await openWallet('100.00');
    const bet = {
      providerId: PROVIDER_ID,
      externalTransactionId: 'acme-tx-000223',
      playerId: PLAYER_ID,
      walletId,
      roundId: 'round-7f3a',
      gameId: 'lucky-sevens',
      kind: 'BET',
      money: brl('40.00'),
    };

    for (const [externalTransactionId, overrides] of [
      ['acme-tx-000223', {}],
      ['acme-tx-000224', { money: brl('500.00') }],
      ['acme-tx-000225', { kind: 'ROLLBACK', referenceExternalTransactionId: 'acme-tx-999999' }],
    ] as const) {
      await request('POST', '/wagering/transactions', {
        body: { ...bet, externalTransactionId, ...overrides },
        idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
      });
    }

    const rows = await runtime.em
      .getConnection()
      .execute<{ event_type: string; payload: unknown }[]>(
        'select "event_type", "payload" from "outbox_messages" order by "occurred_at"',
      );

    expect(
      rows.flatMap((row) => {
        const payload = EVENT_PAYLOADS[row.event_type];

        if (payload === undefined) {
          return [`${row.event_type} is not a message of docs/asyncapi.yaml`];
        }

        return [
          ...validator('asyncapi', schemaPointer(payload))(row.payload),
          ...numericMoney(row.payload),
        ].map((violation) => `${row.event_type}: ${violation}`);
      }),
    ).toEqual([]);

    // The three submissions produce every event type the service has, so the check above is over
    // the whole catalogue and not over whichever one happened to be published.
    expect([...new Set(rows.map((row) => row.event_type))].sort()).toEqual(
      Object.keys(EVENT_PAYLOADS).sort(),
    );
  });

  test('every example in both documents validates against the schema it illustrates', () => {
    expect(exampleViolations()).toEqual([]);
  });
});

/**
 * The documents' own examples, checked against their own schemas: the ones beside a schema in
 * either document, and the message examples AsyncAPI keeps beside the payload they illustrate.
 */
function exampleViolations(): string[] {
  const beside = (['openapi', 'asyncapi'] as const).flatMap((document) =>
    schemaExamples(document).flatMap((example) =>
      validator(
        document,
        example.pointer,
      )(example.value).map((violation) => `${document}${example.where}: ${violation}`),
    ),
  );

  return [...beside, ...messageExampleViolations()];
}

function messageExampleViolations(): string[] {
  const messages = ((asyncApi['components'] ?? {}) as Record<string, unknown>)['messages'] as
    | Record<
        string,
        { payload?: { $ref?: string }; examples?: { name?: string; payload?: unknown }[] }
      >
    | undefined;

  return Object.entries(messages ?? {}).flatMap(([message, definition]) =>
    (definition.examples ?? []).flatMap((example, index) =>
      validator(
        'asyncapi',
        (definition.payload?.$ref ?? '#').slice(1),
      )(example.payload).map(
        (violation) => `${message} example ${example.name ?? index.toString()}: ${violation}`,
      ),
    ),
  );
}
