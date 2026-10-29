/**
 * `failure.stable-codes` and `failure.caller-action`: the code enumerations in the code, in both
 * transport contracts and in the two tables of the system contract are one set, and every row of
 * those tables tells the caller what to do (API-012).
 *
 * There are five places a code can be written down and no generator between them, so what keeps
 * them equal is this comparison. It reads each place as it is: the enumerations of
 * `docs/openapi.yaml` and `docs/asyncapi.yaml` from the parsed documents, the tables from the
 * markdown of the system contract, the `ErrorCode` set from the status table the HTTP adapter is
 * built on — exhaustive by its own type, so a code the type does not have cannot appear in it and a
 * code it has cannot be missing — and the `FailureCode` union from the source of the domain type,
 * which has no runtime form to read and must not grow one for a test's sake.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { PROBLEM_TYPES } from '../../src/infrastructure/http/problem-details';
import { asyncApi, openApi, schemaPointer } from '../helpers/contract-documents';

const SYSTEM_CONTRACT = readFileSync(
  new URL('../../docs/system-contract.md', import.meta.url),
  'utf8',
);

const FAILURE_CODE_TABLE = '### 9.1 FailureCode';

const ERROR_CODE_TABLE = '### 9.2 ErrorCode';

/** The rows of the markdown table that follows a heading, as their cells, header and rule apart. */
function tableUnder(heading: string): readonly (readonly string[])[] {
  const section = SYSTEM_CONTRACT.split(heading)[1];

  if (section === undefined) {
    throw new Error(`docs/system-contract.md has no section ${heading}`);
  }

  const lines = section.split('\n');
  const rows = lines.slice(lines.findIndex((line) => line.startsWith('|')));
  const after = rows.findIndex((line) => !line.startsWith('|'));

  return (after === -1 ? rows : rows.slice(0, after))
    .slice(2) // the header and the rule under it
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** The first cell of each row: the code the row is about, as the table writes it in backticks. */
const codesOf = (rows: readonly (readonly string[])[]): string[] =>
  rows.map((cells) => (cells[0] ?? '').replaceAll('`', ''));

/** The members of a string-literal union, read from the source that declares it. */
function unionMembers(file: string, name: string): string[] {
  const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
  const declaration = source.split(`export type ${name} =`)[1]?.split(';')[0];

  if (declaration === undefined) {
    throw new Error(`src/${file} declares no ${name}`);
  }

  return [...declaration.matchAll(/'([A-Z_]+)'/g)].map(([, member]) => member ?? '');
}

/** The `enum` of a named schema of either transport contract. */
function enumOf(document: 'openapi' | 'asyncapi', name: string): string[] {
  const root = document === 'openapi' ? openApi : asyncApi;
  const schemas = ((root['components'] ?? {}) as Record<string, unknown>)['schemas'] as
    Record<string, { enum?: string[] }> | undefined;
  const members = schemas?.[name]?.enum;

  if (members === undefined) {
    throw new Error(`docs/${document}.yaml has no enumeration at ${schemaPointer(name)}`);
  }

  return members;
}

describe('failure-codes-match-contract', () => {
  test('FailureCode is the same set in the domain, both contracts and the system contract', () => {
    const table = codesOf(tableUnder(FAILURE_CODE_TABLE));

    expect(table).not.toEqual([]);
    expect(unionMembers('domain/failure-code.ts', 'FailureCode')).toEqual(table);
    expect(enumOf('openapi', 'FailureCode')).toEqual(table);
    expect(enumOf('asyncapi', 'FailureCode')).toEqual(table);
  });

  test('ErrorCode is the same set in the domain, the adapter, the contract and the system contract', () => {
    const table = codesOf(tableUnder(ERROR_CODE_TABLE));

    expect(table).not.toEqual([]);
    expect(unionMembers('domain/error-code.ts', 'ErrorCode')).toEqual(table);
    expect(Object.keys(PROBLEM_TYPES)).toEqual(table);
    expect(enumOf('openapi', 'ErrorCode')).toEqual(table);
  });

  test('the status each error code answers with is the one the system contract tabulates', () => {
    expect(
      tableUnder(ERROR_CODE_TABLE).map(
        (cells) => `${(cells[0] ?? '').replaceAll('`', '')} ${cells[1] ?? ''}`,
      ),
    ).toEqual(
      Object.entries(PROBLEM_TYPES).map(
        ([code, problem]) => `${code} ${problem.status.toString()}`,
      ),
    );
  });

  test('every code documents the action expected from the caller', () => {
    const actions = [
      ...tableUnder(FAILURE_CODE_TABLE).map((cells) => [cells[0], cells[2]] as const),
      ...tableUnder(ERROR_CODE_TABLE).map((cells) => [cells[0], cells[3]] as const),
    ];

    expect(
      actions
        .filter(([, action]) => action === undefined || action.length === 0)
        .map(([code]) => code),
    ).toEqual([]);
  });

  test('no code is reused with another meaning: each appears once in each place it is written', () => {
    for (const codes of [
      codesOf(tableUnder(FAILURE_CODE_TABLE)),
      codesOf(tableUnder(ERROR_CODE_TABLE)),
      enumOf('openapi', 'FailureCode'),
      enumOf('openapi', 'ErrorCode'),
      enumOf('asyncapi', 'FailureCode'),
    ]) {
      expect([...new Set(codes)]).toEqual(codes);
    }

    // The two taxonomies are disjoint: a persisted outcome and a refused request are different
    // facts, and one identifier could not stand for both (`failure.request-errors`).
    const failures = new Set(codesOf(tableUnder(FAILURE_CODE_TABLE)));

    expect(codesOf(tableUnder(ERROR_CODE_TABLE)).filter((code) => failures.has(code))).toEqual([]);
  });
});
