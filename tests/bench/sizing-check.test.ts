import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';

/**
 * `pnpm bench:sizing:check` is the gate that holds the sizing guide, the getting-started guide, the explainer, the
 * README and the two charts to the estimator, and CI only ever runs it on pages that pass. This holds it to failing: each case edits the pages the way a
 * regression would and expects the check to refuse. It runs the script itself, in-process over the real tree, with
 * the edited pages laid over it and `@cloudbitmaps/core` served from the source the rest of the suite tests, so it
 * needs no build and writes nothing.
 */
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SCRIPT = join(ROOT, 'bench', 'sizing.cjs');
// Resolves as the script would, so a module it requires beside itself is found where it lives.
const requireFromScript = createRequire(SCRIPT);
const SIZING = 'docs/guide/sizing.md';
const GUIDE = 'docs/guide/getting-started.md';
const page = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run `node bench/sizing.cjs --check` with `pages` (repo-relative path → text) laid over the tree, and the files in
 * `missing` taken out of it; with `write`, run `pnpm bench:sizing` instead, whose writes land in `pages` rather than
 * on disk.
 */
function sizingCheck(
  pages: Record<string, string> = {},
  {
    write = false,
    missing = [],
    mods = {},
    source = (text) => text,
  }: {
    write?: boolean;
    missing?: string[];
    /** Modules served in place of the ones the script requires, by the id it requires them by. */
    mods?: Record<string, unknown>;
    /** An edit to the script itself, for a case no page can reach: a premise the script checks. */
    source?: (text: string) => string;
  } = {},
): { code: number; out: string } {
  const realFs = requireFromScript('node:fs') as typeof import('node:fs');
  const realCp = requireFromScript('node:child_process') as typeof import('node:child_process');
  const rel = (p: unknown): string => relative(ROOT, String(p));
  const fs = {
    ...realFs,
    readFileSync: (p: string, ...rest: unknown[]) =>
      rel(p) in pages
        ? pages[rel(p)]
        : (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
    existsSync: (p: string) =>
      !missing.includes(rel(p)) && (rel(p) in pages || realFs.existsSync(p)),
    writeFileSync: (p: string, data: string) => {
      if (!write) throw new Error('the check must not write');
      pages[rel(p)] = data;
    },
  };
  // A page the tree does not have is tracked too, when git is asked for its kind of file.
  const childProcess = {
    ...realCp,
    execFileSync: (cmd: string, args: string[], options: object) => {
      const out = String(realCp.execFileSync(cmd, args, options));
      const kinds = args.filter((a) => a.startsWith('*.')).map((a) => a.slice(1));
      const extra = Object.keys(pages).filter(
        (p) => !realFs.existsSync(join(ROOT, p)) && kinds.some((k) => p.endsWith(k)),
      );
      return out + extra.map((p) => `${p}\0`).join('');
    },
  };
  const modules: Record<string, unknown> = {
    'node:fs': fs,
    'node:child_process': childProcess,
    '@cloudbitmaps/core': core,
    ...mods,
  };
  const lines: string[] = [];
  const log = (...a: unknown[]): void => {
    lines.push(a.join(' '));
  };
  const proc = {
    argv: ['node', SCRIPT, ...(write ? [] : ['--check'])],
    exit: (code: number): never => {
      throw new Exit(code);
    },
  };
  try {
    new Function(
      'require',
      '__dirname',
      'process',
      'console',
      source(readFileSync(SCRIPT, 'utf8')),
    )((id: string) => modules[id] ?? requireFromScript(id), join(ROOT, 'bench'), proc, {
      log,
      error: log,
      warn: log,
    });
    return { code: 0, out: lines.join('\n') };
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, out: lines.join('\n') };
    return { code: 1, out: `${lines.join('\n')}\n${(e as Error).message}` };
  }
}

