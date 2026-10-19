import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * A Markdown table row is one line. A row broken over two lines renders as separate rows: the continuation becomes a
 * row of its own, in the first column, and the cells that followed move with it, so the cell a reader needs (an
 * action, a verdict) lands under the wrong heading or goes missing. Nothing else in the docs tests looks at tables.
 *
 * WHAT IT CHECKS. A table is a line that, once its indent and any blockquote markers are stripped, starts with `|`,
 * followed by a delimiter row (dashes, with a pipe). That finds tables inside list items and blockquotes as well as
 * at the left margin. Every later line of the table must start with `|` after the same stripping, so a row indented by
 * a space is fine and a continuation line is not. A table ends, without a finding, at a blank line, at a line that
 * opens another block (a heading, a change of blockquote depth, a list item), and at an HTML comment line; a line that starts with `|`
 * straight after such a comment is a finding, because GitHub ends the table at the comment and renders the rest as a
 * paragraph. Fenced code is skipped: a fence closes only on its own character, at least as long as it opened.
 *
 * LIMITS. A table with no leading pipe on its header is not found. A table in a raw HTML block is not Markdown and is
 * not looked at. A continuation line that itself begins like another block (`- `, `# `, `> `) reads as the end of the
 * table, and a line that continues a row with a leading `|` reads as a row.
 */
const ROOT = join(__dirname, '..', '..');

const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

/** A delimiter row: cells of dashes (colons allowed), at least one pipe. */
const DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** What opens a block of another kind, so that a table ends there. */
const OTHER_BLOCK = /^(#{1,6}(\s|$)|>|[-*+]\s|\d+[.)]\s)/;

/** How many blockquote markers open the line. */
const quoteDepth = (line: string): number =>
  (/^\s*((?:>\s*)*)/.exec(line)?.[1] ?? '').split('>').length - 1;

/** The line without its indent and its blockquote markers. */
const bare = (line: string): string => line.replace(/^\s*(>\s*)*/, '');

/** Each line of `text` that breaks a table, as `line: start of it`. */
function brokenRows(text: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let inTable = false;
  let depth = 0;
  let afterComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const rest = bare(line);
    const mark = /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fence !== undefined) {
      const close = /^(`+|~+)\s*$/.exec(rest);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (mark) {
      fence = { char: mark[1]![0]!, length: mark[1]!.length };
      inTable = false;
      afterComment = false;
      continue;
    }
    const flag = (why: string): void => {
      out.push(`${i + 1}: ${why}${rest.slice(0, 60)}`);
    };
    if (afterComment) {
      afterComment = false;
      if (rest.startsWith('|')) flag('after a comment: ');
    }
    if (inTable) {
      if (rest.trim() === '' || quoteDepth(line) !== depth || OTHER_BLOCK.test(rest))
        inTable = false;
      else if (rest.startsWith('<!--')) {
        inTable = false;
        afterComment = true;
      } else if (!rest.startsWith('|')) flag('');
      continue;
    }
    if (rest.startsWith('|') && rest.includes('|', 1) && DELIMITER.test(bare(lines[i + 1] ?? ''))) {
      inTable = true;
      depth = quoteDepth(line);
    }
  }
  return out;
}

describe('Markdown tables', () => {
  it('holds each row on one line', () => {
    const found = files.flatMap((f) =>
      brokenRows(readFileSync(join(ROOT, f), 'utf8')).map((b) => `${f}:${b}`),
    );
    expect(found).toEqual([]);
  });

  describe('finds', () => {
    const table = '| a | b |\n|---|---|\n| one | two\n';
    it.each([
      [
        'a row broken over lines',
        `${table}continued | three |\n\nafter\n`,
        ['4: continued | three |'],
      ],
      [
        'a broken row in a list item',
        '- item\n\n  | a | b |\n  |---|---|\n  | one | two\n  continued |\n',
        ['6: continued |'],
      ],
      [
        'a broken row in a blockquote',
        '> | a | b |\n> |---|---|\n> | one | two\n> continued |\n',
        ['4: continued |'],
      ],
      [
        'rows after a comment partway through a table',
        '| a | b |\n|---|---|\n| 1 | 2 |\n<!-- mid -->\n| 3 | 4 |\n',
        ['5: after a comment: | 3 | 4 |'],
      ],
      [
        'a table after a backtick line inside a tilde fence',
        '~~~\n```\n| a | b |\n|---|---|\n~~~\n| a | b |\n|---|---|\n| 1 | 2\nbroken |\n',
        ['9: broken |'],
      ],
    ])('%s', (_name, text, expected) => {
      expect(brokenRows(text)).toEqual(expected);
    });
  });

  describe('leaves alone', () => {
    it.each([
      [
        'a table that ends in a generated marker',
        '| a | b |\n|---|---|\n| 1 | 2 |\n<!-- end -->\n\ntext\n',
      ],
      ['a broken table inside a fence', '```\n| a |\n|---|\nplain\n```\n'],
      ['a fence that holds another fence', '````md\n```\n| a |\n|---|\nplain\n```\n````\n'],
      ['a pipe line that is not a table', 'a | b\ntext after a pipe line\n'],
      ['a table followed by a heading', '| a | b |\n|---|---|\n| 1 | 2 |\n# Heading\n'],
      ['a table followed by a list', '| a | b |\n|---|---|\n| 1 | 2 |\n- item\n'],
      ['a table followed by a quote', '| a | b |\n|---|---|\n| 1 | 2 |\n> quote\n'],
      ['a row indented by one space', '| a | b |\n|---|---|\n | 1 | 2 |\n'],
      ['a line of pipes and spaces', '| a | b |\n|---|---|\n|  |  |\n| 1 | 2 |\n'],
      ['a table with an escaped pipe', '| a | b |\n|:--|--:|\n| x \\| y | `a|b` |\n'],
      ['a CRLF file', '| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\ntext\r\n'],
    ])('%s', (_name, text) => {
      expect(brokenRows(text)).toEqual([]);
    });
  });
});
