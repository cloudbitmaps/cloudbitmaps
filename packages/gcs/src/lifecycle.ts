/**
 * The GCS lifecycle check behind `GcsStorage.checkLifecycle`: reads the bucket's metadata (one request) and says whether
 * a lifecycle rule would delete what the store keeps.
 *
 * Everything the store keeps sits under one object-name prefix, and every name ends `.crbm` (a generation) or `.reg`
 * (a registry row). A rule is a **problem** when its action is `Delete`, it applies to live objects (not `isLive: false`
 * and not one of the conditions that only noncurrent versions meet: `numNewerVersions`, `daysSinceNoncurrentTime`,
 * `noncurrentTimeBefore`), and its `matchesPrefix` and `matchesSuffix`, when it has them, can match a name of ours: a
 * prefix and ours are one a prefix of the other, and a suffix and `.crbm` or `.reg` are one a suffix of the other. Any
 * other condition (age, creation date, storage class, a name pattern) is not interpreted and is judged as if it matched,
 * so a rule it would not match can be reported; one that does is never hidden. `SetStorageClass` (even to ARCHIVE, which
 * stays readable) and `AbortIncompleteMultipartUpload` are safe.
 */
import type { Storage } from '@google-cloud/storage';
import type { LifecycleVerdict } from '@cloudbitmaps/core/driver-kit';
import { scrubCredentials } from './scrub-error';

/** The longest the message of a failed request is shown. */
const MAX_MESSAGE = 200;

/** The suffixes of every name the store writes. */
const NAME_SUFFIXES = ['.crbm', '.reg'] as const;

/** Two strings share a prefix relation (one starts with the other). */
const prefixRelated = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
/** Two strings share a suffix relation (one ends with the other). */
const suffixRelated = (a: string, b: string): boolean => a.endsWith(b) || b.endsWith(a);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Conditions only a noncurrent version can meet. */
const NONCURRENT_ONLY = ['numNewerVersions', 'daysSinceNoncurrentTime', 'noncurrentTimeBefore'];

/** Whether `rule` is one that deletes live objects whose name can be one of ours, under `prefix`. */
function deletesOurs(rule: unknown, prefix: string): boolean {
  const { action, condition } = record(rule);
  if (record(action).type !== 'Delete') return false;
  const when = record(condition);
  if (when.isLive === false) return false;
  if (NONCURRENT_ONLY.some((key) => when[key] !== undefined)) return false;
  const prefixes = strings(when.matchesPrefix);
  if (prefixes.length > 0 && !prefixes.some((p) => prefixRelated(p, prefix))) return false;
  const suffixes = strings(when.matchesSuffix);
  return (
    suffixes.length === 0 ||
    suffixes.some((s) => NAME_SUFFIXES.some((ours) => suffixRelated(s, ours)))
  );
}

/**
 * What a bucket's metadata means for a store under `prefix` (`''`, or `trimmed/`). Pure: no request.
 */
function judgeMetadata(metadata: unknown, prefix: string): LifecycleVerdict {
  const rules = record(record(metadata).lifecycle).rule;
  const found = (Array.isArray(rules) ? (rules as unknown[]) : []).filter((r) =>
    deletesOurs(r, prefix),
  );
  if (found.length > 0) {
    return {
      status: 'problem',
      detail:
        `${found.length} bucket lifecycle rule(s) with a Delete action can match objects under ${JSON.stringify(prefix)}: ` +
        `${found.map((r) => JSON.stringify(record(r).condition ?? {}).slice(0, 120)).join('; ')}. ` +
        'The store keeps current objects it must be able to read back: narrow the rule with matchesPrefix to exclude ' +
        'this prefix, or restrict it to noncurrent versions.',
    };
  }
  return {
    status: 'ok',
    detail: `no bucket lifecycle rule deletes live objects under ${JSON.stringify(prefix)}`,
  };
}

/** A failed request as a sentence: the permission to grant for a refusal, the scrubbed error otherwise. */
function unchecked(err: unknown): LifecycleVerdict {
  const scrubbed = scrubCredentials(err);
  const { code, message, name } = record(scrubbed);
  if (code === 403) {
    return {
      status: 'unchecked',
      detail:
        'the identity may not read the bucket metadata: grant storage.buckets.get on the bucket to check its ' +
        'lifecycle rules, or confirm by hand that no rule deletes current objects under this prefix',
    };
  }
  const shown = typeof message === 'string' ? `: ${message.slice(0, MAX_MESSAGE)}` : '';
  const label = typeof name === 'string' ? name : 'Error';
  const status = typeof code === 'number' ? ` ${code}` : '';
  return {
    status: 'unchecked',
    detail: `could not read the bucket metadata (${label}${status}${shown}); check the lifecycle rules by hand`,
  };
}

/** The check: one request, never a throw. */
export async function checkGcsLifecycle(
  client: Storage,
  bucket: string,
  prefix: string,
): Promise<LifecycleVerdict> {
  try {
    const [metadata] = await client.bucket(bucket).getMetadata();
    return judgeMetadata(metadata, prefix);
  } catch (err) {
    try {
      return unchecked(err);
    } catch {
      return { status: 'unchecked', detail: 'could not read the bucket metadata' };
    }
  }
}
