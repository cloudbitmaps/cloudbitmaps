/**
 * The S3 lifecycle check behind `S3Storage.checkLifecycle`: reads the bucket's lifecycle configuration (one
 * `GetBucketLifecycleConfiguration` request) and says whether a rule would expire or archive what the store keeps.
 *
 * Everything the store keeps sits under one key prefix: the generation objects at `<prefix><namespace>/segments/…`
 * and the registry rows at `<prefix>registry/…`. A rule is a **problem** when it is enabled, its prefix and ours are
 * one a prefix of the other (a rule on `a/` covers a store under `a/b/`, and a rule on `a/b/registry/` covers part of
 * it), it is enabled (a rule with no `Status` is read as enabled), it has no tag filter (the store tags nothing, so a
 * tag-filtered rule never matches), and it expires current objects (`Days` or `Date`) or transitions them to GLACIER or
 * DEEP_ARCHIVE, which cannot be read without a restore, or to a storage class this check does not know. A rule that
 * only expires noncurrent versions, only removes expired delete markers or only aborts incomplete uploads is safe. A
 * rule with a condition this check does not interpret (an object size filter) is judged as if the condition were
 * absent, so it can report a problem for a rule that would not match; it never hides one. When unsure, a problem.
 *
 * Advice in `detail`, never a problem by itself: a missing rule that aborts incomplete multipart uploads over the
 * generation keys; a transition to INTELLIGENT_TIERING (its archive access tiers, if the bucket turns them on, need a
 * restore before a read); a transition to an infrequent-access class or GLACIER_IR (a minimum storage duration and a
 * per-GB retrieval fee).
 *
 * The request honours the backend's `readTimeoutMs`: one that gets no answer in time is `unchecked`.
 */
import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import type { LifecycleRule, S3Client } from '@aws-sdk/client-s3';
import type { LifecycleVerdict } from '@cloudbitmaps/core/driver-kit';
import { TransientError } from '@cloudbitmaps/core/driver-kit';
import { errorName } from './aws-errors';
import { timedRead } from './read-timeout';
import { scrubCredentials } from './scrub-error';

/** The longest the message of a failed request is shown. */
const MAX_MESSAGE = 200;

/** The longest a rule id, a rule prefix or an error name is shown. */
const MAX_FIELD = 64;

/** How many problem rules a `detail` names before it says "and N more". */
export const MAX_NAMED_RULES = 3;

/** Classes an object reads from at once, with no restore. */
const READABLE_CLASSES: ReadonlySet<string> = new Set([
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'GLACIER_IR',
  'INTELLIGENT_TIERING',
]);
const ARCHIVE_CLASSES: ReadonlySet<string> = new Set(['GLACIER', 'DEEP_ARCHIVE']);
const INFREQUENT_CLASSES: ReadonlySet<string> = new Set([
  'STANDARD_IA',
  'ONEZONE_IA',
  'GLACIER_IR',
]);

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** Two key prefixes cover a common key when one starts with the other. */
const overlaps = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** The prefix a rule applies to: the filter's, the filter's `And`, or the legacy rule-level one; none is every key. */
function rulePrefix(rule: LifecycleRule): string {
  return rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? '';
}

const hasTagFilter = (rule: LifecycleRule): boolean =>
  rule.Filter?.Tag !== undefined || (rule.Filter?.And?.Tags?.length ?? 0) > 0;

/** Whether a rule is in force: only an explicit `Disabled` switches it off. */
const isEnabled = (rule: LifecycleRule): boolean => rule.Status !== 'Disabled';

/** How a rule threatens current objects, or `undefined` when it does not. */
function threat(rule: LifecycleRule): string | undefined {
  if (rule.Expiration?.Days !== undefined || rule.Expiration?.Date !== undefined) {
    return 'expires current objects';
  }
  const classes = (rule.Transitions ?? []).map((t) => t.StorageClass);
  const archive = classes.find((c) => c !== undefined && ARCHIVE_CLASSES.has(c));
  if (archive !== undefined) return `moves current objects to ${archive}`;
  const unknown = (rule.Transitions ?? []).find(
    (t) => t.StorageClass === undefined || !READABLE_CLASSES.has(t.StorageClass),
  );
  return unknown === undefined
    ? undefined
    : `moves current objects to ${cut(String(unknown.StorageClass ?? 'no storage class'), MAX_FIELD)}, a storage class this check does not know`;
}

const label = (rule: LifecycleRule): string => {
  const id = rule.ID === undefined ? '' : `${JSON.stringify(cut(rule.ID, MAX_FIELD))} `;
  return `${id}(prefix ${JSON.stringify(cut(rulePrefix(rule), MAX_FIELD))})`;
};

/** Whether an abort-incomplete-upload rule covers generation keys, `<prefix><ns>/segments/…`, not only `<prefix>registry/`. */
function coversGenerations(rule: LifecycleRule, prefix: string): boolean {
  const own = rulePrefix(rule);
  if (prefix.startsWith(own)) return true;
  return !own.slice(prefix.length).startsWith('registry/');
}

