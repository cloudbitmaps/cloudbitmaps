/**
 * The GCS lifecycle check behind `GcsStorage.checkLifecycle`: reads the bucket's metadata (one request) and says whether
 * a lifecycle rule would delete what the store keeps.
 *
 * Everything the store keeps sits under one object-name prefix, and every name ends `.crbm` (a generation) or `.reg`
 * (a registry row). A rule is a **problem** when its action is `Delete` (or one this check does not know), it applies
 * to live objects (not `isLive: false` and not one of the conditions that only noncurrent versions meet:
 * `numNewerVersions` of 1 or more, which a live object never meets because none is newer than it, and
 * `daysSinceNoncurrentTime` and `noncurrentTimeBefore` at any value, because a live object has no noncurrent time), and its `matchesPrefix` and `matchesSuffix`, when it has them, can match a name of ours: a
 * prefix and ours are one a prefix of the other, and a suffix and `.crbm` or `.reg` are one a suffix of the other. Any
 * other condition (age, creation date, storage class, a name pattern) is not interpreted and is judged as if it matched,
 * so a rule it would not match can be reported; one that does is never hidden. `SetStorageClass` (even to ARCHIVE, which
 * stays readable) and `AbortIncompleteMultipartUpload` are safe.
 */
import type { Storage } from '@google-cloud/storage';
import type { LifecycleVerdict } from '@cloudbitmaps/core/driver-kit';
import { ReadTimedOut, startDeadline, withDeadline } from './read-timeout';
import { scrubCredentials } from './scrub-error';

/** The longest the message of a failed request is shown. */
const MAX_MESSAGE = 200;

/** The longest an error name, a prefix or a rule's condition is shown. */
const MAX_FIELD = 64;
const MAX_CONDITION = 120;

/** How many problem rules a `detail` names before it says "and N more". */
export const MAX_NAMED_RULES = 3;

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** Actions that leave every object readable. Any other action type is judged like a `Delete`. */
const SAFE_ACTIONS: ReadonlySet<string> = new Set([
  'SetStorageClass',
  'AbortIncompleteMultipartUpload',
]);

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

/** Conditions only a noncurrent version can meet, at any value: a live object has no noncurrent time. */
const NONCURRENT_ONLY = ['daysSinceNoncurrentTime', 'noncurrentTimeBefore'];

/**
 * Whether a live object can meet the condition `numNewerVersions`: it holds when at least that many newer versions
 * exist, and a live object has none, so only a 0 matches it (a value that is not a number is judged as met).
 */
const metByLiveObject = (value: unknown): boolean => typeof value !== 'number' || value < 1;

/** The action type of a rule, or `undefined` when it names none. */
const actionOf = (rule: unknown): string | undefined => {
  const type = record(record(rule).action).type;
  return typeof type === 'string' && type !== '' ? type : undefined;
};

/** Whether `rule` has an action that deletes or is not known to be safe, and applies to live objects whose name can be one of ours, under `prefix`. */
function deletesOurs(rule: unknown, prefix: string): boolean {
  const type = actionOf(rule);
  if (type === undefined || SAFE_ACTIONS.has(type)) return false;
  const when = record(record(rule).condition);
  if (when.isLive === false) return false;
  if (NONCURRENT_ONLY.some((key) => when[key] !== undefined)) return false;
  if (!metByLiveObject(when.numNewerVersions)) return false;
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
    const named = found
      .slice(0, MAX_NAMED_RULES)
      .map(
        (r) =>
          `${actionOf(r)} when ${cut(JSON.stringify(record(r).condition ?? {}), MAX_CONDITION)}`,
      )
      .join('; ');
    const more =
      found.length > MAX_NAMED_RULES ? ` and ${found.length - MAX_NAMED_RULES} more` : '';
    return {
      status: 'problem',
      detail:
        `${found.length} bucket lifecycle rule(s) with a Delete action, or one this check does not know, can match objects under ${JSON.stringify(cut(prefix, MAX_FIELD))}: ` +
        `${named}${more}. ` +
        'The store keeps current objects it must be able to read back: narrow the rule with matchesPrefix to exclude ' +
        'this prefix, or restrict it to noncurrent versions.',
    };
  }
  return {
    status: 'ok',
    detail: `no bucket lifecycle rule deletes live objects under ${JSON.stringify(cut(prefix, MAX_FIELD))}`,
  };
}

/** A failed request as a sentence: the permission to grant for a refusal, the scrubbed error otherwise. */
function unchecked(err: unknown): LifecycleVerdict {
  if (err instanceof ReadTimedOut) {
    return {
      status: 'unchecked',
      detail:
        'the read of the bucket metadata got no answer in time (readTimeoutMs); run the check again',
    };
  }
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
  const label = typeof name === 'string' ? cut(name, MAX_FIELD) : 'Error';
  const status = typeof code === 'number' ? ` ${code}` : '';
  return {
    status: 'unchecked',
    detail: `could not read the bucket metadata (${label}${status}${shown}); check the lifecycle rules by hand`,
  };
}

/** The check: one request (the SDK may retry it), under `readTimeoutMs` (`0`: none), never a throw. */
export async function checkGcsLifecycle(
  client: Storage,
  bucket: string,
  prefix: string,
  readTimeoutMs = 0,
): Promise<LifecycleVerdict> {
  try {
    const [metadata] = await withDeadline(
      () => client.bucket(bucket).getMetadata(),
      startDeadline(readTimeoutMs, 'bucket metadata read'),
    );
    return judgeMetadata(metadata, prefix);
  } catch (err) {
    try {
      return unchecked(err);
    } catch {
      return { status: 'unchecked', detail: 'could not read the bucket metadata' };
    }
  }
}
