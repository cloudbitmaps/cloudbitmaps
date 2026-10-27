/**
 * Reading a playbook page, running its code and holding the output it shows to what the run prints.
 *
 * A playbook is `docs/playbooks/<slug>.md`: a title, a one-sentence summary, then prose and TypeScript fences. Each
 * fence the reader copies carries the marker `<!-- typecheck -->` (the doc-sample gate compiles the page's fences as
 * one module). A fence that prints puts the output a reader should see right after it:
 *
 *     <!-- typecheck -->
 *     ```ts
 *     console.log(1 + 1);
 *     ```
 *
 *     <!-- output -->
 *     ```text
 *     2
 *     ```
 *
 * The page's fences run in order as one program (a name one declares the next may use), with the package sources
 * injected for the `@cloudbitmaps/*` imports and `console.log` captured. What each fence logged, one line per
 * call (arguments joined as `util.format` does), must equal the text of the output fence after it, exactly (a line that
 * says `Output:` may sit between them). A fence
 * that logged nothing has no output fence, and an output fence is never left without its code.
 */
import { format } from 'node:util';

import ts from 'typescript';

import { markedSamples } from './doc-samples';

export interface PlaybookPart {
  /** The line of the page the fence's first line of code is on. */
  readonly line: number;
  readonly code: string;
  /** The text of the output fence after it, or `null` when the fence has none. */
  readonly output: string | null;
}

export interface Playbook {
  readonly title: string;
  readonly summary: string;
  readonly parts: readonly PlaybookPart[];
  readonly problems: readonly string[];
}

const OUTPUT_MARKER = /^<!--[ \t]*output[ \t]*-->[ \t]*$/;
const TEXT_FENCE = /^```text[ \t]*$/;
const CLOSE_FENCE = /^```[ \t]*$/;

