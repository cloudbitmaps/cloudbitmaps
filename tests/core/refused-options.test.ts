import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { MOVED_OPTIONS } from '@/moved-options';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every option spelling the store does not take, and a caller may still pass, is REFUSED BY NAME rather than
 * ignored: TypeScript rejects each at the call site, but a plain-JS caller, a config that arrived as JSON or an
 * `as` cast gets past it, and every one of these is a knob whose absence is silent and wrong.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The options `CloudRoaringOptions` declares, read from the source with its comments stripped. */
function declaredOptions(): Set<string> {
  const src = readFileSync(join(ROOT, 'packages/roaring/src/index.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body = /export interface CloudRoaringOptions[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
  return new Set([...body.matchAll(/readonly\s+([A-Za-z0-9_]+)\??:/g)].map((m) => m[1] as string));
}

describe('an option spelling the store does not take is refused by name', () => {
  it('reads the declared options, so the check below is not vacuous', () => {
    const declared = declaredOptions();
    expect(declared.has('storage')).toBe(true);
    expect(declared.has('cache')).toBe(true);
  });

  it('no refused spelling is an option the store declares', () => {
    const declared = declaredOptions();
    expect(MOVED_OPTIONS.map(([key]) => key).filter((key) => declared.has(key))).toEqual([]);
  });

  for (const [key, instead] of MOVED_OPTIONS) {
    it(`\`${key}\` is refused, naming what to write instead`, () => {
      const options = {
        storage: new MemoryStorage(),
        [key]: 1,
      } as unknown as ConstructorParameters<typeof CloudRoaring>[0];
      let thrown: unknown;
      try {
        new CloudRoaring(options);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as Error).message).toContain(`\`${key}\``);
      expect((thrown as Error).message).toContain(instead);
    });
  }
});
