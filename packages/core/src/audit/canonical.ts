import { createHash } from 'node:crypto';
import type { Hash } from '@sr/schema';
import type { HashableAuditRecord } from './types.js';

/** All-zero 32-byte hash, used as the chain's terminal value and genesis. */
export const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** The `prevHash` of the first record in a chain: the audit chain starts at zero. */
export const GENESIS_PREV_HASH: Hash = ZERO_HASH;

function stringifyValue(value: unknown, omit: ReadonlySet<string>, isRoot: boolean): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stringifyValue(item, omit, false)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const entries = Object.entries(record)
        .filter(([key, item]) => item !== undefined && !(isRoot && omit.has(key)))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${stringifyValue(item, omit, false)}`)
        .join(',')}}`;
    }
    default:
      // undefined, function and symbol serialize to null, matching JSON semantics.
      return 'null';
  }
}

/**
 * Deterministic JSON for hashing: object keys sorted bytewise, `undefined`
 * dropped, and the named top-level keys omitted. Structurally equal records
 * always produce the same string regardless of key insertion order.
 */
export function canonicalize(value: unknown, omitTopLevelKeys: readonly string[] = []): string {
  return stringifyValue(value, new Set(omitTopLevelKeys), true);
}

/** Lowercase hex sha256 of the UTF-8 bytes of `input`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Record hash: sha256 over the canonical JSON of the record with its `hash`
 * field removed. `prevHash` stays inside the digest, so the chain is bound.
 */
export function auditRecordHash(record: HashableAuditRecord): Hash {
  return `0x${sha256Hex(canonicalize(record, ['hash']))}`;
}