describe('bench:sizing:check fails what it exists to catch', () => {
  const sizing = page(SIZING);
  const guide = page(GUIDE);
  const region = (name: string): string => {
    const m = new RegExp(`<!-- SIZING:${name}:START -->[\\s\\S]*?<!-- SIZING:${name}:END -->`).exec(
      sizing,
    );
    if (m === null) throw new Error(`no ${name} region in ${SIZING}`);
    return m[0];
  };
  const refused = (pages: Record<string, string>, message: RegExp) => {
    const r = sizingCheck(pages);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(message);
  };

  it('passes the pages as committed, and a CRLF checkout of them', () => {
    const clean = sizingCheck();
    expect(clean.code, clean.out).toBe(0);
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
    const r = sizingCheck({ [SIZING]: crlf(sizing), [GUIDE]: crlf(guide) });
    expect(r.code, r.out).toBe(0);
  });

  it('fails a generated figure edited by hand', () => {
    expect(sizing).toContain('**$281**');
    refused({ [SIZING]: sizing.replace('**$281**', '**$280**') }, /not what the shipped estimator/);
  });

  it('fails a hand-edited figure in the README, and a hand-edited or missing chart', () => {
    const readme = page('README.md');
    expect(readme).toContain('**90% less**');
    refused(
      { 'README.md': readme.replace('**90% less**', '**91% less**') },
      /README\.md \(WHY_SIZES\)/,
    );
    const CHART = 'bench/bill-as-data-grows.svg';
    const chart = page(CHART);
    refused(
      { [CHART]: chart.replace('as the data grows', 'as data grows') },
      /bill-as-data-grows\.svg/,
    );
    // A chart that is not there is as stale as a wrong one: `--check` must not pass it for want of a file.
    const gone = sizingCheck({}, { write: false, missing: [CHART] });
    expect(gone.code, gone.out).not.toBe(0);
    expect(gone.out).toMatch(/bill-as-data-grows\.svg/);
  });

  it('regenerates a hand-edited page back to exactly what it was', () => {
    // A figure that changes length moves every region after it: each must still be written in its own place.
    expect(sizing).toContain('| 200 MB |');
    const pages = { [SIZING]: sizing.replace('| 200 MB |', '| 200 megabytes |') };
    const r = sizingCheck(pages, { write: true });
    expect(r.code, r.out).toBe(0);
    expect(pages[SIZING]).toBe(sizing);
  });

  it('fails a malformed marker rather than never comparing its region', () => {
    for (const bad of ['<!-- sizing:BILL:START -->', '<!--SIZING:BILL:START-->']) {
      refused({ [SIZING]: `${sizing}\n${bad}\n` }, /malformed marker/);
    }
  });

  it('fails markers that do not pair up, each START with the END of its own name', () => {
    const swapped = sizing
      .replace('<!-- SIZING:BILL:END -->', '<!-- SIZING:X -->')
      .replace('<!-- SIZING:REDIS:END -->', '<!-- SIZING:BILL:END -->')
      .replace('<!-- SIZING:X -->', '<!-- SIZING:REDIS:END -->');
    refused({ [SIZING]: swapped }, /must pair up in order/);
    const endFirst = sizing.replace('<!-- SIZING:BILL:START -->', '<!-- SIZING:BILL:END -->');
    refused({ [SIZING]: endFirst }, /must pair up in order/);
  });

  it('fails a region nothing writes, a region twice, and a region gone', () => {
    const nope = '<!-- SIZING:NOPE:START -->\n<!-- SIZING:NOPE:END -->';
    refused({ [SIZING]: `${sizing}\n${nope}\n` }, /holds a SIZING:NOPE region nothing writes/);
    refused({ [SIZING]: `${sizing}\n${region('PREFIX')}\n` }, /exactly one SIZING:PREFIX region/);
    refused({ [SIZING]: sizing.replace(region('BILL'), '') }, /exactly one SIZING:BILL region/);
  });

  it('fails a region in a page it does not write, markdown or HTML', () => {
    for (const stray of ['docs/stray.md', 'site/stray.html']) {
      refused(
        { [stray]: '<p>\n<!-- SIZING:BILL:START -->\n</p>\n' },
        /holds SIZING regions, but DOCS does not list it/,
      );
    }
  });

  describe('the prose around the regions, and what the pages show', () => {
    const WHY = 'docs/guide/why-cloudbitmaps.md';
    const README = 'README.md';
    const why = page(WHY);
    const readme = page(README);

    it('fails a figure typed outside the regions of a page that says its figures are generated', () => {
      const cases: Array<[string, string]> = [
        [WHY, why.replace('mostly cold.', 'mostly cold: $99,999 a month.')],
        [WHY, why.replace('**Overlap.**', '**Overlap.** Each costs 5 + 3k GETs.')],
        [
          README,
          readme.replace('Where it loses:', 'It is 95% cheaper at every size. Where it loses:'),
        ],
        [
          SIZING,
          sizing.replace(
            '## The three workloads',
            'It saves 12× over Redis.\n\n## The three workloads',
          ),
        ],
      ];
      for (const [doc, text] of cases) {
        refused({ [doc]: text }, /outside its SIZING regions/);
      }
    });

    it("reads only the README's Why section, and a link's address is not a figure", () => {
      // The rest of the README quotes measured figures, which the site figures gate holds to their sources.
      const elsewhere = readme.replace(
        '## Your data stays yours',
        '## Your data stays yours\n\nIt cost $1.23.',
      );
      expect(sizingCheck({ [README]: elsewhere }).code).toBe(0);
      const linked = why.replace('[How it works]', '[How it works, in 95% of cases]');
      refused({ [WHY]: linked }, /outside its SIZING regions/);
      // A figure in a link's address is not on the page: this one passes.
      const address = why.replace(
        'has the rest.',
        'has the rest, and [AWS](https://aws.amazon.com/?off=20%) its own.',
      );
      const r = sizingCheck({ [WHY]: address });
      expect(r.code, r.out).toBe(0);
    });

    // However a figure is spelled, it is one: in an entity, in words, or as a count of requests.
    it.each([
      ['&#36;5 a month'],
      ['&dollar;7 a month'],
      ['90&percnt; less'],
      ['90&#37; less'],
      ['3&times; as much'],
      ['66x as much'],
      ['90 percent less'],
      ['66 times as much'],
      ['USD 21,445 a month'],
      ['$  5 a month'],
      ['4+2k GETs'],
      ['4,140 GETs a second'],
    ])('fails %j typed outside a region, however it is spelled', (figure) => {
      refused(
        { [WHY]: why.replace('mostly cold.', `mostly cold: ${figure}.`) },
        /outside its SIZING regions/,
      );
    });

    // And what only looks like one is not: a version, and an address wherever markdown or HTML keeps one.
    it.each([
      ['a version', 'has the rest, from 0.9.x on.'],
      [
        'a link with parentheses',
        'has the rest, and [the paper](https://example.org/Roaring_(2016)_50%) more.',
      ],
      ['a reference definition', 'has the rest.\n\n[aws]: https://aws.amazon.com/?off=20%\n'],
      ['an autolink', 'has the rest, and <https://aws.amazon.com/?off=20%> more.'],
      ['a bare address', 'has the rest, and https://example.org/a%20b/50% more.'],
      ['an attribute', 'has the rest. <img width="50%" src="x.png" alt="">'],
    ])('passes %s', (_what, text) => {
      const r = sizingCheck({ [WHY]: why.replace('has the rest.', text) });
      expect(r.code, r.out).toBe(0);
    });

    it('holds the rest of the README to the shares and multiples it lists, wherever the Why section ends', () => {
      // Above the section, where no region is: refused, as a share it does not list.
      refused(
        {
          [README]: readme.replace(
            '## Why CloudBitmaps',
            'It costs 90% less.\n\n## Why CloudBitmaps',
          ),
        },
        /states "90%" outside its "Why CloudBitmaps" section/,
      );
      // A `## ` quoted in a fence is not a heading, so the section runs on past it, and a figure after it is still in it.
      refused(
        {
          [README]: readme
            .replace(
              '## Why CloudBitmaps\n',
              '## Why CloudBitmaps\n\n```text\n## not a heading\n```\n',
            )
            .replace('Where it loses:', 'It is 95% cheaper. Where it loses:'),
        },
        /states "95%" outside its SIZING regions, in its "Why CloudBitmaps" section/,
      );
      // A real heading does end it, and what follows is held to the list.
      refused(
        {
          [README]: readme.replace(
            'Where it loses:',
            '## What it saves\n\nIt is 95% cheaper.\n\nWhere it loses:',
          ),
        },
        /states "95%" outside its "Why CloudBitmaps" section/,
      );
      // And a region moved out of the section is refused, rather than left where no rule reads its neighbours.
      const cut = /<!-- SIZING:WHY_CAVEATS:START -->[\s\S]*?<!-- SIZING:WHY_CAVEATS:END -->\n/.exec(
        readme,
      )![0];
      refused(
        {
          [README]: readme
            .replace(cut, '')
            .replace('## Why CloudBitmaps', `${cut}\n## Why CloudBitmaps`),
        },
        /WHY_CAVEATS region sits outside its "Why CloudBitmaps" section/,
      );
    });

    it('fails a chart shown only through <source srcset>, or as a PNG in a folder under bench/', () => {
      const shown = (src: string, dark: string) =>
        `${why}\n<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="../../${dark}">\n` +
        `  <img alt="x" src="../../${src}">\n</picture>\n`;
      refused(
        {
          'bench/hand-dark.svg': '<svg/>',
          [WHY]: shown('bench/bill-as-data-grows.svg', 'bench/hand-dark.svg'),
        },
        /hand-dark\.svg, which no generator draws/,
      );
      refused(
        { 'bench/charts/x.png': 'png', [WHY]: `${why}\n![x](../../bench/charts/x.png)\n` },
        /bench\/charts\/x\.png, which no generator draws/,
      );
    });

    it('fails an image from bench/ that nothing draws, and passes the benchmarks chart', () => {
      refused(
        { 'bench/hand.svg': '<svg/>', [WHY]: `${why}\n![x](../../bench/hand.svg)\n` },
        /no generator draws/,
      );
      expect(sizingCheck({ [WHY]: `${why}\n![x](../../bench/crossover.svg)\n` }).code).toBe(0);
    });

    it('fails a region that another page owns', () => {
      refused(
        { [SIZING]: `${sizing}\n<!-- SIZING:HOT:START -->\n<!-- SIZING:HOT:END -->\n` },
        /which DOCS puts in docs\/guide\/why-cloudbitmaps\.md/,
      );
    });

    it('ignores a marker quoted in code, and still sees a real one beside it', () => {
      const quoted = `${sizing}\n\`<!-- SIZING:NOPE:START -->\`\n\n\`\`\`md\n<!-- SIZING:NOPE:END -->\n\`\`\`\n`;
      const ok = sizingCheck({ [SIZING]: quoted });
      expect(ok.code, ok.out).toBe(0);
      refused({ [SIZING]: `${quoted}\n<!-- SIZING:NOPE:START -->\n` }, /pair up in order/);
    });

    it('writes a region inside a blockquote with every line of it still in the quote', () => {
      const { withRegions } = requireFromScript('./lib/sizing-markers.cjs') as {
        withRegions: (doc: string, text: string, regions: object, docs: object) => { text: string };
      };
      const quoted = '> <!-- SIZING:X:START -->\n> <!-- SIZING:X:END -->\n';
      const { text } = withRegions('q.md', quoted, { X: 'a\n\nb' }, { 'q.md': ['X'] });
      expect(text).toBe('> <!-- SIZING:X:START -->\n> a\n>\n> b\n> <!-- SIZING:X:END -->\n');
    });

    it('fails text before a START marker on its line', () => {
      const moved = why.replace(
        '<!-- SIZING:WHY_ROOM:START -->',
        'Room: <!-- SIZING:WHY_ROOM:START -->',
      );
      refused({ [WHY]: moved }, /must begin its line/);
    });

    it('fails a chart CHARTS lists that nothing draws', () => {
      const lists = requireFromScript('./lib/sizing-pages.cjs') as {
        DOCS: object;
        CHARTS: string[];
      };
      const r = sizingCheck(
        {},
        {
          mods: {
            './lib/sizing-pages.cjs': { ...lists, CHARTS: [...lists.CHARTS, 'bench/extra.svg'] },
          },
        },
      );
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(
        /charts drawn are not the ones CHARTS lists.*listed but not drawn \[bench\/extra\.svg\]/,
      );
    });

    it('passes a CRLF checkout of the explainer, the README and every chart', () => {
      const lists = requireFromScript('./lib/sizing-pages.cjs') as { CHARTS: string[] };
      const crlf = (rel: string): [string, string] => [rel, page(rel).replace(/\n/g, '\r\n')];
      const r = sizingCheck(Object.fromEntries([WHY, README, ...lists.CHARTS].map(crlf)));
      expect(r.code, r.out).toBe(0);
    });
  });

  describe('what the pages say of the deployments, held as premises', () => {
    it.each([
      [
        'the hot dashboard no longer losing',
        (t: string) =>
          t.replace(
            'const HOT = { sizeBytes: 5e9, perSec: 100 };',
            'const HOT = { sizeBytes: 5e9, perSec: 1 };',
          ),
        /hot dashboard no longer loses/,
      ],
      [
        // Two a second loses to Redis, but by less than the multiple the pages claim: only the 2× itself refuses it.
        'the hot dashboard losing by less than a multiple',
        (t: string) =>
          t.replace(
            'const HOT = { sizeBytes: 5e9, perSec: 100 };',
            'const HOT = { sizeBytes: 5e9, perSec: 2 };',
          ),
        /hot dashboard no longer loses to Redis by a multiple/,
      ],
      [
        'segments larger than their chunks can hold',
        (t: string) => t.replace('segmentBytes: 10 * MB,', 'segmentBytes: 20 * MB,'),
        /large deployment's segments are larger than 2,000 full chunks can hold/,
      ],
      [
        // Four a second is past the medium deployment's whole-bill break-even of 3.9, and still under the 4.2 the
        // chart's line gives cold intersects alone: only the room the pages claim is gone.
        'a deployment with no room left',
        (t: string) =>
          t.replace(
            'intersectsPerMonth: 2_628_000, // one a second',
            'intersectsPerMonth: 10_512_000, // one a second',
          ),
        /medium deployment's bill already meets its Redis/,
      ],
    ])('fails %s rather than printing it', (_name, edit, message) => {
      const r = sizingCheck({}, { source: edit });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(message);
    });

    // Two premises only a different model can break, so each is tested against one: an estimator wrapped to price
    // things as the current one does not.
    it('fails a deployment above the line, as it would be if cached intersects cost less than cold ones', () => {
      // With intersects half price whenever a cache is in play, the medium deployment's whole-bill break-even moves
      // past the chart's line, where the room it is given still holds: only the line's own premise refuses it.
      const halved = {
        ...core,
        estimateCost: (input: Parameters<typeof core.estimateCost>[0]) => {
          const r = core.estimateCost(input);
          if (!input.workload?.cacheHitRate) return r;
          const cut = r.monthlyUSD.byOp.intersects / 2;
          return {
            ...r,
            monthlyUSD: {
              ...r.monthlyUSD,
              byOp: { ...r.monthlyUSD.byOp, intersects: cut },
              total: r.monthlyUSD.total - cut,
            },
          };
        },
      };
      const r = sizingCheck(
        {},
        {
          mods: { '@cloudbitmaps/core': halved },
          source: (t) =>
            t.replace(
              'intersectsPerMonth: 2_628_000, // one a second',
              'intersectsPerMonth: 11_826_000, // one a second',
            ),
        },
      );
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/medium deployment is no longer below the line the chart draws/);
    });

    it('fails bills that cross back inside the chart, where the pages say they cross once', () => {
      const cheapPast10TB = {
        ...core,
        estimateCost: (input: Parameters<typeof core.estimateCost>[0]) => {
          const r = core.estimateCost(input);
          const size = input.segments.reduce((a, g) => a + (g.sizeBytes ?? 0) * (g.count ?? 1), 0);
          return size > 1e13 ? { ...r, redisBaseline: { ...r.redisBaseline, monthlyUSD: 1 } } : r;
        },
      };
      const r = sizingCheck({}, { mods: { '@cloudbitmaps/core': cheapPast10TB } });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/cross more than once/);
    });
  });
});
