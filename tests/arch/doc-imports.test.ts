import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The scanner `scripts/smoke.cjs` finds the docs' imports with, fired at planted inputs in BOTH directions.
 *
 * The smoke test compiles what this finds against the built packages, so a form it misses is a sample nobody
 * compiles: a guide can import a name the package no longer exports, and the check stays green. A form it matches
 * wrongly is the other failure: a line that is not an import becomes a compile error asserting something false, and
 * the remedy a contributor reaches for is to reword the page. Every form it must read and must pass is planted here.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { docImports, docImportPages } = createRequire(import.meta.url)(
  '../../scripts/doc-imports.cjs',
) as {
  docImports: (text: string) => Array<{ line: number; specifier: string; statement: string }>;
  docImportPages: (root: string) => string[];
};

const specifiers = (text: string): string[] => docImports(text).map((i) => i.specifier);

describe('the docs-import scanner smoke compiles', () => {
  it('finds an import on one line, across lines, typed, in a list item and in a block quote', () => {
    expect(specifiers("import { CloudRoaring } from '@cloudbitmaps/roaring';")).toEqual([
      '@cloudbitmaps/roaring',
    ]);
    expect(
      specifiers('import type {\n  IStorageDriver,\n} from "@cloudbitmaps/core/driver-kit"'),
    ).toEqual(['@cloudbitmaps/core/driver-kit']);
    expect(
      specifiers("1. Run it:\n\n   import { destroySegment } from '@cloudbitmaps/roaring';"),
    ).toEqual(['@cloudbitmaps/roaring']);
    expect(specifiers("> import { S3Storage } from '@cloudbitmaps/s3';")).toEqual([
      '@cloudbitmaps/s3',
    ]);
    expect(
      specifiers(
        "```ts\nimport { CloudRoaring } from '@cloudbitmaps/roaring';\nimport { S3Storage } from '@cloudbitmaps/s3';\n```",
      ),
    ).toEqual(['@cloudbitmaps/roaring', '@cloudbitmaps/s3']);
  });

  it('reports the line an import starts on, and the statement as a reader copies it', () => {
    expect(
      docImports(
        "# Title\n\n```ts\n  > import {\n  >   CloudRoaring,\n  >   type SegmentRef,\n  > } from '@cloudbitmaps/roaring';\n```",
      ),
    ).toEqual([
      {
        line: 4,
        specifier: '@cloudbitmaps/roaring',
        statement: "import {\nCloudRoaring,\ntype SegmentRef,\n} from '@cloudbitmaps/roaring';",
      },
    ]);
  });

  it('passes what it does not read: another scope, a default or namespace import, a require, an import mid-sentence', () => {
    expect(specifiers("import { readFileSync } from 'node:fs';")).toEqual([]);
    expect(specifiers("import { thing } from '@other/roaring';")).toEqual([]);
    expect(specifiers("import roaring from '@cloudbitmaps/roaring';")).toEqual([]);
    expect(specifiers("import * as roaring from '@cloudbitmaps/roaring';")).toEqual([]);
    expect(specifiers("const { CloudRoaring } = require('@cloudbitmaps/roaring');")).toEqual([]);
    expect(
      specifiers("Write `import { CloudRoaring } from '@cloudbitmaps/roaring'` first."),
    ).toEqual([]);
  });

  it('reads the README, every guide page and every package README, and no other page', () => {
    const pages = docImportPages(ROOT);
    expect(pages[0]).toBe('README.md');
    for (const page of [
      join('docs', 'guide', 'getting-started.md'),
      join('docs', 'guide', 'api-reference.md'),
      join('packages', 'roaring', 'README.md'),
      join('packages', 's3', 'README.md'),
    ]) {
      expect(pages).toContain(page);
    }
    expect(
      pages.filter((p) => !/^(?:README\.md|docs[/\\]guide[/\\]|packages[/\\])/.test(p)),
    ).toEqual([]);
  });

  it("finds the docs' imports today, above the floor smoke refuses to run under", () => {
    const smoke = readFileSync(join(ROOT, 'scripts', 'smoke.cjs'), 'utf8');
    const floor = Number(/const FLOOR = (\d+);/.exec(smoke)?.[1]);
    expect(floor).toBeGreaterThan(0);
    const found = docImportPages(ROOT).flatMap((p) =>
      docImports(readFileSync(join(ROOT, p), 'utf8')),
    );
    expect(found.length).toBeGreaterThanOrEqual(floor);
  });
});
