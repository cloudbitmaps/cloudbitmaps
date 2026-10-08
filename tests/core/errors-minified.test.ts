import { build } from 'esbuild';
import { ValidationError, isValidationError } from '@/core/errors';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * An application that bundles the library with a minifier renames its classes, so an error's class name is no longer
 * what it was written as. The predicates (`isWriteConflictError` and the rest) classify an error by its brand and its
 * `name`, and the library's own conflict retries, read heals and not-found handling go through them, so each class
 * carries its name as a literal. This bundles core from source with esbuild's `minify`, as such an application would,
 * and holds every exported error class to its name and its predicate.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the errors under a minifying bundler', () => {
  it('every exported error class keeps its name, and its predicate still classifies it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-minified-'));
    try {
      const outfile = join(dir, 'core.mjs');
      await build({
        entryPoints: [join(ROOT, 'packages', 'core', 'src', 'index.ts')],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'node',
        outfile,
        logLevel: 'silent',
      });
      const core = (await import(pathToFileURL(outfile).href)) as Record<string, unknown>;
      const classes = Object.entries(core).filter(
        ([name, value]) => /^[A-Z]\w*Error$/.test(name) && typeof value === 'function',
      ) as Array<[string, new (message: string) => Error]>;
      expect(classes.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          'ValidationError',
          'WriteConflictError',
          'NotFoundError',
          'TransientError',
        ]),
      );
      // The control: the minifier did rename them, so the checks below cannot pass for want of minification.
      expect(classes.filter(([name, C]) => C.name !== name).length).toBeGreaterThan(0);
      for (const [name, C] of classes) {
        const err = new C('a message');
        expect(err.name, name).toBe(name);
        const predicate = core[`is${name}`];
        if (typeof predicate === 'function')
          expect((predicate as (e: unknown) => boolean)(err), name).toBe(true);
        expect((core.isCloudRoaringError as (e: unknown) => boolean)(err), name).toBe(
          name !== 'Error',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("an application's own subclass keeps the name its class has", () => {
    class TenantRefused extends ValidationError {}
    const err = new TenantRefused('refused');
    expect(err.name).toBe('TenantRefused');
    expect(err).toBeInstanceOf(ValidationError);
    expect(isValidationError(new ValidationError('m'))).toBe(true);
  });
});
