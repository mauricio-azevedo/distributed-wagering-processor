import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DOMAIN = path.join(import.meta.dirname, '../../src/domain');

/** Every `from '...'` and `import('...')` specifier, the two forms the layer uses. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)'([^']+)'/g;

interface DomainImport {
  readonly file: string;
  readonly specifier: string;
}

function domainImports(): DomainImport[] {
  const files = readdirSync(DOMAIN, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );

  return files.flatMap((file) => {
    const source = readFileSync(path.join(DOMAIN, file), 'utf8');

    return [...source.matchAll(SPECIFIER)].map((match) => ({ file, specifier: match[1] ?? '' }));
  });
}

/** `model.framework-free-domain`, as the import graph of `src/domain` states it (MODEL-005). */
describe('domain-import-graph-is-clean', () => {
  const imports = domainImports();

  test('the layer is not empty, so an empty graph cannot pass the rule by accident', () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  test('no import resolves to a package: no framework, ORM, transport or runtime module', () => {
    const packages = imports.filter(({ specifier }) => !specifier.startsWith('.'));

    expect(packages).toEqual([]);
  });

  test('no relative import leaves the domain, so no other layer reaches it', () => {
    const escaping = imports.filter(
      ({ file, specifier }) =>
        !path.resolve(DOMAIN, path.dirname(file), specifier).startsWith(DOMAIN + path.sep),
    );

    expect(escaping).toEqual([]);
  });
});
