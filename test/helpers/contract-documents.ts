/**
 * The transport contracts as an oracle: `docs/openapi.yaml` and `docs/asyncapi.yaml` parsed, their
 * operations enumerated and their schemas compiled into validators (`model.contract-first`).
 *
 * The documents are authoritative and nothing is generated from them (ARCHITECTURE.md section 6),
 * so what holds the code to them is a test that reads them at run time and checks the service's own
 * answers against them. The compiler is Ajv, the standard JSON Schema implementation, because an
 * OpenAPI 3.1 schema object is a JSON Schema 2020-12 schema: a hand-written subset validator would
 * be a second implementation of the thing being trusted.
 *
 * The whole document is registered under one base id, so `#/components/schemas/...` — the only form
 * of reference either document uses — resolves exactly as it reads in the file. The keywords
 * OpenAPI adds around the schemas (`paths`, `components.responses`, the `examples` maps) are not
 * JSON Schema keywords and are ignored, which is why `strict` is off rather than a list of
 * exceptions.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';

/** The repository document, as bytes: what `/docs-json` has to serve unchanged (API-011). */
export const OPEN_API_PATH = new URL('../../docs/openapi.yaml', import.meta.url);

export const ASYNC_API_PATH = new URL('../../docs/asyncapi.yaml', import.meta.url);

export const openApiBytes = readFileSync(OPEN_API_PATH, 'utf8');

export const asyncApiBytes = readFileSync(ASYNC_API_PATH, 'utf8');

type Document = Record<string, unknown>;

export const openApi = Bun.YAML.parse(openApiBytes) as Document;

export const asyncApi = Bun.YAML.parse(asyncApiBytes) as Document;

/** The HTTP methods an OpenAPI path item may carry. The service uses two; the list is the document's. */
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type Method = (typeof METHODS)[number];

/** One operation of the document: where it answers, and what it answers with. */
export interface Operation {
  /** The templated path as the document spells it, for example `/wallets/{walletId}`. */
  readonly path: string;
  readonly method: Method;
  readonly operationId: string;
  /** The status codes the document declares for it, as strings. */
  readonly statuses: readonly string[];
  readonly definition: Document;
}

/** Every operation of `docs/openapi.yaml`, which is the API surface the service may register. */
export function openApiOperations(): readonly Operation[] {
  const paths = (openApi['paths'] ?? {}) as Record<string, Document>;

  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.filter((method) => method in item).map((method) => {
      const definition = item[method] as Document;

      return {
        path,
        method,
        operationId: String(definition['operationId']),
        statuses: Object.keys(definition['responses'] ?? {}),
        definition,
      };
    }),
  );
}

/**
 * The schema of one response of one operation, as a JSON Pointer into the document, or `null` when
 * the document declares no body for it. The content type is the one the document names, so a
 * problem is validated against the `application/problem+json` schema and never against the success
 * schema of the same operation.
 *
 * A response the operation shares with others is a reference to `components/responses`, which is
 * followed here: the schema a caller is held to is the one the document would show them, wherever
 * the document keeps it.
 */
export function responseSchemaPointer(
  operation: Operation,
  status: string,
  contentType: string,
): string | null {
  const response = [
    '',
    'paths',
    escapePointer(operation.path),
    operation.method,
    'responses',
    status,
  ].join('/');
  const reference = (resolvePointer(openApi, response) as { $ref?: string } | undefined)?.$ref;
  const pointer = [
    reference === undefined ? response : reference.slice(1),
    'content',
    escapePointer(contentType),
    'schema',
  ].join('/');

  return resolvePointer(openApi, pointer) === undefined ? null : pointer;
}

/**
 * Every example either document carries beside a schema, as the schema it illustrates and the value
 * it illustrates it with. They are fixtures — the suites take their requests, their messages and the
 * canonical hashing vectors from them — so an example that does not satisfy its own schema would
 * make a test agree with a payload no caller could send.
 *
 * The walk is over the whole document rather than over the paths, because the documents keep
 * examples wherever the shape they illustrate lives: beside an operation, beside a shared response,
 * beside a parameter.
 */
export interface SchemaExample {
  readonly where: string;
  readonly pointer: string;
  readonly value: unknown;
}

export function schemaExamples(document: 'openapi' | 'asyncapi'): readonly SchemaExample[] {
  const root = document === 'openapi' ? openApi : asyncApi;
  const found: SchemaExample[] = [];

  const walk = (node: unknown, pointer: string): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${pointer}/${index.toString()}`);
      });

      return;
    }

    const members = node as Record<string, unknown>;
    const named = members['examples'];

    if (
      'schema' in members &&
      named !== null &&
      typeof named === 'object' &&
      !Array.isArray(named)
    ) {
      for (const [name, example] of Object.entries(named as Record<string, unknown>)) {
        found.push({
          where: `${pointer}/examples/${name}`,
          pointer: `${pointer}/schema`,
          value: (example as { value?: unknown }).value,
        });
      }
    }

    for (const [member, value] of Object.entries(members)) {
      walk(value, `${pointer}/${escapePointer(member)}`);
    }
  };

  walk(root, '');

  return found;
}

/**
 * A document as a schema root: the two members a reference can point into, and nothing else. The
 * metadata around them is not JSON Schema and some of it collides with it — AsyncAPI's own `id`
 * member is the schema identifier keyword — so the root registered here carries only what
 * `#/components/...` and `#/paths/...` resolve through.
 */
const asSchemaRoot = (document: Document): Document => ({
  ...(document['paths'] === undefined ? {} : { paths: document['paths'] }),
  components: document['components'],
});

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(asSchemaRoot(openApi), 'openapi');
ajv.addSchema(asSchemaRoot(asyncApi), 'asyncapi');

/**
 * A validator for one schema of one document, named by the JSON Pointer the document itself uses.
 * It returns the violations as readable lines, so a failing assertion names the member and the rule
 * rather than an Ajv object.
 */
export function validator(
  document: 'openapi' | 'asyncapi',
  pointer: string,
): (value: unknown) => string[] {
  const compiled = ajv.getSchema(`${document}#${pointer}`) as ValidateFunction | undefined;

  if (compiled === undefined) {
    throw new Error(`${document} has no schema at ${pointer}`);
  }

  return (value: unknown): string[] =>
    compiled(value)
      ? []
      : (compiled.errors ?? []).map(
          (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        );
}

/** A `$ref`-style pointer to a named schema of either document. */
export const schemaPointer = (name: string): string => `/components/schemas/${name}`;

/**
 * `model.money-props-in-contracts`: every amount anywhere in a payload is a string. The walk is over
 * the serialized value, so it sees what a caller or a consumer receives and not what the code
 * believed it was sending: a `Money` instance that reached a body would arrive as its members, and a
 * number would arrive as a number.
 *
 * It names the members by the vocabulary the contracts use for money — the `amount` of a
 * `MoneyProps`, and the members that carry one — so a numeric amount is a violation wherever it
 * appears, however deeply nested.
 */
const MONEY_MEMBERS = new Set(['amount', 'balance', 'balanceAfter', 'balanceBefore', 'difference']);

export function numericMoney(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => numericMoney(item, `${at}/${index.toString()}`));
  }

  if (value === null || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([member, member_value]) => {
    const path = `${at}/${member}`;

    if (MONEY_MEMBERS.has(member) && typeof member_value === 'number') {
      return [`${path} is a JSON number`];
    }

    return numericMoney(member_value, path);
  });
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function resolvePointer(document: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((current, segment) => {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');

      return current === null || typeof current !== 'object'
        ? undefined
        : (current as Record<string, unknown>)[key];
    }, document);
}
