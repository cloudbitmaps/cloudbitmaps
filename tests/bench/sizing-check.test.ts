import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';

/**
 * `pnpm bench:sizing:check` is the gate that holds the sizing guide, the cost guide, the explainer, the
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
const GUIDE = 'docs/guide/cost.md';
const page = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
/**
 * The script prices the same few thousand workloads on every run, and every case below runs it, so the prices are the
 * bulk of a run. `estimateCost` is a pure function of its input, so a result is kept by the input that made it. It is
 * kept frozen: the script is strict, so a change it tried to make to a shared result would throw rather than reach
 * the next case. A case that serves another estimator through `mods` does not go through this, and every page and
 * figure a case edits is still compared with the estimator's own answer.
 */
const priced = new Map<string, ReturnType<typeof core.estimateCost>>();
const cachedCore: typeof core = {
  ...core,
  estimateCost: (input) => {
    // A non-finite number would otherwise print as `null`, the same key as an input that has a `null` there.
    const key = JSON.stringify(input, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isFinite(v) ? { nonFinite: String(v) } : v,
    );
    let report = priced.get(key);
    if (report === undefined) {
      report = deepFreeze(core.estimateCost(input));
      priced.set(key, report);
    }
    return report;
  },
};
// What git lists is the tree as committed, which the cases never change (they lay pages over it).
const listed = new Map<string, string>();

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
      const listKey = JSON.stringify([cmd, args]);
      if (!listed.has(listKey))
        listed.set(listKey, String(realCp.execFileSync(cmd, args, options)));
      const out = listed.get(listKey)!;
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
    '@cloudbitmaps/core': cachedCore,
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
    // However it is cased, spaced or separated: a marker only one spelling of which is read would hide the others.
    for (const bad of [
      '<!-- sizing:BILL:START -->',
      '<!--SIZING:BILL:START-->',
      '<!--SIZING_BILL:START-->',
      '<!-- SIZING-BILL-START -->',
      '<!--  SIZING:BILL:START -->',
      '<!--\tSIZING:BILL:START -->',
    ]) {
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
    const guideText = page(GUIDE);
    /** The explainer with `text` written into it by hand, where no region is. */
    const intoWhy = (text: string): string => {
      const edited = why.replace('has the rest.', () => `has the rest.${text}`); // a function: `$&` is text here
      expect(edited).not.toBe(why);
      return edited;
    };
    const F = ' The large deployment costs $99,999 a month.';

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

    it("reads only the README's Why section, and passes only the link targets it lists", () => {
      // The rest of the README quotes measured figures, which the site figures gate holds to their sources.
      const elsewhere = readme.replace(
        '## Your data stays yours',
        '## Your data stays yours\n\nIt cost $1.23.',
      );
      expect(sizingCheck({ [README]: elsewhere }).code).toBe(0);
      const linked = why.replace('[How it works]', '[How it works, in 95% of cases]');
      refused({ [WHY]: linked }, /holds a number, "95%", outside its SIZING regions/);
      // A target the list names is not shown, and passes; its digits anywhere else, or any other target's, do not.
      for (const text of [
        ' See [what S3 sends](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html).',
        ' See [the storage classes](https://aws.amazon.com/s3/storage-classes/).',
      ]) {
        const r = sizingCheck({ [WHY]: intoWhy(text) });
        expect(r.code, r.out).toBe(0);
      }
      for (const text of [
        ' See [AWS](https://aws.amazon.com/?off=20%).',
        ' See [the guide](getting-started.md#12-other).',
        ' See [the storage classes](https://aws.amazon.com/s3/storage-classes/#2).',
        ' It is https://aws.amazon.com/s3/storage-classes/.',
        ' See (https://aws.amazon.com/s3/storage-classes/).',
        ' See [the prices](https://aws.amazon.com/s3/pricing/).',
        ' See [the guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html).',
      ]) {
        refused({ [WHY]: intoWhy(text) }, /holds a number, .*outside its SIZING regions/);
      }
    });

    // A reading that exempts a link's target wherever `](` begins one lets each of these through, and each shows
    // its digits: a target is exempt only when the list names it, whole.
    it.each([
      ['a code span holding a link', ' It costs `[x](85,509)` a month.'],
      ['escaped brackets', ' It costs \\[x\\](85,509) a month.'],
      ['a ] with no [', ' It costs ](85,509) a month.'],
      ['indented code', '\n\n    all in memory   [x](85,509) a month\n'],
      [
        'a table row split by | inside a "target"',
        '\n\n| a | b | c |\n|---|---|---:|\n| Large |](|85,509|)|\n',
      ],
      ['a footnote reference before (…)', ' It costs [^m](85,509) a month.'],
    ])('refuses the digits of a "target" in %s, which a reader is shown', (_what, text) => {
      refused({ [WHY]: intoWhy(text) }, /holds a number, .*outside its SIZING regions/);
    });

    // The check catches the drift an honest edit makes: a figure typed by hand, however it is spelled, marked up or
    // split. It is not built to stop someone writing one on purpose in a form it has never seen; on the three pages
    // whose figures are all generated it refuses what it cannot read instead, so the forms it knows are few there.
    describe('a drift check, closed where it can be', () => {
      /** The rest of the README, below its Why section, with `text` written into it. */
      const intoRest = (text: string): string => {
        const edited = readme.replace(
          '## Your data stays yours',
          () => `## Your data stays yours\n\n${text}\n`,
        );
        expect(edited).not.toBe(readme);
        return edited;
      };

      it.each([
        ['&pound', ' Its Redis bills &pound forty a month.'],
        ['&times', ' Redis costs 12&times as much.'],
        ['&frac14', ' It costs &frac14 as much.'],
        ['&nbsp', ' It is cheap&nbsp&nbsp enough.'],
        ['&cent', ' It costs a &cent.'],
        ['&not', ' It is &notin the bill.'],
      ])('refuses %s with no semicolon, which GitHub decodes inside HTML', (name, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds an entity, "${name}`));
        refused(
          { [GUIDE]: guideText.replace('\n## ', () => `\n${text}\n\n## `) },
          /holds an entity/,
        );
      });

      it('passes an ampersand no entity begins', () => {
        const text = ' See [x](https://example.org/?a=b&label=c&logo=d), for Q&A.';
        const r = sizingCheck({ [WHY]: intoWhy(text) });
        expect(r.code, r.out).toBe(0);
      });

      it('holds an END marker to ending its line, since what follows it there is shown as HTML', () => {
        const edited = sizing.replace(
          /(<!-- SIZING:[A-Z0-9_]+:END -->)/,
          '$1 Its Redis bills a lot.',
        );
        expect(edited).not.toBe(sizing);
        refused({ [SIZING]: edited }, /SIZING:[A-Z0-9_]+:END must end its line/);
      });

      it.each([
        ['a sign after a letter that looks like a digit', ' It costs lO% less.'],
        ['a sign after a Cyrillic letter', ' It costs З× as much.'],
        ['a sign after Roman numerals', ' It costs XII× as much.'],
        ['a sign after an escape', ' Storage is S3\\% of the bill.'],
        ['a sign in bold after a token', ' It is 65,536 ids **×** more.'],
      ])("refuses a share or a multiple's sign outright on those pages: %s", (_what, text) => {
        refused({ [WHY]: intoWhy(text) }, /holds a share or a multiple's sign/);
      });

      it.each([
        ['a braille blank', ' It costs less⠀overall.'],
        ['an accented letter', ' It costs less, naïvely.'],
        ['an emoji', ' It costs less \u{1F680}.'],
      ])('refuses any character but plain ASCII, § and — on those pages: %s', (_what, text) => {
        refused({ [WHY]: intoWhy(text) }, /holds a character other than plain ASCII, § or —/);
      });

      it.each([
        ['twenty-seven', ' It costs twenty-seven thousand a month.'],
        ['two', ' It makes two more requests than S3.'],
        ['two', ' It makes two HEAD requests.'],
        ['hundreds', ' It costs hundreds of times as much.'],
        ['four', ' The four workloads differ.'],
      ])('refuses a number word from two up outside the phrases it lists: "%s"', (word, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds a number in words, "${word}"`));
      });

      it.each([
        ['twice', ' The hot dashboard costs twice the Redis.'],
        ['twice', ' It costs twice its Redis on a hot dashboard.'],
        ['double', ' Redis costs double the CloudBitmaps bill.'],
        ['triple', ' Redis costs triple its own bill.'],
        ['quadruple', ' Redis costs quadruple its own.'],
        ['half', ' Storage is half of the bill.'],
        ['half', ' CloudBitmaps costs about half.'],
        ['half', ' It costs one and a half times the Redis.'],
        ['tens', ' A cold intersect waits tens of milliseconds a request.'],
        ['trillion', ' S3 holds over a trillion objects.'],
        ['thousands', ' It reads thousands of chunks.'],
        ['millions', ' It reads millions of ids.'],
        ['billions', ' It reads billions of ids.'],
        ['dozens', ' It reads dozens of chunks.'],
        ['dozen', ' It reads the dozen chunks it needs.'],
        ['three', ' Redis keeps three replicas.'],
        ['eleven', ' It keeps eleven segments open.'],
        ['two', ' Neither of the two is cheap.'],
        ['twenty', ' See [the guide](sizing.md "about twenty").'],
        ['twenty', ' See [the guide](twenty thousand a month).'],
      ])('refuses a number or a multiple in a word it knows: "%s"', (word, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds a number in words, "${word}`, 'i'));
      });

      it.each([
        ['a penny', ' It costs a penny a day.'],
        ['halved', ' It halved the bill.'],
        ['a third more', ' It costs a third more.'],
        ['twice as much', ' Redis costs [tw](a\\)b)ice as much.'],
      ])('refuses a share or an amount it knows however a link falls: "%s"', (figure, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds a figure in words, "${figure}"`));
      });

      it.each([
        ['&frac12', ' It costs &frac12 as much.'],
        ['&yen', ' It costs &yen a month.'],
        ['&divide', ' It is the bill &divide two.'],
        ['&sup2', ' It grows as n&sup2 does.'],
        ['&COPY', ' It is &COPY the vendor.'],
      ])('refuses %s, a legacy entity name, capitals and all', (name, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds an entity, "${name}`));
      });

      it('passes a query parameter a legacy name begins, which GitHub shows as written', () => {
        for (const text of [
          ' See [the console](https://console.example.com/s3/home?bucket=b&region=us-east-1).',
          ' See [the docs](https://example.org/a?b=1&section=c&timestamp=d&notify=e).',
        ]) {
          const r = sizingCheck({ [GUIDE]: guideText.replace('\n## ', () => `\n${text}\n\n## `) });
          expect(r.code, r.out).toBe(0);
        }
        refused({ [WHY]: intoWhy(' Its Redis bills &pound forty.') }, /holds an entity, "&pound/);
      });

      it('names a character it refuses by its code point, which a no-break space would not show', () => {
        refused({ [WHY]: intoWhy(' It costs\u00a0less.') }, /"U\+00A0, in /);
        refused({ [WHY]: intoWhy(' It’s cheap.') }, /"U\+2019, in /);
      });

      it.each([
        ['[^', '[^'],
        ['[^a', '[^a'],
        ['](', ']('],
      ])('reads 100 KB of %s well inside 2 s', (_what, unit) => {
        const started = performance.now();
        sizingCheck({ [WHY]: intoWhy(` ${unit.repeat(Math.ceil(100_000 / unit.length))}`) });
        expect(performance.now() - started).toBeLessThan(2000);
      });

      it.each([
        ['in half', ' It cuts the Redis bill in half.'],
        ['doubles', ' It doubles the bill.'],
        ['a third less', ' It costs a third less.'],
        ['a dollar', ' It costs under a dollar a week.'],
      ])('refuses a share or an amount in a word on those pages: "%s"', (figure, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds a figure in words, "${figure}"`));
      });

      it.each([
        ['twice as much', ' Redis costs [tw](a(b))ice as much.'],
        ['sixty times', ' Redis costs [six](a "x)")ty times as much.'],
      ])('reads a link whose target holds parentheses or a quoted ")": "%s"', (figure, text) => {
        refused({ [WHY]: intoWhy(text) }, new RegExp(`holds a figure in words, "${figure}"`));
      });

      // Each a true sentence the rules refuse, with a way to write it that passes.
      it.each([
        [
          ' It reads the chunks its two operands share.',
          ' It reads the chunks both its operands share.',
        ],
        [' A store holds thousands of segments.', ' A store holds many segments.'],
        [' It splits each id in half.', ' It splits each id into a chunk key and an offset.'],
        [
          ' A dollar amount typed by hand is refused.',
          ' Every dollar amount typed by hand is refused.',
        ],
        [' S3 bills its GETs per million requests.', ' S3 bills its GETs by the request.'],
        [
          ' The two halves of an id are its chunk key and its offset.',
          ' An id splits into its chunk key and its offset.',
        ],
        [
          ' Both share a bucket, the two in one place.',
          ' Both share a bucket, together in one place.',
        ],
      ])('refuses "%s", and passes "%s"', (refusedText, reworded) => {
        refused({ [WHY]: intoWhy(refusedText) }, /outside its SIZING regions/);
        const r = sizingCheck({ [WHY]: intoWhy(reworded) });
        expect(r.code, r.out).toBe(0);
      });

      it.each([
        ['a blockquote continued onto a line', '> Redis costs 12\n> times as much.'],
        ['a braille blank before a sign', 'CloudBitmaps costs 90⠀% less.'],
        ['a braille blank before "times"', 'Redis costs 12⠀times as much.'],
        ['a footnote reference', 'Redis costs 12[^r] times as much.\n\n[^r]: As priced.'],
        [
          'a link with parentheses in its target',
          'CloudBitmaps costs 90[](a(b))% less than Redis.',
        ],
        ['a link inside "times"', 'Redis costs 12 [ti](a(b))mes as much.'],
        ['the Arabic percent sign', 'CloudBitmaps costs 90٪ less.'],
        ['a Cyrillic х', 'Redis costs 12х as much.'],
        ['another ×', 'Redis costs 12⨉ as much.'],
        ["the × emoji's shortcode", 'Redis costs 12 :heavy_multiplication_x: as much.'],
        ['math', 'Redis costs $12{\\times}$ as much.'],
        ['math with dollar signs alone', 'Redis costs 12$\\times$ as much.'],
        ['a sign before the digit', 'Redis costs \u2A0912 as much.'],
        ["a quote in a link's title", "CloudBitmaps costs 90[](a 'x)')% less."],
        [
          "a badge's underscores",
          '![](https://img.shields.io/badge/Redis_costs-12_times_more-red)',
        ],
      ])(
        'refuses a share or a multiple in the rest of the README however it is split: %s',
        (_what, text) => {
          refused({ [README]: intoRest(text) }, /holds a share or a multiple/);
        },
      );

      it('passes an image whose name ends in _2x, and a heading in another script where the section ends', () => {
        const r = sizingCheck({ [README]: intoRest('![logo](docs/img/logo_2x.png)') });
        expect(r.code, r.out).toBe(0);
        const edited = readme.replace(
          '## Your data stays yours',
          '## 日本語\n\n## Your data stays yours',
        );
        expect(sizingCheck({ [README]: edited }).out).not.toMatch(/shows nothing/);
      });

      it('reads 100 KB of digits, or of an unclosed tag, in the rest of the README well inside 2 s', () => {
        for (const text of ['1'.repeat(100_000), '<h2 '.repeat(25_000)]) {
          const started = performance.now();
          sizingCheck({ [README]: intoRest(text) });
          expect(performance.now() - started).toBeLessThan(2000);
        }
      });

      it('passes "times out" after a number word in the rest of the README, where number words are words', () => {
        const r = sizingCheck({
          [README]: intoRest('If either of the two times out, the reader retries.'),
        });
        expect(r.code, r.out).toBe(0);
      });

      it.each([
        ['a braille blank', '## Why CloudBitmaps⠀'],
        ['a Cyrillic а', '## Why CloudBitmаps'],
        ['punctuation', '## Why Cloud-Bitmaps?'],
        ['a Greek ο', '## Why Cl\u03bfudBitmaps'],
        ['an accent', '## Why CloudB\u00edtmaps'],
      ])("refuses a heading that shows as the Why section's, with %s", (_what, heading) => {
        const edited = readme.replace(
          '## Why CloudBitmaps\n',
          () => `${heading}\n\nText.\n\n## Why CloudBitmaps\n`,
        );
        expect(edited).not.toBe(readme);
        refused(
          { [README]: edited },
          /could show as the heading of its "Why CloudBitmaps" section/,
        );
      });

      it("refuses an HTML heading of the Why section's title, and passes one of another", () => {
        refused(
          { [README]: intoRest('<h2>Why CloudBitmaps</h2>') },
          /has an HTML heading that shows as its "Why CloudBitmaps" section's/,
        );
        for (const html of ['<h3>Why CloudBitmaps</h3>', '<h2>Why CloudBitmaps\n\nText.']) {
          refused({ [README]: intoRest(html) }, /has an HTML heading that shows as its/);
        }
        const r = sizingCheck({ [README]: intoRest('<h2>Why it is cheap</h2>') });
        expect(r.code, r.out).toBe(0);
      });
    });

    // A title is shown, as a tooltip, so the words in one are read like the text around it.
    it('refuses a figure in words in a link title, however the title is quoted', () => {
      for (const text of [
        ' See [x](https://a.example "twice as much").',
        " See [x](https://a.example 'twice as much').",
        ' See [x](https://a.example (twice as much)).',
      ]) {
        refused({ [WHY]: intoWhy(text) }, /holds a figure in words, "twice as much"/);
      }
    });

    it("refuses a fence opened on a list item's line and never closed", () => {
      for (const text of [
        '\n\n- ```text\n  large, all in memory: [x](85,509) a month\n\nAfter the list.\n',
        '\n\n* ~~~\n  no figure here\n',
        '\n\n> - ```\n>   no figure here\n',
        '\n\n1. ```\n   no figure here\n',
      ]) {
        refused({ [WHY]: intoWhy(text) }, /holds a code fence/);
      }
    });

    // However a figure is spelled, it is one: a digit is refused wherever it stands, in any form, and a figure in words
    // is read however emphasis or code falls across it.
    it.each([
      ['&#36;5 a month'],
      ['&dollar;7 a month'],
      ['90&percnt; less'],
      ['3&times; as much'],
      ['66x as much'],
      ['90 percent less'],
      ['USD 21,445 a month'],
      ['4+2k GETs'],
      ['4,140 GETs a second'],
      ['40¢ a million'],
      ['66-fold as much'],
      ['twice as much'],
      ['90 per-cent less'],
      ['3 ✕ as much'],
      ['９０％ less'],
      ['＄21,445 a month'],
      ['4,000 PUTs'],
      ['4.1k GETs'],
      ['three times as much'],
      ['tenfold'],
      ['half as much'],
      ['double the cost'],
      ['triple the bill'],
      ['thrice as much'],
      ['×3'],
      ['€5 a month'],
      ['950‰'],
      ['95\\% less'],
      ['66\\-fold'],
      ['cheaper by a factor of four'],
      ['a few per cent'],
      ['tw**ice** as much'],
      ['`twice as much`'],
      ['ｔｗｉｃｅ as much'],
      ['²¹ a month'],
      ['half\\ the bill'],
      // Markup a reader never sees, inside a figure in words.
      ['_twice_ as much'],
      ['`twice` as much'],
      ['~~twice~~ as much'],
      ['[twice](#x) as much'],
      ['tw[ice][x] as much'],
      // Invisible characters, and a double space.
      ['three\u200B times as much'],
      ['tw\u00ADice as much'],
      ['ten\u2060fold more'],
      ['ninety per  cent less'],
      ['ninety per\u00A0\u00A0cent less'],
      ['ninety per- cent less'],
      // Multiples, folds, fractions and shares, in words, compound numbers among them.
      ['a ten-fold saving'],
      ['sixty times as much'],
      ['sixty-five times as much'],
      ['twenty-one times as much'],
      ['one hundred times as much'],
      ['a hundredfold more'],
      ['hundredfold more'],
      ['several hundred times as much'],
      ['twice what CloudBitmaps does'],
      ['half of what Redis costs'],
      ['a tenth as much'],
      ['two thirds of the bill'],
      ['less than half of what Redis does'],
      ['less than a third'],
      ['an order of magnitude cheaper'],
      ['orders of magnitude cheaper'],
      ['nine in ten dollars of the bill'],
      ['one in a hundred reads'],
      ['nine out of ten'],
      ['three times out of four'],
      ['by a factor of sixty'],
      // Dollar amounts and request counts in words.
      ['about eighty-five thousand dollars a month'],
      ['forty cents a million'],
      ['one dollar a month'],
      ['four GETs plus two for each shared chunk'],
      ['two requests for a pointer'],
      ['a two-request tail read'],
      ['one hundred PUTs'],
      // Digits a renderer shows, which NFKC turns into letters or leaves as a symbol.
      ['Ⅻ× as much'],
      // And symbols that are no number until NFKC shows the digit in them: ㏠ is 1日, ㎡ is m2.
      ['㏠ of the month'],
      ['a price per ㎡'],
      ['٩٠% less'],
      ['💯% of the bill'],
      ['🔟× as much'],
      ['🔢 a month'],
      ['#\uFE0F\u20E3 of GETs'],
      [':nine::zero:% less'],
      [':keycap_ten:× as much'],
      [':nine: a month'],
      [':heavy_dollar_sign: a month'],
      ['💲 a month'],
      // A name or a definition, in words that make it a figure.
      ['65,536 a month'],
      ['$65,536 a month'],
      ['1.2 billion GETs a month'],
      ['1.2 billion a year'],
      ['S3× as much'],
      ['S3% of it'],
      ['65,536 ids× over'],
      ['12,345 ids'],
      ['a 64-bit key'],
      ['an S4 bucket'],
      ["V9's heap"],
      ['ids are 16-bit'],
      ['ids are 32-bits'],
      ['a 128-bit id'],
      ['us-east-1 prices'],
      ['[§12 of the guide](cost.md#what-each-term-counts)'],
      ['§11 a month'],
      ['3.4 billion customers'],
      ['1-2 billion customers'],
    ])('fails %j typed outside a region', (figure) => {
      refused(
        { [WHY]: why.replace('mostly cold.', `mostly cold: ${figure}.`) },
        /outside its SIZING regions|holds an entity/,
      );
    });

    // What the hand-written text may hold: the names and definitions the rule lists, and words that only look like
    // a figure.
    it.each([
      ['a region', ' It runs in `us-east-1`.'],
      ['a service, and its possessive', " S3's prices are S3's, and S3's request rate is its own."],
      ['an engine', " V8's heap holds the index."],
      ['the width of an id', ' Its ids are 32-bit; 64-bit ids need a new format.'],
      ['the ids a chunk holds', ' A chunk holds up to 65,536 ids.'],
      ['"S3 times out"', ' If S3 times out, the reader retries.'],
      ['a service as the subject of "times"', ' S3 times each request from its first byte.'],
      ['"double as", which is a use', ' It can double as a lock.'],
      ['a count of one', ' One request per pointer read, and a one-request tail read.'],
      [
        '"one" and "two" as words',
        ' The one or two hottest paths, in one bucket, and the two bills.',
      ],
      ['a script whose name holds colons', ' Run `pnpm bench:sizing:check` first.'],
      ['a fraction as an ordinal', ' The fifth column is what holding a hot set whole takes.'],
      ['ordinary ampersands', ' Q&A, R&D and AT&T are names, and `&str` is a type.'],
    ])('passes %s', (_what, text) => {
      const r = sizingCheck({ [WHY]: intoWhy(text) });
      expect(r.code, r.out).toBe(0);
    });

    // What it cannot read, it refuses, whether or not a reader would be shown a figure: a number, HTML, an entity, an
    // image, a fence.
    it.each([
      ['a version', ' From 2.3.x on.', /holds a number, "2\.3\.x"/],
      ['a year', ' Since December 2020, reads included.', /holds a number, "2020,"/],
      ['a protocol version', ' Over HTTP/2 requests.', /holds a number, "HTTP\/2"/],
      ['a bare address with a digit', ' See https://example.org/a/50 for more.', /holds a number/],
      ['a link title, which is shown', ' See [x](https://a.example "95% less").', /holds a number/],
      ['a reference definition', '\n\n[aws]: https://aws.amazon.com/?off=20%\n', /holds a number/],
      ['a comment', ' <!-- it cost less once -->', /holds HTML, "<!-- it cost less once/],
      ['a tag', ' It is <b>cheap</b>.', /holds HTML/],
      ['a tag in capitals', ' It is <B>cheap</B>.', /holds HTML, "<B>/],
      ['a closing tag alone', ' It is cheap</b>.', /holds HTML, "<\/b>/],
      ['a processing instruction', ' It is <?x cheap ?>.', /holds HTML, "<\?x/],
      ['the end of a comment', ' A comment closes with -->.', /holds HTML, "-->/],
      ['the end of a CDATA section', ' It closes with ]]>.', /holds HTML, "\]\]>/],
      ['an autolink', ' See <https://aws.amazon.com/>.', /holds HTML/],
      ['an entity', ' It is cheap&nbsp;enough.', /holds an entity, "&nbsp"/],
      ['an entity in capitals', ' It is AT&AMP;T.', /holds an entity, "&AMP"/],
      ['an entity named in capitals', ' It is cheap&Tab;enough.', /holds an entity, "&Tab"/],
      ['an entity in a code span', ' Write `&#36;` for the sign.', /holds an entity, "&#36"/],
      ['a hexadecimal entity', ' Write &#x24; for the sign.', /holds an entity, "&#x24"/],
      // GitHub decodes a numeric reference without its semicolon inside HTML, so one is refused however written.
      ['a numeric entity with no semicolon', ' It costs &#36 a month.', /holds an entity, "&#36"/],
      ['a currency sign', ' It costs $lOO,OOO a month.', /holds a currency sign, "\$lOO,OOO/],
      ['a fullwidth currency sign', ' It costs ＄ a month.', /holds a currency sign/],
      ['an image', ' ![a chart](../../bench/crossover.svg)', /holds an image/],
      ['a fence', '\n\n```text\nno figure here\n```\n', /holds a code fence/],
      ['a fence of tildes, indented', '\n\n   ~~~\nno figure here\n   ~~~\n', /holds a code fence/],
      [
        'a fence in a nested list',
        '\n\n- a\n  - b\n\n        ```\n        no figure here\n        ```\n',
        /holds a code fence/,
      ],
      ['a fence in a blockquote', '\n\n> ```\n> no figure here\n> ```\n', /holds a code fence/],
    ])('refuses %s, which it does not read', (_what, text, message) => {
      refused({ [WHY]: intoWhy(text) }, message);
    });

    // Each way a figure can hide from a reading of markdown, refused before any is read.
    it.each([
      ['a fence in a blockquote', `\n\n> ~~~\n> <!--\n> ~~~\n\n${F}\n\n`],
      ['a fence in a list item', `\n\n- \`\`\`\n  <!--\n  \`\`\`\n\n${F}\n\n`],
      ['an HTML block in a blockquote', `\n\n> <div>\n> [x](y "${F}")\n\n`],
      [
        'a table in a blockquote',
        '\n\n> | Deployment | a month, USD |\n> |---|---:|\n> | Large | 99,999 |\n\n',
      ],
      ['indented code holding <!--', `\n\n    <!--\n\n${F}\n\n`],
      [
        'an unclosed <!-- in a paragraph',
        `\n\nA region opens with <!-- and ends at its marker.\n\n${F}\n\n`,
      ],
      ['a tag across a blank line', `\n\nSee <span title="a\n\n${F}\n\nb"> here.\n\n`],
      ['a link title across a blank line', `\n\nSee [x](y\n\n"${F}")\n\n`],
      [
        'a stray backtick across a heading',
        `\n\nA stray \` here.\n### A heading\nReal code \`<!--\` here.\n\n${F}\n\n`,
      ],
      [
        'an escaped backslash before a code span',
        `\n\nWrite \\\\\`<!--\` to open one.\n\n${F}\n\n`,
      ],
      [
        'an escaped backtick before a code span',
        `\n\nType \\\`\`<!--\` to start a comment.\n\n${F}\n\n`,
      ],
      [
        'a code span inside a comment',
        `\n\n<!-- A region's marker ends with \`-->\`, like any comment.\n${F} -->\n\n`,
      ],
      ['text after --> on a comment line', `\n\n<!-- note --> [x](y "${F}")\n\n`],
      ['a <?…?> line', `\n\n<?x ?> [a](b "${F}")\n\n`],
      ['a tag with > in an attribute', `\n\n<span title="a>b">\n[x](y "${F}")\n\n`],
      [
        'a <source> interrupting a paragraph',
        `\n\nSome text\n<source srcset="x.png">\n[x](y "${F}")\n\n`,
      ],
      ['a numeric reference without ;', '\n\n<div>\nIt costs &#36 99,999 a month.\n</div>\n\n'],
      ['a <textarea> attribute', `\n\nSee <textarea title="${F}"> here.\n\n`],
      ['a [ in a definition label', '\n\n[Large[1]: $99,999\n\n'],
      ['an unbalanced ) after a definition', '\n\n[Large]: $99,999)\n\n'],
      ['a ( in a definition title', '\n\n[Large]: /u ((costs $99,999)\n\n'],
      ['an unlisted inline tag', '\n\nIt costs 66 time<tt>s</tt> as much.\n\n'],
      ['an unknown tag', '\n\nIt costs 66 time<foo>s</foo> as much.\n\n'],
      ['&Tab;', '\n\nIt is 95&Tab;% less.\n\n'],
      ['&sup2;&sup1;', '\n\nIt costs $&sup2;&sup1; a month.\n\n'],
      ['emphasis on fullwidth digits', '\n\nIt costs **９０**％ less.\n\n'],
      [
        'a table without a leading pipe',
        '\n\nDeployment | a month, USD\n---|---:\nLarge | 99,999\n\n',
      ],
      ['a hard break inside a figure', '\n\nIt costs 66\\\ntimes as much.\n\n'],
      [
        'a unit far from its number',
        '\n\nIn US dollars, the large deployment is 99,999 a month.\n\n',
      ],
      ['a count with no space before its noun', '\n\nIt makes 4,140GETs a second.\n\n'],
      ['a blank-looking braille character', '\n\nIt is 95⠀% less.\n\n'],
    ])('refuses a figure behind %s', (_what, text) => {
      refused({ [WHY]: intoWhy(text) }, /outside its SIZING regions|holds an entity/);
    });

    it('lets the README say its listed phrases, as they are written, and no share or multiple besides', () => {
      // Under another heading, a share the list names is refused all the same where it is not the listed phrase.
      for (const [line, figure] of [
        ['CloudBitmaps costs 5% of its Redis.', '5%'],
        ['Redis costs 12.5× as much.', '12.5×'],
      ]) {
        refused(
          {
            [README]: readme.replace(
              '## Your data stays yours',
              `## Your data stays yours\n\n${line}`,
            ),
          },
          new RegExp(`"${figure}", outside its "Why CloudBitmaps" section`),
        );
      }
      // A listed phrase is allowed once: said again as a new claim, it is a figure like any other.
      refused(
        {
          [README]: readme.replace(
            '## Your data stays yours',
            '## Your data stays yours\n\nTwo segments overlapping in 5% of chunks.',
          ),
        },
        /"5%", outside its "Why CloudBitmaps" section/,
      );
      // Shares are read in any case, as they are written and with their tags taken out.
      for (const [line, figure] of [
        ['It costs 90 PERCENT less.', '90 PERCENT'],
        ['It costs 66 time<b>s</b> as much.', '66 times'],
      ]) {
        refused(
          {
            [README]: readme.replace(
              '## Your data stays yours',
              `## Your data stays yours\n\n${line}`,
            ),
          },
          new RegExp(`"${figure}", outside its "Why CloudBitmaps" section`),
        );
      }
      // A share inside a tag is read as it is written, and one in fullwidth forms as a reader sees it.
      for (const [line, figure] of [
        ['<img alt="It costs 95% less" src="x.png">', '95%'],
        ['It costs ９０％ less.', '90%'],
      ]) {
        refused(
          {
            [README]: readme.replace(
              '## Your data stays yours',
              `## Your data stays yours\n\n${line}`,
            ),
          },
          new RegExp(`"${figure}", outside its "Why CloudBitmaps" section`),
        );
      }
      // An entity could spell a share, and the README needs none, but in a URL's query.
      refused(
        {
          [README]: readme.replace(
            '## Your data stays yours',
            '## Your data stays yours\n\nIt costs 95&#37; less.',
          ),
        },
        /README\.md holds an entity, "&#37"/,
      );
      expect(readme).toContain('?logo=npm&label=');
      // A listed phrase is read as written: with its figure in bold it is another phrase, and the listed one is gone.
      const bolded = readme.replace(
        'overlapping in 5% of chunks',
        'overlapping in **5%** of chunks',
      );
      expect(bolded).not.toBe(readme);
      refused({ [README]: bolded }, /no longer says "overlapping in 5% of chunks"/);
      // Nor is it in compatibility forms, which a reader is shown as the same phrase and this reads as another.
      refused(
        { [README]: readme.replace('overlapping in 5% of chunks', 'overlapping in 5％ of chunks') },
        /no longer says "overlapping in 5% of chunks"/,
      );
      // And a phrase the README stops saying is refused, rather than left to allow a figure nobody quotes.
      refused(
        { [README]: readme.replace('overlapping in 5% of chunks', 'overlapping in a few chunks') },
        /no longer says "overlapping in 5% of chunks"/,
      );
    });

    /** The README with `text` written into it by hand, under the heading after the Why section. */
    const intoRest = (text: string): string => {
      const edited = readme.replace(
        '## Your data stays yours',
        () => `## Your data stays yours\n\n${text}`,
      );
      expect(edited).not.toBe(readme);
      return edited;
    };
    // Read as it is written, each of these passes: emphasis, an escape, a code span, an invisible character, a
    // comment or a tag holding a `>` splits a share or a multiple that a reader is shown whole.
    it.each([
      ['Redis costs *twice* as much.', 'twice as much'],
      ['Redis costs _twice_ as much.', 'twice as much'],
      ['Redis costs **three** times as much.', 'three times'],
      ['CloudBitmaps costs **90**% less than Redis.', '90%'],
      ['Redis costs **3**× as much.', '3×'],
      ['CloudBitmaps costs 90\\% less than Redis.', '90%'],
      ['CloudBitmaps costs `90`% less than Redis.', '90%'],
      ['Redis costs 66 *times* as much.', '66 times'],
      ['Redis costs tw**ice** as much.', 'twice as much'],
      ['CloudBitmaps costs 90\u200B% less than Redis.', '90%'],
      ['Redis costs tw\u200Bice as much.', 'twice as much'],
      ['CloudBitmaps costs 90<!--x>-->% less than Redis.', '90%'],
      ['CloudBitmaps costs 90<span title=">">%</span> less than Redis.', '90%'],
      ["CloudBitmaps costs 90<span title='>'>%</span> less than Redis.", '90%'],
      ['CloudBitmaps costs 90<!-->% less than Redis.', '90%'],
      ['CloudBitmaps costs 90<?x?>% less than Redis.', '90%'],
      ['CloudBitmaps costs 90<![CDATA[x]]>% less than Redis.', '90%'],
      ['CloudBitmaps costs 90<!X y>% less than Redis.', '90%'],
      ['Redis costs [tw](#x)ice as much.', 'twice as much'],
      ['Redis costs sixty ~~times~~ as much.', 'sixty times'],
      ['CloudBitmaps costs 9\uFE0F\u20E30\uFE0F\u20E3% less than Redis.', '90%'],
      ['Redis costs a tenth as much.', 'a tenth as much'],
      ['CloudBitmaps costs ninety per  cent less.', 'per cent'],
      ['See [the chart](x.png "It costs 90% less").', '90%'],
      ["See ![the chart](x.png 'Redis costs twice as much').", 'twice as much'],
    ])('refuses %j in the rest of the README, read as a reader is shown it', (line, figure) => {
      refused(
        { [README]: intoRest(line) },
        new RegExp(
          `"${figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", outside its "Why CloudBitmaps" section`,
        ),
      );
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
        /"90%", outside its "Why CloudBitmaps" section/,
      );
      // The section holds no fence and no HTML, so a `## ` quoted in either cannot end it early and leave what follows
      // it to the rest's rule: after the regions the quote itself is refused, and before one the region is outside.
      for (const [quoted, what] of [
        ['```text\n## not a heading\n```', 'a code fence'],
        ['<!--\n## draft\n-->', 'HTML'],
        ['<details>\n<summary>More</summary>\n## Note\n</details>', 'HTML'],
      ]) {
        refused(
          { [README]: readme.replace('Where it loses:', `${quoted}\n\nWhere it loses:`) },
          new RegExp(`holds ${what}, .*in its "Why CloudBitmaps" section`),
        );
        refused(
          {
            [README]: readme.replace('## Why CloudBitmaps\n', `## Why CloudBitmaps\n\n${quoted}\n`),
          },
          /WHY_SIZES region sits outside its "Why CloudBitmaps" section/,
        );
      }
      // A real heading ends it, and what follows is held to the list.
      refused(
        {
          [README]: readme.replace(
            'Where it loses:',
            '## What it saves\n\nIt is 95% cheaper.\n\nWhere it loses:',
          ),
        },
        /"95%", outside its "Why CloudBitmaps" section/,
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

    // The Why section is read from its one `## Why CloudBitmaps` line. Each of these starts the section a reader
    // sees above that line, which would hold the figure between the two to the rest of the README's weaker rule.
    const FIG =
      'Kept all in memory, the large deployment would be 285 nodes and USD 85,509 a month, making 4,140 GETs a second.';
    it.each([
      ['closing hashes', '## Why CloudBitmaps #'],
      ['a trailing space', '## Why CloudBitmaps '],
      ['another level', '### Why CloudBitmaps'],
      ['indentation', '   ## Why CloudBitmaps'],
      ['a blockquote', '> ## Why CloudBitmaps'],
      ['emphasis', '## Why *CloudBitmaps*'],
      ['another case', '## Why cloudbitmaps'],
      ['fullwidth letters', '## Ｗｈｙ CloudBitmaps'],
      ['two spaces', '## Why  CloudBitmaps'],
      ['an underline of -', 'Why CloudBitmaps\n----------------'],
      ['an underline of =', 'Why CloudBitmaps\n==='],
      ['an underline under two lines', 'Why\nCloudBitmaps\n---'],
    ])(
      'refuses the Why heading spelled with %s, which a reader would take for its start',
      (_what, heading) => {
        const shifted = readme.replace(
          '## Why CloudBitmaps\n',
          () => `${heading}\n\n${FIG}\n\n## Why CloudBitmaps\n`,
        );
        refused(
          { [README]: shifted },
          /could show as the heading of its "Why CloudBitmaps" section/,
        );
      },
    );

    it('refuses HTML or a fence above the Why section, which could hide its heading', () => {
      for (const [above, what] of [
        ['<!-- a note -->', 'HTML'],
        ['<details>\n<summary>More</summary>\n</details>', 'HTML'],
        ['<![CDATA[ x ]]>', 'HTML'],
        ['<!X a declaration >', 'HTML'],
        ['<?x an instruction ?>', 'HTML'],
        ['```text\nx\n```', 'a code fence'],
        ['- ```text\n  x', 'a code fence'],
      ]) {
        refused(
          {
            [README]: readme.replace(
              '## Why CloudBitmaps\n',
              () => `${above}\n\n## Why CloudBitmaps\n`,
            ),
          },
          new RegExp(`holds ${what} above its "Why CloudBitmaps" section`),
        );
      }
      // And each way of hiding the heading line the check reads, below a heading a reader sees.
      for (const [open, close] of [
        ['<!--', '-->'],
        ['<?', '?>'],
        ['<!X', '>'],
        ['<![CDATA[', ']]>'],
      ]) {
        const hidden = readme.replace(
          '## Why CloudBitmaps\n',
          () => `## Why CloudBitmaps #\n\n${FIG}\n\n${open}\n## Why CloudBitmaps\n${close}\n`,
        );
        const r = sizingCheck({ [README]: hidden });
        expect(r.code, r.out).not.toBe(0);
      }
    });

    it.each([['## '], ['## #'], ['## ##'], ['## <!-- -->'], ['## <b></b>'], ['## \u200B']])(
      'refuses an empty heading %j, which would end the Why section before a reader sees it end',
      (heading) => {
        refused(
          {
            [README]: readme.replace(
              'Where it loses:',
              () => `${heading}\n\n${FIG}\n\nWhere it loses:`,
            ),
          },
          /ends its "Why CloudBitmaps" section with a heading that shows nothing/,
        );
      },
    );

    it('reads the Why section once, and passes a heading that only begins like it', () => {
      refused(
        {
          [README]: readme.replace(
            '## Your data stays yours',
            '## Why CloudBitmaps\n\n## Your data stays yours',
          ),
        },
        /has "## Why CloudBitmaps" 2 times/,
      );
      refused(
        { [README]: readme.replace('## Why CloudBitmaps\n', '## What CloudBitmaps is\n') },
        /no longer has the section whose figures are generated/,
      );
      // A heading of another title ends the section, and what follows it is the rest's, figures of its own included.
      const r = sizingCheck({
        [README]: readme.replace(
          '## Your data stays yours',
          `## Why CloudBitmaps, measured\n\n${FIG}\n\n## Your data stays yours`,
        ),
      });
      expect(r.code, r.out).toBe(0);
      // A heading one level down does not end it: the figure under it is still the section's.
      refused(
        {
          [README]: readme.replace(
            'Where it loses:',
            () => `### Where it loses\n\n${FIG}\n\nWhere it loses:`,
          ),
        },
        /holds a number, .*in its "Why CloudBitmaps" section/,
      );
    });

    it('refuses a name or a definition in the Why section where it reads as a figure', () => {
      for (const text of ['It makes 1.2 billion GETs a month.', 'It holds 1.2 billion ids.']) {
        refused(
          { [README]: readme.replace('Where it loses:', () => `${text}\n\nWhere it loses:`) },
          /holds a number, "1\.2", .*in its "Why CloudBitmaps" section/,
        );
      }
    });

    // Charts are checked on every page a generator writes into, the guide among them, which has no rule for its prose.
    const intoGuide = (text: string): string => `${guideText}\n${text}\n`;
    it.each([
      ['bench/hand.SVG'],
      ['bench/hand.avif'],
      ['bench/hand.bmp'],
      ['bench/%68and.svg'],
      ['bench%2Fhand.svg'],
      ['bench/hand\\.svg'],
      ['bench\\/hand.svg'],
      ['bench/café.svg'],
      ['bench/@2x/hand.svg'],
      ['bench/hand(1).svg'],
      ['bench/a,b.svg'],
      ["bench/it's.svg"],
      ['bench/hand%20chart.svg'],
      ...[
        'apng',
        'png',
        'gif',
        'jpg',
        'jpeg',
        'jfif',
        'pjpeg',
        'webp',
        'ico',
        'cur',
        'tif',
        'tiff',
      ].map((ext) => [`bench/hand.${ext}`]),
      ...['jxl', 'heic', 'heif', 'svgz'].map((ext) => [`bench/hand.${ext}`]),
    ])('fails a page that shows %s, an image under bench/ no generator draws', (image) => {
      refused({ [GUIDE]: intoGuide(`![a chart](../../${image})`) }, /which no generator draws/);
    });

    it('fails an image under bench/ whose path holds a space, where a path can hold one', () => {
      for (const shown of [
        '![a chart](<../../bench/hand chart.svg>)',
        '[chart]: <../../bench/hand chart.svg>\n\n![a chart][chart]',
        '<img alt="a chart" src="../../bench/hand chart.svg">',
        '<img alt="a>b" src="../../bench/hand chart.svg">',
        "<img alt='a chart' src='../../bench/hand chart.svg'>",
        "<img alt='a>b' src='../../bench/hand chart.svg'>",
        '<img\n  alt="a chart"\n  src="../../bench/hand chart.svg">',
      ]) {
        refused(
          { [GUIDE]: intoGuide(shown) },
          /shows bench\/hand chart\.svg, which no generator draws/,
        );
      }
      // Outside those, a space ends a path, so prose that names bench/ and then an image file is not read as one.
      const r = sizingCheck({
        [GUIDE]: intoGuide('The charts in bench/ are drawn by a script, and crossover.svg is one.'),
      });
      expect(r.code, r.out).toBe(0);
    });

    it.each([
      ['bench/hand&#46;svg'],
      ['bench&#47;hand.svg'],
      ['bench&#47hand.svg'],
      ['bench&sol;hand.svg'],
      ['ben&#99;h/hand&#46;svg'],
    ])('fails a page that spells an image path %s with an entity', (image) => {
      refused(
        { [GUIDE]: intoGuide(`<img alt="a chart" src="../../${image}">`) },
        /cost\.md holds an entity/,
      );
    });

    // GitHub decodes a named reference only with its semicolon, so an ampersand before letters is text on any page.
    it('passes an ampersand that is text, and refuses one GitHub decodes, on every page it writes into', () => {
      const prose = [
        'See the Q&A below.',
        'Built by an R&D team.',
        'Tested on AT&T fibre.',
        '`fn f(s: &str)`',
        '`type Both = A & B;`',
        '[![npm](https://img.shields.io/badge/a-b-blue?style=flat&logo=npm)](https://www.npmjs.com/)',
      ];
      for (const text of prose) {
        const r = sizingCheck({ [GUIDE]: intoGuide(text), [README]: intoRest(text) });
        expect(r.code, `${text}\n${r.out}`).toBe(0);
      }
      const decoded: Array<[string, string]> = [
        ['HTML escapes it as `&lt;`.', '&lt'],
        ['<img src="https://img.shields.io/badge/a?b=1&amp;c=2">', '&amp'],
        ['`type Both = A&B;`', '&B'],
        ['It is 9&#48; here.', '&#48'],
      ];
      for (const [text, entity] of decoded) {
        refused({ [GUIDE]: intoGuide(text) }, new RegExp(`cost\\.md holds an entity, "${entity}"`));
      }
    });

    it('fails a chart shown only through <source srcset>, or as a PNG in a folder under bench/', () => {
      const shown = (src: string, dark: string) =>
        `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="../../${dark}">\n` +
        `  <img alt="x" src="../../${src}">\n</picture>`;
      refused(
        {
          'bench/hand-dark.svg': '<svg/>',
          [GUIDE]: intoGuide(shown('bench/bill-as-data-grows.svg', 'bench/hand-dark.svg')),
        },
        /hand-dark\.svg, which no generator draws/,
      );
      refused(
        { 'bench/charts/x.png': 'png', [GUIDE]: intoGuide('![x](../../bench/charts/x.png)') },
        /bench\/charts\/x\.png, which no generator draws/,
      );
    });

    it('fails an image from bench/ that nothing draws, and passes the benchmarks chart', () => {
      refused(
        { 'bench/hand.svg': '<svg/>', [GUIDE]: intoGuide('![x](../../bench/hand.svg)') },
        /no generator draws/,
      );
      const r = sizingCheck({ [GUIDE]: intoGuide('![x](../../bench/crossover.svg)') });
      expect(r.code, r.out).toBe(0);
    });

    it('shows a headroom row of 1,000 a second and more with its comma, and refuses rates that do not divide as shown', () => {
      // Rounded to three figures, 1.3125 shows as 1.31, which divides by 1.25 to 1×, not the 1.1× printed beside it.
      const call = (now: number, even: number) =>
        sizingCheck(
          {},
          { source: (t) => `${t}\nconsole.log(JSON.stringify(headroomRow(${now}, ${even})));` },
        );
      const wide = call(20, 1160);
      expect(wide.code, wide.out).toBe(0);
      expect(wide.out).toContain('["20","1,160","58×"]');
      // Every comma of a rate is read, not the first alone.
      const wider = call(1000, 1_160_000);
      expect(wider.code, wider.out).toBe(0);
      expect(wider.out).toContain('["1,000","1,160,000","1200×"]');
      const off = call(1.25, 1.3125);
      expect(off.code).not.toBe(0);
      expect(off.out).toMatch(/1\.31 ÷ 1\.25 does not show as 1\.1×/);
    });

    it('fails a region that another page owns', () => {
      refused(
        { [SIZING]: `${sizing}\n<!-- SIZING:HOT:START -->\n<!-- SIZING:HOT:END -->\n` },
        /which DOCS puts in docs\/guide\/why-cloudbitmaps\.md/,
      );
    });

    it('reads a marker quoted in code as a marker, since a page quotes none', () => {
      const quoted = `${sizing}\n\`<!-- SIZING:NOPE:START -->\`\n\n\`\`\`md\n<!-- SIZING:NOPE:END -->\n\`\`\`\n`;
      refused({ [SIZING]: quoted }, /holds a SIZING:NOPE region nothing writes/);
    });

    it('takes the text of every region out of a page for site-figures, and leaves its markers', () => {
      const { withoutRegions } = requireFromScript('./lib/sizing-markers.cjs') as {
        withoutRegions: (doc: string, text: string, docs: object) => string;
      };
      const two =
        'a\n<!-- SIZING:X:START -->\n$1\n<!-- SIZING:X:END -->\nb\n' +
        '<!-- SIZING:Y:START -->\n$2\n<!-- SIZING:Y:END -->\n';
      expect(withoutRegions('q.md', two, { 'q.md': ['X', 'Y'] })).toBe(
        'a\n<!-- SIZING:X:START --><!-- SIZING:X:END -->\nb\n<!-- SIZING:Y:START --><!-- SIZING:Y:END -->\n',
      );
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
        /large deployment's segments are larger than 2,000 chunks can take/,
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
