import { createHash } from 'node:crypto';

/**
 * The `Sha256Hex` the domain asks for (`idem.payload-hash`): the SHA-256 of a UTF-8 string as
 * lowercase hex.
 *
 * It sits here rather than in the domain because the domain imports no module at all, not even a
 * runtime one (`model.framework-free-domain`, MODEL-005), and rather than in infrastructure
 * because there is nothing to adapt: a digest is a pure function of its input, with no
 * configuration, no clock and no connection, so it needs no port and no fake. The rule it serves
 * — which bytes are digested and what the result looks like — stays in the domain, where the
 * fixed vectors of IDEM-004 hold it.
 */
export function sha256Hex(utf8: string): string {
  return createHash('sha256').update(utf8, 'utf8').digest('hex');
}
