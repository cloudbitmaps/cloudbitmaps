/**
 * Reading prose the way a reader does, for the gates that match phrases in it: a sentence continues across a wrapped
 * line in a comment or a Markdown paragraph, across two string literals joined by `+`, and across an array of string
 * literals passed to `.join` with a string literal for its separator, so a phrase split by any of them is still one
 * phrase.
 */
import { createRequire } from 'node:module';

/**
 * `text` with every match of `pattern` (a global regex) replaced until none is left, so removing one comment or tag
 * cannot join the text around it into another. The same function the figure and calibration gates use.
 */
export const removeAll = (
  createRequire(import.meta.url)('../../bench/lib/remove-all.cjs') as {
    removeAll: (text: string, pattern: RegExp, replacement?: string) => string;
  }
).removeAll;

/** Two string literals joined by `+` across a line break. */
const JOIN = String.raw`['"\x60][ \t]*\+[ \t]*\n[ \t]*['"\x60]`;
/** One string literal: a backtick one holds no `$`, so no interpolation. */
const ITEM = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\$]|\\.)*\x60)`;
/**
 * An array holding only string literals, read as one string: `['a', 'b'].join(' ')` is `a b`. An array that is not
 * joined, is joined by something other than a string literal, or holds anything but string literals is not a phrase.
 */
const ARRAY_JOIN = String.raw`\[\s*(?:${ITEM}\s*,\s*)*${ITEM}\s*,?\s*\]\s*\.join\(\s*${ITEM}\s*\)`;
const LITERALS = new RegExp(ITEM, 'g');
/**
 * A line break with the comment or quote marker that starts the next line: `//`, `*` and `>`, and `#` in a language
 * whose comments it starts. A line holding only a marker, like a blank line, ends a paragraph and is not a seam. In
 * Markdown a heading is read onto the line before it, but its `#` stays, so no phrase runs across it.
 */
const wrap = (marker: string): string =>
  String.raw`\n(?![ \t]*(?:${marker})?[ \t]*\n)[ \t]*(?:${marker})?[ \t]*`;
const MARKERS = String.raw`\/\/+|\*(?!\/)|>`;
const SEAMS = new RegExp(`${ARRAY_JOIN}|${JOIN}|${wrap(MARKERS)}`, 'g');
const HASH_SEAMS = new RegExp(`${ARRAY_JOIN}|${JOIN}|${wrap(`${MARKERS}|#+`)}`, 'g');
const JOINS = new RegExp(`${ARRAY_JOIN}|${JOIN}`, 'g');

/** The string an `ARRAY_JOIN` match reads as, with where each of its characters sits in `text` from `index`. */
function joinedArray(match: string, index: number): { flat: string; at: number[] } {
  const literals = [...match.matchAll(LITERALS)].map((l) => ({
    body: l[0].slice(1, -1),
    start: index + (l.index ?? 0) + 1,
  }));
  const sep = literals.pop();
  let flat = '';
  const at: number[] = [];
  literals.forEach((item, n) => {
    if (n > 0) {
      for (const c of sep?.body ?? '') {
        flat += c;
        at.push(item.start - 1);
      }
    }
    for (let k = 0; k < item.body.length; k++) {
      flat += item.body[k];
      at.push(item.start + k);
    }
  });
  return { flat, at };
}

/**
 * `text` with every seam read through (a wrap as one space, a string join as nothing, an array join as its joined
 * string), and for each character of
 * the result, where it was in `text`, so a match can be reported at the line it starts on. With `joinsOnly`, only
 * joined strings are read through, and every line break stays. With `hashComments`, a `#` that starts a line starts
 * a comment, as in YAML, shell and Python, and a wrap reads through it.
 */
export function unwrap(
  text: string,
  { joinsOnly = false, hashComments = false } = {},
): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  let from = 0;
  const keep = (to: number): void => {
    for (let k = from; k < to; k++) {
      flat += text[k];
      at.push(k);
    }
  };
  for (const m of text.matchAll(joinsOnly ? JOINS : hashComments ? HASH_SEAMS : SEAMS)) {
    const i = m.index ?? 0;
    keep(i);
    if (m[0].startsWith('[')) {
      const joined = joinedArray(m[0], i);
      flat += joined.flat;
      at.push(...joined.at);
    } else if (!m[0].includes('+')) {
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
