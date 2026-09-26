/*
 * The one reader of SIZING markers, for bench/sizing.cjs, which writes and checks the regions between them, and for
 * scripts/site-figures.cjs, which leaves exactly those regions to it. Two parsers that disagreed about where a region
 * begins would each skip what the other reads: a marker quoted in inline code, say, which one saw as a region and the
 * other as text. Pure functions of a page's text, so either script can read pages however it likes.
 */
'use strict';

/**
 * Any comment shaped like a SIZING marker, however it is cased, spaced or separated — `<!--SIZING_BILL:START-->` as
 * much as the strict form — and not a comment that merely begins with the word. Only the strict form is written.
 */
const ANY_MARKER = /<!--\s*sizing\s*[:_-]\s*[a-z0-9_]*\s*[:_-]?\s*(?:start|end)\b[^>]*-->/gi;
const MARKER = /^<!-- SIZING:([A-Z][A-Z0-9_]*):(START|END) -->$/;
/** What may stand before a START marker on its line: a list item's or a blockquote's indentation, and nothing else. */
const INDENT = /^[ \t]*(?:>[ \t]*)*$/;

/**
 * The spans of a markdown page that are code — fenced blocks and inline spans — where a marker is text a page shows,
 * as a page documenting the syntax does, not a comment. In HTML a comment is a comment wherever it sits.
 */
function codeSpans(doc, text) {
  if (!/\.mdx?$/.test(doc)) return [];
  const spans = [];
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  const inFence = (at) => spans.some(([a, b]) => at >= a && at < b);
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    if (!inFence(m.index)) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** A page's markers, in order. A malformed one throws: no check would ever compare the region it meant. */
function markersOf(doc, text) {
  const code = codeSpans(doc, text);
  return [...text.matchAll(ANY_MARKER)]
    .filter((m) => !code.some(([a, b]) => m.index >= a && m.index < b))
    .map((m) => {
      const strict = MARKER.exec(m[0]);
      if (strict === null) {
        throw new Error(
          `${doc}: malformed marker ${JSON.stringify(m[0])} — write <!-- SIZING:NAME:START --> or ` +
            '<!-- SIZING:NAME:END --> exactly',
        );
      }
      return { name: strict[1], edge: strict[2], at: m.index, end: m.index + m[0].length };
    });
}

/**
 * Where each of `names` sits in the page, as `{ i, j, indent }`: the text between its markers is `text.slice(i, j)`.
 * `docs` is the whole page list, so a region in the wrong page is named with the page that owns it. Throws unless the
 * page holds exactly `names`, each once, paired in order and none inside another.
 */
function regionsOf(doc, text, names, docs) {
  const owner = (name) => Object.keys(docs).find((d) => docs[d].includes(name));
  const markers = markersOf(doc, text);
  const out = {};
  for (let n = 0; n < markers.length; n += 2) {
    const open = markers[n];
    const close = markers[n + 1];
    if (open.edge !== 'START' || close?.edge !== 'END' || close.name !== open.name) {
      throw new Error(
        `${doc}: SIZING markers must pair up in order, each START with the END of its name, never nested or ` +
          `overlapping (at SIZING:${open.name}:${open.edge})`,
      );
    }
    if (!names.includes(open.name)) {
      const home = owner(open.name);
      throw new Error(
        home === undefined
          ? `${doc} holds a SIZING:${open.name} region nothing writes: render it in bench/sizing.cjs and list ` +
              'it in bench/lib/sizing-pages.cjs, or delete the markers'
          : `${doc} holds a SIZING:${open.name} region, which DOCS puts in ${home}`,
      );
    }
    // Exactly one of each: a second copy is one this check would never compare.
    if (out[open.name] !== undefined) {
      throw new Error(`${doc} must hold exactly one SIZING:${open.name} region`);
    }
    // A region inside a list item is indented with it, and the table must be too, or it ends the list. Anything else
    // before the marker would be written onto every line of the region.
    const indent = text.slice(text.lastIndexOf('\n', open.at) + 1, open.at);
    if (!INDENT.test(indent)) {
      throw new Error(
        `${doc}: SIZING:${open.name}:START must begin its line, after a list's or a quote's indentation only`,
      );
    }
    out[open.name] = { i: open.end, j: close.at, indent };
  }
  for (const name of names) {
    if (out[name] === undefined)
      throw new Error(`${doc} must hold exactly one SIZING:${name} region`);
  }
  return out;
}

/** The page with every region rewritten, and the names of the regions whose text changed. */
function withRegions(doc, text, regions, docs) {
  const at = regionsOf(doc, text, Object.keys(regions), docs);
  let s = text;
  const changed = [];
  // Replace from the last region back, so earlier offsets stay valid.
  for (const name of Object.keys(at).sort((a, b) => at[b].i - at[a].i)) {
    const { i, j, indent } = at[name];
    const body = regions[name]
      .split('\n')
      // A blank line keeps a quote's `>`, or it would end the blockquote the region sits in.
      .map((line) => (line === '' ? indent.trimEnd() : indent + line))
      .join('\n');
    const next = '\n' + body + '\n' + indent;
    if (s.slice(i, j) !== next) changed.unshift(name);
    s = s.slice(0, i) + next + s.slice(j);
  }
  return { text: s, changed };
}

/** The page with the text of every region DOCS gives it removed, the markers left in place. Throws as regionsOf does. */
function withoutRegions(doc, text, docs) {
  const at = regionsOf(doc, text, docs[doc] ?? [], docs);
  let s = text;
  for (const { i, j } of Object.values(at).sort((a, b) => b.i - a.i)) {
    s = s.slice(0, i) + s.slice(j);
  }
  return s;
}

module.exports = { markersOf, regionsOf, withRegions, withoutRegions };
