/**
 * Reading prose the way a reader does, for the gates that match phrases in it: a sentence continues across a wrapped
 * line in a comment or a Markdown paragraph, and across two string literals joined by `+`, so a phrase split by
 * either is still one phrase.
 */

/** Two string literals joined by `+` across a line break. */
const JOIN = String.raw`['"\x60][ \t]*\+[ \t]*\n[ \t]*['"\x60]`;
/**
 * A line break with the comment or quote marker (`//`, `*`, `>`) that starts the next line. A line holding only a
 * marker, like a blank line, ends a paragraph and is not a seam. A Markdown heading is read onto the line before it,
 * but its `#` stays, so no phrase runs across it.
 */
const WRAP = String.raw`\n(?![ \t]*(?:\/\/+|\*(?!\/)|>)?[ \t]*\n)[ \t]*(?:\/\/+|\*(?!\/)|>)?[ \t]*`;
const SEAMS = new RegExp(`${JOIN}|${WRAP}`, 'g');
const JOINS = new RegExp(JOIN, 'g');

/**
 * `text` with every seam read through (a wrap as one space, a string join as nothing), and for each character of
 * the result, where it was in `text`, so a match can be reported at the line it starts on. With `joinsOnly`, only
 * joined strings are read through, and every line break stays.
 */
export function unwrap(text: string, { joinsOnly = false } = {}): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  let from = 0;
  const keep = (to: number): void => {
    for (let k = from; k < to; k++) {
      flat += text[k];
      at.push(k);
    }
  };
  for (const m of text.matchAll(joinsOnly ? JOINS : SEAMS)) {
    const i = m.index ?? 0;
    keep(i);
    if (!m[0].includes('+')) {
      flat += ' ';
      at.push(i);
    }
    from = i + m[0].length;
  }
  keep(text.length);
  return { flat, at };
}

/** The 1-based line of `text` that its character `index` sits on. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}
