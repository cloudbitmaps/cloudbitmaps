import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as core from '@cloudbitmaps/core';
import * as roaring from '@/index';

import {
  checkIndex,
  parsePlaybook,
  runPlaybook,
  sizeOf,
  type IndexedPage,
  type Modules,
} from '../helpers/playbooks';

/**
 * The playbooks in `docs/playbooks/` run, and print what they show.
 *
 * WHY THIS EXISTS. A playbook is a page a reader copies, runs and trusts: invented data end to end, the output they
 * should see, and the limits. A page like that is worth reading only while it still runs. Its code is therefore the
 * code CI runs (the page's fences, in order, as one program: no second copy that can drift), against the package
 * sources on `MemoryStorage`, with no network, no Docker and no `dist/`; the output a page shows is compared exactly with
 * what that run prints; and the doc-sample typecheck gate compiles the same fences as one module per page.
 *
 * WHAT IT HOLDS. Every page opens with a title and a one-sentence summary (a site page is made from them); every fence
 * is marked `<!-- typecheck -->`; a fence that prints is followed by `<!-- output -->` and a `text` fence with exactly
 * what it prints, and a fence that prints nothing has none; the index `docs/playbooks/README.md` has one row for each
 * page and a page for each row, with the size the page's line count gives (S under 150 lines, M to 300, L beyond); and
 * the whole run takes under ten seconds.
 *
 * WHAT IT DOES NOT CLAIM. That a playbook is true of a real cloud backend: it runs on `MemoryStorage`, so latency,
 * request counts and throttling are the guides' to state. Time is not read: a page that prints a figure that depends on
 * the clock or the machine would fail here, so a page does not print one.
 */

const ROOT = join(__dirname, '..', '..');
const MODULES: Modules = { '@cloudbitmaps/roaring': roaring, '@cloudbitmaps/core': core };
const FOLDER = 'docs/playbooks/';

