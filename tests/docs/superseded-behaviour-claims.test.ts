import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claims about behaviour this library NO LONGER HAS, spelled out so they cannot come back.
 *
 * WHY THIS FILE EXISTS. "An empty result publishes an empty generation" was true, was documented as
 * deliberate, and lived in **four** places: the guide's `*Into` section, two entries in the roadmap, and a
 * doc-comment that ships in the published `.d.ts`. The change that made it false updated exactly one of them,
 * and the full gate stayed green — the docs gates check that exports are documented and that links resolve,
 * neither of which can see prose contradicting behaviour.
 *
 * That is the second time a single sentence has outlived the code in this repo, which is the point at which
 * being careful stops being the answer. Each entry below is a phrase that was TRUE and is now FALSE; a hit
 * means someone wrote it again, or a stale copy survived a sweep.
 *
 * Adding an entry is the cheap half of retiring a behaviour. Removing one is only correct if the behaviour
 * came back.
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
 * line cannot see any of it: whether a retired claim is caught then depends on how long the preceding words
 * happen to be, which is not a property anyone controls.
 *
 * `vocabulary-damage.test.ts` learned this first. Carried here, and to `unreleased-install-caveat`. Here it crosses
 * one line end at most: a sentence does not run on past a blank line, and a gap that did would join two copies of
 * a claim in two paragraphs into one hit.
 */
const GAP = String.raw`(?:[^\S\n]+|[^\S\n]*\n[^\S\n]*(?:(?:[>*#]|\/\/)[^\S\n]*)?)`;
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

