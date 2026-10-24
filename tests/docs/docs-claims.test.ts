import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Install, cache, `RoaringBitmap`, retention-grace and seal-bound claims, held where a rewrite cannot quietly undo
 * them: the install line for the `roaring` package from npm names the version the repo pins, the seal bound does
 * not call itself unreachable, a `RoaringBitmap` is not offered to a method of that package or to `JSON.stringify`
 * as it is, and the retention grace names the window it must outlast.
 *
 * Each reads its file whole with line breaks, a comment's leading `*` and runs of spaces folded to one space, so a sentence the formatter
 * wrapped differently still matches.
 */

const ROOT = join(__dirname, '..', '..');
const read = (file: string): string => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  // A comment's leading `*` is not prose; in Markdown a leading `*` is, so only source files lose it.
  const seam = file.endsWith('.ts') ? /\s*\n[ \t]*(?:\*(?!\/))?[ \t]*/g : /\s*\n[ \t]*/g;
  return text.replace(seam, ' ').replace(/\s+/g, ' ');
};

const roaringPin = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  }
).devDependencies['roaring'];

describe('install, cache, RoaringBitmap and grace claims', () => {
  it('tells a reader of the samples that import roaring the version the samples are tested against, and that any version works', () => {
    expect(roaringPin).toMatch(/^\d+\.\d+\.\d+$/);
    const loading = read('docs/guide/loading.md');
    expect(loading).toContain(
      `\`pnpm add roaring@${roaringPin}\` is the version the samples are tested against, and any version whose bitmaps have \`serialize('portable')\` works`,
    );
    // `@cloudbitmaps/roaring` has no `roaring` dependency: no shared copy, no fast path that depends on a version.
    expect(loading).not.toMatch(
      /share one copy|takes the fast path|version\s+`@cloudbitmaps\/roaring` uses/,
    );
    expect(loading).not.toMatch(/another copy loads as the ids/);
    expect(read('docs/guide/export.md')).toContain('add it to your own `package.json`');
  });

  it('does not tell an installer of @cloudbitmaps/roaring to allow or rebuild a native install script', () => {
    expect(read('README.md')).not.toMatch(/rebuild roaring/);
    expect(read('site/llms.txt')).not.toMatch(/allow `roaring`'s install script/);
    expect(read('docs/guide/production.md')).not.toMatch(
      /native \(C\+\+\) addon|install for the target/,
    );
  });

  it('says the TS2550 report starts when the code imports roaring itself', () => {
    expect(read('docs/guide/getting-started.md')).toContain(
      'reports `TS2550` in its `index.d.ts` as soon as your code imports it',
    );
  });

  it('describes the chunk cache ttlMs in the API reference', () => {
    expect(read('docs/guide/api-reference.md')).toContain(
      '`ttlMs?` (the longest a decoded chunk is kept, in ms, counted from when it was cached',
    );
  });

  it('warns that a RoaringBitmap is not a roaring bitmap and does not serialize to JSON', () => {
    for (const file of ['docs/guide/api-reference.md', 'docs/guide/loading.md']) {
      const text = read(file);
      expect(text, file).toContain('`JSON.stringify([...bitmap])`');
      expect(text, file).toMatch(/to a method of the `roaring` package from npm/);
    }
    expect(read('packages/roaring/src/bitmap.ts')).toContain(
      'Passed to a method of the `roaring` package from npm in place of a `RoaringBitmap32`, it answers wrongly',
    );
  });

  it('names the window the retention grace must outlast, in the guide, the page on correctness and the option', () => {
    expect(read('docs/guide/retention.md')).toContain('**Three bounds to set deliberately.**');
    expect(read('docs/guide/retention.md')).toContain(
      '`tombstoneGraceMs` (default 86,400,000, 24 h)',
    );
    expect(read('docs/guide/correctness.md')).toContain(
      "the grace (`tombstoneGraceMs`) must outlast the longest time a load's write can still reach the registry",
    );
    expect(read('packages/core/src/core/retention-sweep.ts')).toContain(
      "Keep it well above the longest time a first load's registry write can still arrive",
    );
    expect(read('packages/azure-blob/README.md')).toContain(
      "A retention sweep's `tombstoneGraceMs` must stay above that window",
    );
  });

  it('keeps the empty directories a delete leaves in the local-files paragraph', () => {
    expect(read('docs/guide/getting-started.md')).toContain(
      "A delete removes the file and leaves its directory, so a dropped namespace, and the preflight probe's `cbm.due.preflight` folder, stay as empty directories.",
    );
  });
});

describe('the seal bound', () => {
  const unreachable = /far (?:past|beyond) any realistic workload/i;

  it('is not called beyond any realistic workload, where it states the bound', () => {
    for (const file of [
      'docs/guide/correctness.md',
      'docs/guide/encryption.md',
      'packages/core/src/drivers/crypto.ts',
    ]) {
      expect(read(file), file).not.toMatch(unreachable);
    }
  });

  it('gives the full-width figure and what to do before the bound, in all three places', () => {
    for (const file of [
      'docs/guide/correctness.md',
      'docs/guide/encryption.md',
      'packages/core/src/drivers/crypto.ts',
    ]) {
      expect(read(file), file).toContain('65,536-chunk maximum');
      expect(read(file), file).toContain('230 days');
    }
    expect(read('docs/guide/correctness.md')).toMatch(
      /load into a new segment.*or load it less often/,
    );
    expect(read('packages/core/src/drivers/crypto.ts')).toContain(
      'load into a fresh segment, or load less often',
    );
  });

  it('lists a data key per generation as planned work', () => {
    expect(read('docs/ROADMAP.md')).toContain('**A data key per generation.**');
    expect(read('docs/ROADMAP.md')).toContain('decided at the `1.0` format freeze');
  });
});
