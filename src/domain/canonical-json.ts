import { CanonicalHashError } from './errors';

/**
 * JSON that is one sequence of bytes per value: RFC 8785 (JSON Canonicalization Scheme), the form
 * `idem.payload-hash` hashes. Two instances of the service, two entry points and two field orders
 * have to produce the same bytes for the same data, or a replay would read as a conflict.
 *
 * ECMAScript does most of the work, because that is what the RFC is written against: `JSON.stringify`
 * of a string is already the RFC's escape form (the short escapes for the five named control
 * characters, `\u00xx` in lowercase hex for the rest, everything else literal) and of a finite
 * number is already the RFC's number form. What it does not do is order the members, which this
 * serializer does by UTF-16 code unit, the comparison the RFC states and the one JavaScript string
 * ordering happens to be.
 *
 * What `JSON.stringify` does beyond the RFC is refused instead: it drops an `undefined` member,
 * prints a non-finite number as `null` and asks a value for a `toJSON` of its own. Each of those
 * silently turns one value into another, which is how two instances holding the same data would
 * come to hash differently, so only the values JSON has a form for are serialized at all.
 */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, []);
}

/**
 * Takes `unknown` rather than `CanonicalValue`, because the type states what a caller intends and
 * this is where that intent is checked: the data arrives from a provider through a validated DTO
 * or a message body, where a `Date`, a `Money` or an absent field is one cast away.
 */
function serialize(value: unknown, path: readonly string[]): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw refusal(value, path);
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value as readonly unknown[];

    return `[${items.map((item, index) => serialize(item, [...path, index.toString()])).join(',')}]`;
  }

  if (isJsonObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const member = value[key];

        if (member === undefined) {
          throw refusal(member, [...path, key]);
        }

        return `${JSON.stringify(key)}:${serialize(member, [...path, key])}`;
      });

    return `{${members.join(',')}}`;
  }

  throw refusal(value, path);
}

/**
 * A JSON object and nothing that merely looks like one: a `Date`, a `Map` or any aggregate of the
 * domain carries state its own class understands, and serializing its enumerable properties would
 * invent a canonical form for it.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function refusal(value: unknown, path: readonly string[]): CanonicalHashError {
  const where = path.length === 0 ? 'the root' : path.join('/');

  return new CanonicalHashError(
    `canonical JSON has no form for ${describeValue(value)} at ${where}`,
  );
}

/** Names the refused value without stringifying something arbitrary into the message. */
function describeValue(value: unknown): string {
  return typeof value === 'number' || typeof value === 'bigint'
    ? `${value.toString()} (${typeof value})`
    : `a value of type ${typeof value}`;
}
