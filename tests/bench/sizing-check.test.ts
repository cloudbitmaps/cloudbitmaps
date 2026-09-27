import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';

/**
 * `pnpm bench:sizing:check` is the gate that holds the sizing guide and the getting-started guide to the estimator,
 * and CI only ever runs it on pages that pass. This holds it to failing: each case edits the pages the way a
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
 * Run `node bench/sizing.cjs --check` with `pages` (repo-relative path → text) laid over the tree; with `write`, run
 * `pnpm bench:sizing` instead, whose writes land in `pages` rather than on disk.
 */
function sizingCheck(
  pages: Record<string, string> = {},
  { write = false }: { write?: boolean } = {},
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
    existsSync: (p: string) => rel(p) in pages || realFs.existsSync(p),
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
    new Function('require', '__dirname', 'process', 'console', readFileSync(SCRIPT, 'utf8'))(
      (id: string) => modules[id] ?? requireFromScript(id),
      join(ROOT, 'bench'),
      proc,
      { log, error: log, warn: log },
    );
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
});
