import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { OPTION_KEYS } from '@/option-keys';

/**
 * `new CloudRoaring(options)` refuses every key it does not take, at the top level and inside each group, by name:
 * a key it ignored would do nothing and look as if it had. The table it checks against is held here to the option
 * interfaces in both directions, so a new option cannot be refused, and a removed one cannot be let through.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The keys an interface declares, read from its source with comments stripped; `extends Partial<X>` adds X's. */
function declared(file: string, name: string): Set<string> {
  const code = readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const m = new RegExp(`export interface ${name}\\b([^{]*)\\{([\\s\\S]*?)\\n\\}`).exec(code);
  if (!m) throw new Error(`${file} declares no interface ${name}`);
  const keys = new Set(
    [...(m[2] ?? '').matchAll(/readonly\s+([A-Za-z0-9_]+)\??:/g)].map((k) => k[1] as string),
  );
  const base = /extends Partial<(\w+)>/.exec(m[1] ?? '')?.[1];
  if (base === 'RetryPolicy')
    for (const k of declared('packages/core/src/core/retry.ts', base)) keys.add(k);
  return keys;
}

const ROARING = 'packages/roaring/src/index.ts';
const INTERFACES = {
  top: declared(ROARING, 'CloudRoaringOptions'),
  cache: declared(ROARING, 'CacheOptions'),
  encryption: declared(ROARING, 'EncryptionOptions'),
  retry: declared(ROARING, 'RetryOptions'),
  budget: declared('packages/core/src/core/budget.ts', 'Budget'),
  seams: declared(ROARING, 'SeamOptions'),
};

function refusal(options: unknown): Error | undefined {
  try {
    new CloudRoaring(options as ConstructorParameters<typeof CloudRoaring>[0]);
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

describe('the option keys the store takes', () => {
  it('are exactly the keys its option interfaces declare, group by group', () => {
    expect(Object.keys(OPTION_KEYS).sort()).toEqual(Object.keys(INTERFACES).sort());
    for (const [group, keys] of Object.entries(INTERFACES)) {
      expect(keys.size, group).toBeGreaterThan(0);
      expect(
        [...(OPTION_KEYS[group as keyof typeof OPTION_KEYS] as readonly string[])].sort(),
        group,
      ).toEqual([...keys].sort());
    }
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

  it('refuse a bag that is not an object, typed', () => {
    expect(refusal(null)).toBeInstanceOf(ValidationError);
    expect(refusal('storage')).toBeInstanceOf(ValidationError);
  });
});
