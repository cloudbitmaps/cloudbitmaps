import { describe, expect, it } from 'vitest';

import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import type { CloudRoaringOptions } from '@/index';
import { OPTION_KEYS } from '@/option-keys';
import type { SameKeys } from '../helpers/types';

/**
 * `new CloudRoaring(options)` refuses every key it does not take, at the top level and inside each group, by name:
 * a key it ignored would do nothing and look as if it had. The compiler holds the table it checks against to the
 * option interfaces in both directions, so a new option cannot be refused, and a removed one cannot be let through.
 */
type Listed<G extends keyof typeof OPTION_KEYS> = (typeof OPTION_KEYS)[G][number];

/**
 * Checked by the compiler: `pnpm typecheck` fails when the table and the option's type part, a key declared and not
 * listed, or listed and no longer declared. Each group is read off the type `CloudRoaringOptions` gives it.
 */
const AGREE: {
  readonly top: SameKeys<Listed<'top'>, keyof CloudRoaringOptions>;
  readonly cache: SameKeys<Listed<'cache'>, keyof NonNullable<CloudRoaringOptions['cache']>>;
  readonly encryption: SameKeys<
    Listed<'encryption'>,
    keyof NonNullable<CloudRoaringOptions['encryption']>
  >;
  readonly retry: SameKeys<
    Listed<'retry'>,
    keyof Exclude<NonNullable<CloudRoaringOptions['retry']>, false>
  >;
  readonly budget: SameKeys<
    Listed<'budget'>,
    keyof Exclude<NonNullable<CloudRoaringOptions['budget']>, false>
  >;
  readonly seams: SameKeys<Listed<'seams'>, keyof NonNullable<CloudRoaringOptions['seams']>>;
} = { top: true, cache: true, encryption: true, retry: true, budget: true, seams: true };

function refusal(options: unknown): Error | undefined {
  try {
    new CloudRoaring(options as ConstructorParameters<typeof CloudRoaring>[0]);
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

describe('the option keys the store takes', () => {
  it('are exactly the keys its option interfaces declare, group by group (checked by the compiler)', () => {
    expect(Object.keys(OPTION_KEYS).sort()).toEqual([
      'budget',
      'cache',
      'encryption',
      'retry',
      'seams',
      'top',
    ]);
    expect(Object.values(AGREE).every(Boolean)).toBe(true);
  });

  it('pass: every group filled in, and `retry: false` and `budget: false`', () => {
    const storage = new MemoryStorage();
    expect(
      refusal({
        storage,
        cache: { maxChunks: 10, ttlMs: 1000, genTtlMs: 0, readerMax: 4, readerMaxBytes: 1 << 20 },
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 2,
          backoffFactor: 2,
          jitter: 'none',
          onRetry: () => {},
        },
        budget: { maxRequests: 100 },
        seams: {},
        encryption: {},
        metrics: { emit: () => {} },
      }),
    ).toBeUndefined();
    expect(refusal({ storage, retry: false, budget: false })).toBeUndefined();
  });

  it('refuse any other key at the top level, by name, listing what the store takes', () => {
    const err = refusal({ storage: new MemoryStorage(), maxChunks: 10, registry: {} });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('`maxChunks`, `registry`');
    expect(err?.message).toContain('The store takes `storage`, `cache`');
  });

  it('refuse any other key inside a group, by its path, listing what that group takes', () => {
    const err = refusal({
      storage: new MemoryStorage(),
      cache: { maxChunk: 10 },
      seams: { clok: null },
    });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('`cache.maxChunk`, `seams.clok`');
    expect(err?.message).toContain('`cache` takes `maxChunks`, `ttlMs`');
    expect(err?.message).toContain('`seams` takes `clock`, `rng`');
    expect(err?.message).not.toContain('The store takes');
  });

  it('refuse a top-level key with a dot in it as a top-level key, typed', () => {
    for (const key of ['aws.region', 'constructor.x', 'cache.maxChunks']) {
      const err = refusal({ storage: new MemoryStorage(), [key]: 1 });
      expect(err, key).toBeInstanceOf(ValidationError);
      expect(err?.message, key).toContain(`\`${key}\``);
      expect(err?.message, key).toContain('The store takes');
    }
  });

  it('refuse a group that is not an object, `encryption: true` among them', () => {
    const storage = new MemoryStorage();
    for (const [group, value, got] of [
      ['encryption', true, 'boolean'],
      ['encryption', 'required', 'string'],
      ['cache', 5, 'number'],
      ['cache', [1], 'an array'],
      ['cache', new Map([['maxChunks', 1]]), 'a Map'],
      ['encryption', new Boolean(true), 'a boxed boolean'],
      ['seams', null, 'null'],
      ['retry', true, 'boolean'],
    ] as const) {
      const err = refusal({ storage, [group]: value });
      expect(err, `${group}: ${String(value)}`).toBeInstanceOf(ValidationError);
      expect(err?.message).toContain(`\`${group}\` must be an object`);
      expect(err?.message).toContain(got);
    }
  });

  it('refuse a bag that is not an object, typed', () => {
    expect(refusal(null)).toBeInstanceOf(ValidationError);
    expect(refusal('storage')).toBeInstanceOf(ValidationError);
  });
});