const ABORT_ADVICE =
  'No rule aborts incomplete multipart uploads under this prefix; add one (AbortIncompleteMultipartUpload, a few days) ' +
  'so an upload a crashed writer abandoned stops billing for its parts.';

const INTELLIGENT_TIERING_ADVICE =
  'A rule moves current objects to INTELLIGENT_TIERING: if the bucket turns on its archive access tiers, an object in ' +
  'one needs a restore before it can be read, so leave them off for this prefix.';

const INFREQUENT_ADVICE =
  'A rule moves current objects to an infrequent-access class or GLACIER_IR: they stay readable, but each has a ' +
  'minimum storage duration and a per-GB retrieval fee that reads of the store will pay.';

/**
 * What a bucket's rules mean for a store under `prefix` (`''`, or `trimmed/`, the form every key builder uses).
 * Pure: no request, no SDK object but the rule shape.
 */
function judgeRules(rules: readonly LifecycleRule[], prefix: string): LifecycleVerdict {
  const live = rules.filter((r) => isEnabled(r) && overlaps(rulePrefix(r), prefix));
  const untagged = live.filter((r) => !hasTagFilter(r));
  const problems = untagged.flatMap((r) => {
    const how = threat(r);
    return how === undefined ? [] : [`rule ${label(r)} ${how}`];
  });
  const transitionsTo = (classes: ReadonlySet<string>): boolean =>
    untagged.some((r) =>
      (r.Transitions ?? []).some(
        (t) => t.StorageClass !== undefined && classes.has(t.StorageClass),
      ),
    );
  const advice = [
    live.some((r) => r.AbortIncompleteMultipartUpload !== undefined && coversGenerations(r, prefix))
      ? ''
      : ABORT_ADVICE,
    transitionsTo(new Set(['INTELLIGENT_TIERING'])) ? INTELLIGENT_TIERING_ADVICE : '',
    transitionsTo(INFREQUENT_CLASSES) ? INFREQUENT_ADVICE : '',
  ]
    .filter((a) => a !== '')
    .map((a) => ` ${a}`)
    .join('');
  if (problems.length > 0) {
    const named = problems.slice(0, MAX_NAMED_RULES).join('; ');
    const more =
      problems.length > MAX_NAMED_RULES ? ` and ${problems.length - MAX_NAMED_RULES} more` : '';
    const where =
      prefix === ''
        ? 'The store has no prefix, so every bucket-wide or prefixed rule can reach it: give the store a prefix, ' +
          'or scope the rule away from its paths'
        : `Narrow the rule's prefix to exclude ${JSON.stringify(cut(prefix, MAX_FIELD))}`;
    return {
      status: 'problem',
      detail:
        `${named}${more}. The store keeps current objects it must be able to read back. ${where}` +
        `${prefix === '' ? '' : ', or restrict it to noncurrent versions'}.${advice}`,
    };
  }
  return {
    status: 'ok',
    detail: `no enabled lifecycle rule under ${JSON.stringify(cut(prefix, MAX_FIELD))} expires or archives current objects.${advice}`,
  };
}

/** A failed request as a sentence: the permission to grant for a refusal, the scrubbed error otherwise. */
function unchecked(err: unknown): LifecycleVerdict {
  if (err instanceof TransientError) {
    return {
      status: 'unchecked',
      detail:
        'the read of the bucket lifecycle configuration got no answer in time (readTimeoutMs); run the check again',
    };
  }
  const scrubbed = scrubCredentials(err);
  if (errorName(scrubbed) === 'AccessDenied') {
    return {
      status: 'unchecked',
      detail:
        'the identity may not read the bucket lifecycle configuration: grant s3:GetLifecycleConfiguration on the ' +
        'bucket to check it, or confirm by hand that no rule expires or archives current objects under this prefix',
    };
  }
  const name = cut(String(errorName(scrubbed) ?? 'Error'), MAX_FIELD);
  const raw = (scrubbed as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? `: ${raw.slice(0, MAX_MESSAGE)}` : '';
  return {
    status: 'unchecked',
    detail: `could not read the bucket lifecycle configuration (${name}${message}); check it by hand`,
  };
}

/** The check: one request (the SDK may retry it), under `readTimeoutMs` (`0`: none), never a throw. */
export async function checkS3Lifecycle(
  client: S3Client,
  bucket: string,
  prefix: string,
  readTimeoutMs = 0,
): Promise<LifecycleVerdict> {
  try {
    const out = await timedRead('GetBucketLifecycleConfiguration', readTimeoutMs, (options) =>
      client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }), options),
    );
    return judgeRules(out.Rules ?? [], prefix);
  } catch (err) {
    try {
      if (errorName(err) === 'NoSuchLifecycleConfiguration') {
        return judgeRules([], prefix);
      }
      return unchecked(err);
    } catch {
      return { status: 'unchecked', detail: 'could not read the bucket lifecycle configuration' };
    }
  }
}
