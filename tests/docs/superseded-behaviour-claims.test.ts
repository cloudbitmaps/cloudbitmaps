import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_US_EAST_1_ONDEMAND, estimateCost } from '@cloudbitmaps/core';
import { LIST_COLLECTION_CADENCE } from '@/core/generation-gc';

/**
 * Claims about the library's behaviour that its code makes FALSE, spelled out so no page makes them.
 *
 * WHY THIS FILE EXISTS. A sentence about behaviour is written in several places at once: "an empty result
 * publishes an empty generation" would sit in the guide's `*Into` section, two entries in the roadmap, and a
 * doc-comment that ships in the published `.d.ts`. A change to the behaviour that updates one of them leaves
 * the full gate green — the docs gates check that exports are documented and that links resolve, neither of
 * which can see prose contradicting behaviour — and a hand sweep of the others is careful work that misses a
 * copy.
 *
 * Each entry below is a phrase the code makes FALSE; a hit means a page states it, in a copy or a paraphrase.
 *
 * Adding an entry is the cheap half of changing a behaviour. Removing one is only correct if the phrase is
 * true of the code.
 *
 * WHAT IT IS NOT. It catches honest drift: a stale copy, a paraphrase of it, the same claim wrapped, split or marked
 * up differently. It is not built to stop someone writing the claim on purpose in words it has never seen, and no
 * list of phrases could be. Where the claim's own words are also the words of a true sentence, the true sentence is
 * sometimes refused; each such case below has the rewording that passes, and a narrow collision is fixed by
 * rewording the sentence, not by loosening the pattern.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = [
  '.ts',
  '.md',
  '.html',
  '.txt',
  '.cjs',
  '.mjs',
  '.js',
  '.yml',
  '.yaml',
  '.json',
  '.svg',
];

/**
 * The gap between two words, across a wrap.
 *
 * These phrases are sentences, and sentences in this repo hard-wrap at about 110 columns — inside Markdown
 * blockquotes and JSDoc comments, whose continuation lines begin `> ` and `* `. So the gap between two words
 * is often a newline plus a marker, and neither a literal space nor `\s+` alone spans it. Scanning line by
 * line cannot see any of it: whether a refused claim is caught then depends on how long the preceding words
 * happen to be, which is not a property anyone controls.
 *
 * `vocabulary-damage.test.ts` reads across a wrap the same way. Here it crosses
 * one line end at most: a sentence does not run on past a blank line, and a gap that did would join two copies of
 * a claim in two paragraphs into one hit.
 */
// A gap takes its whole run of blanks: a run a pattern could split among its parts costs a scan per way to split it.
// One that crosses a line end ends at text, never at a margin or a second line end, so it cannot stop inside a blank
// line, where nothing after it would see the blank.
const GAP = String.raw`(?:[^\S\n]+(?![^\S\n]|\n)|[^\S\n]*\n[^\S\n]*(?:(?:[>*#]|\/\/)[^\S\n]*)?(?![\s>*#]|\/\/))`;
const g = (src: string): string => src.replace(/ /g, GAP);

const NO_TIMED_REFRESH =
  '`cache.genTtlMs: 0`, no clock or no registry turns off the timed refresh, and nothing more: the store still ' +
  're-resolves on an eviction, a read that finds its generation swept, or an invalidation. Say "no timed ' +
  'refresh", and point at `seg.pin()` for one instant';

/** The named entities a sentence here is spelled with. A numeric one is decoded whatever it names. */
const ENTITY: Readonly<Record<string, string>> = {
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  amp: '&',
  quot: '"',
  apos: "'",
};
/**
 * A line end moved out of a word it split (see `readings`). The patterns read it as a space, since it is whitespace
 * and not `\n`, and `hitsIn` counts it as the line end it was, so a hit after it is still on its own line.
 */
const MOVED = '\u2028';
/** What a transform keeps of the text it takes out: its line ends, so every line after it keeps its number. */
const lineEnds = (s: string): string => s.replace(/[^\n\u2028]/g, '');
/** How many line ends a reading has, the moved ones among them. */
const lineCount = (s: string): number => s.split(/[\n\u2028]/).length - 1;
/** A numeric entity, decoded whatever it names; one that spells a line end reads as a space, and adds no line. */
const codePoint = (entity: string, n: number): string => {
  if (n > 0x10ffff) return entity;
  const decoded = String.fromCodePoint(n);
  return /[\n\u2028\u2029]/.test(decoded) ? ' ' : decoded;
};

/** A tag that ends a block or a positioned run of text, so the words either side of it are two words. */
const BLOCK_TAG =
  /^<\/?(?:text|tspan|td|th|tr|li|p|div|h[1-6]|dt|dd|blockquote|section|title|desc)\b/i;
