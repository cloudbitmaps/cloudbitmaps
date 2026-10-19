import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * A Markdown table row is one line. A row broken over two lines renders as separate rows: the continuation becomes a
 * row of its own, in the first column, and the cells that followed move with it, so the cell a reader needs (an
 * action, a verdict) lands under the wrong heading or goes missing. Nothing else in the docs tests looks at tables.
 *
 * A table starts at a `|` line followed by a delimiter row and runs to the first blank line. Inside it every line must
 * start with `|`; an HTML comment line (a generated table's markers) is allowed. Fenced code is skipped.
 */
const ROOT = join(__dirname, '..', '..');

const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const DELIMITER = /^\|[\s:|-]+\|?\s*$/;

/** Each line of `text` inside a table that does not start with `|`, as `line: start of it`. */
function brokenRows(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence = false;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      inTable = false;
      continue;
    }
    if (fence) continue;
    if (inTable) {
      if (line.trim() === '') inTable = false;
      else if (!line.startsWith('|') && !line.startsWith('<!--')) {
        out.push(`${i + 1}: ${line.slice(0, 60)}`);
      }
      continue;
    }
    if (line.startsWith('|') && DELIMITER.test(lines[i + 1] ?? '')) inTable = true;
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

  it('finds a row broken over lines, and leaves a table that is not one alone', () => {
    const broken = '| a | b |\n|---|---|\n| one | two\ncontinued | three |\n\nafter\n';
    expect(brokenRows(broken)).toEqual(['4: continued | three |']);
    expect(brokenRows('| a | b |\n|---|---|\n| 1 | 2 |\n<!-- end -->\n\ntext\n')).toEqual([]);
    expect(brokenRows('```\n| a |\n|---|\nplain\n```\n')).toEqual([]);
    expect(brokenRows('a | b\ntext after a pipe line\n')).toEqual([]);
  });
});
