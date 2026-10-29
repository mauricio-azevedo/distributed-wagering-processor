import { describe, expect, test } from 'bun:test';

import { type CanonicalValue, canonicalJson } from '../../src/domain/canonical-json';
import { CanonicalHashError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

/**
 * The vectors of RFC 8785 itself, the definition `idem.payload-hash` cites. They are the reason
 * this serializer is not `JSON.stringify` with sorted keys and nothing else: the number forms, the
 * escape forms and the code-unit ordering of the property names are all stated by the RFC, and a
 * divergence in any of them would turn a replay into a conflict between two instances.
 *
 * Every character the vectors depend on is built from its code point, and every escape the
 * expected output contains is built as text, so what each assertion compares is visible in it
 * rather than hidden in a literal that a reader has to decode.
 */
const BACKSLASH = '\\';
const QUOTE = '"';
const ESCAPED_BACKSLASH = BACKSLASH + BACKSLASH;
const ESCAPED_QUOTE = BACKSLASH + QUOTE;

/** The RFC's escape form for a control character: a backslash, a `u`, four lowercase hex digits. */
const escaped = (code: number): string => `${BACKSLASH}u${code.toString(16).padStart(4, '0')}`;

/** The short escape the RFC keeps for five of the control characters. */
const shortEscape = (letter: string): string => BACKSLASH + letter;

const CHAR = {
  backspace: String.fromCharCode(0x08),
  tab: String.fromCharCode(0x09),
  newline: String.fromCharCode(0x0a),
  formFeed: String.fromCharCode(0x0c),
  carriageReturn: String.fromCharCode(0x0d),
  shiftIn: String.fromCharCode(0x0f),
  unitSeparator: String.fromCharCode(0x1f),
  del: String.fromCharCode(0x7f),
  padding: String.fromCharCode(0x80),
  oDiaeresis: String.fromCharCode(0xf6),
  euro: String.fromCharCode(0x20ac),
  daletDagesh: String.fromCharCode(0xfb33),
  grinningFace: String.fromCodePoint(0x1f600),
};

/** The input of RFC 8785 appendix B, decoded: the numbers, the escapes and the three literals. */
const RFC_INPUT: CanonicalValue = {
  numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
  string: `${CHAR.euro}$${CHAR.shiftIn}${CHAR.newline}A'B${QUOTE}${BACKSLASH}${BACKSLASH}${QUOTE}/`,
  literals: [null, true, false],
};

const RFC_OUTPUT =
  '{"literals":[null,true,false],' +
  '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
  `"string":"${CHAR.euro}$${escaped(0x0f)}${shortEscape('n')}A'B` +
  `${ESCAPED_QUOTE}${ESCAPED_BACKSLASH}${ESCAPED_BACKSLASH}${ESCAPED_QUOTE}/"}`;

/**
 * RFC 8785 section 3.2.3: property names are sorted by UTF-16 code unit, so the emoji, whose
 * first code unit is `0xD83D`, precedes `U+FB33` even though its code point is far above it. A
 * serializer sorting by code point would order those two the other way round.
 */
const RFC_SORTING_INPUT: CanonicalValue = {
  [CHAR.euro]: 'Euro Sign',
  [CHAR.carriageReturn]: 'Carriage Return',
  [CHAR.daletDagesh]: 'Hebrew Letter Dalet With Dagesh',
  '1': 'One',
  [CHAR.grinningFace]: 'Emoji: Grinning Face',
  [CHAR.padding]: 'Control',
  [CHAR.oDiaeresis]: 'Latin Small Letter O With Diaeresis',
};

const RFC_SORTING_OUTPUT =
  `{"${shortEscape('r')}":"Carriage Return","1":"One",` +
  `"${CHAR.padding}":"Control","${CHAR.oDiaeresis}":"Latin Small Letter O With Diaeresis",` +
  `"${CHAR.euro}":"Euro Sign","${CHAR.grinningFace}":"Emoji: Grinning Face",` +
  `"${CHAR.daletDagesh}":"Hebrew Letter Dalet With Dagesh"}`;

describe('canonical-json-follows-rfc-8785', () => {
  test('serializes the vector of RFC 8785 appendix B exactly', () => {
    expect(canonicalJson(RFC_INPUT)).toBe(RFC_OUTPUT);
  });

  test('sorts property names by UTF-16 code unit, not by code point', () => {
    expect(canonicalJson(RFC_SORTING_INPUT)).toBe(RFC_SORTING_OUTPUT);
  });

  test('sorts at every depth and keeps array order', () => {
    expect(canonicalJson({ b: { d: 1, c: [3, 1, 2] }, a: [{ f: 1, e: 2 }] })).toBe(
      '{"a":[{"e":2,"f":1}],"b":{"c":[3,1,2],"d":1}}',
    );
  });

  test('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: {} })).toBe('{"a":[1,2],"b":{}}');
  });

  test.each<readonly [CanonicalValue, string]>([
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    ['', '""'],
    [0, '0'],
    [-0, '0'],
    [-1.5, '-1.5'],
    [1e21, '1e+21'],
    [{}, '{}'],
    [[], '[]'],
  ])('serializes %p as %p', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  /** The escape table of section 3.2.2.2: five short forms, `\u00xx` below `U+0020`, nothing else. */
  test.each([
    [0x08, shortEscape('b')],
    [0x09, shortEscape('t')],
    [0x0a, shortEscape('n')],
    [0x0c, shortEscape('f')],
    [0x0d, shortEscape('r')],
    [0x00, escaped(0x00)],
    [0x01, escaped(0x01)],
    [0x0b, escaped(0x0b)],
    [0x1f, escaped(0x1f)],
    [0x7f, CHAR.del],
    [0x80, CHAR.padding],
  ])('serializes the character at %p as %p', (code, expected) => {
    expect(canonicalJson(String.fromCharCode(code))).toBe(`${QUOTE}${expected}${QUOTE}`);
  });

  test('escapes the quotation mark and the backslash, and leaves the solidus alone', () => {
    expect(canonicalJson(`a${QUOTE}b${BACKSLASH}c/d`)).toBe(
      `"a${ESCAPED_QUOTE}b${ESCAPED_BACKSLASH}c/d"`,
    );
  });

  test('keeps every character above U+001F literal, inside and outside the BMP', () => {
    expect(canonicalJson(`ä${CHAR.euro}${CHAR.grinningFace}`)).toBe(
      `"ä${CHAR.euro}${CHAR.grinningFace}"`,
    );
  });
});

/**
 * A value JSON has no form for is refused rather than serialized by a convention of its own:
 * `JSON.stringify` drops an `undefined` member, prints `NaN` as `null` and calls `toJSON`, and any
 * of the three would let two instances holding the same data hash differently.
 */
describe('canonical-json-refuses-what-json-cannot-hold', () => {
  test.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a bigint', 10n],
    ['a Date', new Date('2026-10-28T12:05:00.000Z')],
    ['a Map', new Map([['a', 1]])],
    ['a function', (): number => 1],
    ['a symbol', Symbol('a')],
  ])('refuses %s', (_what, value) => {
    expect(() => canonicalJson(value as CanonicalValue)).toThrow(CanonicalHashError);
  });

  /** The hash takes the amount as it was submitted, so a `Money` never reaches the serializer. */
  test('refuses a domain object even though it carries a toJSON method', () => {
    const money = Money.from('40.00', 'BRL') as unknown as CanonicalValue;

    expect(() => canonicalJson({ money })).toThrow(CanonicalHashError);
  });

  test('refuses an undefined member instead of dropping it', () => {
    expect(() => canonicalJson({ a: undefined } as unknown as CanonicalValue)).toThrow(
      CanonicalHashError,
    );
  });

  test('names where the refused value sits', () => {
    expect(() => canonicalJson({ money: { amount: Number.NaN } })).toThrow(/money\/amount/);
    expect(() => canonicalJson([1, [2, Number.NaN]])).toThrow(/1\/1/);
  });
});
