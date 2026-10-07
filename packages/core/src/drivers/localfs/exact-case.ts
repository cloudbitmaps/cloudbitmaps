/**
 * Exact-case path resolution for the LocalFs drivers.
 *
 * A name keeps its case in a path (`TenantA` and `tenanta` are two names), but a case-insensitive filesystem, the
 * macOS and Windows default, opens one file for both. The drivers therefore resolve the name actually on disk and
 * compare it with the one asked for: a path whose real name differs only by case is not the object asked for, so a
 * read finds nothing and a write is refused. No layout changes, and a case-sensitive filesystem pays nothing: it is
 * detected once, and the check is skipped from then on.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ValidationError } from '@/core/errors';
import { isCode } from './fs-util';

/**
 * The index of the first component of `actual` (the path as it is on disk, relative to the root) that equals the same
 * component of `expected` ignoring case but not exactly, or `-1` when there is none. A component that is a different
 * name altogether, or a path that is longer or shorter, is not a case difference.
 */
export function firstCaseDifference(
  expected: readonly string[],
  actual: readonly string[],
): number {
  const shared = Math.min(expected.length, actual.length);
  for (let i = 0; i < shared; i++) {
    const want = expected[i]!;
    const have = actual[i]!;
    if (want !== have) return want.toLowerCase() === have.toLowerCase() ? i : -1;
  }
  return -1;
}

const swapCase = (s: string): string =>
  [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');

const components = (path: string): string[] => path.split(sep).filter((c) => c !== '');

/** What a path-resolving call needs of the filesystem: the error to refuse a write with. */
export function caseVariantError(): ValidationError {
  return new ValidationError(
    'names differ only by case on a case-insensitive filesystem: a name that differs only by case from one already ' +
      'stored is the same file here, so it is refused rather than written over',
  );
}

export class ExactCase {
  /** `undefined` until the root holds an entry to try; then fixed, as a filesystem does not change its mind. */
  private insensitive: boolean | undefined;

  constructor(private readonly root: string) {}

  /**
   * Whether the root's filesystem folds case, learned from an entry already in the root: the entry's name with its
   * case swapped is the same file or it is not. An empty or absent root holds nothing to alias, so it is not
   * insensitive yet, and is looked at again on the next call.
   */
  private async foldsCase(): Promise<boolean> {
    if (this.insensitive !== undefined) return this.insensitive;
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) return false;
      throw err;
    }
    for (const name of names) {
      const swapped = swapCase(name);
      if (swapped === name) continue;
      const own = await stat(join(this.root, name), { bigint: true }).catch(() => undefined);
      if (own === undefined) continue;
      const other = await stat(join(this.root, swapped), { bigint: true }).catch(() => undefined);
      this.insensitive = other !== undefined && other.ino === own.ino && other.dev === own.dev;
      return this.insensitive;
    }
    return false;
  }

  /**
   * `true` when `path` (inside the root) is, on disk, a path whose name differs only by case from the one given:
   * the deepest part of it that exists is resolved to its real name and compared exactly. A path that does not exist
   * yet, or that nothing differs from, is `false`.
   */
  async differs(path: string): Promise<boolean> {
    if (!(await this.foldsCase())) return false;
    const rootAbs = resolve(this.root);
    let probe = resolve(path);
    let real: string;
    for (;;) {
      if (
        probe === rootAbs ||
        !relative(rootAbs, probe) ||
        relative(rootAbs, probe).startsWith('..')
      ) {
        return false;
      }
      try {
        real = await realpath(probe);
        break;
      } catch (err) {
        if (!isCode(err, 'ENOENT') && !isCode(err, 'ENOTDIR')) throw err;
        probe = dirname(probe);
      }
    }
    const realRoot = await realpath(rootAbs).catch(() => undefined);
    if (realRoot === undefined) return false;
    const actual = relative(realRoot, real);
    // Outside the root once symlinks are resolved: a symlinked directory is outside this model, as the root is.
    if (actual.startsWith('..')) return false;
    return firstCaseDifference(components(relative(rootAbs, probe)), components(actual)) !== -1;
  }

  /** Refuse a write to `path` when its real name differs from it only by case. */
  async refuseVariant(path: string): Promise<void> {
    if (await this.differs(path)) throw caseVariantError();
  }
}
