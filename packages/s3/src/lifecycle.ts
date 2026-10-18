/**
 * The S3 lifecycle check behind `S3Storage.checkLifecycle`: reads the bucket's lifecycle configuration (one
 * `GetBucketLifecycleConfiguration` request) and says whether a rule would expire or archive what the store keeps.
 *
 * Everything the store keeps sits under one key prefix: the generation objects at `<prefix><namespace>/segments/…`
 * and the registry rows at `<prefix>registry/…`. A rule is a **problem** when it is enabled, its prefix and ours are
 * one a prefix of the other (a rule on `a/` covers a store under `a/b/`, and a rule on `a/b/registry/` covers part of
 * it), it has no tag filter (the store tags nothing, so a tag-filtered rule never matches), and it expires current
 * objects (`Days` or `Date`) or transitions them to GLACIER or DEEP_ARCHIVE, which cannot be read without a restore.
 * A rule that only expires noncurrent versions, only removes expired delete markers or only aborts incomplete uploads
 * is safe. A rule with a condition this check does not interpret (an object size filter) is judged as if the
 * condition were absent, so it can report a problem for a rule that would not match; it never hides one.
 *
 * A missing rule that aborts incomplete multipart uploads is advice in `detail`, never a problem by itself.
 */
import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import type { LifecycleRule, S3Client } from '@aws-sdk/client-s3';
import type { LifecycleVerdict } from '@cloudbitmaps/core/driver-kit';
import { errorName } from './aws-errors';
import { scrubCredentials } from './scrub-error';

/** The longest the message of a failed request is shown. */
const MAX_MESSAGE = 200;

/** Two key prefixes cover a common key when one starts with the other. */
const overlaps = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** The prefix a rule applies to: the filter's, the filter's `And`, or the legacy rule-level one; none is every key. */
function rulePrefix(rule: LifecycleRule): string {
  return rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? '';
}

const hasTagFilter = (rule: LifecycleRule): boolean =>
  rule.Filter?.Tag !== undefined || (rule.Filter?.And?.Tags?.length ?? 0) > 0;

/** How a rule threatens current objects, or `undefined` when it does not. */
function threat(rule: LifecycleRule): string | undefined {
  if (rule.Expiration?.Days !== undefined || rule.Expiration?.Date !== undefined) {
    return 'expires current objects';
  }
  const archive = rule.Transitions?.find(
    (t) => t.StorageClass === 'GLACIER' || t.StorageClass === 'DEEP_ARCHIVE',
  );
  return archive === undefined ? undefined : `moves current objects to ${archive.StorageClass}`;
}

const label = (rule: LifecycleRule): string => {
  const id = rule.ID === undefined ? '' : `${JSON.stringify(rule.ID.slice(0, 64))} `;
  return `${id}(prefix ${JSON.stringify(rulePrefix(rule))})`;
};

const ABORT_ADVICE =
  'No rule aborts incomplete multipart uploads under this prefix; add one (AbortIncompleteMultipartUpload, a few days) ' +
  'so an upload a crashed writer abandoned stops billing for its parts.';

/**
 * What a bucket's rules mean for a store under `prefix` (`''`, or `trimmed/`, the form every key builder uses).
 * Pure: no request, no SDK object but the rule shape.
 */
function judgeRules(rules: readonly LifecycleRule[], prefix: string): LifecycleVerdict {
  const live = rules.filter((r) => r.Status === 'Enabled' && overlaps(rulePrefix(r), prefix));
  const problems = live
    .filter((r) => !hasTagFilter(r))
    .flatMap((r) => {
      const how = threat(r);
      return how === undefined ? [] : [`rule ${label(r)} ${how}`];
    });
  const advice = live.some((r) => r.AbortIncompleteMultipartUpload !== undefined)
    ? ''
    : ` ${ABORT_ADVICE}`;
  if (problems.length > 0) {
    return {
      status: 'problem',
      detail:
        `${problems.join('; ')}. The store keeps current objects it must be able to read back: narrow the rule's ` +
        `prefix to exclude ${JSON.stringify(prefix)}, or restrict it to noncurrent versions.${advice}`,
    };
  }
  return {
    status: 'ok',
    detail: `no enabled lifecycle rule under ${JSON.stringify(prefix)} expires or archives current objects.${advice}`,
  };
}

/** A failed request as a sentence: the permission to grant for a refusal, the scrubbed error otherwise. */
function unchecked(err: unknown): LifecycleVerdict {
  const scrubbed = scrubCredentials(err);
  if (errorName(scrubbed) === 'AccessDenied') {
    return {
      status: 'unchecked',
      detail:
        'the identity may not read the bucket lifecycle configuration: grant s3:GetLifecycleConfiguration on the ' +
        'bucket to check it, or confirm by hand that no rule expires or archives current objects under this prefix',
    };
  }
  const name = errorName(scrubbed) ?? 'Error';
  const raw = (scrubbed as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? `: ${raw.slice(0, MAX_MESSAGE)}` : '';
  return {
    status: 'unchecked',
    detail: `could not read the bucket lifecycle configuration (${name}${message}); check it by hand`,
  };
}

/** The check: one request, never a throw. */
export async function checkS3Lifecycle(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<LifecycleVerdict> {
  try {
    const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
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