/** An attribute whose value a reader is shown, and so reads. */
const SHOWN_ATTRIBUTE = /\b(?:content|alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The text a reader is given, so markup cannot carry a retired claim past the patterns. Tags, link targets, code
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
      let shown = '';
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
    .replace(
      /(\{@link(?:code|plain)?\s+(?:\*(?!\/)\s+)?)([^\s|{}]+)((?:\s*(?:\*(?!\/)\s*)?\||\s+(?:\*(?!\/)\s+)?)?)(\s*)([^{}]*?)(\s*)\}/g,
      (_, open: string, name: string, sep: string, lead: string, text: string, trail: string) =>
        text === ''
          ? `${lineEnds(open)}${name}${lineEnds(sep + lead + trail)}`
          : `${lineEnds(open + name + sep + lead)}${text}${lineEnds(trail)}`,
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

/** A string a program prints, split across literals: a closing quote, the `+`, a line end or none, an opening quote. */
const SPLIT = /(['"`])[^\S\n]*\+[^\S\n]*\n?[^\S\n]*(['"`])/g;
/**
 * The same, between two letters and across a line end: `'…an empty gen' +`, then `'eration'` and the rest of its word.
 * Not after an escape, `'…\n' +`, whose letter is a line end the program prints.
 */
const SPLIT_WORD = /(?<=(?<!\\)\w)(['"`])[^\S\n]*\+[^\S\n]*\n[^\S\n]*(['"`])(\w+)/g;
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
const NO_TIMED_REFRESH_SUBJECT = String.raw`(?:${TTL_ZERO}|\b(?:no|neither(?: an?| the| any)?|without (?:an?|the|any)) (?:injected )?(?:clock|registry|backend)\b|\b(?:registry|clock)-?less\b|\bIStorageDriver\b(?<=\b(?:bare|raw|plain) IStorageDriver)|\bno timed refresh\b|\btimed refresh(?: (?:is |turned |switched )?(?:off|disabled)\b|(?<=\b(?:disabl(?:e|es|ed|ing)|turn(?:s|ed|ing)? off|switch(?:es|ed|ing)? off) (?:the |its |their )?timed refresh)))`;
/** The end of a table row: its last cell's edge and the line end after it, or a line end before another row. */
const ROW_END = String.raw`\|[^\S\n]*(?:\n|$)|\n(?=[^\n]*\|)`;
/**
 * At most `n` characters of one sentence between a claim's words: never past a blank line or the end of a table row,
 * though past a semicolon and an "e.g.", which end no sentence. A row's cells pair, since a settings table says what a
 * setting does in the cell beside it.
 */
const within = (n: number): string =>
  String.raw`(?:(?!(?<!\b(?:e\.g|i\.e))\.\s|\n\s*\n|${ROW_END})[\s\S]){0,${n}}?`;
/** Up to a clause of one paragraph, for a claim whose words may sit apart. */
const SPAN = String.raw`(?:(?!\n\s*\n|${ROW_END})[^.;:])`;
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
 * each exemption a sentence has earned so far has also let a retired claim through. Only these are not the claim:
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
  String.raw`\b(?:(?:act|acts|behave|behaves|work|works|function|functions) (?:(?:just|exactly|much|essentially|effectively|basically) )?(?:as|like)|(?:is|are|becomes?) (?:(?:just|exactly|essentially|effectively|basically) )?(?:equivalent|identical|equal|tantamount|akin|the same) (?:to|as)|amounts? to) (?:a |an |one )?(?:[\w'-]+ )?${LIKE_A_PIN}`,
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
const NEWER = String.raw`(?:(?:a|an|the|any|another)(?: other)? )?(?:[\w-]+(?:'s|s') )?(?:(?:new|newer|later|next) (?:generation|publish|pointer|change)s?|publish(?:es)?|changes?|drops?|erasures?|writes?|deletions?|(?:crypto-)?shreds?)`;
/**
 * The rest of a clause: up to a full stop, a semicolon, a colon, a dash or a blank line. It runs on across a line end,
 * since the repo's prose is hard-wrapped and a claim's "or otherwise" lands on the next line as often as not; and it
 * stops after 200 characters, which is longer than any clause here and keeps a long unbroken line from taking seconds.
 */
const CLAUSE = String.raw`(?:(?! - )(?:[^.;:\n]|\n(?!\s*\n))){0,200}`;
/** A second "never", not itself one on a timer: "…, and an eviction never moves it". */
const ANOTHER_NEVER = String.raw`\bnever\b(?! (?:[\w'-]+ ){1,4}?on a timer\b)`;
/**
 * An "or" that joins the next clause straight after "on a timer": across a comma, a semicolon, a dash, or a wrap and its
 * margin. "; nor does an eviction move it" is one, and so is "— and never on an eviction".
 */
const CONNECTOR = String.raw`(?:[,;]|[^\S\n]+-)?[^\S\n]*\n?[^\S\n]*(?:(?:[>*#]|\/\/)[^\S\n]*)?(?:(?:or|nor|either|neither)\b|and ${ANOTHER_NEVER})`;
/** A verb for moving on, as it follows "does not" or "cannot": "re-resolve", "re-read its pointer", "see a publish". */
const MOVE_ON = String.raw`(?:re-resolve|refresh|converge|re-(?:read|check) (?:(?:the|its|a|each) )?(?:pointer|segment)s?|move on|resolve (?:[\w'-]+ ){0,3}again|(?:observe|see|notice|pick up) ${NEWER})`;
/** The same verb as it follows "never": "re-resolves", "re-reads its pointer", "sees a publish". */
const MOVES_ON = String.raw`(?:re-resolves?|refresh(?:es)?|converges?|re-(?:reads?|checks?) (?:(?:the|its|a|each) )?(?:pointer|segment)s?|moves? on|resolves? (?:[\w'-]+ ){0,3}again|(?:observes?|sees?|notices?|picks? up) ${NEWER})`;
/** A word between "never" and its verb that changes nothing: "never really re-resolves", "does not ever re-resolve". */
const EVER = String.raw`(?:(?:actually|again|ever|really|even|truly|once) )?`;
/**
 * What a claim that a store never moves on says it never does, actively ("never re-resolves", "cannot re-resolve") or
 * passively ("is never refreshed"). Only "on a timer" ending the claim, just after the verb or its object, is true and
 * exempt: "never re-resolves on a timer", "never re-reads a pointer on a timer". Anything between, or an "or", "nor",
 * "either", "neither", "at all" or "otherwise" after it in its clause, a connector straight after it, or another
 * "never" in its clause or the next one, after a semicolon or a dash ("…, and an eviction never moves it"), makes it
 * the claim again.
 */
const NEVER_MOVES = String.raw`(?:(?:never|no longer) ${EVER}${MOVES_ON}|(?:(?:is|are) (?:never|not|no longer)|isn't|aren't) ${EVER}(?:re-resolved|refreshed|re-read|re-checked)|(?:cannot|can't|can never|does not|doesn't|will not|won't) ${EVER}${MOVE_ON})\b(?! (?:(?:a|the|its|each) (?:segment|pointer|generation)s? )?on a timer\b(?!${CONNECTOR}|${CLAUSE}\b(?:or|nor|either|neither|at all|otherwise)\b|${CLAUSE}(?:(?:;| - )${CLAUSE})?${ANOTHER_NEVER}))`;
/** Until the store or its process ends: "until it restarts", "until you restart it", "until the process exits". */
const UNTIL_IT_ENDS = String.raw`until (?:(?:it|the (?:process|store))(?: is)? (?:restart(?:s|ed)|exits|ends|stops|dies|killed|terminates|shuts down)|(?:you|they|we|someone|an operator) restarts? (?:it|them|the (?:process|store))|(?:a|the|the next|its next) restart|restarted)`;
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
const IN_PLACE_OF_A_PIN = String.raw`(?:\b(?:instead of|in place of|in lieu of|rather than|over|in preference to|no need (?:for|of|to(?: (?:take|call|use))?)) ${A_PIN}|\b(?:makes?|making|made|renders?|rendering|rendered)(?<!(?:\bnot|\bnever|n't) \w+) ${A_PIN} (?:redundant|unnecessary|needless|superfluous|obsolete|moot)\b|${PIN_NAMED} (?:is|are|becomes?) (?:then |thus |therefore |now )?(?:redundant|unnecessary|needless|superfluous|obsolete|moot|not needed|unneeded)\b)`;
/** Said to stay on a generation, by any verb but "pins": "stays on its first generation", "freezes each segment". */
const STAYS = String.raw`\b(?:stays?|stuck|sticks?|freezes?|frozen|locks?|locked)(?<!\b(?:not|never|no) \w+) (?:(?:on|at|to|with|in) )?(?:(?:each|every|its|their|the|one|a) )?(?:[\w'-]+ )?(?:segments?|generations?|snapshots?|pointers?)\b`;

/** Phrases that describe behaviour this library used to have, each with what to say instead. */
const RETIRED: ReadonlyArray<{ readonly claim: RegExp; readonly why: string }> = [
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
    why: 'the load guard covers the *Into verbs now',
  },
  // A store with no timed refresh was called a pin — "pin forever", "pins the generation for its lifetime" —
  // across the guide, both privacy notes, shipped doc-comments and the tests. It stopped being true once such a
  // store still moved on: its reader cache evicting the segment, a read finding the generation it holds swept, and
  // an invalidation (its own `load`, `rollback`, `eraseSubject` and `*Into` writes, or `invalidate()`) each
  // re-resolve it. `seg.pin()` is the one thing that holds a generation, and the copies taught readers to reach for
  // `cache.genTtlMs: 0` instead. The patterns read prose, not syntax, so bold and entities are resolved first
  // (`**pins**` is how one copy escaped a first sweep). When a true sentence trips one, reword the sentence: of a
  // real pin, say "a pinned handle holds its generation for the life of the handle". A paraphrase can always escape a
  // list of patterns, which is why each hit says what to write instead. The forms are the ones copies were found in
  // and the ones a review wrote to get past them. What no pattern here reads is left to review: a claim whose subject
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
          String.raw`(?:${FOR_GOOD}|for the life of the (?:store|source|process|reader|cache)|(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime)\b`,
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
    // A store with no timed refresh does move on, so "never" is the retired claim, in either order.
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
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}\b(?:generation|pointer|snapshot)s? (?:never|does not|doesn't|will not|won't) (?:changes?|moves?|advances?)\b|` +
          String.raw`\b(?:generation|pointer|snapshot)s? (?:never|does not|doesn't|will not|won't) (?:changes?|moves?|advances?)\b${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
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
      /(?<=(?:^|[.!?][^\S\n]+|\n|[:=][^\S\n]*)[^\S\n]*(?:(?:\/\/|\*|#+|>|-|\d+\.)[^\S\n]*)?)Pinned(?:[^\S\n]*[:,(]|\.(?!\w)|[^\S\n]+-[^\S\n])/,
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
    // One of the four things that re-resolve a segment, said to be the only one: "only on a timer", "only when its TTL
    // lapses", "only when invalidated".
    claim: new RegExp(
      g(
        String.raw`\bonly (?:on|at|with|by|after|through|when|once|if|upon) (?:(?:it is|it's|it has been|they are|they're) )?(?:(?:a|an|the|its|their) )?(?:(?:timed refresh(?:es)?|timer|(?:TTL|genTtlMs) (?:lapses|has lapsed|expires|has expired|elapses|runs out)|invalidat(?:ed|ions?))\b|invalidate\(\))`,
      ),
      'i',
    ),
    why:
      'a store re-resolves a segment on four things, and this names one of them as the only one: a timed refresh, ' +
      'an eviction, a read that finds its generation swept, and an invalidation each re-resolve it',
  },
];

/**
 * Files that DEFINE the rule and so must spell the retired phrases out — this one, and nothing else.
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

describe('no document claims behaviour this library has retired', () => {
  const files = textFiles();

  it('is scanning the surfaces where the stale copies actually were', () => {
    // Each of these held one of the four copies. A guard that stopped reaching them would pass silently.
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

  // Both directions: each retired form is caught however it wraps, and the sentences that must stay legal are not.
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
    // Copies the repo has carried, and the word orders it has used.
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
    // And markup the first rules did not strip.
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
    // The other things such a store was said never to do, and "on a timer" that no longer excuses it.
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
    // Word orders and words an exemption or a narrowing let through.
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
    // "Until a restart", a TTL of zero, a quoted phrase, and more that such a store was said never to notice.
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
    // What an exemption let through: a pinned handle, "pins nothing but", the life of a handle.
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
    // The claim before its subject, for each claim that was read only after it.
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
    // Never moving on, in the verbs that escaped: "cannot", the passive, a word between "never" and its verb, "only"
    // one of the four things, the end of the process, another writer's drop, "a single instant", and "on a timer"
    // followed by a second "never", a "nor" or a "neither", across a comma, a semicolon or a dash.
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
    // A label with a full stop.
    '// Pinned. The model bills none.',
    // A claim in a string whose quote is escaped or doubled, read as the program or the YAML prints it.
    "it('a store with no clock can\\'t see a new generation', () => {});",
    "description: 'A store with no clock can''t see a new generation.'",
    '{ "description": "the source \\"pins\\" the generation forever" }',
  ])('catches the retired form %j', (text) => {
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
    // True sentences an earlier rule refused: the gate's own advice, negations, and facts about other things.
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
    // Look-alikes of the forms added since, each true: the claim before its subject, negated; a pin offered in the
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
    // An apostrophe in a quoted string, escaped or doubled, is the possessive it prints: it opens no quotation.
    "description: 'Two incarnations'' pins stay apart on a store with no registry.'",
    "it('keeps two incarnations\\' pins apart on a store with no registry', () => {});",
  ])('leaves %j alone', (text) => {
    expect(hitsIn('x.md', text)).toEqual([]);
  });

  // Strict on purpose: these are true, and each reads as the retired claim. Each one reworded, as the gate asks, passes.
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
      'A store with no clock re-resolves a segment only when it is invalidated, evicted or swept.',
      'A store with no clock re-resolves a segment on an invalidation, an eviction or a swept read.',
    ],
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
      '## [0.1.0]',
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

  it('reads a 100 KB line with no full stop well inside 2 s, whatever it is made of', () => {
    // A bracket, a run of stars and a doc-comment link that never close took 2.8 s, 23 s and 1.4 s on such a line before
    // their transforms were made to scan it once. The last two work the quote pairing and the rules hardest.
    for (const unit of [
      '[a ',
      '*',
      '{@link a ',
      "'a ",
      'no clock never re-resolves on a timer, and ',
    ]) {
      const line = unit.repeat(Math.ceil(102_400 / unit.length)).slice(0, 102_400);
      const started = performance.now();
      hitsIn('x.md', line);
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(2000);
    }
  });

  it("reads a package's changelog as the root one: its released history is not scanned", () => {
    const changelog =
      '# c\n\n## [Unreleased]\n\n- pins it forever\n\n## [0.1.0]\n\n- pins it forever';
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
 * Every retired claim a file makes, with its line. Every hit, not the first of each: three copies say so at once. A
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
    for (const { claim, why } of RETIRED) {
      let line = 1;
      let at = 0;
      for (const m of reading.matchAll(new RegExp(claim.source, `${claim.flags}g`))) {
        line += lineCount(reading.slice(at, m.index));
        at = m.index;
        const hit = `${rel}:${line} — "${m[0].replace(/\s+/g, ' ')}" is no longer true. ${why}`;
        const seen = earlier.indexOf(hit);
        if (seen < 0) hits.push(hit);
        else earlier.splice(seen, 1);
      }
    }
  }
  return hits;
}
