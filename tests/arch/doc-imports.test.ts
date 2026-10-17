import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The scanner `scripts/smoke.cjs` finds the docs' imports with, fired at planted inputs in BOTH directions.
 *
 * The smoke test compiles what this finds against the built packages, so a form it misses is a sample nobody
 * compiles: a guide can import a name its package does not export, and the check stays green. A form it matches
 * wrongly is the other failure: a line that is not an import becomes a compile error asserting something false, and
 * the remedy a contributor reaches for is to reword the page. Every form it must read and must pass is planted here,
 * and so is every malformed import it must report rather than skip.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { docImports, docImportPages, pageText, stripMarkup, unparsedImports } = createRequire(
  import.meta.url,
)('../../scripts/doc-imports.cjs') as {
  docImports: (text: string) => Array<{ line: number; specifier: string; statement: string }>;
  docImportPages: (root: string) => string[];
  pageText: (root: string, rel: string) => string;
  stripMarkup: (html: string) => string;
  unparsedImports: (text: string) => Array<{ line: number; text: string }>;
};

const specifiers = (text: string): string[] => docImports(text).map((i) => i.specifier);
const unparsedLines = (text: string): number[] => unparsedImports(text).map((u) => u.line);

describe('the docs-import scanner smoke compiles', () => {
  it('finds an import on one line, across lines, typed, in a list item, in a block quote and after a comment', () => {
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
    expect(specifiers("// For S3 instead: import { S3Storage } from '@cloudbitmaps/s3';")).toEqual([
      '@cloudbitmaps/s3',
    ]);
    expect(
      specifiers("Write `import { CloudRoaring } from '@cloudbitmaps/roaring'` first."),
    ).toEqual(['@cloudbitmaps/roaring']);
    expect(
      specifiers(
        "```ts\nimport { CloudRoaring } from '@cloudbitmaps/roaring';\nimport { S3Storage } from '@cloudbitmaps/s3';\n```",
      ),
    ).toEqual(['@cloudbitmaps/roaring', '@cloudbitmaps/s3']);
  });

  it('finds a namespace import and a default import, which the compiler then holds to the package', () => {
    expect(specifiers("import * as roaring from '@cloudbitmaps/roaring';")).toEqual([
      '@cloudbitmaps/roaring',
    ]);
    expect(specifiers("import roaring from '@cloudbitmaps/roaring';")).toEqual([
      '@cloudbitmaps/roaring',
    ]);
    expect(specifiers("import roaring, { CloudRoaring } from '@cloudbitmaps/roaring';")).toEqual([
      '@cloudbitmaps/roaring',
    ]);
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

  it('passes what it does not read: another scope, a require, a dynamic import, a placeholder in prose', () => {
    expect(specifiers("import { readFileSync } from 'node:fs';")).toEqual([]);
    expect(specifiers("import { thing } from '@other/roaring';")).toEqual([]);
    expect(specifiers("const { CloudRoaring } = require('@cloudbitmaps/roaring');")).toEqual([]);
    expect(specifiers("const m = await import('@cloudbitmaps/roaring');")).toEqual([]);
    expect(specifiers("Every `import { … } from '@cloudbitmaps/…'` line is compiled.")).toEqual([]);
  });

  it('reports a line that starts an import of a workspace package and does not parse', () => {
    // a closing brace missing, on one line and across lines
    expect(
      unparsedLines("```ts\nimport { CloudRoaring from '@cloudbitmaps/roaring';\n```"),
    ).toEqual([2]);
    expect(
      unparsedLines(
        "```ts\nimport {\n  CloudRoaring,\n  MemoryStorage\nfrom '@cloudbitmaps/roaring';\n```",
      ),
    ).toEqual([2]);
    // a brace missing does not run on to a later import's closing brace: that import is still read on its own line
    const two =
      "```ts\nimport { CloudRoaring from '@cloudbitmaps/roaring';\n```\n\nProse.\n\n```ts\nimport { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';\n```";
    expect(unparsedLines(two)).toEqual([2]);
    expect(docImports(two).map((i) => i.line)).toEqual([8]);
    // a closing quote missing
    expect(unparsedLines("import { CloudRoaring } from '@cloudbitmaps/roaring;")).toEqual([1]);
  });

  it('reports nothing for a well-formed import, another scope, or a line of prose that starts with the word', () => {
    expect(unparsedLines("import { CloudRoaring } from '@cloudbitmaps/roaring';")).toEqual([]);
    expect(
      unparsedLines("import type {\n  IStorageDriver,\n} from '@cloudbitmaps/core/driver-kit';"),
    ).toEqual([]);
    expect(unparsedLines("import { readFileSync } from 'node:fs';")).toEqual([]);
    expect(
      unparsedLines('import it from `@cloudbitmaps/core/driver-kit`, as the guide says.'),
    ).toEqual([]);
    expect(
      unparsedLines("Then import { CloudRoaring } from '@cloudbitmaps/roaring' once."),
    ).toEqual([]);
  });

  it('reads an HTML page through its markup, keeping each line where it is', () => {
    const html =
      '<!-- a\ncomment -->\n<pre><code><span class="k">import</span> { CloudRoaring } <span class="k">from</span> <span class="s">&#39;@cloudbitmaps/roaring&#39;</span>;</code></pre>';
    expect(docImports(stripMarkup(html))).toEqual([
      {
        line: 3,
        specifier: '@cloudbitmaps/roaring',
        statement: "import { CloudRoaring } from '@cloudbitmaps/roaring';",
      },
    ]);
    expect(pageText(ROOT, join('site', 'usage.html'))).not.toContain('<span');
    expect(pageText(ROOT, 'README.md')).toBe(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  });

  it('reads the README, every guide page, every package README and the site, and no other page', () => {
    const pages = docImportPages(ROOT);
    expect(pages[0]).toBe('README.md');
    for (const page of [
      join('docs', 'guide', 'getting-started.md'),
      join('docs', 'guide', 'api-reference.md'),
      join('packages', 'roaring', 'README.md'),
      join('packages', 's3', 'README.md'),
      join('site', 'usage.html'),
      join('site', 'flavors', 'roaring.html'),
      join('site', 'llms.txt'),
    ]) {
      expect(pages).toContain(page);
    }
    expect(
      pages.filter((p) => !/^(?:README\.md|docs[/\\]guide[/\\]|packages[/\\]|site[/\\])/.test(p)),
    ).toEqual([]);
  });

  it("finds the docs' imports today, the site's among them, above the floor smoke refuses to run under", () => {
    const smoke = readFileSync(join(ROOT, 'scripts', 'smoke.cjs'), 'utf8');
    const floor = Number(/const FLOOR = (\d+);/.exec(smoke)?.[1]);
    expect(floor).toBeGreaterThan(0);
    const found = docImportPages(ROOT).flatMap((p) =>
      docImports(pageText(ROOT, p)).map((i) => ({ page: p, ...i })),
    );
    expect(found.length).toBeGreaterThanOrEqual(floor);
    expect(found.filter((i) => i.page.startsWith('site')).length).toBeGreaterThan(0);
    expect(docImportPages(ROOT).flatMap((p) => unparsedImports(pageText(ROOT, p)))).toEqual([]);
  });
});
