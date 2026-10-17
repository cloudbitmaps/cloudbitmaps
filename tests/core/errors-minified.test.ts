import { build } from 'esbuild';
import * as errors from '@/core/errors';
import { ValidationError, errorKind } from '@/core/errors';
import * as driverKit from '@cloudbitmaps/core/driver-kit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * An application that bundles the library with a minifier renames its classes, so an error's class name is no longer
 * what it was written as. `errorKind` classifies an error by its brand and its
 * `name`, and the library's own conflict retries, read heals and not-found handling go through them, so each class
 * carries its name as a literal. This bundles core from source with esbuild's `minify`, as such an application would,
 * and holds every exported error class to its name and its kind.
 */
/** What every class's constructor can be given: the classes that take more than a message ignore what they do not read. */
const DETAILS = { option: 'maxBufferedBytes', limit: 1, spent: 2 };
type ErrorConstructor = new (message: string, details: typeof DETAILS) => Error;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the errors under a minifying bundler', () => {
  it('every exported error class keeps its name, and errorKind still names it', async () => {
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
      ) as Array<[string, ErrorConstructor]>;
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
        const err = new C('a message', DETAILS);
        expect(err.name, name).toBe(name);
        // Every exported class has a kind, so a caller never has to fall back on `instanceof`.
        expect((core.errorKind as (e: unknown) => unknown)(err), name).toBe(name);
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
    expect(errorKind(new ValidationError('m'))).toBe('ValidationError');
  });

  it("an application's own subclass is not one of the library's: errorKind names the base class", () => {
    class TenantRefused extends errors.UnsupportedError {}
    const err = new TenantRefused('refused');
    expect(errorKind(err)).toBe('CloudRoaringError');
  });
});

describe('errorKind names one class', () => {
  const kinds = Object.entries(errors).filter(
    ([name, value]) =>
      /^[A-Z]\w*Error$/.test(name) && name !== 'CloudRoaringError' && typeof value === 'function',
  ) as Array<[string, ErrorConstructor]>;

  it('for each class, and no other', () => {
    expect(kinds.length).toBeGreaterThan(10);
    for (const [name, C] of kinds) {
      expect(errorKind(new C('m', DETAILS)), name).toBe(name);
      expect(errorKind(new Error('m')), `${name}: Error`).toBeUndefined();
      expect(errorKind({ name }), `${name}: { name }`).toBeUndefined();
    }
  });

  it('the driver kit exports errorKind, and it names every error class the kit exports', () => {
    const exported = Object.entries(driverKit).filter(([name]) =>
      /^[A-Z]\w*Error$/.test(name),
    ) as Array<[string, ErrorConstructor]>;
    expect(exported.length).toBeGreaterThan(0);
    expect(typeof driverKit.errorKind).toBe('function');
    for (const [name, C] of exported)
      expect(driverKit.errorKind(new C('m', DETAILS)), name).toBe(name);
  });
});
