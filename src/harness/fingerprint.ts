import { createHash } from 'node:crypto';

/** Values accepted by the deterministic canonical JSON encoder. */
export type FingerprintValue =
  | null
  | boolean
  | number
  | string
  | readonly FingerprintValue[]
  | { readonly [key: string]: FingerprintValue | undefined };

/**
 * Canonical JSON is intentionally small and dependency-free. Object keys are
 * sorted and undefined fields are omitted, so input key order cannot change a
 * finding fingerprint.
 */
export function canonicalJson(value: FingerprintValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item as FingerprintValue)}`)
    .join(',')}}`;
}

/**
 * Callers must pass a redacted context. The function deliberately has no
 * access to a request or provider payload, preventing accidental raw-content
 * fingerprints.
 */
export function stableFingerprint(ruleId: string, context: FingerprintValue): string {
  const source = canonicalJson({ ruleId, context });
  const digest = createHash('sha256').update(source).digest('hex');
  return `h1_${digest.slice(0, 24)}`;
}