const tracked = execFileSync('git', ['ls-files', `${FOLDER}*.md`], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const pageFiles = tracked.filter((f) => f !== `${FOLDER}README.md`);
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');

describe('the playbooks folder', () => {
  it('has an index and playbooks (the scan must not silently match nothing)', () => {
    expect(tracked).toContain(`${FOLDER}README.md`);
    expect(pageFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('has a page and an index row for each other, with the size the page has', () => {
    const pages: IndexedPage[] = pageFiles.map((f) => {
      const text = read(f);
      return {
        name: f.slice(FOLDER.length),
        title: parsePlaybook(f, text).title,
        lines: text.replace(/\n$/, '').split('\n').length,
      };
    });
    expect(checkIndex(read(`${FOLDER}README.md`), pages)).toEqual([]);
  });

  it('opens every page with a title and a one-sentence summary, and marks every fence', () => {
    const problems = pageFiles.flatMap((f) => parsePlaybook(f, read(f)).problems);
    expect(problems).toEqual([]);
  });

  it('runs every page, and each prints what it shows, in under ten seconds in all', async () => {
    const started = performance.now();
    const problems: string[] = [];
    for (const f of pageFiles) {
      const page = parsePlaybook(f, read(f));
      problems.push(...(await runPlaybook(f, page.parts, MODULES)));
    }
    expect(problems).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe('the gate fires (planted pages)', () => {
  const page = (body: string): string =>
    `# A playbook\n\nA one-sentence summary of what this playbook does.\n\n${body}`;
  const run = async (body: string): Promise<string[]> => {
    const parsed = parsePlaybook('x.md', page(body));
    return [...parsed.problems, ...(await runPlaybook('x.md', parsed.parts, MODULES))];
  };
  const fence = (code: string, output?: string): string =>
    `<!-- typecheck -->\n\`\`\`ts\n${code}\n\`\`\`\n\n${
      output === undefined ? '' : `<!-- output -->\n\`\`\`text\n${output}\n\`\`\`\n\n`
    }`;

  it('passes a page whose code runs and whose output is what it prints', async () => {
    expect(
      await run(
        fence(
          [
            "import { RoaringBitmap } from '@cloudbitmaps/roaring';",
            'const a = new RoaringBitmap([1, 2, 3]);',
            "console.log('size', a.size);",
            'console.log([...a]);',
          ].join('\n'),
          'size 3\n[ 1, 2, 3 ]',
        ) +
          // A second fence uses a name the first declared, awaits at the top level, and prints nothing.
          fence(
            'const b = RoaringBitmap.and(a, new RoaringBitmap([2]));\nawait Promise.resolve(b);',
          ) +
          fence('console.log(b.size);', '1'),
      ),
    ).toEqual([]);
  });

  it('refuses a page whose code throws, naming the line of the fence', async () => {
    const out = await run(fence("throw new Error('boom');"));
    expect(out).toEqual([expect.stringMatching(/^x\.md:\d+ — the code throws Error: boom$/)]);
  });

  it('refuses a page whose shown output differs from what the code prints', async () => {
    const out = await run(fence('console.log(2 + 2);', '5'));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('the output shown differs from what the code prints');
    expect(out[0]).toContain('--- shown\n5\n--- printed\n4');
  });

  it('refuses code that prints with no output fence, and an output fence for code that prints nothing', async () => {
    expect(await run(fence('console.log(1);'))).toEqual([
      expect.stringContaining('the code prints, and no output fence follows it'),
    ]);
    expect(await run(fence('const x = 1;\nvoid x;', '1'))).toEqual([
      expect.stringContaining('the output shown differs'),
    ]);
  });

  it('refuses an output marker with no fence of code before it, a skipped fence and an import it does not provide', async () => {
    expect(await run('<!-- output -->\n```text\n1\n```\n\n' + fence('void 1;'))).toEqual([
      expect.stringContaining('an output marker with no runnable fence right before it'),
    ]);
    expect(
      await run('<!-- typecheck-skip: a fragment of something -->\n```ts\nvoid 1;\n```\n'),
    ).toEqual([
      expect.stringContaining('a playbook has no typecheck-skip'),
      expect.stringContaining('a playbook with no runnable fence'),
    ]);
    expect(await run(fence("import { readFileSync } from 'node:fs';\nvoid readFileSync;"))).toEqual(
      [expect.stringContaining('imports "node:fs", which a playbook may not')],
    );
  });

  it('refuses an "Output:" line with no output fence after it', async () => {
    expect(await run(fence('void 1;') + 'Output:\n\nprose\n')).toEqual([
      expect.stringContaining('"Output:" with no output fence after it'),
    ]);
  });

  it('keeps a legitimate look-alike quiet: output of several arguments, an object, a string with a colon', async () => {
    expect(
      await run(
        fence(
          "console.log('a', 1, true);\nconsole.log({ k: [1, 2] });\nconsole.log('x: y');",
          'a 1 true\n{ k: [ 1, 2 ] }\nx: y',
        ),
      ),
    ).toEqual([]);
  });

  it('refuses a page without the title, or the summary, or with a summary that is not plain', () => {
    const shape = (text: string): string[] =>
      parsePlaybook('x.md', text).problems.filter((p) => !p.includes('no runnable fence'));
    expect(shape('No title\n')).toEqual([
      expect.stringContaining('must open with a "# Title" line'),
    ]);
    expect(shape('# T\n\n## Heading\n')).toEqual([expect.stringContaining('one-sentence summary')]);
    expect(shape('# T\n\nTwo sentences. They are here.\n')).toEqual([
      expect.stringContaining('one sentence that ends with a full stop'),
    ]);
    expect(shape('# T\n\nA summary with `code` in it.\n')).toEqual([
      expect.stringContaining('plain text'),
    ]);
    expect(shape('# T\n\nA fine summary.\n')).toEqual([]);
  });
});

describe('the index check', () => {
  const readme = (rows: string[]): string =>
    `# Playbooks\n\n| Playbook | Does | Uses | Size |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  const pages: IndexedPage[] = [{ name: 'one.md', title: 'One', lines: 90 }];
  const row = (target: string, label = 'One', size = 'S'): string =>
    `| [${label}](${target}) | does a job | an API | ${size} |`;

  it('passes an index whose rows and pages agree', () => {
    expect(checkIndex(readme([row('one.md')]), pages)).toEqual([]);
  });

  it('refuses a row with no file, and a file with no row', () => {
    expect(checkIndex(readme([row('one.md'), row('two.md', 'Two')]), pages)).toEqual([
      expect.stringContaining('the row for two.md names a page that does not exist'),
    ]);
    expect(checkIndex(readme([]), pages)).toEqual(['README.md — no row for one.md']);
  });

  it('refuses a duplicate row, a wrong link text, a wrong size and a malformed row', () => {
    expect(checkIndex(readme([row('one.md'), row('one.md')]), pages)).toEqual([
      'README.md — one.md has 2 rows',
    ]);
    expect(checkIndex(readme([row('one.md', 'Other')]), pages)).toEqual([
      expect.stringContaining('the link text "Other" is not the page\'s title "One"'),
    ]);
    expect(checkIndex(readme([row('one.md', 'One', 'L')]), pages)).toEqual([
      expect.stringContaining('the size of one.md is S (90 lines), the row says L'),
    ]);
    expect(checkIndex(readme(['| [One](one.md) | only two cells |']), pages)).toEqual([
      expect.stringContaining('a row is |'),
      'README.md — no row for one.md',
    ]);
  });

  it('sizes a page by its lines: S under 150, M up to 300, L beyond', () => {
    expect([sizeOf(149), sizeOf(150), sizeOf(300), sizeOf(301)]).toEqual(['S', 'M', 'M', 'L']);
  });
});