/** Of those, a tag that ends a block of its own, so the words either side of it are two sentences. A row's cells pair. */
const BREAK_TAG = /^<\/?(?:tr|li|p|div|h[1-6]|dt|dd|blockquote|section)\b/i;
/** An attribute whose value a reader is shown, and so reads. */
const SHOWN_ATTRIBUTE = /\b(?:content|alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The text a reader is given, so markup cannot carry a refused claim past the patterns. Tags, link targets, code
 * spans, emphasis and doc-comment links go, as a renderer takes them away; entities are decoded, quotation marks go,
 * and a dash or a line break reads as the gap it is, which the patterns' word runs then cross. Each transform keeps
 * the line ends of the text it takes out, where they were, so a hit's line is still its own; `hitsIn` checks it.
 */
const plain = (src: string): string =>
  src
    .replace(/<br\b[^<>]*>/gi, (br) => ` ${lineEnds(br)}`)
    // Any tag, its attributes wrapped or not; a `<` in a sentence opens none. What an attribute shows is kept, on the
    // line it is on: a `<meta>` description is a search result's text, and `alt`, `title` and `aria-label` are read
    // or shown too.
    .replace(/<\/?[a-z][^<>]*>/gi, (tag) => {
      // A tag that ends a block or a positioned run of text, `</td>` or `</text>`, is the gap between two words.
      let shown = BREAK_TAG.test(tag) ? '. ' : BLOCK_TAG.test(tag) ? ' ' : '';
      let read = 0; // how much of the tag is behind us
      for (const a of tag.matchAll(SHOWN_ATTRIBUTE)) {
        const value = a[1] ?? a[2] ?? '';
        const end = a.index + a[0].length;
        shown += `${lineEnds(tag.slice(read, end - value.length - 1))} ${value} `;
        read = end;
      }
      return shown + lineEnds(tag.slice(read));
    })
    // A link, inline or by reference, reads as its text. Neither part runs past the next one opening, so a line of
    // brackets that never close costs a scan of it, not one per bracket.
    .replace(/!?\[([^[\]\n]*)\](?:\([^()\n]*\)|\[[^[\]\n]*\])/g, '$1')
    // A doc-comment link reads as its text, or as its target when it has none, wrapped or not: the margin a wrap
    // brings, ` * `, goes with the separator, and each line end stays on the side of the text it was on.
    .replace(/(\{@link(?:code|plain)?)(\s[^{}]*)\}/g, (_, open: string, body: string) =>
      linkText(open, body),
    )
    .replace(/`[^`\n]*`/g, (span) => span.replace(/\|/g, '\u00a6')) // a pipe in code, `number | null`, ends no row
    .replace(/`/g, '')
    // Emphasis hugs a word; a JSDoc or list marker does not. A run is tried from its first mark only, so a line of
    // marks that hug nothing costs a scan of it, not one per mark.
    .replace(/(?<=\w)[*_]+|(?<![*_])[*_]+(?=\w)/g, '')
    .replace(/&#(\d+);/g, (e, d: string) => codePoint(e, Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (e, h: string) => codePoint(e, Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (e, name: string) => ENTITY[name.toLowerCase()] ?? e)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // Quotation marks go, around a word or a phrase: the store "pins the generation" is the claim, and so is a JSON
    // string's escaped `\"pins\"`. A single quote goes in pairs only, so an apostrophe, "two incarnations' pins",
    // stays; and one escaped or doubled inside a quoted string, `'…incarnations\' pins'` or YAML's `'…incarnations''
    // pins'`, is the apostrophe it prints, and closes nothing.
    .replace(/\\?"/g, '')
    .replace(/(?<![\w\\'])'((?:[^'\\\n]|\\.|'')*?)'(?![\w'])/g, (_, quoted: string) =>
      quoted.replace(/\\'|''/g, "'"),
    )
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2013\u2014]/g, ' - '); // a dash reads as the gap it is, and stays a mark a label is told by

/** Blanks and a wrap's ` * ` margin, as one run: each character is one or the other, so the run matches one way. */
const MARGIN = /^(?:\s|\*(?!\/))*/;
/**
 * A doc-comment link's body read as its text, or as its target when it has none, wrapped or not: the margin a wrap
 * brings goes with the separator, and each line end stays on the side of the text it was on. Plain string work, not a
 * pattern, so a body of any length costs one scan of it.
 */
function linkText(open: string, body: string): string {
  const lead = MARGIN.exec(body)?.[0] ?? '';
  let rest = body.slice(lead.length);
  const nameEnd = rest.search(/[\s|]/);
  const name = nameEnd < 0 ? rest : rest.slice(0, nameEnd);
  rest = nameEnd < 0 ? '' : rest.slice(nameEnd);
  let sep = MARGIN.exec(rest)?.[0] ?? '';
  rest = rest.slice(sep.length);
  if (rest.startsWith('|')) {
    const after = MARGIN.exec(rest.slice(1))?.[0] ?? '';
    sep += `|${after}`;
    rest = rest.slice(1 + after.length);
  }
  const text = rest.trimEnd();
  const trail = rest.slice(text.length);
  return text === ''
    ? `${lineEnds(open + lead)}${name}${lineEnds(sep + trail)}`
    : `${lineEnds(open + lead + name + sep)}${text}${lineEnds(trail)}`;
}

/** A string a program prints, split across literals: a closing quote, the `+`, a line end or none, an opening quote. */
const SPLIT = /(['"`])[^\S\n]*\+[^\S\n]*(?:\n[^\S\n]*)?(['"`])/g;
/**
 * The same, between two letters and across a line end: `'…an empty gen' +`, then `'eration'` and the rest of its word.
 * Not after an escape, `'…\n' +`, whose letter is a line end the program prints.
 */
const SPLIT_WORD = /(?<=(?<!\\)[\w-])(['"`])[^\S\n]*\+[^\S\n]*\n[^\S\n]*(['"`])([\w-]+)/g;
/**
 * Each way a reader can be given a file, through `plain()`. A string a program prints, split across literals, is one
 * sentence, `'…never ' +` then `'re-resolves'`, and a line end the join takes out stays where it was. Split between two
 * letters across a line end, it is read two ways, since the source cannot say whether the writer split a word (`'…an
 * empty gen' +` then `'eration'`) or left a space out (`'…an empty' +` then `'generation'`): across the line end, and
 * glued as the program prints it, with the line end moved past the word it ran into. A file with no such split is read
 * once.
 */
const readings = (src: string): string[] => {
  const text = src.replace(/\u2028/g, ' '); // one the file has would count as a line end
  const gap = text.replace(SPLIT, lineEnds);
  const glued = text
    .replace(SPLIT_WORD, (_, open: string, close: string, rest: string) => `${rest}${MOVED}`)
    .replace(SPLIT, lineEnds);
  return gap === glued ? [plain(gap)] : [plain(gap), plain(glued)];
};

/**
 * `cache.genTtlMs`, or a TTL, set to zero, however the sentence spells the setting: in seconds too ("a TTL of 0s"),
 * and with the value in the table cell after the setting's. Not a TTL of 0.5.
 */
const TTL_ZERO = String.raw`(?:(?:genTtlMs|\bTTL)(?:\s*[:=]\s*|[^\S\n]*\|[^\S\n]*|\s+(?:is|of|at|to|set to|is set to|set at)\s+|\s+)(?:0(?:m?s)?|zero)\b(?![.,]\d)|\bzero (?:genTtlMs|TTL)\b)`;
/**
 * What turns the timed refresh off, however a sentence names it: a zero TTL, no clock, or no registry, a bare
 * `IStorageDriver` and a store with no backend among them, or the words this gate itself asks for, "no timed refresh".
 * An alternative whose first word is common opens on the rarer word it must have, and looks back for the first: the
 * same words, found in a fraction of the time.
 */
const NO_TIMED_REFRESH_SUBJECT = String.raw`(?:${TTL_ZERO}|\b(?:no|neither(?: an?| the| any)?|without (?:an?|the|any)) (?:injected )?(?:clock|registry|backend)\b(?! (?:reads?|calls?|requests?|round trips?|writes?)\b(?! (?:the|its|a|an|no|one|each|every|nothing)\b))|\b(?:registry|clock)-?less\b|\bno-(?:registry|clock)\b|\b(?:bare|raw|plain)-driver\b|\bIStorageDriver\b(?<=\b(?:bare|raw|plain) IStorageDriver)|\bno timed refresh\b|\btimed refresh(?: (?:is |turned |switched )?(?:off|disabled)\b|(?<=\b(?:disabl(?:e|es|ed|ing)|turn(?:s|ed|ing)? off|switch(?:es|ed|ing)? off) (?:the |its |their )?timed refresh)))`;
/** The end of a table row: its last cell's edge and the line end after it, or a line end before another row. */
const ROW_END = String.raw`\|[^\S\n]*(?:\n|$)|\n(?=[^\n]*\|)`;
/** What follows a line end to make a blank line: blanks, or a comment's bare margin (` *`, `>`, `//`, `#`), then another. */
const BLANK_REST = String.raw`[^\S\n]*(?:(?:\*|>|\/\/|#)[^\S\n]*)?\n`;
/**
 * At most `n` characters of one sentence between a claim's words: never past a full stop, one that closes bold or
 * italics included, a blank line or the end of a table row,
 * though past a semicolon and an "e.g.", which end no sentence. A row's cells pair, since a settings table says what a
 * setting does in the cell beside it.
 */
const within = (n: number): string =>
  String.raw`(?:(?!(?<!\b(?:e\.g|i\.e))\.(?:\*{1,2}|_{1,2})?\s|\n${BLANK_REST}|${ROW_END})[\s\S]){0,${n}}?`;
/** Up to a clause of one paragraph, for a claim whose words may sit apart. */
const SPAN = String.raw`(?:(?!\n${BLANK_REST}|${ROW_END})[^.;:])`;
/** Not after a word that negates the claim: "nothing pins a generation forever" is not it. */
const NOT_NEGATED = String.raw`(?<!\b(?:nothing|never|not|no|cannot|can't) )`;
/** A pin as a verb, or "acts as a pin". Not "a pinned handle", which is `seg.pin()`, nor "pins nothing". */
const PIN_WORD = String.raw`(?:\bpin(?:s|ning)?|\bpinned(?! handles?\b))\b`;
/** A pin as what something else is said to be like: "a pin", "a pinned handle", "`seg.pin()`", "`Segment.pin`". */
const LIKE_A_PIN = String.raw`(?:pins?|pinned handles?|(?:\w+\.)?pin\(\)|\w+\.pin)(?![\w(])`;
/** What a pinned handle does with its generation for the life of the handle. */
const HOLDS = String.raw`(?:holds?|keeps?|reads?|serves?|sees?|answers? from|stays? on)`;
/** A word that says a thing is one in all but name: "is effectively a pinned handle". */
const IN_EFFECT = String.raw`(?:(?:effectively|essentially|basically|practically|in effect|just|really|always|then|now|thus),? )?`;
/**
 * The same, as the verb a store is said to do, and strict on purpose: a true sentence this refuses is reworded, since
 * an exemption a true sentence earns lets a false claim through as well. Only these are not the claim:
 * "pins" after a possessive or a determiner, which is the noun ("two incarnations' pins"), or after `pin()`, its
 * subject; "pinned" after a determiner, the adjective ("the pinned object"); "pins nothing", with no "but", "except"
 * or "apart from" after it; "pin" after a determiner, the noun; and a "pinned handle", which is `seg.pin()`'s, unless
 * something else is said to be one, or to be like one.
 */
const PINS = `(?:${[
  // Each word first and what may not come before it after, which says the same and lets a scan skip to the word.
  String.raw`\bpins\b(?<!(?:'|\b(?:its|their|the|all|both|of|these|those|whose|two|three|many|several|other|your|our)|\bpin\(\)) pins)(?! nothing\b(?! (?:but|except|other than|apart from|aside from|besides|save|bar|beyond)\b))`,
  String.raw`\bpinning\b`,
  String.raw`\bpinned\b(?<!\b(?:the|a|an|its|their|each|every|one|this|that) pinned)(?! handles?\b)`,
  // "pin" the verb, on what a store resolves: "set it to 0 to pin every segment". Not the noun, "the pin a segment holds".
  String.raw`\bpin(?<!\b(?:a|the|each|every|one|its|their|this|that|your) pin) (?:each|every|all|its|their|the|a|one|your) (?:[\w'-]+ )?(?:segments?|generations?)\b`,
  // Said to be like one: "acts as a pinned handle", "works just like a pin", "is equivalent to `seg.pin()`".
  String.raw`\b(?:(?:act|acts|behave|behaves|work|works|function|functions) (?:(?:just|exactly|much|essentially|effectively|basically) )?(?:as|like)|(?:is|are|becomes?) (?:(?:just|exactly|much|essentially|effectively|basically) )?like|(?:is|are|becomes?) (?:(?:just|exactly|essentially|effectively|basically) )?(?:equivalent|identical|equal|tantamount|akin|the same) (?:to|as)|(?:is|are) (?:the )?equivalent of|amounts? to) (?:a |an |one )?(?:[\w'-]+ )?${LIKE_A_PIN}`,
  // Said to be one: "every handle is a pinned handle", "is a store-wide `seg.pin()`", "is effectively a pin". The bare
  // noun only after "is a": "gives each pin its own reader" says nothing about a store.
  String.raw`\b(?:is|are|returns?|becomes?|gives?) ${IN_EFFECT}(?:a |an |every |each )?(?:[\w'-]+ )?(?:pinned handles?|(?:\w+\.)?pin\(\))`,
  String.raw`\b(?:is|are|becomes?) ${IN_EFFECT}an? (?:[\w'-]+ )?pin(?![\w'(])`,
  // Held for the life of a handle, which is what a pinned handle does, said of anything else.
  String.raw`\b${HOLDS}(?<!\bpin(?:ned handles?|\(\)) ${HOLDS}) (?:its|their|the|each|one|a) (?:[\w'-]+ )?generations? for the life of the handle\b`,
].join('|')})`;
/**
 * What a store is said never to see: a newer generation, a publish, a change, or what another store, process or
 * writer destroys ("another writer's drop").
 */
const NEWER = String.raw`(?:(?:a|an|the|any|another)(?: other)? )?(?:[\w-]+(?:'s|s') )?(?:(?:new|newer|later|next) (?:generation|publish|pointer|change|version)s?|publish(?:es)?|changes?|updates?|drops?|erasures?|writes?|deletions?|(?:crypto-)?shreds?)`;
/**
 * The rest of a clause: up to a full stop, a semicolon, a colon, a dash or a blank line. It runs on across a line end,
 * since the repo's prose is hard-wrapped and a claim's "or otherwise" lands on the next line as often as not; and it
 * stops after 200 characters, which is longer than any clause here and keeps a long unbroken line from taking seconds.
 */
const CLAUSE = String.raw`(?:(?! - )(?:[^.;:\n]|\n(?!${BLANK_REST}))){0,200}`;
/** A second "never", not itself one on a timer: "…, and an eviction never moves it". */
const ANOTHER_NEVER = String.raw`\bnever\b(?! (?:[\w'-]+ ){1,4}?on a timer\b)`;
/**
 * An "or" that joins the next clause straight after "on a timer": across a comma, a semicolon, a dash, or a wrap and its
 * margin, and a dash opening the next line. "; nor does an eviction move it" is one, and so are "— and never on an
 * eviction", ", not even after an eviction" and ", and not on an eviction".
 */
const CONNECTOR = String.raw`[,;]?[^\S\n]*(?:\n[^\S\n]*(?:(?:[>*#]|\/\/)[^\S\n]*)?)?(?:-[^\S\n]+)?(?:(?:or|nor|either|neither|let alone|much less)\b|(?:and )?not\b|and ${ANOTHER_NEVER})`;
/** A verb for moving on, as it follows "does not" or "cannot": "re-resolve", "re-read its pointer", "see a publish". */
const MOVE_ON = String.raw`(?:re-resolve|refresh|converge|re-(?:read|check) (?:(?:the|its|a|each) )?(?:pointer|segment|currentGen)s?|move on|resolve (?:[\w'-]+ ){0,3}again|(?:observe|see|notice|pick up) ${NEWER})`;
/** The same verb as it follows "never": "re-resolves", "re-reads its pointer", "sees a publish". */
const MOVES_ON = String.raw`(?:re-resolves?|refresh(?:es)?|converges?|re-(?:reads?|checks?) (?:(?:the|its|a|each) )?(?:pointer|segment|currentGen)s?|moves? on|resolves? (?:[\w'-]+ ){0,3}again|(?:observes?|sees?|notices?|picks? up) ${NEWER})`;
/** A word between "never" and its verb that changes nothing: "never really re-resolves", "does not ever re-resolve". */
const EVER = String.raw`(?:(?:actually|again|ever|really|even|truly|once|automatically) )?`;
/**
 * What a claim that a store never moves on says it never does, actively ("never re-resolves", "cannot re-resolve") or
 * passively ("is never refreshed"). Only "on a timer" ending the claim, just after the verb or its object, is true and
 * exempt: "never re-resolves on a timer", "never re-reads a pointer on a timer". Anything between, or an "or", "nor",
 * "either", "neither", "at all" or "otherwise" after it in its clause, a connector straight after it, or another
 * "never" in its clause or the next one, after a semicolon or a dash ("…, and an eviction never moves it"), makes it
 * the claim again.
 */
const NEVER_MOVES = String.raw`(?:(?:never|no longer) ${EVER}${MOVES_ON}|(?:(?:is|are) (?:never|not|no longer)|isn't|aren't) ${EVER}(?:re-resolved|refreshed|re-read|re-checked)|(?:cannot|can't|can never|does not|doesn't|do not|don't|will not|won't) ${EVER}${MOVE_ON})\b(?! (?:(?:a|the|its|each) (?:segment|pointer|generation)s? )?on a timer\b(?!${CONNECTOR}|${CLAUSE}\b(?:or|nor|either|neither|at all|otherwise)\b|${CLAUSE}(?:(?:;| - )${CLAUSE})?${ANOTHER_NEVER}|${CLAUSE}(?:;| - )${CLAUSE}\b(?:either|neither|nor)\b))`;
/** Until the store or its process ends: "until it restarts", "until you restart it", "until the process exits". */
const UNTIL_IT_ENDS = String.raw`until (?:(?:it|the (?:process|store|pod|container|server|service|app))(?: is)? (?:restart(?:s|ed)|exits|ends|stops|dies|killed|terminates|shuts down)|(?:you|they|we|someone|an operator) restarts? (?:it|them|the (?:process|store))|(?:a|the|the next|its next) restart|restart(?:ed)?)`;
/** Held for good, one way or another: "forever", "indefinitely", "until the next restart". */
const FOR_GOOD = String.raw`(?:forever|permanently|indefinitely|for all time|${UNTIL_IT_ENDS})`;
/** Said to give one instant, which is what `seg.pin()` is for: "describes one instant", "reads a single instant". */
const ONE_INSTANT = String.raw`\b(?:describes?|gives?|holds?|reads?|sees?|keeps?)(?<!\b(?:not|never|no) \w+) (?:just |only |exactly )?(?:one|a single) instant\b`;
/** A pin named any way: "pin", "`seg.pin()`", "pinning", "a pinned handle". */
const PIN_NAMED = String.raw`\b(?:pin\(\)|pins?|pinning|pinned handles?)(?![\w(])`;
/** The same after the words that offer something in its place: "instead of a pin", "over `seg.pin()`". */
const A_PIN = String.raw`(?:(?:a|an|the|one) )?(?:\w+\.)?${PIN_NAMED}`;
/**
 * Offered in a pin's place, or said to make one needless: "instead of `seg.pin()`", "over `seg.pin()`", "no need for a
 * pin", "makes `seg.pin()` redundant".
 */
const IN_PLACE_OF_A_PIN = String.raw`(?:\b(?:(?:instead of|in place of|in lieu of|rather than|in preference to)(?: (?:taking|take|using|use|calling|call|holding|hold))?|over|no need (?:for|of|to(?: (?:take|call|use))?)) ${A_PIN}|\b(?:makes?|making|made|renders?|rendering|rendered)(?<!(?:\bnot|\bnever|n't) \w+) ${A_PIN} (?:redundant|unnecessary|needless|superfluous|obsolete|moot)\b|${PIN_NAMED} (?:is|are|becomes?) (?:then |thus |therefore |now )?(?:redundant|unnecessary|needless|superfluous|obsolete|moot|not needed|unneeded)\b|${PIN_NAMED} (?:isn't|aren't) needed\b|\b(?:do not|don't|does not|doesn't|no longer) need ${A_PIN})`;
/**
 * What ends a hold, named in the clause that states it: "until an eviction, a swept read or an invalidation". A
 * claim that says so is the correction, and true.
 */
const UNTIL_MOVED = String.raw`(?:(?: [\w'-]+){0,6})? until (?:(?:an?|the|its|it is) )?(?:evict|swept|sweep|invalidat|reader cache evicts|\`?(?:store\.)?invalidate)`;
/** Said never to change: "never changes", "does not advance", "is fixed", "stays frozen". */
const FIXED = String.raw`(?:(?:never|does not|doesn't|will not|won't) (?:changes?|moves?|advances?)|(?:is|are|stays?|remains?) (?:fixed|frozen))(?!${UNTIL_MOVED})`;
/** Said to stay on a generation, by any verb but "pins": "stays on its first generation", "freezes each segment". */
const STAYS = String.raw`\b(?:(?:stays?|remains?|stuck|sticks?|freezes?|frozen|locks?|locked)(?<!\b(?:not|never|no) \w+)|(?<!\b(?:not|never|no)|n't) keeps? (?:serving|using|reading)) (?:(?:on|at|to|with|in) )?(?:(?:each|every|its|their|the|one|a) )?(?:(?!(?:newest|latest) )[\w'-]+ )?(?:segments?|generations?|snapshots?|pointers?)\b(?!${UNTIL_MOVED})`;

/** Phrases that describe the library's behaviour falsely, each with what to say instead. */
/** A load as a sentence's subject: one, the, each or every load (a later or next one too), or loads. */
const A_LOAD = String.raw`\b(?:(?:an?|the|each|every)(?: later| next)? load|loads)\b`;
/** A load as a sentence's subject, `store.load()` too. */
const A_LOAD_CALL = String.raw`(?:${A_LOAD}|\bstore\.load\(\))`;
/**
 * What a true sentence about a load's collection names: that it is by name, the sixteenth generation it lists on, the
 * `keep` above 64 (more than a row records), a row that records no list, or a check that met an object that make it
 * list, or a writer that always lists. (`*Into` is
 * not one of the words: a reading of the page drops its asterisk, so it would be a word that can never match.)
 */
const COLLECTION_CONDITION = String.raw`\b(?:by name|sixteenth|16th|check(?:s|ed)?|taken|meets?|holds?|held|erasure|rewrite|materiali[sz]ations?|wider|(?:above|over|more than) (?:64|sixty-four)|records? (?:no|none)|no list|absent|not know)\b`;
/** What a true sentence about a load's numbering names: the check and what it finds, or the writers that list. */
const NUMBERING_CONDITION = String.raw`\b(?:check(?:s|ed)?|taken|meets?|holds?|held|cannot answer|erasure|rewrite|nextGeneration)\b`;

/** Why a page may not say a write is never retried. */
const WRITE_RETRY =
  'a write is retried where that is safe: the registry row is sent once and, when it gets no answer, settled by reading the row and sent again as a bounded fresh compare-and-swap; a throttled write-once object is sent again on S3 and GCS. Say which write, and that a lost response, a timeout and every delete are not sent again';

const REFUSED_CLAIMS: ReadonlyArray<{ readonly claim: RegExp; readonly why: string }> = [
  {
    claim: new RegExp(g(String.raw`publish(?:es|ing)? an empty generation over \`?dest`), 'i'),
    why: 'the *Into verbs refuse an empty result over a non-empty destination — say that instead',
  },
  {
    claim: new RegExp(g('an empty result publishes an empty generation'), 'i'),
    why: 'the *Into verbs refuse it; `allowEmpty: true` is the override',
  },
  {
    claim: new RegExp(g('still calls the bulk-load path directly'), 'i'),
    why: 'the *Into verbs route through the guarded loadSegment path',
  },
  {
    claim: new RegExp(g('does not yet cover these verbs'), 'i'), // read in plain text, its bold gone
    why: 'the load guard covers the *Into verbs',
  },
  // No page (the guide, the privacy notes, a shipped doc-comment, a test) may call a store with no timed refresh a
  // pin ("pin forever", "pins the generation for its lifetime"), because such a store still moves on: its reader
  // cache evicting the segment, a read finding the generation it holds swept, and an invalidation (its own `load`,
  // `rollback`, `eraseSubject` and `*Into` writes, or `invalidate()`) each re-resolve it. `seg.pin()` is the one thing
  // that holds a generation, and a sentence calling the store a pin teaches readers to reach for `cache.genTtlMs: 0`
  // instead. The patterns read prose, not syntax, so bold and entities are resolved first (`**pins**` would pass a
  // pattern that reads the raw text). When a true sentence trips one, reword the sentence: of a real pin, say "a
  // pinned handle holds its generation for the life of the handle". A paraphrase can always escape a list of
  // patterns, which is why each hit says what to write instead. The forms are the ones the claim is written in and
  // the paraphrases written to get past them. What no pattern here reads is left to review: a claim whose subject
  // is in another sentence ("It pins…") or in the heading above it, subject and claim further apart than the 60 or 80
  // characters each pattern allows, a table whose header, not its cell, says "Pinned" or names the setting, and a
  // sentence a program builds other than from string literals joined by `+`, as prettier wraps them.
  {
    claim: new RegExp(
      g(NOT_NEGATED + String.raw`${PIN_WORD} (?:[\w'(),-]+ ){0,5}${FOR_GOOD}\b`),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // One generation kept for good; "a keep that holds every generation forever" is retention, and true.
    claim: new RegExp(
      g(
        String.raw`\b(?:keeps?|kept|holds?|held|reads?|serves?|served|answers? from) (?:[\w'-]+ ){0,2}?(?:its|their|the|one|a|that)(?: (?:first|first-resolved|resolved|current|same|single|own))? ` +
          String.raw`(?:generation|pointer|snapshot|reader)s? (?:[\w'(),-]+ ){0,3}` +
          String.raw`(?:${FOR_GOOD}|for the life of the (?:store|source|process|reader|cache|client)|(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime)\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // "For good" is the idiom only where it ends its clause: "held for good reason" is not the claim.
    claim: new RegExp(
      g(
        NOT_NEGATED +
          String.raw`${PIN_WORD} (?:${SPAN}{1,60}? )?(?:(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime\b|for good\b(?! \w)|for the life of the (?:store|source|process|reader|cache)\b)`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // Held for a lifetime: a generation, snapshot, pointer or reader, not any word ("a row holds its DEK for the
    // segment's lifetime" is true).
    claim: new RegExp(
      g(
        String.raw`\b(?:holds?|held|keeps?|kept)\b (?:${SPAN}{0,40}? )?(?:generation|snapshot|pointer|reader)s? ` +
          String.raw`(?:${SPAN}{0,30}? )?(?:(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime\b|for good\b(?! \w)|for the life of the (?:store|source|process|reader|cache)\b)`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh said to pin, in either order.
    claim: new RegExp(
      g(
        String.raw`${PINS}${within(80)}${NO_TIMED_REFRESH_SUBJECT}|${NO_TIMED_REFRESH_SUBJECT}${within(80)}${PINS}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh does move on, so "never" is the false claim, in either order.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}\b${NEVER_MOVES}|\b${NEVER_MOVES}${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // "Never, with no clock": a store's re-resolving, said to stop. Of the timed refresh it is true, and said plainly
    // instead: "with no clock there is no timed refresh".
    claim: new RegExp(
      g(String.raw`\bnever,? (?:if|when|with|for) (?:[\w'-]+ ){0,4}${NO_TIMED_REFRESH_SUBJECT}`),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // The generation a store with no timed refresh reads, said never to change.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}\b(?:generation|pointer|snapshot)s? ${FIXED}\b|` +
          String.raw`\b(?:generation|pointer|snapshot)s? ${FIXED}\b${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A pin holds a generation; a pointer is what a store re-reads. In either order: "its pointer pinned".
    claim: new RegExp(
      g(
        NOT_NEGATED +
          String.raw`\b(?:pin(?:s|ned|ning)? (?:each|every|its|their|the|a|one|that) (?:[\w'-]+ )?pointers?|pinned pointers?|pointers? (?:is |are |stays? |kept |held |left )?pinned)\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh, labelled "Pinned" where a sentence, a comment line or a value opens: "Pinned: no
    // refresh at all", "Pinned, it is two", "Pinned (no refresh)", "Pinned — none", "Pinned. The model bills none",
    // `name: "Pinned: …"`. Capitalised, as a label is: `pinned:` in code is a key. Of a real pin, say "a pinned handle".
    claim:
      /Pinned(?<=(?:^|\n|[:=([,|]|[.!?](?=[^\S\n]))[^\S\n]*(?:(?:\/\/|\*|#+|>|-|\d+\.)[^\S\n]*)?Pinned)(?:[^\S\n]*[:,(]|\.(?!\w)|[^\S\n]+-[^\S\n])/,
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh said to give one instant, which only `seg.pin()` does, or offered in its place, in
    // either order.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}(?:${within(80)}${ONE_INSTANT}|${within(60)}${IN_PLACE_OF_A_PIN})|` +
          String.raw`(?:${ONE_INSTANT}|${IN_PLACE_OF_A_PIN})${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh said to stay on a generation, by any other verb, in either order.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}${STAYS}|${STAYS}${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // What the calibration harness does is turn the timed refresh off; it pins nothing.
    claim: new RegExp(
      g(String.raw`\b(?:harness|timed (?:store|intersect|read)s?)(?:'s?)? (?:now )?pins\b`),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // One of the four things that re-resolve a segment, said to be the only one: "re-resolves only on a timer", "only
    // when its TTL lapses", "moves on only when invalidated". Said of a verb that moves a store on, or sees or picks up
    // a change: "runs only on a timer" is not.
    claim: new RegExp(
      g(
        String.raw`\b(?:(?:re-resolv|refresh|re-read|re-check|converg|resolv)\w*|mov(?:e|es|ed|ing) (?:on|to)|sees?|picks? up|advances?|changes?|(?:is|are) updated|goes)\b${within(60)}\bonly (?:on|at|with|by|after|through|when|once|if|upon) (?:(?:it is|it's|it has been|they are|they're) )?(?:(?:a|an|the|its|their) )?(?:(?:timed refresh(?:es)?|timer|(?:TTL|genTtlMs) (?:lapses|has lapsed|expires|has expired|elapses|runs out)|invalidat(?:ed|ions?))\b|invalidate\(\))`,
      ),
      'i',
    ),
    why:
      'a store re-resolves a segment on four things, and this names one of them as the only one: a timed refresh, ' +
      'an eviction, a read that finds its generation swept, and an invalidation each re-resolve it',
  },
  // estimateCost() adds store.load()'s requests to a load and each operand's pointer and tail reads to an intersect,
  // so a sentence telling a reader to fold the pointer's requests into requestsPerLoad and chunksPerIntersect by hand
  // is false.
  {
    claim: new RegExp(g(String.raw`(?:does not|doesn't) count the pointer`), 'i'),
    why: 'estimateCost() counts the pointer, the index and the pointer refresh',
  },
  {
    claim: new RegExp(g('has no term (?:yet )?for the pointer'), 'i'),
    why: 'estimateCost() has a term for each of the pointer, the tail read and the refresh',
  },
  {
    claim: /requestsPerLoad: (?:2\.24|4\.56|4\.64|4\.72)\b|`4\.(?:56|64|72)`/,
    why: "requestsPerLoad is the object's own PUT-class requests; the model adds what store.load() makes",
  },
  {
    claim: /chunksPerIntersect: 204\b/,
    why: "chunksPerIntersect is the chunk range requests an intersect makes, not its chunks; the model adds each operand's pointer and tail read",
  },
  {
    claim: new RegExp(g('Fetching neighbouring chunks together would cut'), 'i'),
    why: 'combines and iterate read neighbouring chunks together as ranges',
  },
  {
    claim: new RegExp(g('Nothing (?:in the engine )?calls (?:it|getChunks) yet'), 'i'),
    why: 'combines and iterate read each operand through getChunks',
  },
  {
    claim: new RegExp(g('until it counts them itself'), 'i'),
    why: 'estimateCost() counts the pointer, the index and the pointer refresh',
  },
  {
    claim: new RegExp(g(String.raw`(?:does not|doesn't) add (?:this )?for you yet`), 'i'),
    why: "estimateCost() adds the pointer, the tail reads and store.load()'s requests itself",
  },
  {
    // A rollback leaves every generation it rolled back from above the pointer, and several can hold the id.
    claim: new RegExp(
      g(String.raw`deletes the (?:one |single )?holder (?:there|above (?:the|its) pointer)`),
      'i',
    ),
    why: 'an erasure deletes every generation above the pointer that holds the id, and keeps the ones that do not — say "each holder"',
  },
  {
    claim: new RegExp(
      g(String.raw`the winner(?:'|’)s generation is (?:necessarily|always) higher`),
      'i',
    ),
    why: "a refused rewrite that took its number after the winner's object was in the bucket sits above the winner's pointer, and deletes its own object before returning — say that",
  },
  {
    claim: new RegExp(g('no orphan is left behind by a refused rewrite'), 'i'),
    why: "a refused rewrite deletes its object only when it sits above the winner's pointer; elsewhere it stays, as a refused load's does",
  },
  // The S3, GCS and Azure Blob packages can time their reads (`readTimeoutMs`), so a page may not say the library has
  // no timeout. What is true is narrower: nothing is timed unless that is set, and no write, delete or listing is timed
  // on any backend.
  {
    claim: new RegExp(
      g(
        String.raw`(?:the|this) library (?:has|sets) (?:none|no (?:request )?timeouts?) of its own`,
      ),
      'i',
    ),
    why: 'the S3, GCS and Azure Blob packages time each read when `readTimeoutMs` is set — say what is not timed: any read while it is unset, and every write, delete and listing',
  },
  // A load's guard read and an erasure's reads run under the store's read retry, so no page may say they are not
  // retried. The write itself is still sent once; say that instead.
  {
    claim: new RegExp(g(String.raw`nor are an erasure(?:'|’)s reads`), 'i'),
    why: "an erasure's reads and a load's guard read are retried as the store's reads are; only the writes are not",
  },
  {
    claim: new RegExp(
      g(
        String.raw`(?:an erasure(?:'|’)s reads|a load(?:'|’)s guard read)(?: and (?:an erasure(?:'|’)s reads|a load(?:'|’)s guard read))? (?:is|are) not retried`,
      ),
      'i',
    ),
    why: "an erasure's reads and a load's guard read are retried as the store's reads are; only the writes are not",
  },
  // A write is retried where that is safe, so no page may say it never is. The registry row is sent once by the driver
  // and reconciled by its effect (a bounded fresh compare-and-swap); a write-once object is sent again after a
  // throttle on S3 and GCS, under a write id. What is true is narrower: no delete is retried, and nothing is
  // re-sent after a lost response or a timeout.
  {
    claim: new RegExp(g(String.raw`\bwrites?(?: and deletes)? (?:is|are) never retried`), 'i'),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(
      g(String.raw`\bwrites?(?: and deletes)? (?:is|are) not retried`) + `(?!${GAP}by\\b)`,
      'i',
    ),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(g(String.raw`never retries (?:a |any |the )?writes?\b`), 'i'),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(g(String.raw`nothing replays a write`), 'i'),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(g(String.raw`nothing wraps a write`), 'i'),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(g(String.raw`sent once whatever (?:it is configured to do|they say)`), 'i'),
    why: "the driver sends a registry row once, and a generation's object again after a throttle on S3 and GCS: say which, and that it is the SDK's own retry that is off",
  },
  {
    claim: new RegExp(g(String.raw`\bwrites are yours to re-run`), 'i'),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(
      g(String.raw`a write, its compare-and-swap included, reports (?:one|it)\b`),
      'i',
    ),
    why: 'a registry write that gets no answer is settled by reading the row, and sent again as a bounded fresh compare-and-swap when it is unchanged; only a fault that read does not settle is reported',
  },
  {
    claim: new RegExp(
      g(String.raw`(?:is|are) what the S3 driver and the single-request GCS upload do(?=[;,.])`),
      'i',
    ),
    why: "the S3 driver and the single-request GCS upload send a generation's object again after a throttle, under a write id; sending each write once is what their registry writes do",
  },
  {
    claim: new RegExp(
      g(String.raw`a transient fault on a write reaches you, and the retry is yours`),
      'i',
    ),
    why: WRITE_RETRY,
  },
  {
    claim: new RegExp(g(String.raw`no \`?AbortSignal\`? anywhere in (?:this|the) library`), 'i'),
    why: "the S3 and Azure Blob packages abort a read that runs past `readTimeoutMs` through its request's abort signal — say that no write is timed",
  },
  {
    claim: new RegExp(g('fresh, greater token'), 'i'),
    why: 'tokens are not ordered: a later create gets a token never issued before under the name',
  },
  {
    claim: new RegExp(g("makes the row's token unique for all time"), 'i'),
    why: "a tombstone's counter is not all that keeps tokens apart: every token carries random parts",
  },
  {
    claim: new RegExp(g('starts the counter again and re-issues a token'), 'i'),
    why: 'a re-created row draws a new incarnation id, so its tokens are new even when its counter restarts',
  },
  {
    claim: new RegExp(g('would issue tokens from 0 again'), 'i'),
    why: "a re-created row's tokens carry a new incarnation id, whatever its counter",
  },
  {
    claim: new RegExp(g('tokens issued after `?T`? will be issued again'), 'i'),
    why: 'every write draws its own part of the token, so a restored row is never given a token it had before',
  },
  {
    claim: new RegExp(
      g(
        String.raw`keeps (?:its bare token|the (?:token )?form it was born with) for (?:as long as it lives|life)`,
      ),
      'i',
    ),
    why: 'a row 0.11 wrote keeps its bare counter only until its first 0.12 write, which adds a write part',
  },
  {
    claim: new RegExp(g('token that is not a plain decimal counter passes the read'), 'i'),
    why: 'a token in no form the registry writes fails the read, naming the row',
  },
  {
    claim: new RegExp(
      g('(?:keeps? the token monotonic|monotonic token survives|token is a monotonic counter)'),
      'i',
    ),
    why: 'the token is not ordered: its counter advances, beside random parts',
  },
  // A load's numbering. A true sentence about it says the condition the retired rule left out: the check finding the
  // number taken, an object holding it, or another writer, the erasure rewrite or `nextGeneration`, which still number
  // above everything. The first three entries leave alone a sentence that names one of these anywhere in it, and refuse
  // one that states the rule without it; such a sentence passes reworded to say it ("once its check meets one, a load
  // numbers above them all"), and the cases below show each collision with its rewording.
  {
    claim: new RegExp(
      g(
        String.raw`(?<!${NUMBERING_CONDITION}[^.]{0,160})${A_LOAD}(?![^.]{0,160}${NUMBERING_CONDITION})[^.]{0,80}?\b(?:one )?above the highest\b`,
      ),
      'i',
    ),
    why: 'a load takes `currentGen + 1` when no object holds it, and numbers above everything in the bucket only when its check finds that number taken or cannot answer',
  },
  {
    claim: new RegExp(
      g(
        String.raw`(?<!${NUMBERING_CONDITION}[^.]{0,160})${A_LOAD} (?:numbers?|is numbered|are numbered) (?:its generation |their generations? )?above (?:them|it)\b(?![^.]{0,160}${NUMBERING_CONDITION})`,
      ),
      'i',
    ),
    why: 'a load can number below an object above the pointer: such objects stay until loads pass them (the first whose number one of them holds numbers above them all), or until a generation above them is current',
  },
  {
    claim: new RegExp(
      g(
        String.raw`(?<!${NUMBERING_CONDITION}[^.]{0,160})\b(?:lists?|listing|listings)\b(?: the segment)?(?: twice)?[^.]{0,30}?\b(?:to (?:choose|number)|that numbers?) (?:the|a|its) generation(?: number)?\b(?![^.]{0,160}${NUMBERING_CONDITION})`,
      ),
      'i',
    ),
    why: 'a load checks that its generation number is free with one metadata request, and lists the segment for it only when the check finds the number taken',
  },
  {
    claim: new RegExp(
      g(
        String.raw`store\.load\([^)]*\)[^.]{0,200}?\babout (?:twice|doubles?|half as much again)\b|\babout doubles a load(?:'|’)s bill\b|\bhalf (?:a|the) load(?:'|’)s bill again\b`,
      ),
      'i',
    ),
    why: "store.load() adds about a tenth to the write and publish's bill, not half again and not as much again",
  },
  {
    claim: new RegExp(
      g(
        String.raw`\b(?:reads (?:the |its )?(?:registry )?pointer seven times|seven (?:registry )?pointer reads)\b`,
      ),
      'i',
    ),
    why: "a segment's first load reads the pointer three times and checks its generation number once",
  },
  // A load's collection. A true sentence about it says the condition the retired rule left out: that the generation
  // is deleted by name and the segment listed on the sixteenth, or the `keep` or the object above the pointer that
  // makes it list, or the writer that always lists.
  {
    claim: new RegExp(
      g(
        String.raw`(?<!${COLLECTION_CONDITION}[^.]{0,160})${A_LOAD_CALL}(?![^.]{0,200}${COLLECTION_CONDITION})[^.]{0,80}?\b(?:lists?|listing)\b[^.]{0,60}?\b(?:to collect|and collects?|then collects?|before it collects?|for (?:its )?collection)\b`,
      ),
      'i',
    ),
    why: 'a load whose row records the generations it keeps (a `keep` up to 64) and that found nothing above its pointer deletes the generations its publish pushed out of the window by name, and lists the segment only every sixteenth generation, for a `keep` above 64, for a row that records no list, and when its check met an object',
  },
  // A load's collection at a `keep` of 2 or more is by name too, so a page may not say it lists.
  {
    claim: new RegExp(
      g(
        String.raw`\b(?:a|the|each|every) (?:store\.)?load (?:that|which|with|whose|when) (?:[\w'-]+ ){0,4}?\bkeeps? (?:of )?(?:2|two|more|several|many|(?:two|2|three|3) or more)\b[^.]{0,80}?\blists?\b|\b(?:whenever|when) \`?keep\`? (?:is )?(?:2|two) or more\b[^.]{0,60}?\blists?\b|\blists? on every load\b[^.]{0,40}?\b(?:whenever|when) \`?keep\`? (?:is )?(?:2|two) or more\b|\bkeep: 12\b[^.]{0,40}?\blists? (?:on )?every`,
      ),
      'i',
    ),
    why: 'a load collects by name at any `keep` up to 64, from the generations its row records; it lists on every sixteenth generation, for a `keep` above 64, for a row that records no list, and when its check met an object',
  },
  {
    claim: new RegExp(
      g(
        String.raw`\bnext (?:store\.)?load of (?:the|that|its) destination collects (?:everything|its predecessors)\b`,
      ),
      'i',
    ),
    why: "the next load of a destination deletes the one generation its own publish pushes out of the window by name; an `*Into` with `keep` collects every generation below its own pointer at once, and a load's listing, on every sixteenth generation, takes the rest",
  },
];

/**
 * Files that DEFINE the rule and so must spell the refused phrases out — this one, and nothing else.
 *
 * History is not scanned: it says what was true when it was written, and would be a worse record rewritten to match
 * today. That is a released section of CHANGELOG.md, and a calibration run's dated report, which describes the
 * harness as that run used it. `[Unreleased]` is not history — it is what ships next — so it is read; so is a living
 * page that sits beside the reports, such as that directory's README.
 */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'superseded-behaviour-claims.test.ts')]);
const { checkRunId } = createRequire(import.meta.url)('../../bench/lib/calibrate-guards.cjs') as {
  checkRunId: (id: string) => string;
};
/**
 * A calibration run's report: a page in that directory named by an id the harness itself would accept for a run, beside
 * the `<id>.json` evidence that run wrote. A page named like one, with no run behind it, is read like any other.
 */
const RUN_REPORT = /^bench[\\/]calibration[\\/](.+)\.md$/;
const isHistory = (rel: string): boolean => {
  const id = RUN_REPORT.exec(rel)?.[1];
  if (id === undefined || !existsSync(join(ROOT, dirname(rel), `${id}.json`))) return false;
  try {
    checkRunId(id);
    return true;
  } catch {
    return false;
  }
};
/** The part of a file the rule reads: all of it, but of a changelog only what comes before its first release. */
function scanned(rel: string, text: string): string {
  if (basename(rel) !== 'CHANGELOG.md') return text;
  const next = text.indexOf('\n## [', text.indexOf('## [Unreleased]') + 1);
  // Cut from the start, so offsets, and the line numbers read from them, stay the file's own.
  return next < 0 ? text : text.slice(0, next);
}

function textFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry)) continue;
      const child = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(child);
    }
  };
  walk('.');
  return out.filter((f) => !DEFINES_THE_RULE.has(f) && !isHistory(f));
}

describe('no document claims behaviour this library does not have', () => {
  const files = textFiles();

  it('is scanning the surfaces a behaviour claim is written on', () => {
    // The guide, the roadmap, the facade's doc-comments and the site each state behaviour. A guard that stopped
    // reaching them would pass silently.
    expect(files).toContain(join('docs', 'guide', 'getting-started.md'));
    expect(files).toContain(join('docs', 'ROADMAP.md'));
    expect(files).toContain(join('packages', 'roaring', 'src', 'index.ts'));
    expect(files.some((f) => f.startsWith('site/'))).toBe(true);
    // The living pages are read, the history beside them is not.
    expect(files).toContain('CHANGELOG.md');
    expect(files).toContain(join('bench', 'calibration', 'README.md'));
    expect(files.some(isHistory)).toBe(false);
    // And the prose that lives outside Markdown and TypeScript: scripts, workflows and issue forms, data, charts.
    for (const ext of ['.js', '.yml', '.json', '.svg'])
      expect(files.some((f) => f.endsWith(ext))).toBe(true);
    expect(files.length).toBeGreaterThan(150);
  });

  // Both directions: each refused form is caught however it wraps, and the sentences that must stay legal are not.
  it.each([
    'with `cache: { genTtlMs: 0 }` ("pin forever"), holds',
    'instead of pinning one generation\n   * forever.',
    'the source **pins** the\n   * first-resolved generation for its lifetime',
    'holds its resolved snapshot for its own lifetime',
    "the fixture pins a segment's generation for the store's lifetime",
    '(pinned per source lifetime)',
    "Each timed intersect now pins its store's pointers (`cache.genTtlMs: 0`)",
    'the source **pins** the **generation** forever',
    'the source <strong>pins</strong> it forever',
    'pins&nbsp;the generation forever',
    'pins the first generation it resolved forever',
    '// the store pins the generation\n  // forever',
    'with `cache.genTtlMs = 0` the store pins it',
    'the fixture pins it for good',
    'a store built with no clock never re-resolves a segment',
    // Markup a renderer takes away: emphasis, code spans, links and tags.
    'the source *pins* the *generation* forever',
    'the source _pins_ the _generation_ forever',
    'the source `pins` the generation forever',
    'the source [pins](#pin) the generation forever',
    'the source <b>pins</b> the generation forever',
    'the source <em>pins</em> the generation forever',
    'the source <i>pins</i> the generation forever',
    'the source <span class="k">pins</span> the generation forever',
    '<a href="#pin">pins</a> the generation forever',
    // Entities, named and numeric, and the dashes they spell.
    'pins the generation &mdash; forever',
    'pins the generation &ndash; forever',
    'pins the generation&#x2014;forever',
    'pins the generation&#8212;forever',
    'the store pins the generation — forever',
    // The "never" form, wrapped, in the plural, and of each thing that turns the timed refresh off.
    'a store with no clock never\n   * re-resolves a segment',
    'a store with no\n   * clock never re-resolves a segment',
    'stores with no clock never re-resolve a segment',
    'a store with no clock never refresh',
    'a store with no registry never re-resolves a segment',
    'with `cache: { genTtlMs: 0 }` the store never re-reads the pointer',
    'with `genTtlMs: 0` it never observes a new generation',
    'cache.genTtlMs: 0 means the store never moves on',
    'a store whose `genTtlMs` is 0 never re-resolves a segment',
    'with `genTtlMs` set to 0 the store pins it',
    // And its synonyms.
    'the store keeps its first generation forever when `genTtlMs` is 0',
    'pins the generation for all time',
    'pins it permanently',
    "a store re-reads a segment's pointer only on a timed refresh",
    // Sentences in the repo's own phrasing and word orders.
    '`0` pins each pointer for as long as the reader keeps the segment open.',
    'A pinned pointer (`genTtlMs: 0`) is not refreshed.',
    'The exception is a source that never re-resolves — no clock injected, no registry, or `cache: { genTtlMs: 0 }`.',
    'until its TTL lapses, and **never** if it has no clock or `cache.genTtlMs: 0`.',
    'A store with no clock pins each segment at the generation it first resolved.',
    'a store with `genTtlMs: 0` acts as a pin',
    'a store with no clock behaves like one big `seg.pin()`',
    'Setting `genTtlMs` to 0 pins the generation',
    'Stores with `genTtlMs: 0` hold their generation forever',
    'the source pins it indefinitely',
    'the store holds its generation for the life of the store',
    'a store with no clock does not re-resolve a segment',
    'A store with no clock never re-resolves a segment on its own: only `invalidate()` moves it.',
    // And markup a narrower strip would leave.
    'the source pins every {@link Segment} forever',
    'the source pins the segment\u2019s generation forever',
    'the source pins the generation, forever',
    'the source pins<br>forever',
    'the source [pins][pin] the generation forever',
    'the source pins <span\n  class="k">the</span> generation forever',
    'the fixture pins it for the life of the store',
    // A pin named in the sentence does not make it about a pin: here the store is the subject.
    'Like `seg.pin()`, a store with `genTtlMs: 0` holds its generation forever.',
    'Like a pin, a store with no clock never re-resolves a segment.',
    'A pin, like a store with no clock, never re-resolves.',
    'Take a `seg.pin()` for one instant.\nA store with no clock never re-resolves a segment.',
    'the whole promise of a pin, and the memo is allowed to be up to `cache.genTtlMs` behind — or, on a store with\n * no clock, arbitrarily far behind, since it never refreshes at all.',
    // The other things such a store is said never to do, and an "on a timer" that does not end the claim.
    'a store with no clock never sees a new generation',
    'with `cache.genTtlMs: 0` the store never sees a publish',
    'a store with no clock never re-reads a segment',
    'with `genTtlMs: 0` it never observes a publish',
    'A store with no clock never re-resolves a segment, not even on a timer.',
    'A store with no clock never re-resolves, on a timer or otherwise.',
    'A store with no clock never re-resolves on a timer or otherwise.',
    'A store with no clock never re-resolves a segment — not even on a timer.',
    // A sentence ends at a line end too, so the one before it cannot excuse it.
    'The timed refresh is off.\nA store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'A store with no clock keeps serving the same generation forever.',
    'With `genTtlMs: 0`, the pinned generation never changes.',
    '| `cache.genTtlMs: 0` | pins each segment at its first generation |',
    '| the fixture pins it | for the life of the store |',
    // What excuses "never" is said before it, not in the sentence after.
    'The store re-reads its pointer until the TTL lapses, and never if it has no clock. The timed refresh is off there.',
    // Labels and reversed orders.
    '// Pinned: no refresh at all, and the model bills none.',
    '// Pinned, it never refreshes, and the report bills none.',
    "Each timed intersect's store has its pointer pinned.",
    'the store keeps each pointer pinned',
    'as the library does when an intersect ends inside its pointer refresh, and which the harness now pins.',
    // Word orders and words an exemption or a narrowing would let through.
    '`cache.genTtlMs: 0` pins your segments at the generation they first resolved.',
    'A store with no clock pins segments to the generation it first read.',
    'Setting `genTtlMs: 0` amounts to pinning every segment.',
    'A store with `genTtlMs: 0` ends up pinning each segment.',
    'With `cache.genTtlMs: 0`, reads are pinned reads.',
    'A store with no clock serves pinned generations until it restarts.',
    'A store with `genTtlMs: 0` pins, in effect, the first generation it read.',
    'A store with no clock pins generation 0 until it restarts.',
    'Stores with `genTtlMs: 0` act like pins and never re-resolve.',
    'Stores with `genTtlMs: 0` act like pins.',
    'Stores with `genTtlMs: 0` behave like a pin.',
    'the source "pins" the generation forever',
    'the source \u201cpins\u201d the generation forever',
    'with `genTtlMs: 0` the store "pins" the generation forever',
    'with `genTtlMs: 0` the store \u201cpins\u201d the generation forever',
    'A store with no clock, like a pin, never re-resolves a segment.',
    'Like a store with no clock, a pin never re-resolves.',
    'A pin never re-resolves, and neither does a store with no clock.',
    'With `genTtlMs: 0` the store, just like `seg.pin()`, keeps its first generation forever.',
    '- **Timed refresh**\n  A store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'The timed refresh is off\nA store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'A store with no clock never re-resolves on a timer or on an eviction.',
    'A store with no clock never re-resolves on a timer, nor on an eviction.',
    'A store with no clock never re-resolves, because nothing fires on a timer.',
    'A registry-less store never re-resolves a segment.',
    'A store wired with a bare `IStorageDriver` never re-resolves a segment.',
    'A store with no injected clock never re-resolves a segment.',
    'With a `genTtlMs` of zero the store never re-resolves a segment.',
    'A store with no clock never picks up a new generation.',
    'A store with no clock never notices a publish.',
    'A store with `genTtlMs: 0` reads the same generation forever.',
    'A store with `genTtlMs: 0` keeps its first generation until it restarts.',
    '// Pinned, it is two — one per operand — however long the intersect takes.',
    // What an attribute shows is read.
    '<meta\n  name="description"\n  content="Set cache.genTtlMs: 0 and the store pins each segment forever"\n/>',
    '<img src="a.svg" alt="With no clock, the store pins it forever" />',
    // A pipe inside code ends no table row, so the claim across the wrap is still one sentence.
    "/**\n * With `cache.genTtlMs: 0` the store\n * pins each segment's generation (a `number | null`) at the one it first resolved.\n */",
    // "Until a restart", a TTL of zero, a quoted phrase, and more that such a store is said never to notice.
    'A store with `genTtlMs: 0` serves the same generation until a restart.',
    'With a TTL of zero, the store pins each segment at the generation it first resolved.',
    'the source "pins the generation" forever',
    "with `genTtlMs: 0` the store 'pins the generation' forever",
    "A store with `genTtlMs: 0` never notices another process's publish.",
    'A store with no registry never notices the drop.',
    // Labels that open with a dash or a bracket, and a label that is a value.
    '// Pinned — no refresh at all, and the model bills none.',
    '// Pinned (no refresh): the model bills none.',
    '{ "name": "Pinned: no timed refresh" }',
    'label: Pinned, no timed refresh',
    // The bare verb, and the subject spelled every other way.
    'Stores with `genTtlMs: 0` pin each segment at the generation they first resolved.',
    '`genTtlMs: 0` makes the store pin each segment at its first generation.',
    'Set `genTtlMs` to `0` to pin every segment.',
    'A store with no timed refresh pins each segment at its first generation.',
    'With the timed refresh off, the store pins each segment.',
    'When `cache.genTtlMs` is set to 0, the store pins each segment.',
    'With a zero `genTtlMs`, the store pins each segment.',
    'A store on a raw `IStorageDriver` pins each segment.',
    'A store without the registry pins each segment.',
    'A clockless store pins each segment.',
    // What an exemption would let through: a pinned handle, "pins nothing but", the life of a handle.
    'With `genTtlMs: 0`, every handle is a pinned handle.',
    '`store.segment()` returns a pinned handle when `genTtlMs` is 0.',
    '`genTtlMs: 0` pins nothing but the generation each segment first resolved.',
    'With `genTtlMs: 0`, a live handle holds its generation for the life of the handle.',
    // A pin named by a link or a code span.
    'A store with `genTtlMs: 0` behaves like a {@link Segment.pin}.',
    'A store with `genTtlMs: 0` behaves like `Segment.pin()`.',
    // "Never", however it is said, and "on a timer" that goes on.
    'With no clock, a segment is never re-resolved.',
    'A store with no clock never resolves a segment again.',
    'A store with no clock no longer re-resolves a segment.',
    'A store with no clock cannot see a newer generation.',
    'A store with no clock never actually re-resolves a segment.',
    'A store with no registry never sees an erasure made by another store.',
    "A store with no clock re-reads a segment's pointer only on a timer.",
    'A store with no clock never re-resolves on a timer, and never on an eviction either.',
    'A store with no clock never re-resolves on a timer (or at all).',
    // A claim that goes on past a semicolon, or past an "e.g.".
    'With `genTtlMs: 0` the store is simpler; it pins each segment at its first generation.',
    'With `genTtlMs: 0`, e.g. on a replica, the store pins each segment.',
    // The claim with none of the pin words, and other verbs for it.
    'With `genTtlMs: 0`, a long export describes one instant.',
    'Use `cache: { genTtlMs: 0 }` instead of `seg.pin()` for a long export.',
    '`cache.genTtlMs: 0` is a store-wide `seg.pin()`.',
    'A store with `genTtlMs: 0` answers from its first generation forever.',
    'A store with `genTtlMs: 0` stays on its first generation.',
    'A store with no clock sticks with the generation it first resolved.',
    'With `genTtlMs: 0` the store freezes each segment at its first generation.',
    // A string a program prints, split across literals, or quoted as a label.
    "const note = 'a store with no clock never ' +\n  're-resolves a segment';",
    "const label = 'Pinned: it is two, one per operand';",
    '{ "name": "Pinned: it is two, one per operand" }',
    // Each form the ones above lean on, alone.
    "A store with no clock never re-reads a segment's pointer.",
    'A store with no clock never re-resolves on a timer, and never on an eviction.',
    // The same, wrapped or dashed as this repo's prose wraps and dashes: "or" opens the next line, or follows a dash.
    'A store with no clock never re-resolves on a timer\n * or otherwise.',
    'A store with no clock never re-resolves on a timer,\n * or on an eviction.',
    'A store with no clock never re-resolves on a timer\n> nor on an eviction.',
    '// A store with no clock never re-resolves on a timer\n// or on an eviction.',
    'A store with no clock never re-resolves on a timer — or otherwise.',
    'A store with no clock never re-resolves on a timer — nor on an eviction.',
    'A store with no clock never re-resolves on a timer &mdash; or on an eviction.',
    'With `genTtlMs: 0` the store never re-reads its pointer on a timer\n * or on an eviction.',
    'A store with no clock never re-resolves on a timer — and never on an eviction.',
    // The claim before its subject, for each claim a subject-first pattern would miss.
    'A long export describes one instant with `genTtlMs: 0`.',
    'Each segment stays on its first generation when `genTtlMs` is 0.',
    'Instead of `seg.pin()`, set `cache.genTtlMs: 0` for a long export.',
    // The subject spelled the other ways it is: run together or hyphenated, "neither … nor", disabled, in seconds,
    // plain, with no backend, and in a table, the setting in one cell and its value in the next.
    'A registryless store pins each segment.',
    'A clock-less store pins each segment.',
    'A store with neither a clock nor a registry pins each segment.',
    'With the timed refresh disabled, the store pins each segment.',
    'A store that disables the timed refresh pins each segment.',
    'With a TTL of 0s, the store pins each segment.',
    'A store on a plain `IStorageDriver` pins each segment.',
    'A store with no backend pins each segment.',
    '| cache.genTtlMs | 0 | pins each segment |',
    // Never moving on, in the verbs a narrower pattern misses: "cannot", the passive, a word between "never" and its
    // verb, "only" one of the four things, the end of the process, another writer's drop, "a single instant", and "on a
    // timer" followed by a second "never", a "nor" or a "neither", across a comma, a semicolon or a dash.
    'A store with no clock cannot re-resolve a segment.',
    'With no clock, a segment is never refreshed.',
    'With no clock, a segment is never re-read.',
    'With no clock, a segment is never re-checked.',
    'With no clock, a segment is not re-resolved.',
    'A store with no clock never re-checks its pointer.',
    'A store with no clock does not resolve a segment again.',
    'A store with no clock does not ever re-resolve a segment.',
    'A store with no clock never really re-resolves a segment.',
    'A store with no clock never even re-resolves a segment.',
    'A store with no clock re-resolves only when invalidated.',
    'A store with no clock re-resolves a segment only once it is invalidated.',
    'A store with no clock re-resolves only on `invalidate()`.',
    'A store re-resolves a segment only when its TTL lapses.',
    'A store with `genTtlMs: 0` keeps its first generation until you restart it.',
    'A store with `genTtlMs: 0` keeps its first generation until the next restart.',
    'A store with `genTtlMs: 0` keeps its first generation until the process exits.',
    'The fixture pins it until the process exits.',
    "A store with `genTtlMs: 0` reads one generation for the process's lifetime.",
    "A store with no registry never notices another writer's drop.",
    'With `genTtlMs: 0`, a long export describes a single instant.',
    'A store with no clock never re-resolves on a timer, and an eviction never moves it.',
    'A store with no clock never re-resolves on a timer; nor does an eviction move it.',
    'A store with no clock never re-resolves on a timer; neither does an eviction.',
    'A store with no clock never re-resolves on a timer, and neither does an eviction move it.',
    'A store with no clock never re-resolves on a timer; an eviction never moves it.',
    'A store with no clock never re-resolves on a timer — and an eviction never moves it.',
    // Said to be a pin or like one, or offered in a pin's place.
    'A store with `genTtlMs: 0` is equivalent to a pin.',
    'A store with `genTtlMs: 0` works just like a pin.',
    'A store with `genTtlMs: 0` acts as a pinned handle.',
    'A store with no clock amounts to one big pin.',
    'With `genTtlMs: 0`, a live handle is effectively a pinned handle.',
    'With `genTtlMs: 0`, a live handle is effectively a pin.',
    'With `genTtlMs: 0`, a live handle reads one generation for the life of the handle.',
    '`genTtlMs: 0` pins nothing apart from the generation each segment first resolved.',
    'With `genTtlMs: 0` there is no need for `seg.pin()`.',
    'Setting `genTtlMs: 0` makes `seg.pin()` redundant.',
    'With `genTtlMs: 0`, `seg.pin()` is unnecessary.',
    'Prefer `cache.genTtlMs: 0` over `seg.pin()` for a long export.',
    // Across a line end, where a claim's "or" or second "never" lands when the prose is wrapped, and after a dash that
    // opens the next line.
    'A store with no clock never re-resolves on a timer, and\n * an eviction never moves it.',
    'A store with no clock never re-resolves on a timer, not on an eviction\n * or otherwise.',
    'A store with no clock never re-resolves on a timer when it is idle\n * or otherwise.',
    'A store with no clock never re-resolves on a timer;\n * nor does an eviction move it.',
    'A store with no clock never re-resolves on a timer\n— or on an eviction.',
    '> A store with no clock never re-resolves on a timer\n> — or on an eviction.',
    ' * A store with no clock never re-resolves on a timer\n * — or on an eviction.',
    'A store with no clock never re-resolves on a timer when the workload is quiet, or otherwise.',
    'A store with no clock never re-resolves on a timer, not even after an eviction.',
    'A store with no clock never re-resolves on a timer, and not on an eviction.',
    'A store with no clock never re-resolves on a timer, let alone on an eviction.',
    'A store with no clock never re-resolves on a timer, much less on an eviction.',
    'A store with no clock never re-resolves on a timer; an eviction does not move it either.',
    // Each word the patterns know, alone.
    'A store with no clock never truly re-resolves.',
    'A store with no clock never once re-resolves.',
    'A store with no clock never automatically re-resolves.',
    "With no clock, a segment isn't re-resolved.",
    'With no clock, a segment is no longer refreshed.',
    'A store with no clock cannot converge.',
    'A store with no clock does not re-check its pointer.',
    'A store with no clock can never re-resolve.',
    'Stores with no clock do not re-resolve.',
    "Stores with no clock don't re-resolve.",
    'A store with no clock does not re-read `currentGen`.',
    'A store with no clock never re-reads `currentGen`.',
    'A store with no clock never sees updates.',
    'A store with no clock never sees a newer version.',
    "A store with no clock never sees any other store's publish.",
    'Turn off the timed refresh and a store never re-resolves.',
    'Switch off the timed refresh and the store never re-resolves.',
    'With neither the clock nor a registry, a store never re-resolves.',
    'With a TTL of 0ms, a store never re-resolves.',
    'A no-registry store never re-resolves.',
    'A raw-driver store never re-resolves.',
    'With `genTtlMs: 0`, a live handle is essentially a pinned handle.',
    'With `genTtlMs: 0`, a live handle is in effect a pin.',
    'A store with `genTtlMs: 0` functions as a pin.',
    'A store with `genTtlMs: 0` is the same as a pinned handle.',
    'A store with `genTtlMs: 0` behaves essentially like a pin.',
    'A store with `genTtlMs: 0` is like a pin.',
    'A store with `genTtlMs: 0` is the equivalent of a pin.',
    '`genTtlMs: 0` pins nothing besides the generation each segment first resolved.',
    'With `genTtlMs: 0`, a live handle serves one generation for the life of the handle.',
    'With no clock, a long export reads a single instant.',
    'Use `cache.genTtlMs: 0` in place of `seg.pin()`.',
    'Set `cache.genTtlMs: 0` rather than take a pin.',
    'Setting `genTtlMs: 0` renders `seg.pin()` redundant.',
    "With `genTtlMs: 0` you don't need `seg.pin()`.",
    "With `genTtlMs: 0`, a pin isn't needed.",
    'With no clock, the store pins each segment until the process dies.',
    'With no clock, a store keeps its first generation until the pod restarts.',
    'With no clock, a store keeps its first generation until restart.',
    'With no clock, a store keeps its first generation until an operator restarts it.',
    'With no clock, a store keeps its first generation until the process is killed.',
    'With no clock, the store holds its first generation for the life of the client.',
    'A store with no clock remains on its first generation.',
    'A store with no clock keeps serving the generation it first resolved.',
    "With no clock, each segment's generation is fixed.",
    "With no clock, each segment's generation stays frozen.",
    'A store with no clock re-resolves a segment only if it is invalidated.',
    'A store with no clock re-resolves only upon an invalidation.',
    'A store re-resolves a segment only once its TTL expires.',
    // Split across literals at a hyphen, and across tags that each hold a run of text.
    "const note = 'A store with no clock never re-' +\n  'resolves a segment.';",
    '<text>A store with no clock never</text><text>re-resolves a segment.</text>',
    '<td>cache.genTtlMs: 0</td><td>pins each segment forever</td>',
    // A label inside a call, an array or a table cell.
    "expect(note).toBe('Pinned: no refresh at all');",
    "notes.push('Pinned: none');",
    "['Pinned: none', 'x']",
    '| Pinned: no refresh at all | $0.00 |',
    // "Only" after the other verbs that move a store on, or see or pick up a change.
    'A store with `genTtlMs: 0` moves on only when it is invalidated.',
    'With no clock, a store moves to a new generation only after an invalidation.',
    'A store with no registry sees a publish only after an invalidation.',
    'With `cache.genTtlMs: 0`, a store picks up a new generation only when invalidated.',
    'With `genTtlMs: 0`, a segment is updated only on an invalidation.',
    "With no clock, a segment's generation advances only when it is invalidated.",
    'A store with no clock changes generation only when invalidated.',
    'With `genTtlMs: 0` the store goes to the next generation only after an invalidation.',
    'A store with a registry moves on only on a timer.',
    // "Reads" and "writes" as verbs, with their object: the subject stands.
    'A store with no registry reads no pointer, so it never re-resolves.',
    'A store with no registry reads the bucket, so it never re-resolves.',
    'A store with no clock reads its generation once and never re-resolves.',
    'A store with no registry writes nothing and never sees a publish.',
    // The next clause's "nor" or "neither", past a clause of its own.
    'A store with no clock never re-resolves on a timer; an eviction moves it no more, nor does an invalidation.',
    'A store with no clock never re-resolves on a timer; it moves on after neither an eviction nor a sweep.',
    "notes = ['a', 'Pinned: none'];",
    'A store with no clock keeps using the generation it first resolved.',
    'A store with no clock keeps reading its first generation.',
    'With no clock, a store keeps its first generation until the container restarts.',
    'With no clock, a store keeps its first generation until the server restarts.',
    'With no clock, a store keeps its first generation until the service restarts.',
    'With no clock, a store keeps its first generation until the app restarts.',
    'A store with `genTtlMs: 0` is much like a pin.',
    "const note = 'A store with no clock never' +\n  're-resolves a segment.';",
    "const note = 'A store with no clock never re' +\n  '-resolves a segment.';",
    'A store with no clock never re-resolves on a timer; on an eviction, neither.',
    // A label with a full stop.
    '// Pinned. The model bills none.',
    // A claim in a string whose quote is escaped or doubled, read as the program or the YAML prints it.
    "it('a store with no clock can\\'t see a new generation', () => {});",
    "description: 'A store with no clock can''t see a new generation.'",
    '{ "description": "the source \\"pins\\" the generation forever" }',
    // What an erasure deletes above the pointer, and what a refused rewrite leaves behind.
    'an erasure performed *after* a rollback also reaches above the pointer and deletes the holder there',
    '> performed *after* a rollback also reaches above the pointer and deletes the\n> holder there.',
    ' * if the write did complete, the winner’s generation is necessarily\n * higher, which puts ours below its pointer',
    "the winner's generation is always higher",
    ' * **No orphan is left behind by a\n * refused rewrite**, and it is worth saying why',
    // What the store retries.
    "Writes are not retried, and nor are an erasure's reads, a load's guard read, or the calls",
    "(an erasure's reads and a load's guard read are not retried)",
    "a load's guard read is not retried",
    // What a write's retry is.
    'Writes are never retried for you',
    'The write is never retried.',
    '   * The writes and deletes are never retried.',
    "the store retries a read's transient faults and never retries a write.",
    "On S3, and on GCS up to its simple-upload threshold, nothing replays a write's object either;",
    'Nothing wraps a write. A conditional put or compare-and-swap that lands and then loses its response',
    'which are sent once whatever it is configured to do.',
    'single-request conditional writes, which are sent once whatever they\n   * say.',
    '**Writes are yours to re-run.** What is retried for you:',
    'while a <em>write</em>, its compare-and-swap included, reports one, because a',
    'The first is what the S3 driver and the single-request GCS upload do; the second is what the Azure Blob driver',
    'So a transient fault on a write reaches you, and the retry is yours.',
    "An erasure's writes are not retried; its reads are.",
    // What the library times.
    'The library has no timeout of its own, because one would abandon requests',
    '| The library has none of its own; a hung request hangs the read |',
    'This library sets no request timeout of its own.',
    '- **Set a request timeout.** There is no `AbortSignal` anywhere in this library —',
    'there is no AbortSignal anywhere in the\n  library',
    // How a row's token changes.
    'A row written before 0.12 keeps its bare token for as long as it lives.',
    'a row keeps the form it was born with for life',
    // A load's numbering and cost as they were, and the paraphrases an honest rewrite would produce.
    'a load takes the next number itself: one above the highest the registry points at or that is present in the bucket',
    'A load numbers its generation one above the highest of the pointer and any object in the bucket',
    'The load takes one above the highest generation.',
    'Each load numbers its generation one above the highest.',
    'Loads number their generation one above the highest of the pointer and the bucket.',
    'a load numbers its generation above the highest present',
    'a load numbers its generation above them, and its collection never touches them',
    'They remain until a load numbers above them.',
    'until the next load numbers above them',
    'a later load numbers above it',
    'a later load is numbered above them',
    '`store.load()` adds the listings that number\n            the generation and collect what it supersedes',
    '`store.load()` also lists the segment to choose a generation number',
    'adds a listing to choose the generation number',
    'lists the segment twice (to choose the generation number, and to collect',
    '`store.load()` is expected at about twice that',
    '`store.load(ref, ids)` costs about twice the write and publish',
    "which about doubles a load's bill",
    '`store.load()` is expected at about half as much again.',
    "A test counts what that adds, about half a load's bill again.",
    'and reads the pointer seven times even with nothing racing it',
    'it reads the registry pointer seven times',
    'a first load makes seven pointer reads',
    // A load's collection as it was: a listing in every load, and the claims that follow from it.
    "`store.load()` also lists the segment's objects and collects the old ones",
    'Each load lists the segment to collect what its publish superseded.',
    'A load lists the bucket after it publishes, then collects the old generation.',
    'the load lists the segment and collects everything below its pointer',
    'With `keep` of 2 or more, a load lists the segment to collect on every load.',
    'A load that keeps two or more generations lists on every load.',
    'With keep of two, a load lists the segment to collect on every load.',
    'A load lists on every load whenever `keep` is 2 or more.',
    'At `keep: 12` a load lists every publish.',
    'The next load of the destination collects everything below its own pointer beyond its `keep`.',
    'and the next load of its destination collects its predecessors',
    "the next store.load of that destination collects everything it didn't",
  ])('catches the refused form %j', (text) => {
    expect(hitsIn('x.md', text)).not.toEqual([]);
  });

  it.each([
    'Pass `purgeTombstones: false` to keep every tombstone forever',
    '`seg.pin()` holds a segment at the generation current when you call it, for the life of the handle',
    "a monotonic move forward within that segment's lifetime, never a torn object",
    'a segment approaching ~2³² lifetime chunk-seals',
    '`cache: { genTtlMs: 0 }` turns the timed refresh off. A pinned handle is what holds one generation',
    'A pinned handle holds its generation for the life of the handle',
    'a store with no clock never re-reads a pointer on a timer, and never refreshes on a timer',
    'it can keep answering `true` for a dropped segment indefinitely',
    'the destroyed row is held for good reason',
    'Pass `purgeTombstones: false` and the sweep keeps every tombstone forever',
    'a store with no registry reads the newest generation in the bucket, and never re-resolves on a timer',
    'the timed refresh re-reads the pointer once `cache.genTtlMs` lapses, and an eviction re-reads it too',
    'a `snake_case_name` and `a * b` are not emphasis',
    // True sentences a broader rule would refuse: the gate's own advice, negations, and facts about other things.
    '`cache.genTtlMs: 0` means no timed refresh, and for one instant you want a pinned handle, `seg.pin()`.',
    '`cache: { genTtlMs: 0 }` turns the timed refresh off, and a pinned handle is what holds one generation',
    '`cache.genTtlMs: 0` pins nothing: take a `seg.pin()`.',
    'Nothing pins a generation forever — size `keep` to cover the longest job.',
    'A store with no registry never sees a `destroyed` tombstone, since there is no row to hold one.',
    'A `keep` of `Number.MAX_SAFE_INTEGER` holds every generation forever.',
    "The registry row holds the wrapped DEK for the segment's lifetime.",
    '### Stores with no registry\n\nA pinned handle never sees a publish, by design.',
    '| a store with **no clock**, or `cache: { genTtlMs: 0 }` | no bound |\n| a pinned handle (`seg.pin()`) in another store | no bound |',
    "The fingerprint keeps two incarnations' pins apart where the version cannot: on a store with no registry.",
    'On a store with no registry, the pinned object is found by its fingerprint.',
    // A claim's words never pair across a heading's blank line or a table cell's edge.
    '### With no clock\n\nThe loader pins its version to the lockfile',
    '`cache.genTtlMs: 0` turns the timed refresh off, and pinned handles are what hold one generation',
    '| no clock | none |\n| the loader pins its version | yes |',
    '| the loader pins its version | yes |\n| per process lifetime | once |',
    'no clock | none\nthe loader pins its version | yes',
    // `pin()` as the subject of "pins" says what a pin does, on any store.
    'Without a registry, `pin()` pins the newest generation in the bucket.',
    // True sentences about pins on a store with no clock or no registry, and negations.
    'Without a registry, `pin()` pins the newest generation in the bucket.',
    'A store with no clock never re-resolves a segment on a timer: an eviction or an invalidation moves it.',
    '<meta name="description" content="A pinned handle holds one generation for the life of the handle" />',
    // Look-alikes of the forms caught above, each true.
    'Only this segment is pinned, so pin each segment to hold a whole query.',
    'A store with no timed refresh re-resolves a segment on an eviction, a swept generation or an invalidation.',
    '`seg.pin()` returns a pinned handle.',
    'A store with no clock never re-resolves on a timer - an eviction or an invalidation moves it.',
    'With a TTL of 0.5 s the store never re-resolves more than twice a second.',
    'A store with no clock never re-resolves on a timer; each pin a segment holds keeps its own generation.',
    "Two incarnations' pins stay apart on a store with no registry.",
    '{ "label": "pinned" }',
    'With `genTtlMs: 0` a long export can describe two instants: take `seg.pin()` for one.',
    'Use `seg.pin()` instead of `cache: { genTtlMs: 0 }` for a long export.',
    'A store with no registry stays consistent with the bucket it lists.',
    '| `number | null` | a pinned handle holds one generation for the life of the handle |',
    'With `genTtlMs: 0` a long export does not describe one instant: take `seg.pin()`.',
    // More look-alikes, each true: the claim before its subject, negated; a pin offered in the
    // setting's place; "each pin" as a noun; the gate's own advice with another verb; "on a timer" and then what does
    // move the segment; the timed refresh's own TTL; a label that is not one.
    'A long export does not describe one instant with `genTtlMs: 0`: take `seg.pin()`.',
    'A segment an eviction moves does not stay on its first generation, even with `genTtlMs: 0`.',
    'Take `seg.pin()` instead of setting `cache.genTtlMs: 0` for a long export.',
    'Prefer `seg.pin()` over `cache.genTtlMs: 0` for a long export.',
    'Setting `genTtlMs: 0` does not make `seg.pin()` redundant.',
    "Setting `genTtlMs: 0` doesn't make `seg.pin()` redundant.",
    'Without a registry, the store gives each pin a tail read of its own.',
    'A pinned handle reads one generation for the life of the handle, even on a store with no clock.',
    'A store with no clock never re-resolves on a timer; an eviction or an invalidation moves it.',
    'A store with no clock never re-resolves on a timer — an eviction or an invalidation moves it.',
    'With no clock, a segment is never refreshed on a timer: an eviction or an invalidation moves it.',
    'The timed refresh re-reads the pointer when its TTL lapses.',
    '| cache.genTtlMs | 0 | no timed refresh: an eviction still re-resolves |',
    '// Pinned so a casual edit is deliberate.',
    // A claim's words in the next paragraph, a blank comment line included, and a verb that moves nothing.
    'A store with no clock never re-resolves on a timer\n\nOr set `genTtlMs` above 0 for a timed refresh.',
    ' * ### With no clock\n *\n * The loader pins every chunk it reads to its generation.',
    'The calibration job runs only on a timer.',
    'Until it is called, the source keeps serving that snapshot with no backend read at all.',
    "A store with no clock doesn't keep serving the old generation once it is invalidated.",
    // The correction, with what ends the hold named in its clause.
    'A store with no clock stays on its first generation until an eviction, a swept read or an invalidation.',
    'A store with no clock remains on its first generation until an eviction, a swept read or an invalidation.',
    'One with `cache: { genTtlMs: 0 }` keeps serving that generation until an eviction, a swept read or an invalidation moves it.',
    'With `genTtlMs: 0`, the generation is fixed until an eviction, a swept read or an invalidation moves it.',
    'With `genTtlMs: 0`, the generation never changes until an eviction, a swept read or an invalidation.',
    // A store with no registry, as the DR runbook describes it: the newest generation in the bucket.
    'With no registry, a store keeps using the newest generation in the bucket, whatever the pointer says.',
    'With no registry, a store keeps reading the newest generation in the bucket after a rollback.',
    'With no registry, a store remains on the newest generation in the bucket, not the restored pointer.',
    // "Reload" as loading again, and a store with no `seams.clock`, which uses the system clock.
    'A store with no backend cannot reload a segment: loading needs a registry.',
    'With no registry, do not reload the store to pick up a publish: call `invalidate()`.',
    'With no `seams.clock`, a test cannot see a publish until the real TTL lapses.',
    'The store keeps its reader cache for the life of the app, bounded by `cache.readerMax`.',
    // A sentence ended by a full stop that closes bold, and the words of a noun that takes no object.
    '- **With no registry, a misfiled generation read as damage.** Once the generation is fixed, the store reads it.',
    'Until it is called, the source keeps serving that snapshot with no backend call at all.',
    'Until it is called, the source keeps serving that snapshot with no registry request.',
    'Until it is called, the source keeps serving that snapshot with no backend round trip.',
    'Until it is called, the source keeps serving that snapshot with no backend write.',
    // Paragraphs of a doc comment, and list items, are apart.
    ' * ### How a store pins\n *\n * The reader cache lives for the life of the store.',
    ' * A reader pins each chunk\n *\n * it decodes, which lives for the life of the store.',
    ' * A store with no clock never re-resolves on a timer\n *\n * Or set `genTtlMs` above 0 for a timed refresh.',
    '<ul><li>A store with no clock never re-resolves on a timer</li><li>or reads a chunk twice</li></ul>',
    // An apostrophe in a quoted string, escaped or doubled, is the possessive it prints: it opens no quotation.
    "description: 'Two incarnations'' pins stay apart on a store with no registry.'",
    "it('keeps two incarnations\\' pins apart on a store with no registry', () => {});",
    'An erasure after a rollback deletes each holder above the pointer and keeps the rest as rollback targets.',
    'The erasure deletes that holder itself, since it is above the pointer.',
    "A refused rewrite deletes its own object when it sits above the winner's pointer.",
    'A refused load leaves its object behind once the row has changed.',
    'The library times no write, deliberately, since a timeout of its own would abandon a write in flight.',
    'An S3 write has no timeout of its own.',
    'No S3, GCS or Azure Blob write has a timeout of its own.',
    "An erasure's reads are retried; its deletes are not.",
    "An erasure's reads are retried, and its registry write is settled as a load's is.",
    // What a write's retry is, true: the registry row is sent once and reconciled, an object is sent again after a
    // throttle, and nothing is sent again after a lost response.
    'A write is retried only where that is safe.',
    'A registry row is sent once and reconciled by its effect.',
    'A write is not retried by `retry`: a throttled write-once object is sent again by the S3 and GCS drivers.',
    'A write is not retried by the store, but by the driver, and only after a throttle.',
    'This option does not govern writes, nor the calls that read the registry directly.',
    "The deletes are not retried, and the rewrite's registry write is settled as a load's is.",
    'No write goes through the read retry; a fault the publish does not settle reaches the caller.',
    'A lost response, a timeout or a `500` is not sent again.',
    "which the driver sends with that retry off whatever it is configured to do: a registry row once,\n   * and a generation's object again only after a throttle",
    'The first is what the registry writes of every shipped driver do; the second is what the Azure Blob driver and\n * the resumable GCS upload do, and what the S3 driver and the single-request GCS upload do when they send an\n * object again after a throttle.',
    'A fault the drivers and the publish do not settle reaches you as `TransientError`, and the retry is yours.',
    'A row written before 0.12 keeps its bare decimal token (`"7"`) until its first 0.12 write.',
    // A load's numbering, true: each names the check, what it finds, or the writer that lists.
    'When its check meets one of them, a load numbers above them all.',
    'When the check finds the number taken, a load numbers one above the highest of the pointer and every object in the bucket.',
    'A load whose check meets an object lists the segment to number its generation above everything in it.',
    'The erasure rewrite lists the segment to number its generation above everything in the bucket.',
    'A load numbers above them all once its check meets one.',
    'A load takes `currentGen + 1` while no object holds it, and otherwise numbers above everything in the bucket.',
    '`nextGeneration` lists the segment to number the next generation above everything in it.',
    '`store.load()` is expected at about a tenth more.',
    'A first load reads the pointer three times and checks its generation number once.',
    // A load's collection, true: each names that it is by name, the sixteenth generation, or what makes it list.
    'A load that keeps one generation deletes by name the generation its publish pushed out, and lists the segment to collect only every sixteenth generation.',
    'With a `keep` above 64, a load lists the segment to collect on every load.',
    'A load lists the segment to collect when its row records no list.',
    'A load that keeps twelve generations deletes by name the generation its publish pushed out, and lists the segment only every sixteenth generation.',
    // Each word the exemption names, once: a sentence that would be refused without it.
    'A load lists the segment to collect what it did not take by name.',
    'A load lists the segment to collect on the sixteenth pass.',
    'A load lists the segment to collect on the 16th pass.',
    'A load lists the segment to collect after its check.',
    'A load lists the segment to collect once its check has run.',
    'A load lists the segment to collect when a number is taken.',
    'A load lists the segment to collect when a stray meets it.',
    'A load lists the segment to collect while a wide window holds older generations.',
    'A load lists the segment to collect what an earlier window held.',
    'A load lists the segment to collect after an erasure.',
    'A load lists the segment to collect after a rewrite.',
    'A load lists the segment to collect after a materialisation.',
    'A load lists the segment to collect after a materialization.',
    'A load lists the segment to collect under a wider window.',
    'With a keep over sixty-four, a load lists the segment to collect on every load.',
    'A load whose check meets an object lists the segment to number past it, and lists again to collect.',
    'The retention sweep lists the segment to collect what a drop left.',
    'The erasure rewrite lists the segment and collects every generation below its own.',
    '`store.load()` collects by name and lists every sixteenth generation.',
    'An `*Into` that passes `keep` lists the destination and collects every generation below its own beyond it.',
    'The next load of the destination deletes the generation its own publish pushed out of the window, by name.',
  ])('leaves %j alone', (text) => {
    expect(hitsIn('x.md', text)).toEqual([]);
  });

  // Strict on purpose: these are true, and each reads as the refused claim. Each one reworded, as the gate asks,
  // passes.
  it.each([
    [
      'A pinned handle never re-resolves, even on a store with no clock.',
      'A pinned handle holds its generation for the life of the handle, even on a store with no clock.',
    ],
    ['Pinning needs no clock.', '`pin()` needs no clock.'],
    [
      'Pinning without a registry costs a LIST and a tail read per pin.',
      'Without a registry, each `pin()` costs a LIST and a tail read.',
    ],
    [
      'Pins taken on a store with no registry each read the tail.',
      'On a store with no registry, each `pin()` reads the tail.',
    ],
    [
      'A store with no clock is not pinned: it still re-resolves on an eviction.',
      'A store with no clock still re-resolves on an eviction.',
    ],
    [
      "A store with no clock isn't pinned to its first generation.",
      'A store with no clock moves past its first generation on an eviction.',
    ],
    [
      'No one pins a generation with `genTtlMs: 0`.',
      '`genTtlMs: 0` holds no generation: it turns the timed refresh off.',
    ],
    [
      'Pinned readers live in the same LRU on a store with no registry.',
      "A pin's readers live in the same LRU on a store with no registry.",
    ],
    [
      'The timed refresh runs every `genTtlMs`, and never with no clock or `genTtlMs: 0`.',
      'The timed refresh runs every `genTtlMs`; with no clock or `genTtlMs: 0` there is none.',
    ],
    [
      'On a store with no clock, a pinned handle never re-resolves.',
      'On a store with no clock, a pinned handle holds its generation for the life of the handle.',
    ],
    [
      "A pinned handle's generation never changes, even with `genTtlMs: 0`.",
      'A pinned handle holds one generation for the life of the handle, even with `genTtlMs: 0`.',
    ],
    [
      'A pinned handle describes one instant; a store with `genTtlMs: 0` does not.',
      'A pinned handle describes one instant. A store with `genTtlMs: 0` does not.',
    ],
    [
      'With `genTtlMs: 0`, a live read still moves on after an eviction; a pinned handle never sees a newer version.',
      'With `genTtlMs: 0`, a live read still moves on after an eviction. A pinned handle never sees a newer version.',
    ],
    [
      'A store with no registry is not refreshed on a timer, not even when another process publishes.',
      "A store with no registry is not refreshed on a timer, and another process's publish does not move it.",
    ],
    [
      'A store with no clock never re-resolves on a timer, but an eviction or an invalidation still moves it.',
      'A store with no clock never re-resolves on a timer. An eviction and an invalidation still move it.',
    ],
    [
      'A store with no clock never re-resolves on a timer\n * and is moved on only by an eviction, a swept read or an invalidation.',
      'A store with no clock never re-resolves on a timer.\n * An eviction, a swept read and an invalidation still move it.',
    ],
    [
      'The timed refresh re-reads the pointer only when its TTL lapses.',
      'The timed refresh re-reads the pointer each time its TTL lapses.',
    ],
    [
      '# Pinned (full commit SHA): a moved tag cannot inject code.',
      '# Pinned to a full commit SHA: a moved tag cannot inject code.',
    ],
    [
      'A store with no clock re-resolves a segment only when it is invalidated, evicted or swept.',
      'A store with no clock re-resolves a segment on an invalidation, an eviction or a swept read.',
    ],
    // A load's numbering: true after a plain rollback, whose generation above the pointer the check then meets,
    // but stated without the check; and a sum that reads as the cost claim.
    [
      'After a rollback, the next load numbers above them.',
      'After a rollback, the next load finds the generation above the pointer held, and numbers above them all.',
    ],
    [
      'Two store.load() calls cost about twice what one does.',
      'Two calls of store.load() cost twice what one does.',
    ],
    [
      "The S3 driver's registry writes are not retried.",
      "The S3 driver sends each registry write once, with the SDK's retry off.",
    ],
    [
      'A delete is never retried, and a write is never retried after a lost response.',
      'No delete is sent again, and no write is sent again after a lost response.',
    ],
    ['Nothing replays a write after a timeout.', 'A write that times out is not sent again.'],
  ])('refuses %j, though true, and passes it reworded', (refused, reworded) => {
    expect(hitsIn('x.md', refused)).not.toEqual([]);
    expect(hitsIn('x.md', reworded)).toEqual([]);
  });

  it('reads a file as the scan below does: in plain text, and of CHANGELOG.md only what is unreleased', () => {
    const changelog = [
      '# Changelog', // line 1
      '',
      '## [Unreleased]',
      '',
      '- the source **pins** it forever', // line 5: bold, and unreleased
      '',
      '## [0.10.0]',
      '',
      '- pins forever', // released: history
    ].join('\n');
    expect(hitsIn('CHANGELOG.md', changelog).map((h) => h.split(' — ')[0])).toEqual([
      'CHANGELOG.md:5',
    ]);
  });

  it('reads every file through plain(), not only the changelog', () => {
    expect(hitsIn(join('docs', 'x.md'), 'the source **pins** it forever')).toHaveLength(1);
  });

  it('keeps the lines of a tag it reads the attributes of, so a hit after one is on its own line', () => {
    const lines = hitsIn(
      'x.html',
      '<meta\n  name="description"\n  content="x"\n/>\n\npins it forever',
    ).map((h) => h.split(' — ')[0]);
    expect(lines).toEqual(['x.html:6']);
  });

  it('reports a hit after a string split across literals on its own line', () => {
    const lines = hitsIn(
      'x.ts',
      "const a = 'one ' +\n  'two';\n\n// Pinned: no refresh at all",
    ).map((h) => h.split(' — ')[0]);
    expect(lines).toEqual(['x.ts:4']);
  });

  it('reports a label on its own line, not the line before it', () => {
    const lines = hitsIn('x.ts', 'const a = 1;\n\n    // Pinned: no refresh at all').map(
      (h) => h.split(' — ')[0],
    );
    expect(lines).toEqual(['x.ts:3']);
  });

  it('reports every hit, not the first of each pattern', () => {
    const lines = hitsIn('x.md', 'pins it forever\n\npins it forever').map(
      (h) => h.split(' — ')[0],
    );
    expect(lines).toEqual(['x.md:1', 'x.md:3']);
  });

  /** The `file:line` of each hit. */
  const hitLines = (rel: string, text: string): string[] =>
    hitsIn(rel, text).map((h) => h.slice(0, h.indexOf(' — ')));

  it('reports a hit after a `<br>` that spans a line end on its own line', () => {
    expect(hitLines('x.html', 'one<br\n/>two\n\nthe source pins it forever')).toEqual(['x.html:4']);
  });

  it('reports a hit inside or after a wrapped doc-comment link on the line it is on', () => {
    const after =
      '/**\n * See {@link Segment.pin\n * | a pin}.\n *\n * The source pins it forever.\n */';
    expect(hitLines('x.ts', after)).toEqual(['x.ts:5']);
    const inside = '/**\n * See {@link Segment\n * | the source pins it forever}.\n */';
    expect(hitLines('x.ts', inside)).toEqual(['x.ts:3']);
  });

  it('reports a hit inside a wrapped attribute on its own line, not the line its tag opens on', () => {
    const meta = '<meta\n  name="description"\n  content="the source pins it forever"\n/>';
    expect(hitLines('x.html', meta)).toEqual(['x.html:3']);
  });

  it('reads an entity that spells a line end as a space, which adds no line', () => {
    expect(hitLines('x.html', 'one&#10;two\n\nthe source pins it forever')).toEqual(['x.html:3']);
  });

  it('reads a string split between two letters both ways, and reports each hit once, on its own line', () => {
    // Split inside a word, the claim is read glued; split between two words, across the line end. Both open on line 2.
    const inWord =
      "const a = 1;\nconst note = 'an empty result publishes an empty gen' +\n  'eration';";
    expect(hitLines('x.ts', inWord)).toEqual(['x.ts:2']);
    const betweenWords =
      "const a = 1;\nconst note = 'an empty result publishes an empty' +\n  'generation';";
    expect(hitLines('x.ts', betweenWords)).toEqual(['x.ts:2']);
    // What follows the split word keeps its line, on the line after the split and below it, and is reported once.
    const more =
      "const note = 'an empty result publishes an empty gen' +\n" +
      "  'eration; a store with no clock pins each segment';\n\n// Pinned: no refresh at all";
    expect(hitLines('x.ts', more).sort()).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:4']);
    // A letter after an escape is a line end the program prints, not half a word, so that string is read once.
    expect(readings("const s = 'a line\\n' +\n  'another';")).toHaveLength(1);
  });

  it('keeps every line end it reads, in each reading, whatever markup it takes out', () => {
    const src = [
      "const s = 'one gen' +",
      "  'eration' + 'two' +",
      "  'three';",
      '<br',
      '/>',
      '<meta',
      '  content="a',
      '  b"',
      '/>',
      '{@link A',
      ' * | b}',
      '{@link',
      ' * C}',
      '[a](b) `c` &#10; &#8232; &#x2029;',
      "'d''e' 'f\\'g' \"h\\\"i\"",
    ].join('\n');
    expect(readings(src)).toHaveLength(2);
    for (const reading of readings(src)) expect(lineCount(reading)).toBe(lineCount(src));
  });

  it(
    'reads a 100 KB line with no full stop in time that grows with its length, whatever it is made of',
    { timeout: 120_000 },
    () => {
      // A bracket, a run of stars and a doc-comment link that never close: a transform that retries from each one
      // scans such a line once per unit, so each must scan it once. The last two work the quote pairing and the rules
      // hardest.
      //
      // Judged by how the time grows, not by a wall-clock bound: each shape is read at a quarter of the length and at
      // the full length, in this process, so a loaded machine slows both alike. Four times the input is about four
      // times the time for a single scan and sixteen for a scan per unit. A reading is the least of five, so a pause
      // in one run does not decide it. The growth counts against a shape only when its full-length reading is over
      // 500 ms, a floor that keeps load noise on a reading of tens of milliseconds from failing it: so only a regression
      // that takes a shape past 500 ms is caught. Several shapes read in a few milliseconds, and a regression that
      // leaves one of them under the floor is not seen; what the test catches is a scan that goes quadratic or worse on 100 KB, as the old 2 s bound did.
      const FULL = 102_400;
      const timed = (line: string): number => {
        let least = Infinity;
        for (let run = 0; run < 5; run++) {
          const started = performance.now();
          hitsIn('x.md', line);
          least = Math.min(least, performance.now() - started);
        }
        return least;
      };
      const expectLinear = (what: string, build: (length: number) => string): void => {
        const small = timed(build(FULL / 4));
        const full = timed(build(FULL));
        const growth = full / Math.max(small, 1);
        const verdict = `${what}: ${small.toFixed(1)} ms at a quarter, ${full.toFixed(1)} ms at full, ${growth.toFixed(1)}x`;
        expect(full > 500 && growth > 9, verdict).toBe(false);
      };
      for (const unit of [
        '[a ',
        '*',
        '{@link a ',
        "'a ",
        'no clock never re-resolves on a timer, and ',
      ]) {
        expectLinear(JSON.stringify(unit), (n) =>
          unit.repeat(Math.ceil(n / unit.length)).slice(0, n),
        );
      }
      // And a long run of blanks where a pattern could split it among its parts, which costs seconds, growing faster
      // than the run, when a pattern tries each split.
      expectLinear('a doc-comment link never closed', (n) => `{@link a${' '.repeat(n - 8)}`);
      expectLinear(
        'blanks before a label',
        (n) => `${'x'.repeat(n / 2)}${' '.repeat(n / 2 - 12)}Pinned: none`,
      );
      expectLinear(
        'split literals, then blanks',
        (n) => `${"'a' +".repeat(Math.floor(n / 5.12))}${' '.repeat(Math.floor(n / 51.2))}x`,
      );
      expectLinear('one split literal, then blanks', (n) => `'a' +${' '.repeat(n - 6)}x`);
      expectLinear('blanks after a pin word', (n) => `pins${' '.repeat(n - 4)}`);
      expectLinear('a wide table', (n) => `| pins${' '.repeat(100)}| `.repeat(Math.ceil(n / 108)));
    },
  );

  it("reads a package's changelog as the root one: its released history is not scanned", () => {
    const changelog =
      '# c\n\n## [Unreleased]\n\n- pins it forever\n\n## [0.10.0]\n\n- pins it forever';
    expect(hitsIn(join('packages', 'core', 'CHANGELOG.md'), changelog)).toHaveLength(1);
  });

  it("treats only a calibration run's dated report as history, not every page beside it", () => {
    // The published run's report sits beside the evidence it wrote; a page only named like one does not.
    expect(existsSync(join(ROOT, 'bench', 'calibration', '2026-09-23-94416.json'))).toBe(true);
    expect(isHistory(join('bench', 'calibration', '2026-09-23-94416.md'))).toBe(true);
    expect(isHistory(join('bench', 'calibration', '2026-09-14-12345.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', '2026-10-01-notes.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', 'README.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', 'notes.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', '2026-09-14-12345.json.md'))).toBe(false);
  });

  it.each(files)('%s', (rel) => {
    expect(hitsIn(rel, readFileSync(join(ROOT, rel), 'utf8'))).toEqual([]);
  });
});

/**
 * Every refused claim a file makes, with its line. Every hit, not the first of each: three copies say so at once. A
 * claim that more than one reading of the file makes is one hit, and a reading that lost or gained a line end fails,
 * since every line number after it would be wrong.
 */
function hitsIn(rel: string, text: string): string[] {
  const src = scanned(rel, text);
  const ends = src.split('\n').length - 1; // a line separator the file has reads as a space: see `readings`
  const hits: string[] = [];
  for (const reading of readings(src)) {
    if (lineCount(reading) !== ends)
      throw new Error(`${rel}: plain() read ${ends} line ends as ${lineCount(reading)}`);
    const earlier = [...hits]; // what the readings before this one found, each to be found once more at most
    for (const { claim, why } of REFUSED_CLAIMS) {
      let line = 1;
      let at = 0;
      for (const m of reading.matchAll(new RegExp(claim.source, `${claim.flags}g`))) {
        line += lineCount(reading.slice(at, m.index));
        at = m.index;
        const hit = `${rel}:${line} — "${m[0].replace(/\s+/g, ' ')}" is not true. ${why}`;
        const seen = earlier.indexOf(hit);
        if (seen < 0) hits.push(hit);
        else earlier.splice(seen, 1);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------
// What a page says a `store.load()` costs, and how often it lists, is the estimator's.
//
// The price of a load and the cadence of its listing have been restated by hand in the guides, the site, the roadmap,
// the changelog and the doc-comments each time the engine's counts moved, and each time one copy was missed. The
// figures here are derived from `estimateCost` and the cadence constant, so a count that moves with the engine moves
// the gate with it, and a figure left behind fails it.
//
// What it reads: a clause (a sentence, a clause past a semicolon or a dash, a table cell or a line of a box) that
// names a load and says "per million" gives its dollar amounts, and each must be the one its words call for:
// a segment's first load, a load that does not list (or deletes by name, or is the third or later), one that lists,
// or, with no such word, the average a million single-part loads cost. The price of one GET or one PUT-class
// request is allowed anywhere, and so are the write-and-publish price a run measured and a price 0.11.2 published, after
// "was". A clause about a multipart write, an intersect, or another backend's or an encrypted segment's load is
// another figure's, and is left to the gates that hold it (the calibration report and the site's figures).
// Ratio: a clause that compares `store.load()` with a write and publish says, just after `store.load()`, the
// multiple the model's average makes of that measured write-and-publish price.
// Cadence: a sentence about listing or collecting that says how many generations apart the listings are ("every 16th
// generation", "within 16 generations", "divisible by 16", "a sixteenth of a listing") says the constant.
//
// Known limits, stated rather than hidden: it does not read a figure that has no "per million" in its clause
// (a table cell is its own clause), a ratio more than 40 characters after `store.load()`, or another backend's or
// an encrypted segment's price, which the model does not derive. Those figures are held where they are derived,
// `tests/bench/calibrate-guards.test.ts` and `tests/core/cost.test.ts`.
// ---------------------------------------------------------------------------------------------------
type Dollars = {
  first: number;
  steady: number;
  listing: number;
  average: number;
  get: number;
  put: number;
};
const LOAD_PRICES: Dollars = (() => {
  const base = AWS_US_EAST_1_ONDEMAND;
  /** One modelled load's requests of one kind: price that kind at a dollar each and the other at nothing. */
  const requests = (storage: { putPerMillion: number; getPerMillion: number }): number =>
    estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1, requestsPerLoad: 1 },
      pricing: { ...base, storage: { ...base.storage, ...storage } },
    }).monthlyUSD.byOp.loads;
  const putAverage = requests({ putPerMillion: 1e6, getPerMillion: 0 });
  const getAverage = requests({ putPerMillion: 0, getPerMillion: 1e6 });
  // The model averages one listing (a PUT-class request) and two more pointer reads over the cadence, less the check that
  // the current object is there, which a load that lists does not make.
  const steady = {
    put: putAverage - 1 / LIST_COLLECTION_CADENCE,
    get: getAverage - 1 / LIST_COLLECTION_CADENCE,
  };
  const price = (r: { put: number; get: number }): number =>
    r.put * base.storage.putPerMillion + r.get * base.storage.getPerMillion;
  return {
    steady: price(steady),
    listing: price({ put: steady.put + 1, get: steady.get + 1 }),
    // A first load has nothing to collect, so it makes no re-read before a delete either.
    first: price({ put: steady.put, get: steady.get - 1 }),
    average: price({ put: putAverage, get: getAverage }),
    get: base.storage.getPerMillion,
    put: base.storage.putPerMillion,
  };
})();
/** What 0.11.2 published for a steady and a first load. History belongs to the changelog, after "was". */
const PRICES_BEFORE = [23.6, 22.8];
/**
 * A million single-part writes and publishes, pointer included: the figure of the newest run that timed a write and
 * publish alone, from its committed evidence by the module the site's figures take it from. A page compares
 * `store.load()` with it, so the ratio it states is checked against the two sources the figures come from. A run that
 * timed `store.load()` does not give it: how many requests a load makes beyond a write and publish is the engine's,
 * and moves with it.
 */
const WRITE_AND_PUBLISH: number = (() => {
  const calibration = createRequire(import.meta.url)('../../bench/lib/calibration-figures.cjs') as {
    evidenceFiles: (root: string) => string[];
    readSources: (root: string) => unknown;
    derive: (run: unknown, src: unknown) => { loadVia: string | null; usd: { singleLoad: number } };
  };
  const src = calibration.readSources(ROOT);
  for (const rel of calibration.evidenceFiles(ROOT).reverse()) {
    const f = calibration.derive(JSON.parse(readFileSync(join(ROOT, rel), 'utf8')), src);
    if (f.loadVia === null) return 1e6 * f.usd.singleLoad;
  }
  throw new Error('bench/calibration/ holds no run that timed a write and publish alone');
})();

const SAYS_PER_MILLION = /\bper\s+(?:million|1M)\b|\ba million\b|\/\s*1M\b/i;
const AMOUNT = /\$([\d,]+(?:\.\d+)?)/g;
/**
 * A clause about another figure's subject: a multipart write, an intersect, Redis, the crossover, or a load on another
 * backend's or an encrypted segment's counts, which price differently. A write and publish is not exempt as a
 * subject: its own amount is (`WRITE_AND_PUBLISH`), so a stale load price beside it is still read.
 */
const ANOTHER_FIGURE =
  /\bmultipart\b|\bintersect|\bRedis\b|\bcrossover\b|\bAzure\b|\bGCS\b|\bGoogle Cloud Storage\b|\bencrypt/i;
const ABOUT_A_LOAD = /\bstore\.load\b|\bloads?\b|\bcalls?\b/i;
/** Which load a stretch of words calls for, if it says. */
const whichLoad = (
  words: string,
): keyof Pick<Dollars, 'first' | 'steady' | 'listing'> | undefined => {
  if (/\b(?:first|second)\b/i.test(words)) return 'first';
  if (
    /\b(?:does not|doesn't|do not|without|no)\b[^.;,]{0,12}\blist(?:s|ing)?\b/i.test(words) ||
    /\blists? nothing\b|\bby name\b|\bthird\b/i.test(words)
  )
    return 'steady';
  if (/\b(?:16th|sixteenth)\b|\bdivisible by\b|\blists?\b|\blisting\b/i.test(words))
    return 'listing';
  return undefined;
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  twentieth: 20,
  'thirty-second': 32,
  'sixty-fourth': 64,
  hundredth: 100,
};
const FRACTION_WORDS: Readonly<Record<string, number>> = {
  half: 2,
  third: 3,
  quarter: 4,
  fifth: 5,
  sixth: 6,
  eighth: 8,
  tenth: 10,
  twelfth: 12,
  sixteenth: 16,
  'thirty-second': 32,
};
const WORD_ALTERNATION = (words: Readonly<Record<string, number>>): string =>
  Object.keys(words).join('|');
const CADENCE_CLAIMS: ReadonlyArray<{ re: RegExp; n: (m: RegExpMatchArray) => number }> = [
  {
    re: new RegExp(
      String.raw`\b(?:every|each|on the|on every|the next|next)\s+(?:(\d+)(?:st|nd|rd|th)|(${WORD_ALTERNATION(ORDINAL_WORDS)}))\b`,
      'gi',
    ),
    n: (m) => (m[1] !== undefined ? Number(m[1]) : (ORDINAL_WORDS[m[2]!.toLowerCase()] ?? 0)),
  },
  { re: /\bwithin\s+(\d+)\s+generations\b/gi, n: (m) => Number(m[1]) },
  { re: /\bdivisible\s+by\s+(\d+)\b/gi, n: (m) => Number(m[1]) },
  {
    re: new RegExp(
      String.raw`\b(?:a|one)\s+(${WORD_ALTERNATION(FRACTION_WORDS)})\s+of\s+(?:a|an|each)\b`,
      'gi',
    ),
    n: (m) => FRACTION_WORDS[m[1]!.toLowerCase()] ?? 0,
  },
];
/** A cadence claim is made in a clause about listing or collecting, of generations or loads. */
const ABOUT_LISTING = /\b(?:list(?:s|ing|ings)?|collect(?:s|ed|ion)?)\b/i;
const ABOUT_GENERATIONS = /\b(?:generations?|loads?)\b/i;

/**
 * What `store.load()` costs as a multiple of a write and publish: the model's average over the run's figure. A clause
 * that names `store.load()` and a write or publish and says, in the words just after `store.load()`, how many times
 * as much ("≈ 2×", "twice", "1.1 times", "half as much again", "a tenth more") must say this, to within a tenth of it.
 */
const LOAD_OVER_WRITE = LOAD_PRICES.average / WRITE_AND_PUBLISH;
const COMPARES_A_LOAD = /\bstore\.load\(\)/;
const AGAINST_A_WRITE = /\bwrit(?:e|es|ing|ten)\b|\bpublish(?:ed|ing|es)?\b/i;
const RATIO_CLAIMS: ReadonlyArray<{ re: RegExp; n: (m: RegExpMatchArray) => number }> = [
  // A multiplier, not a product: "2×", but not "64 × 1,024".
  { re: /(\d+(?:\.\d+)?)\s?[×x](?!\w)(?!\s*\d)/g, n: (m) => Number(m[1]) },
  { re: /\b(\d+(?:\.\d+)?)\s+times\b/gi, n: (m) => Number(m[1]) },
  { re: /\b(?:twice|double)\b/gi, n: () => 2 },
  { re: /\bhalf as much again\b/gi, n: () => 1.5 },
  {
    re: new RegExp(String.raw`\ba (${WORD_ALTERNATION(FRACTION_WORDS)}) more\b`, 'gi'),
    n: (m) => 1 + 1 / (FRACTION_WORDS[m[1]!.toLowerCase()] ?? 1),
  },
];

/** The figures and cadences a file states about a load that the estimator does not give, each with its line. */
function loadFigureHits(rel: string, text: string): string[] {
  const src = scanned(rel, text);
  const reading = readings(src)[0] ?? '';
  const hits: string[] = [];
  let line = 1;
  let at = 0;
  const lineOf = (offset: number): number => {
    line += lineCount(reading.slice(at, offset));
    at = offset;
    return line;
  };
  // Clauses, each with where it starts: past a sentence, a semicolon, a dash, a table cell, a box edge.
  const CLAUSE_END = /[;|│]|\.\s+(?=\S)|\s[—–]\s/g;
  let start = 0;
  const clauses: Array<{ text: string; offset: number }> = [];
  for (const m of reading.matchAll(CLAUSE_END)) {
    clauses.push({ text: reading.slice(start, m.index), offset: start });
    start = m.index + m[0].length;
  }
  clauses.push({ text: reading.slice(start), offset: start });
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;
  for (const { text: clause, offset } of clauses) {
    if (
      ABOUT_A_LOAD.test(clause) &&
      SAYS_PER_MILLION.test(clause) &&
      !ANOTHER_FIGURE.test(clause)
    ) {
      for (const m of clause.matchAll(AMOUNT)) {
        const value = Number(m[1]!.replace(/,/g, ''));
        const end = m.index + m[0].length;
        const aheadAfter = clause
          .slice(end)
          .replace(SAYS_PER_MILLION, ' ')
          .split('$')[0]!
          .slice(0, 45);
        const behind = clause.slice(Math.max(0, m.index - 60), m.index);
        const which = whichLoad(aheadAfter) ?? whichLoad(behind) ?? 'average';
        const expected = which === 'average' ? LOAD_PRICES.average : LOAD_PRICES[which];
        const unit =
          close(value, LOAD_PRICES.get) ||
          close(value, LOAD_PRICES.put) ||
          close(value, WRITE_AND_PUBLISH);
        const history =
          PRICES_BEFORE.some((p) => close(value, p)) && /\b(?:where it )?was\s*$/i.test(behind);
        if (!close(value, expected) && !unit && !history) {
          hits.push(
            `${rel}:${lineOf(offset + m.index)} — "${m[0]}" is not what a ${which === 'average' ? 'single-part load' : `${which} load`} costs per million: ` +
              `$${expected.toFixed(2)} at the default prices (first $${LOAD_PRICES.first.toFixed(2)}, steady $${LOAD_PRICES.steady.toFixed(2)}, ` +
              `listing $${LOAD_PRICES.listing.toFixed(2)}, average $${LOAD_PRICES.average.toFixed(2)})`,
          );
        }
      }
    }
    if (COMPARES_A_LOAD.test(clause) && AGAINST_A_WRITE.test(clause)) {
      for (const named of clause.matchAll(new RegExp(COMPARES_A_LOAD.source, 'g'))) {
        const from = named.index + named[0].length;
        const words = clause.slice(from, from + 40);
        for (const { re, n } of RATIO_CLAIMS) {
          for (const m of words.matchAll(new RegExp(re.source, re.flags))) {
            if (Math.abs(n(m) - LOAD_OVER_WRITE) <= 0.1 * LOAD_OVER_WRITE) continue;
            hits.push(
              `${rel}:${lineOf(offset + from + m.index)} — "${m[0]}" is not what store.load() costs against a write and publish: ` +
                `about ${LOAD_OVER_WRITE.toFixed(2)}× ($${LOAD_PRICES.average.toFixed(2)} on average against $${WRITE_AND_PUBLISH.toFixed(2)} per million)`,
            );
          }
        }
      }
    }
    if (ABOUT_LISTING.test(clause) && ABOUT_GENERATIONS.test(clause)) {
      for (const { re, n } of CADENCE_CLAIMS) {
        for (const m of clause.matchAll(new RegExp(re.source, re.flags))) {
          if (n(m) !== LIST_COLLECTION_CADENCE) {
            hits.push(
              `${rel}:${lineOf(offset + m.index)} — "${m[0]}" is not the cadence: a load lists every ${LIST_COLLECTION_CADENCE}th generation`,
            );
          }
        }
      }
    }
  }
  return hits;
}

describe("a page's figures for store.load() are the estimator's", () => {
  it('derives the prices the model gives: first, steady, listing and average', () => {
    const f = (n: number): string => n.toFixed(2);
    expect(LIST_COLLECTION_CADENCE).toBe(16);
    expect([
      f(LOAD_PRICES.first),
      f(LOAD_PRICES.steady),
      f(LOAD_PRICES.listing),
      f(LOAD_PRICES.average),
    ]).toEqual(['11.20', '11.60', '17.00', '11.94']);
    expect(WRITE_AND_PUBLISH.toFixed(2)).toBe('11.20');
    expect(LOAD_OVER_WRITE.toFixed(2)).toBe('1.07');
  });

  // Both directions: each stale form is caught, and the sentences that must stay legal are not.
  it.each([
    'about $17.80 per million single-part loads at the default prices',
    "a segment's first store.load() is expected at $17.40 per million",
    '$12.00 per million single-part loads, on average',
    '$17.80 per million steady single-part loads at the default prices',
    'a load that lists costs $12.36 per million',
    'a load that does not list costs $17.80 per million',
    "$23.60 per million loads, and $17.40 for a segment's first load",
    'It costs $12.36 per million loads, and a first load $17.40.',
    'every 8th generation a load lists the segment to collect',
    'On every eighth generation the load lists to collect what the by-name passes left.',
    'what collection leaves is gone within 8 generations of a load',
    'a load lists on every generation divisible by 8, to collect',
    'a load lists a quarter of a PUT-class request a load, on average, to collect',
    'a load lists to collect, and costs a third of a PUT-class request more on average',
    'each load collects by listing on every 15th generation',
    "the rest go at the destination's next eighth generation, when a load lists",
    // A ratio against a write and publish, and a stale price beside one.
    '1M writes + publishes · store.load() ≈ 2×',
    'store.load() costs twice what a write and publish does',
    'a write and publish, with store.load() half as much again',
    'store.load() is 1.5 times a write and publish',
    'a store.load() that writes and publishes costs $17.80 per million',
    // Naming a run does not exempt a figure: a stale one beside a run id is refused.
    "a segment's first store.load() cost $12.20 per million in run 2026-10-04-73668",
    "a segment's first store.load() was measured at $12.20 per million",
  ])('refuses the stale form %j', (text) => {
    expect(loadFigureHits('x.md', text)).not.toEqual([]);
  });

  it.each([
    'about $11.94 per million single-part loads at the default prices',
    "a segment's first store.load() is expected at $11.20 per million",
    'a load that does not list costs $11.60 per million',
    'a load that lists costs $17.00 per million',
    "$11.94 per million steady single-part loads at the default prices: $11.60 when a load does not list, $17.00 when it lists (every 16th generation), and $11.20 for a segment's first load",
    "$11.94 per million single-part loads, where it was $23.60, and $11.20 for a segment's first load, where it was $22.80.",
    'one more GET ($0.40 per million at the default prices) that a load makes',
    'S3 GETs, $0.40 a million, and a PUT-class request, $5 per million, for each load',
    '$82.40 per million cold intersects of two segments, and $11.20 per million loads written and published',
    'a multipart load costs $26.20 per million',
    'every 16th generation a load lists the segment to collect',
    'every sixteenth generation a load lists the segment to collect',
    'what collection leaves is gone within 16 generations of a load',
    'a load lists on every generation divisible by 16, to collect',
    "the rest go at the destination's next sixteenth generation, when a load lists",
    'a load lists a sixteenth of a PUT-class request a load, on average, to collect',
    // Other things that are every something: not about a listing, or not a cadence of generations.
    'A reader re-reads the pointer every second.',
    'A long-lived reader refreshes every 2 seconds, one load of a pointer each time.',
    'It lists the bucket every third request in the test, to collect nothing.',
    'a half of a segment is loaded from the warehouse',
    // The ratio as it is, and the write and publish's own amount.
    'Writing and publishing a segment, pointer included, with store.load() about a tenth more on average',
    '1M writes + publishes · store.load() ≈ 1.1×',
    'store.load() costs 1.1 times a write and publish, on average',
    'a store.load() writes and publishes for $11.94 per million on average',
    // Prices another load's words call for, and other backends' and encrypted segments' counts.
    'a load that deletes by name costs $11.60 per million',
    'from the third load on, a load costs $11.60 per million',
    'a load that lists nothing costs $11.60 per million',
    'a load on a generation divisible by 16 costs $17.00 per million',
    'on Azure Blob a steady load costs $11.60 per million, $11.94 on average',
    "an encrypted segment's load costs $12.74 per million on average",
    // A ratio that is not a comparison with a write: a 64 × 1,024 product, and a write named without store.load().
    'the writer cuts 64 × 1,024 containers per slice, and store.load() writes each',
    'store.load() writes 64 × 1,024 containers, a slice at a time',
    'it timed a write and a publish rather than store.load(), which is why its median intersect read each pointer twice',
    'a write and publish of 2× the bytes',
  ])('leaves %j alone', (text) => {
    expect(loadFigureHits('x.md', text)).toEqual([]);
  });

  // The pages themselves: every file the claims gate reads.
  it.each(textFiles())('%s', (rel) => {
    expect(loadFigureHits(rel, readFileSync(join(ROOT, rel), 'utf8'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// How many requests a `store.load()`, a cold `count()`, a cold `stat()` or a reload makes is the cost model's.
//
// The prices above are held, and the counts behind them were not: a request count in prose (a guide, the bench README,
// a doc-comment, the changelog) was restated by hand each time the engine's counts moved, and each time a copy was
// missed. The counts here come from the cost model, which `tests/core/cost.test.ts` holds to the engine by counting
// what it sends, and from the pricing the model gives a pointer read and a tail read, so a count that moves with the
// engine moves the gate with it.
//
// What it reads: a clause (as above) that says a number of requests, `N requests`, `N GETs`, `N GET-class`,
// `N PUT-class` or `N pointer reads` (a digit or a number word to twelve), and whose nearest earlier subject is
//   - a load (`store.load()`, `loadSegment`, "a load", "a steady load", "a first load", "a second load", "a reload"):
//     its PUT-class and GET-class counts, and its total with the delete it makes; steady, first, second or one that
//     lists, as the words around it say; with no such word, a steady load;
//   - a cold `count()` or `stat()`: one request, one pointer read, or, where the clause says the row has no summary to
//     use or that the index is read, the tail read it adds (two, or three on Azure Blob).
// It never reads: a number after "was", "were", "made", "took", "from" or a 0.11 release's name (history is
// the changelog's, and says so), a range or a bound ("1 to 3", "two or three", "at most 4", "up to 8"), a count
// of "more", "fewer" or "extra" requests, a clause about another operation nearer than the subject (an intersect, a
// `has()`, an erasure, a rollback, a retirement, a purge, a sweep, a pointer refresh), a multipart or an encrypted
// load, and a warm `count()` or `stat()`.
//
// A cell of a table row is read with the row's first cell as its subject; a row of a table that is HTML is not.
// A rate ("a second") and a count of segments in one call are not a cold count's requests.
//
// Known limits, stated rather than hidden: it does not read a count with no unit ("2 and 3"), a bare "reads" (it counts
// payload and index reads too), a count that comes before its subject in the clause ("5 GETs make a load"), a pointer
// read or a check counted inside a load, a total for a load that lists, a clause that names two operations without a
// word between a subject and its count that tells them apart, or a subject worded another way ("one write and publish").
// The first and second load's counts are derived from the steady load's, as the cost test's counts of the engine hold
// them (2 PUT-class and 4 GET-class, then 2 and 3).
// ---------------------------------------------------------------------------------------------------
type LoadKind = 'steady' | 'first' | 'second' | 'listing';
type Requests = { put: number; get: number };
const REQUEST_COUNTS: {
  load: Record<LoadKind, Requests & { total?: number }>;
  coldCount: { pointer: number; withTail: number[] };
} = (() => {
  const base = AWS_US_EAST_1_ONDEMAND;
  const average = (storage: { putPerMillion: number; getPerMillion: number }): number =>
    estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1, requestsPerLoad: 1 },
      pricing: { ...base, storage: { ...base.storage, ...storage } },
    }).monthlyUSD.byOp.loads;
  const steady = {
    put: average({ putPerMillion: 1e6, getPerMillion: 0 }) - 1 / LIST_COLLECTION_CADENCE,
    get: average({ putPerMillion: 0, getPerMillion: 1e6 }) - 1 / LIST_COLLECTION_CADENCE,
  };
  const DELETE = 1; // the one generation a steady load deletes by name; the first two loads delete none
  // A cold count is the pointer read the profile prices, and a count that must open the object adds the tail read the
  // backend's profile prices: S3 and GCS the default, Azure Blob its two requests.
  const pointer = base.storage.requestsPerPointerRead ?? 1;
  const sized = (base.storage.requestsPerSizedRead ?? 1) + 1; // Azure Blob's tail read is one request more
  return {
    load: {
      steady: { ...steady, total: steady.put + steady.get + DELETE },
      listing: { put: steady.put + 1, get: steady.get + 1 },
      first: { ...steady, get: steady.get - 1, total: steady.put + steady.get - 1 },
      second: { ...steady, get: steady.get - 2, total: steady.put + steady.get - 2 },
    },
    coldCount: {
      pointer,
      withTail: [pointer + (base.storage.requestsPerSizedRead ?? 1), pointer + sized],
    },
  };
})();

const COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const REQUEST_CLAIM = new RegExp(
  String.raw`\b(\d[\d,]*|${Object.keys(COUNT_WORDS).join('|')})\s+(?:(PUT(?:-class(?:\s+requests?)?|\s+requests?|s)|GET(?:-class)?s?(?:\s+requests?)?)|(pointer\s+reads?)|(requests?))(?![\w-])`,
  'gi',
);
const LOAD_SUBJECT = /\bstore\.load\(\)|\bloadSegment\b|\bloads?\b(?!-)|\breloads?\b/gi;
const COLD_READ_SUBJECT = /\bcount\(\)|\bstat\(\)|\bcold\s+(?:count|stat)s?\b/gi;
const OTHER_SUBJECT =
  /\bintersect\w*|\bhas\(\)|\biterate\b|\brollback\b|\bera(?:se|ses|sure|sures)\b|\beraseSubject\b|\bretire\w*|\bpurg\w*|\bsweeps?\b|\bcombines?\b|\bexists\(\)|\bpins?\b|\bcheckConsistency\b|\bwrite and publish\b|\bwrit(?:ten|e|es) and published\b|\bwritten once\b|\bpointer refresh\b|\brefresh(?:es)?\b|\bchecks?\b|\bcalibration\b|\bharness\b|\bprojection\b|\bbounds?\b/gi;
/** A count that is history, a bound or a range, or counts requests "more" or "fewer": none is a claim about the count. */
const NOT_A_COUNT_BEFORE =
  /(?:\b(?:was|were|made|took|sent|from|until)|\bused to|\bwhere it|\b0\.11\.\d+(?:\s+\w+)?|\bat most|\bat least|\bup to|\bno more than|\bmore than|\bfewer than|\b(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:to|or|and)|\d\s*[–-])\s*$/i;
const NOT_A_COUNT_AFTER =
  /^\s*(?:(?:more|fewer|less|extra|additional|too)\b|(?:a|per|every|each)\s+(?:second|minute|hour|day|month)\b)/i;
const ANOTHER_LOAD = /\bmultipart\b|\b\d+-part\b|\buploads?\b|\bencrypt/i;
const WARM = /\bwarm\b|\bwithin\b|\bpinned\b|\bcached\b|\bno request/i;
const NO_SUMMARY_TO_USE =
  /\bno summary\b|\bwithout (?:a|the) summary\b|\bwritten before\b|\btail read\b|\bfrom the object\b|\bopens? the object\b|\bindex\b/i;

/** A kind named after the count counts only when it is a first or a second load: a listing is not told by later words. */
const afterKind = (words: string): LoadKind | undefined => {
  const k = loadKindIn(words);
  return k === 'first' || k === 'second' ? k : undefined;
};
/** The kind of load a stretch of words names, if it names one. */
const loadKindIn = (words: string): LoadKind | undefined => {
  if (/\bfirst\b/i.test(words)) return 'first';
  if (/\bsecond\b|\breloads?\b/i.test(words)) return 'second';
  if (
    /\b(?:does not|doesn't|do not|without|no)\b[^.;,]{0,12}\blist(?:s|ing)?\b|\blists? nothing\b|\bby name\b|\bthird\b|\bsteady\b/i.test(
      words,
    )
  )
    return 'steady';
  if (/\b(?:16th|sixteenth)\b|\bdivisible by\b|\blists?\b|\blisting\b/i.test(words))
    return 'listing';
  return undefined;
};

/** The request counts a file states for a load, a cold count or a cold stat that the cost model does not give. */
function requestCountHits(rel: string, text: string): string[] {
  const src = scanned(rel, text);
  const reading = readings(src)[0] ?? '';
  const hits: string[] = [];
  let line = 1;
  let at = 0;
  const lineOf = (target: number): number => {
    const offset = Math.max(at, target); // a row's carried first cell sits before the cell it is read with
    line += lineCount(reading.slice(at, offset));
    at = offset;
    return line;
  };
  const CLAUSE_END = /[;|│]|\.\s+(?=\S)|\s[—–]\s/g;
  let start = 0;
  const clauses: Array<{ text: string; offset: number }> = [];
  // A cell of a Markdown table row is read with the row's first cell before it, which names what the row is about.
  const cell = (from: number, to: number): { text: string; offset: number } => {
    const ls = reading.lastIndexOf('\n', from - 1) + 1;
    const row = reading.slice(
      ls,
      reading.indexOf('\n', ls) < 0 ? undefined : reading.indexOf('\n', ls),
    );
    const first = row.indexOf('|');
    const second = first < 0 ? -1 : row.indexOf('|', first + 1);
    const head =
      /^\s*\|/.test(row) && second > 0 && from > ls + second
        ? `${row.slice(first + 1, second)} `
        : '';
    return { text: head + reading.slice(from, to), offset: from - head.length };
  };
  for (const m of reading.matchAll(CLAUSE_END)) {
    clauses.push(cell(start, m.index));
    start = m.index + m[0].length;
  }
  clauses.push(cell(start, reading.length));
  for (const { text: clause, offset } of clauses) {
    for (const m of clause.matchAll(REQUEST_CLAIM)) {
      const n = COUNT_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]!.replace(/,/g, ''));
      const before = clause.slice(Math.max(0, m.index - 40), m.index);
      if (NOT_A_COUNT_BEFORE.test(before)) continue;
      if (NOT_A_COUNT_AFTER.test(clause.slice(m.index + m[0].length))) continue;
      // The nearest subject before the count, in this clause: another operation's count is not this gate's.
      const head = clause.slice(0, m.index);
      const last = (re: RegExp): number =>
        Math.max(-1, ...[...head.matchAll(re)].map((x) => x.index));
      const load = last(LOAD_SUBJECT);
      const cold = last(COLD_READ_SUBJECT);
      const other = last(OTHER_SUBJECT);
      const subject = Math.max(load, cold, other);
      if (subject < 0 || subject === other) continue;
      const end = m.index + m[0].length;
      /** The words a subject's qualifiers are read from: from its adjectives to just past the count. */
      const near = clause.slice(Math.max(0, subject - 40), end + 60);
      const kind =
        m[2] !== undefined
          ? /^PUT/i.test(m[2])
            ? 'PUT'
            : 'GET'
          : m[3] !== undefined
            ? 'pointer'
            : 'total';
      const where = `${rel}:${lineOf(offset + m.index)} — "${m[0]}"`;
      if (subject === load) {
        if (ANOTHER_LOAD.test(clause.slice(Math.max(0, subject - 40), end)) || kind === 'pointer')
          continue;
        // Which load is told by the words from the subject, and the adjectives before it, to the count.
        // A kind named after the count counts too ("2 PUT-class and 4 GET-class requests for a first load"), up to the
        // next subject, and only where the words before it name none.
        const next = [...clause.slice(end).matchAll(LOAD_SUBJECT)][0];
        const which =
          loadKindIn(clause.slice(Math.max(0, subject - 40), m.index)) ??
          afterKind(
            clause.slice(end, next === undefined ? end + 60 : end + next.index + next[0].length),
          ) ??
          'steady';
        const want = REQUEST_COUNTS.load[which];
        const expected = kind === 'PUT' ? want.put : kind === 'GET' ? want.get : want.total;
        if (expected === undefined || n === expected) continue;
        hits.push(
          `${where} is not what a ${which} load makes: ${kind === 'total' ? 'requests' : `${kind}-class`} ${expected} ` +
            `(PUT-class ${want.put}, GET-class ${want.get}${want.total === undefined ? '' : `, ${want.total} with its delete`})`,
        );
      } else {
        // A count of segments in one call is that many reads, not one cold count's.
        if (/\b\d[\d,]*\s+(?:segments?|ids?|names?|refs?)\b/i.test(clause.slice(subject, m.index)))
          continue;
        if (WARM.test(near) || kind === 'PUT') continue;
        const { pointer, withTail } = REQUEST_COUNTS.coldCount;
        const allowed = NO_SUMMARY_TO_USE.test(near) ? [pointer, ...withTail] : [pointer];
        if (allowed.includes(n)) continue;
        hits.push(
          `${where} is not what a cold count() or stat() makes: ${pointer} request(s), a pointer read, ` +
            `${withTail.join(' or ')} where the row has no summary to use`,
        );
      }
    }
  }
  return hits;
}

describe("a page's request counts for a load, a cold count and a cold stat are the cost model's", () => {
  it('derives the counts the model gives', () => {
    expect(REQUEST_COUNTS.load).toEqual({
      steady: { put: 2, get: 4, total: 7 },
      listing: { put: 3, get: 5 },
      first: { put: 2, get: 3, total: 5 },
      second: { put: 2, get: 2, total: 4 },
    });
    expect(REQUEST_COUNTS.coldCount).toEqual({ pointer: 1, withTail: [2, 3] });
  });

  // Both directions: each stale or wrong form is caught, and the honest phrasings and the look-alikes are not.
  it.each([
    'a steady single-part load on S3 is 2 PUT-class requests, 4 GET-class and a delete, 9 requests',
    'a steady single-part load on S3 is 2 PUT-class requests, 5 GET-class and a delete, 8 requests',
    "a segment's first load is expected at 2 PUT-class and 4 GET requests",
    'a steady store.load() is 3 PUT-class requests and 4 GET-class',
    "a segment's first load is expected at 2 PUT-class and 5 GET requests",
    "a segment's second load makes 3 GET-class requests",
    'a reload of a segment makes 3 GETs',
    'a load that lists is 3 PUT-class and 6 GET-class',
    'a load makes 14 requests',
    'a cold count() makes 2 requests',
    'a cold count is two requests',
    'count() is one request when cold, and a cold stat() is three requests',
    'A cold `stat()` is 2 pointer reads',
    'a cold count on S3 and GCS makes 3 requests, with the row summary',
    'store.load() sends 3 PUTs.',
    '| A steady store.load() | 8 requests |',
    '| A first load | 2 PUT-class requests and 4 GETs |',
    "a segment's first load was measured at 2 PUT-class and 9 GET requests",
    "a segment's first load made 2 PUT-class and 9 GET requests in run 2026-10-04-73668",
  ])('refuses %j', (text) => {
    expect(requestCountHits('x.md', text)).not.toEqual([]);
  });

  it.each([
    'a steady single-part load on S3 is 2 PUT-class requests, 4 GET-class and a delete, 7 requests',
    'a steady store.load() is 2 PUT-class requests and 4 GET-class',
    "a segment's first load is expected at 2 PUT-class and 3 GET requests",
    "a segment's second load is 2 PUT-class and 2 GET-class requests, 4 in all",
    'a load that lists is 3 PUT-class and 5 GET-class',
    'a load that does not list makes 7 requests',
    'a cold count() makes 1 request',
    'a cold count is one request',
    'count() is one request when cold, and a cold stat() is one pointer read',
    // Where the row has no summary to use, the tail read is added: S3 and GCS two, Azure Blob three.
    'a cold count() of a row with no summary makes 2 requests, and 3 on Azure Blob',
    // History is the changelog's.
    'a steady load makes 7 requests, where 0.11.2 made 14',
    'a cold count makes 1 request where it was 2',
    'it takes a steady load from 14 requests to 7',
    // Ranges, bounds, and "more" or "fewer".
    'a load makes 2 to 3 PUT-class requests',
    'a load makes one or two requests more than it needs',
    'a load lists on at most 4 requests',
    'a load that loses a race makes one request more',
    'a load whose check meets an object makes 2 more pointer reads',
    // Another operation's count, a multipart or an encrypted load, a warm count.
    'a cold intersect of two segments sharing 100 chunks makes 206 GETs',
    'a load, then a has() of one id: a has() makes 2 requests',
    'a retirement is 9 reads, 3 writes and a delete, and a purge is 4 reads and 2 deletes',
    'the sweep makes 4 requests a segment',
    'a multipart load of 100 parts makes 102 PUT-class requests',
    "an encrypted segment's load makes 9 requests",
    'a warm count() makes 0 requests',
    'a count() within cache.genTtlMs makes 0 requests',
    // A count of something else, in a clause that names a load or a count.
    'the load reads 1,024 containers per request',
    'a count of 3 segments makes a report',
    'A load past 3,500 PUT requests a second to one prefix is throttled.',
    'A load takes 2 PUT-class requests and, on the cadence, a listing.',
    'A cold count() of 4 segments in one call makes 4 requests.',
    '| A steady store.load() | 7 requests |',
    'objects that fit one PUT, loaded through store.load(), and objects large enough to upload multipart',
    'store.load() writes the object with one PUT, then moves the pointer',
    'a cold intersect makes 206 GETs, and a load makes 2 PUT-class requests and 4 GET-class requests',
  ])('leaves %j alone', (text) => {
    expect(requestCountHits('x.md', text)).toEqual([]);
  });

  // The pages themselves: the prose a reader is given (Markdown, the site, the doc-comments in the packages), not the
  // tests and the harness scripts, whose comments count a run's own requests.
  const pages = textFiles().filter(
    (f) =>
      !f.startsWith('tests') &&
      (/\.(?:md|html|txt)$/.test(f) || (f.startsWith(join('packages', '')) && f.endsWith('.ts'))),
  );
  it('reads the pages a request count is written on', () => {
    for (const f of [
      'README.md',
      'CHANGELOG.md',
      join('bench', 'README.md'),
      join('docs', 'guide', 'cost.md'),
      join('docs', 'guide', 'reading.md'),
      join('docs', 'ROADMAP.md'),
      join('site', 'usage.html'),
      join('packages', 'core', 'src', 'core', 'cost.ts'),
    ])
      expect(pages).toContain(f);
    expect(pages.some((f) => f.startsWith('tests'))).toBe(false);
  });
  it.each(pages)('%s', (rel) => {
    expect(requestCountHits(rel, readFileSync(join(ROOT, rel), 'utf8'))).toEqual([]);
  });
});