/** Reads a page: its title, its summary, its runnable fences with their output, and what is wrong with its shape. */
export function parsePlaybook(file: string, text: string): Playbook {
  const lines = text.split('\n');
  const problems: string[] = [];

  const titleAt = lines.findIndex((l) => /^# \S/.test(l));
  const title = titleAt === -1 ? '' : (lines[titleAt] as string).slice(2).trim();
  if (titleAt !== 0) problems.push(`${file}:1 — the page must open with a "# Title" line`);

  let summary = '';
  let at = titleAt + 1;
  while (titleAt !== -1 && at < lines.length && (lines[at] as string).trim() === '') at += 1;
  if (titleAt !== -1) {
    const line = lines[at] ?? '';
    const next = lines[at + 1] ?? '';
    if (line === '' || /^[#<`|>*-]|^\d+\./.test(line)) {
      problems.push(`${file}:${at + 1} — the title must be followed by a one-sentence summary`);
    } else if (next.trim() !== '') {
      problems.push(`${file}:${at + 1} — the summary must be one line, then a blank line`);
    } else if (/[`*_[\]<>]/.test(line)) {
      problems.push(`${file}:${at + 1} — the summary is plain text: no code, emphasis or links`);
    } else if (!/[.]$/.test(line) || /[.!?] [A-Z]/.test(line)) {
      problems.push(
        `${file}:${at + 1} — the summary must be one sentence that ends with a full stop`,
      );
    } else {
      summary = line;
    }
  }

  const { samples, orphans } = markedSamples(file, text);
  problems.push(...orphans);
  const claimed = new Set<number>();
  const parts: PlaybookPart[] = [];
  for (const s of samples) {
    if (s.mark === 'skip') {
      problems.push(
        `${file}:${s.line} — a playbook has no typecheck-skip: every fence runs, so write it to run`,
      );
      continue;
    }
    if (s.preludes.length > 0) {
      problems.push(`${file}:${s.line} — a playbook fence declares its own names (no prelude)`);
    }
    // The closing fence is the line after the code; the output marker may follow past blank lines.
    let j = s.line + s.code.split('\n').length;
    while (j < lines.length && (lines[j] as string).trim() === '') j += 1;
    // One optional "Output:" line may announce the output fence.
    if (lines[j] === 'Output:') {
      const announced = j;
      j += 1;
      while (j < lines.length && (lines[j] as string).trim() === '') j += 1;
      if (!OUTPUT_MARKER.test(lines[j] ?? '')) {
        problems.push(`${file}:${announced + 1} — "Output:" with no output fence after it`);
      }
    }
    let output: string | null = null;
    if (OUTPUT_MARKER.test(lines[j] ?? '')) {
      claimed.add(j);
      const open = j + 1;
      if (!TEXT_FENCE.test(lines[open] ?? '')) {
        problems.push(`${file}:${j + 1} — an output marker must be followed by a text fence`);
      } else {
        const body: string[] = [];
        let k = open + 1;
        while (k < lines.length && !CLOSE_FENCE.test(lines[k] as string)) {
          body.push(lines[k] as string);
          k += 1;
        }
        output = body.join('\n');
      }
    }
    parts.push({ line: s.line, code: s.code, output });
  }
  problems.push(...unrunFences(file, lines, samples));
  lines.forEach((l, n) => {
    if (OUTPUT_MARKER.test(l) && !claimed.has(n)) {
      problems.push(`${file}:${n + 1} — an output marker with no runnable fence right before it`);
    }
  });
  if (parts.length === 0) problems.push(`${file} — a playbook with no runnable fence`);
  return { title, summary, parts, problems };
}

const NOT_RUN = /^<!--[ \t]*not-run:[ \t]*(\S.{6,}?)[ \t]*-->[ \t]*$/;

/**
 * Every fence the run does not execute must say so. A page's runnable fences are the marked TypeScript ones; the only other
 * fence is the `text` output right after an output marker; anything else (a `js`, `bash` or `json` fence, an unmarked
 * TypeScript one) fails, unless a `<!-- not-run: reason -->` line sits right above it, so a snippet that reads as proven
 * is never silently untested.
 */
function unrunFences(
  file: string,
  lines: readonly string[],
  samples: readonly { line: number }[],
): string[] {
  const runnable = new Set(samples.map((s) => s.line - 2));
  const problems: string[] = [];
  const above = (n: number): string => {
    let k = n - 1;
    while (k >= 0 && (lines[k] as string).trim() === '') k -= 1;
    return k >= 0 ? (lines[k] as string) : '';
  };
  // An opening fence is three or more backticks or tildes, indented or not; it closes on a run of the same character
  // at least as long.
  let closer: RegExp | null = null;
  lines.forEach((l, n) => {
    if (closer !== null) {
      if (closer.test(l)) closer = null;
      return;
    }
    const open = /^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)/.exec(l);
    if (open === null) return;
    const run = open[1] as string;
    closer = new RegExp(`^[ \\t]*${run[0]}{${run.length},}[ \\t]*$`);
    const lang = open[2] as string;
    if (runnable.has(n)) return;
    if (lang === 'text' && OUTPUT_MARKER.test(above(n))) return;
    if (NOT_RUN.test(above(n))) return;
    problems.push(
      /^(ts|typescript)$/.test(lang)
        ? `${file}:${n + 1} — a TypeScript fence with no typecheck marker above it`
        : `${file}:${n + 1} — a ${lang === '' ? 'bare' : lang} fence is not run: write it as a runnable TypeScript fence, or put "<!-- not-run: why -->" above it`,
    );
  });
  return problems;
}

/** The modules a playbook may import, by specifier: the package sources, injected by the caller. */
export type Modules = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * The page's code as one async function body: types stripped, each import turned into a binding read from `mods`, and a
 * call to `part(n)` after each fence's code so the run can tell which fence logged what.
 */
function programOf(file: string, parts: readonly PlaybookPart[]): string {
  const joined = parts.map((p, n) => `${p.code}\n__part(${n});`).join('\n');
  const js = ts.transpileModule(joined, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
    },
    fileName: `${file}.mts`,
  }).outputText;
  return js
    .replace(/^export \{\};?$/gm, '')
    .replace(/^import ([^\n]+?) from ["']([^"']+)["'];?$/gm, (_all, what: string, spec: string) => {
      const binding = what.startsWith('* as ')
        ? what.slice(5)
        : what.startsWith('{')
          ? what.replace(/(\w+) as (\w+)/g, '$1: $2')
          : null;
      if (binding === null)
        throw new Error(`${file} — a default import of "${spec}" is not supported`);
      return `const ${binding} = __mods[${JSON.stringify(spec)}];`;
    });
}

/**
 * Runs the page's fences in order and compares what each logged with the output fence after it. Returns what differs
 * (empty when the page runs and prints what it shows). A fence that throws stops the run.
 */
export async function runPlaybook(
  file: string,
  parts: readonly PlaybookPart[],
  mods: Modules,
): Promise<string[]> {
  const problems: string[] = [];
  const program = programOf(file, parts);
  const used = [...program.matchAll(/__mods\[("[^"]+")\]/g)].map(
    (m) => JSON.parse(m[1] as string) as string,
  );
  for (const spec of used) {
    if (mods[spec] === undefined) {
      return [
        `${file} — imports "${spec}", which a playbook may not (allowed: ${Object.keys(mods).join(', ')})`,
      ];
    }
  }
  const logged: string[][] = parts.map(() => []);
  const late: string[] = [];
  const slips: string[] = [];
  const onRejection = (reason: unknown): void => {
    slips.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  };
  process.on('unhandledRejection', onRejection);
  let current = 0;
  const part = (n: number): void => {
    current = n + 1;
  };
  const sandboxConsole = {
    log: (...args: unknown[]): void => {
      if (current >= parts.length) late.push(format(...args));
      else (logged[current] as string[]).push(format(...args));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<void>;
  try {
    await new AsyncFunction('__mods', '__part', 'console', program)(mods, part, sandboxConsole);
    // Let a promise the page left running settle, so a slip is named after its page.
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onRejection);
    if (slips.length > 0)
      return [`${file} — a promise the page did not await rejected: ${slips.join('; ')}`];
    if (late.length > 0)
      return [`${file} — the code prints after its last fence ended: ${late.join(' | ')}`];
  } catch (error) {
    process.off('unhandledRejection', onRejection);
    const at = parts[Math.min(current, parts.length - 1)] as PlaybookPart;
    const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return [`${file}:${at.line} — the code throws ${what}`];
  }
  parts.forEach((p, n) => {
    const printed = (logged[n] as string[]).join('\n');
    if (p.output === null) {
      if (printed !== '') {
        problems.push(
          `${file}:${p.line} — the code prints, and no output fence follows it; it prints:\n${printed}`,
        );
      }
    } else if (printed !== p.output) {
      problems.push(
        `${file}:${p.line} — the output shown differs from what the code prints\n--- shown\n${p.output}\n--- printed\n${printed}`,
      );
    }
  });
  return problems;
}

/** The size letter the index shows for a page of `lines` lines: S under 150, M up to 300, L beyond. */
export function sizeOf(lines: number): 'S' | 'M' | 'L' {
  return lines < 150 ? 'S' : lines <= 300 ? 'M' : 'L';
}

export interface IndexedPage {
  /** The file name, `slug.md`. */
  readonly name: string;
  readonly title: string;
  readonly lines: number;
}

/**
 * The index and the pages agree both ways: each page has one row (its link, its title as the link text, what it does,
 * what it uses, its size by line count), and each row names a page that exists.
 */
export function checkIndex(readme: string, pages: readonly IndexedPage[]): string[] {
  const problems: string[] = [];
  const rows = readme
    .split('\n')
    .map((text, n) => ({ text, line: n + 1 }))
    .filter(({ text }) => /^\|\s*\[/.test(text));
  const seen = new Map<string, number>();
  for (const { text, line } of rows) {
    const cells = text
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(cells[0] ?? '');
    if (link === null || cells.length !== 4) {
      problems.push(
        `README.md:${line} — a row is | [Title](slug.md) | what it does | what it uses | size |`,
      );
      continue;
    }
    const [, label, target] = link as unknown as [string, string, string];
    seen.set(target, (seen.get(target) ?? 0) + 1);
    const page = pages.find((p) => p.name === target);
    if (page === undefined) {
      problems.push(`README.md:${line} — the row for ${target} names a page that does not exist`);
      continue;
    }
    if (label !== page.title) {
      problems.push(
        `README.md:${line} — the link text "${label}" is not the page's title "${page.title}"`,
      );
    }
    if ((cells[1] as string) === '' || (cells[2] as string) === '') {
      problems.push(
        `README.md:${line} — the row for ${target} says nothing of what it does or uses`,
      );
    }
    if (cells[3] !== sizeOf(page.lines)) {
      problems.push(
        `README.md:${line} — the size of ${target} is ${sizeOf(page.lines)} (${page.lines} lines), the row says ${cells[3]}`,
      );
    }
  }
  for (const [target, count] of seen) {
    if (count > 1) problems.push(`README.md — ${target} has ${count} rows`);
  }
  for (const page of pages) {
    if (!seen.has(page.name)) problems.push(`README.md — no row for ${page.name}`);
  }
  return problems;
}
