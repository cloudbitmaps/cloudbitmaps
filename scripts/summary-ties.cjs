#!/usr/bin/env node
'use strict';
/*
 * Every restatement of a guarantee links the claim it restates.
 *
 * WHY THIS EXISTS. docs/guide/correctness.md says how each guarantee holds under crashes, races and faults. The guides,
 * the READMEs, the privacy note, the roadmap and the site restate those guarantees in short, and a short restatement
 * written apart from its mechanism says more than the mechanism gives, or less, with nothing to compare the two: that a
 * write's random id settles it, where the mechanism also reads the row again when another writer swaps in first; that
 * every race is reported, where the mechanism names two that are not. Editing a claim means finding every copy of it by
 * hand, and the most restated claims have more than ten.
 *
 * THE TIE. Each claim in correctness.md opens with an anchor, `<a id="<key>"></a>**The claim.**`, a section's intro
 * included, and the key names the claim, never its heading. A restatement links the claim: `[a crash never moves the
 * pointer](correctness.md#crash-never-moves-the-pointer)`, relative in docs/ and the root pages, the absolute
 * https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/correctness.md#<key> in a package README, on the
 * site and in llms.txt. A link to a heading, or to the page, is navigation, not a tie. The unit is the block (a
 * paragraph, a list item, a table row): its ties are the claims it links, wherever in the block the link sits.
 *
 * WHAT FAILS. (The labels skip R5, which would check a record that someone read a changed pair, a record the gate
 * does not keep.)
 *   R1  correctness.md: a paragraph or bulleted item that opens with a bold claim and no anchor; text under a section
 *       heading before its first anchor; an anchor that does not open its block; two anchors with one key; a key that
 *       is a heading's slug or not lower-case words and hyphens. (A numbered item is a step of the claim above it,
 *       and needs none.)
 *   R2  a link into correctness.md whose fragment names neither a claim nor a heading (links.test.ts resolves every
 *       link; this gate cannot classify such a link, so it refuses it too).
 *   R3  a sentence that matches a claim's signature, in a block that does not tie that claim.
 *   R3b a sentence that shares MIN_SHARED or more word 4-grams with a claim, in a block that ties neither the claim it
 *       shares the most with (or one sharing as many) nor the claim the longest run of those words was copied from.
 *       The message names the first, quotes the run, and names the run's claim where it is another, so a writer can
 *       check that the claim states what the sentence says before linking it.
 *   R4  a block under a summary heading that ties no claim; a summary region that names no section of correctness.md,
 *       or two, or another section than its heading; a section with no summary region, or two. A summary heading is a
 *       heading in docs/guide/ whose text is a section heading of correctness.md or "How it stays correct", and its
 *       section is the one its navigation link names.
 *   R6  a baseline row that excuses nothing, or one the baseline at the merge base with origin/main does not have.
 *       Where the merge base has no baseline file (the branch that adds it), there are no rows to compare, and the
 *       output says so; any other failure to read it fails the gate.
 *   R7  a signature that names a key correctness.md does not have, or a pattern of it that matches nothing in the
 *       scope or in correctness.md. (Each signature's own fixtures, a real sentence it must match and a real look-alike
 *       it must not, are checked by tests/docs/summary-ties.test.ts.)
 *
 * THE BASELINE. tests/docs/summary-ties.json lists the restatements R3 and R3b found untied when the gate was written:
 * a row each, `{ file, claim, sentence, starts }`, where `sentence` is the hash of the sentence's text. A row excuses
 * that sentence, every copy of it in that file, for that claim, and nothing in a summary region. Editing the sentence
 * changes its hash, so it fails as new: touching it means tying it. `--update` drops the rows that excuse nothing,
 * never adds one, and exits non-zero while the gate still fails.
 *
 * SCOPE. Every tracked .md file and every .html and .txt page under site/, but the exclusions in EXCLUDED, each with its
 * reason. A new page is read by default.
 *
 * KNOWN LIMITS. It proves that a restatement is tied, not that it is true.
 *  - A tied summary that says more than its claim, or drops its exception, passes. Reading the two together is the
 *    docs-fidelity review's, and `--changed` hands it the pairs to read: each changed claim with the blocks that tie
 *    it and the baselined copies that do not, and each changed or re-pointed tied block with its claims. Nothing here
 *    records that anyone read them.
 *  - A claim edited while its summary is not, or a summary edited, passes when both stay tied: the gate holds the link,
 *    not the reading. `--changed` lists the pair.
 *  - A paraphrase that matches no signature and copies no run of MIN_SHARED 4-grams passes untied, and a signature is
 *    brittle to rewording: one word changed ("is always reported", "only sent once", "never half encrypted") can step
 *    past it. Each one a review finds becomes a signature, or widens one.
 *  - A tied block that restates a second claim it does not tie, in words neither check sees, passes.
 *  - A guarantee correctness.md does not hold has nothing to tie to, and is not seen.
 *  - A signature reads a sentence's text: links read as their text, code spans as plain text, emphasis, strikethrough,
 *    tags and comments gone, non-breaking hyphens read as hyphens, fenced code and HTML <pre>, <script>, <style> and
 *    <svg> skipped. A negation in the three words before a match ("nothing promises that at most one lands") stands it
 *    down; a negation further back does not, and neither does "no answer", which is a claim's own wording.
 *  - Markdown it reads as a reader would not: a setext heading (text over `===` or `---`) is not a heading, so a summary
 *    under one has no region, which fails R4; an indented code block, and a fence indented four spaces or more, read
 *    as prose; a code span that wraps onto the next line does not hide a `<!--` in it; an HTML tag with a `>` inside a
 *    quoted attribute ends at that `>`.
 *  - A paragraph of correctness.md that opens with no bold claim and no anchor belongs to the claim above it, so a new
 *    mechanism written that way is tied by that claim's links.
 *  - A pattern that matches only correctness.md's own wording is never reported dead: the dead-pattern check reads
 *    the source too, which keeps it alive.
 *  - Code comments and doc-comments are not read: they describe the code beside them, which is their source of truth.
 *    Nor is an attribute's text on the site (a meta description, alt text).
 *  - The baseline lists the restatements that were untied when the gate was written. Each is excused until it is tied
 *    or reworded; the baseline can only shrink, which needs the history and origin/main to compare with. On the branch
 *    that adds the baseline, the merge base has none, so every row is that branch's own, and there is nothing to compare.
 *  - Whether correctness.md is true of the code is the tests' job.
 *
 * Usage:
 *   node scripts/summary-ties.cjs                          check the tree (what tests/docs/summary-ties.test.ts runs)
 *   node scripts/summary-ties.cjs --update                 drop the baseline rows that excuse nothing
 *   node scripts/summary-ties.cjs --changed [--against <ref>]
 *                                                          the claims and tied blocks this branch changed, against the
 *                                                          merge base with <ref> (origin/main by default), each beside
 *                                                          what it ties or is tied by; on a stacked branch, pass the
 *                                                          branch it is stacked on
 *   Exit 0: clean. Exit 1: problems found (or, with --update, still there). Exit 2: the gate could not run, and why.
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, writeFileSync } = require('node:fs');
const { join, posix, resolve } = require('node:path');
const { removeAll } = require('../bench/lib/remove-all.cjs');

const ROOT = resolve(__dirname, '..');
const SOURCE = 'docs/guide/correctness.md';
const BASELINE = 'tests/docs/summary-ties.json';
const BASE = 'origin/main';
const ABSOLUTE = 'https://github.com/cloudbitmaps/cloudbitmaps/blob/main/';
/** The heading a guide's summary of its own part of correctness.md goes under, when it is not a section's own. */
const SUMMARY_HEADING = 'How it stays correct';
/**
 * R3b: a sentence sharing this many word 4-grams with one claim (a run of about 11 words, or a few shorter ones) copies
 * it. Measured on 30 sampled hits between 8 and 9 (a true copy restates a claim's mechanism): 27 are copies (90%; 87%
 * counting one borderline), and the misses were an option's default, a wait schedule and shared phrases two mechanisms
 * share.
 */
const MIN_SHARED = 8;

/**
 * What the gate does not read, each with its reason. An entry is a path, a directory (ending in `/`), or a pattern;
 * each must still name a tracked file, so a renamed one fails rather than going on looking excluded.
 */
const EXCLUDED = [
  {
    path: SOURCE,
    reason: 'the source: the claims themselves, which every restatement ties',
  },
  {
    path: 'CHANGELOG.md',
    reason:
      'history: each entry says what a release changed, and its released sections are frozen by ' +
      'changelog-released-sections.test.ts',
  },
  { path: '.changeset/', reason: 'the changesets that become the changelog' },
  {
    path: 'bench/calibration/',
    reason:
      'history: each report is a dated record of one calibration run, written by the run, and says what was measured then',
  },
  {
    path: 'packages/roaring/PRIVACY.md',
    reason:
      'the copy npm publishes, held equal to PRIVACY.md by privacy-note-sync.test.ts, so it carries the same ties ' +
      'in their absolute form; links.test.ts resolves them',
  },
  {
    path: 'AGENTS.md',
    reason:
      "the agent instructions: its invariants restate claims and link the guides' summaries, and its links are " +
      "changed only with the maintainer's approval",
  },
  { path: 'CLAUDE.md', reason: 'a link to AGENTS.md' },
  {
    pattern: /^(?:tests|scripts|bench|fuzz|api-surface|site)\/(?:.+\/)?README\.md$/,
    label: 'the READMEs under tests/, scripts/, bench/, fuzz/, api-surface/ and site/',
    reason: 'they describe the repository to a contributor, not the library to its user',
  },
];

/**
 * A negation in the three words before a match, in its clause (no comma between), which stands the match down. "No
 * answer" is not one: it is the wording of the claim about a write that gets none.
 */
const NEGATED =
  /\b(?:no(?!\s+answer\b)|not|nothing|never|cannot|can't|nor|none|neither)\b(?:\s+[\w'’-]+){0,3}\s*$/i;

/**
 * The claim signatures: the predicate forms a short restatement of each claim takes, not its words alone ("a crash …
 * never moves the pointer", not "crash"). Each is read on a sentence's text, case aside. `summary` is a real sentence it
 * must match and `lookAlike` a real one, on the same subject or in the same words, it must not; the test holds both.
 */
const SIGNATURES = [
  {
    claim: 'refusal-is-reported-not-thrown',
    patterns: [
      /\brefus\w+ (?:is|are) (?:reported|an outcome|a normal outcome)/i,
      /returns? published: false[^.]{0,40}rather than throw/i,
      /reported[^.]{0,30}not thrown|not a throw/i,
    ],
    summary:
      'A refusal is reported in the result, not thrown, so a result you ignore is a load that did nothing.',
    lookAlike: 'A refused load also emits segment.load-refused to the audit sink you pass.',
  },
  {
    claim: 'judged-after-the-write',
    patterns: [
      /judged after the write|writes? (?:its|the new generation's) object first, unpublished/i,
    ],
    summary:
      "The load writes the new generation's object first, unpublished, then judges it, and only then moves the pointer.",
    lookAlike: 'The segment is judged before an id is read.',
  },
  {
    claim: 'two-ratio-bounds',
    patterns: [
      /minRetained[^.]{0,20} is a floor and maxGrowth[^.]{0,20} a ceiling/i,
      /neither (?:bound )?judges a first load/i,
    ],
    summary:
      'Neither judges a first load, and maxGrowth does not judge a load onto an empty segment either, since no ceiling is a multiple of zero; 0 means no bound, on both.',
    lookAlike: 'guard.maxGrowth: a ceiling on how much a load may grow a segment',
  },
  {
    claim: 'object-write-resent',
    patterns: [
      /throttl\w+[^.]{0,80}\bsent again/i,
      /sent again[^.]{0,60}throttl\w+/i,
      /random (?:write )?id[^.]{0,120}(?:tells?|landed|first send|re-send)/i,
    ],
    summary: 'A throttled write is sent again, and never lands twice.',
    lookAlike: 'nothing is throttled, so nothing is sent again',
  },
  {
    claim: 'row-write-settled',
    patterns: [
      /(?<!\b(?:swap|move)\b[^.]{0,120})settle[sd]? (?:an unanswered registry write )?by reading the row/i,
      /(?<![\w-])reads? the row (?:again )?and (?:decides|sends a fresh compare-and-swap)/i,
      /write (?:that )?(?:ends|ended|got|gets) (?:without|no) (?:an )?answer[^.]{0,80}(?:reads?|settled|may still land)/i,
    ],
    summary:
      'A registry row write that ends without an answer may still land, so the load reads the row again and decides from what it holds, deleting nothing until it has.',
    lookAlike:
      "After no answer it sends no fresh swap; after a conflict that changed only the row's leases it does send one.",
  },
  {
    claim: 'rollback-settles-its-swap',
    patterns: [/\b(?:swap|move)\b[^.]{0,120}\bsettled by reading the row/i],
    summary:
      'A swap of the pointer that gets no answer, or that meets a conflict, is settled by reading the row.',
    lookAlike: 'A registry write that gets no answer is settled by reading the row.',
  },
  {
    claim: 'transient-error-leaves-its-object',
    patterns: [
      /TransientError[^.]{0,60}(?:leaves|keeps) its object/i,
      /throws? TransientError[^.]{0,30}and keeps its object/i,
    ],
    summary: 'A load that throws TransientError leaves its object above the pointer: re-run it.',
    lookAlike: 'Any other transient fault reaches you as TransientError',
  },
  {
    claim: 'numbering-is-the-loads',
    patterns: [/takes? the next generation number itself/i, /generation numbering is the load's/i],
    summary: "Generation numbering is the load's.",
    lookAlike: 'It binds the generation number, not the object.',
  },
  {
    claim: 'sorted-load-reads-ids-last',
    patterns: [/with sorted: true the ids are read while the object is written/i],
    summary:
      'With sorted: true the ids are read while the object is written, so everything else comes before the first of them: the row is read again (on a first load or an encrypted segment, as above) and judged, the existence check is joined, and the key is unwrapped or minted.',
    lookAlike: 'sorted: true writes ascending ids one chunk at a time.',
  },
  {
    claim: 'publish-is-forward-only',
    patterns: [
      /(?:never|only) moves? (?:it |the pointer )?(?:backwards?|forward)/i,
      /\b(?:publish|pointer|it) is forward-only/i,
      /at most one (?:of them )?lands/i,
      /of two loads[^.]{0,40}at most one/i,
      /re-?run is (?:safe|idempotent|a newer identical generation)/i,
      /re-running a load is safe/i,
    ],
    summary:
      'So a crash never moves the pointer, a rerun is a newer identical generation, and of two loads racing on one segment at most one lands.',
    lookAlike: 'publish.ts',
  },
  {
    claim: 'which-fence',
    patterns: [/fenced on (?:the|its) (?:row|generation|pointer)/i, /publishes? with the fences/i],
    summary: 'An Into publishes with the fences a load does: see which fence a publish carries.',
    lookAlike:
      'A root is for one process: instances in a process share a lock per row, two processes on one root are not fenced.',
  },
  {
    claim: 'crash-never-moves-the-pointer',
    patterns: [
      /\bcrash\w*[^.]{0,60}\b(?:never moves?|leaves the previous generation)/i,
      /dies between its write and its publish/i,
    ],
    summary:
      'Nothing mutates a stored bitmap, so a crash before the publish leaves the previous generation authoritative, a rerun is a newer identical generation, and there is no partially-visible write.',
    lookAlike: 'A corrupt or hostile chunk is a typed error, not a crash.',
  },
  {
    claim: 'orphan-collected-later',
    patterns: [
      /\borphan\b[^.]{0,40}\b(?:a later load's|a load's) (?:listing|collection)/i,
      /\borphan is collected later/i,
    ],
    summary:
      "A load that dies between its write and its publish leaves an orphan, which a later load's collection removes.",
    lookAlike:
      'A lifecycle rule is still a fine backstop for orphans left by a failed dropSegment.',
  },
  {
    claim: 'miss-is-a-re-read',
    patterns: [
      /heals? forward/i,
      /\bre-resolves?[^.]{0,40}retr(?:y|ies) once/i,
      /never a torn object/i,
    ],
    summary:
      "The call then serves the newer, committed generation: a move forward within that segment's lifetime, never a torn object.",
    lookAlike: 'An ordinary handle re-resolves on cache.genTtlMs; a pinned one does not.',
  },
  {
    claim: 'exposure-window-is-the-ttl',
    patterns: [/exposure window/i, /ceil\(genTtlMs/i],
    summary: 'The exposure window is the TTL, not the length of your call.',
    lookAlike: 'cache.genTtlMs: 0 turns the timed refresh off.',
  },
  {
    claim: 'what-collection-does',
    patterns: [
      /(?:deletes?|collects?) only (?:generations? )?(?:strictly )?below the pointer/i,
      /never (?:touches|collects|deletes) the current generation/i,
      /neither touches the current generation/i,
    ],
    summary: 'It never touches the current generation or anything above it.',
    lookAlike: 'The current generation is 2, the row and its footer.',
  },
  {
    claim: 'lease-read-from-the-row',
    patterns: [/spares? (?:a|every) generation a live lease holds/i],
    summary:
      "A load's collection deletes only below the pointer on an active segment, keeps the window the row records, spares a generation a live lease holds, and re-proves the row before every delete.",
    lookAlike: 'Collection resumes after the lease.',
  },
  {
    claim: 'lease-write-refuses-no-writer',
    patterns: [
      /only in its leases[^.]{0,80}(?:does not refuse|goes on|not refused)/i,
      /lease write[^.]{0,60}(?:does not (?:refuse|delay))/i,
    ],
    summary:
      'A lease write does not delay an erasure: a row that differs from the one the erasure read only in its leases does not refuse it.',
    lookAlike:
      'A lease is written by one compare-and-swap on the row, so it is one more writer of the row, but never one that refuses the others: see the next paragraph.',
  },
  {
    claim: 'collection-re-proves-the-row',
    patterns: [/re-?proves? the row before (?:every|each) delete/i],
    summary:
      "A load's collection deletes only below the pointer on an active segment, keeps the window the row records, spares a generation a live lease holds, and re-proves the row before every delete.",
    lookAlike:
      'A renewal that loses means another write landed since: the call reads the row and decides again.',
  },
  {
    claim: 'list-is-not-a-receipt',
    patterns: [
      /\b(?:returned |collected )?list[^.]{0,30}\bis not a receipt/i,
      /\bno receipt either/i,
    ],
    summary: 'A list is not a receipt, and neither is this one.',
    lookAlike:
      'A segment.publish is not a receipt for anything: it says a set was loaded, not what was removed from it.',
  },
  {
    claim: 'every-delete-reads-the-row',
    patterns: [
      /(?:read|reads) the (?:segment's )?row (?:just )?before (?:each|every) delete/i,
      /kept out of all of them/i,
    ],
    summary: "Every loop that deletes generations reads the segment's row just before each delete.",
    lookAlike:
      'Before each delete the pass reads the row again and spares every name the row knows then, which a publish or a rollback that landed since can have added.',
  },
  {
    claim: 'deleting-call-detects',
    patterns: [/(?:deleting call|the call|the load)[^.]{0,40}detects?/i],
    summary: 'Nothing can restore a deleted object, so the deleting call detects it.',
    lookAlike: 'A CRC detects damage; it does not authenticate.',
  },
  {
    claim: 'rollback-check-gets-time',
    patterns: [/(?:over the next|up to) 1\.75 s/i],
    summary:
      'The deleting call then finds the pointer on a generation it deleted and, once its reads of the row over the next 1.75 s all still find it there, throws NotFoundError naming it rather than answer; it repairs nothing.',
    lookAlike:
      'A rollback whose swap got no answer is one: it puts the pointer back only after its own request timeout and a read of the row, often longer than the 1.75 s the deleting call waits.',
  },
  {
    claim: 'ledger-loses-what-it-deletes',
    patterns: [
      /cannot bring an erased generation back/i,
      /takes? what it will delete out of the (?:row's )?(?:ledger|record)/i,
    ],
    summary:
      "Before it deletes anything, it takes what it will delete out of the row's ledger of known generations, so a rollback without allowUnknown cannot bring an erased generation back, even when a delete fails, except where the pointer alone decides.",
    lookAlike: 'A ledger it cannot use is counted, not read.',
  },
  {
    claim: 'every-holder-goes',
    patterns: [
      /every generation (?:in the bucket )?that (?:holds?|held) (?:the id|the bit)/i,
      /\bphysically gone\b/i,
    ],
    summary:
      'For every segment its ledger reports `erased: true`, the bit is physically gone from the bucket when the call returns; a noncurrent version, a replica or a backup keeps the old object until its own lifecycle removes it.',
    lookAlike:
      'An erasure ledger — per-subject-request proof of physical deletion — is returned by eraseSubject.',
  },
  {
    claim: 'erasure-racing-writers',
    patterns: [
      /\brace\w*[^.]{0,80}\b(?:is|are) (?:reported|caught)/i,
      /(?:is|are) caught and the entry says/i,
    ],
    summary:
      "A race with a load, a rollback or another erasure is reported, as 'superseded', an error: note or a thrown error, with two exceptions at a refused rewrite's delete of its own object above the winner's pointer: a rollback onto that object between the call's renewal of the row and the delete, and, on a storage driver that does not report conditionalDelete, a delete that removes a load's generation published under that object's number.",
    lookAlike: 'One race stays, and the fleet scan repairs it.',
  },
  {
    claim: 'rollback-during-erasure',
    patterns: [/nothing reported/i],
    summary:
      'Each leaves the pointer on a missing object with nothing reported, and only checkConsistency() finds it.',
    lookAlike: 'What the call reports depends on where the rollback lands:',
  },
  {
    claim: 'erasure-number-taken-again',
    patterns: [
      /\bthe load's generation stays/i,
      /took the number[^.]{0,60}keeps? its generation/i,
      /only while it is the (?:object|blob)/i,
      /\bnumber taken again during an erasure/i,
    ],
    summary:
      'Once its own renewal lands, it deletes, passing the version the footer read reported, so a load that took the number after the renewal keeps its generation.',
    lookAlike:
      'usually the library handles it internally (a swept generation, or a number taken again, heals forward).',
  },
  {
    claim: 'erasure-results',
    patterns: [/erased: true over bytes/i, /erased: true (?:means|is a claim)/i],
    summary:
      'A call that could not collect throws rather than report erased: true over bytes still there.',
    lookAlike:
      'Each is listed in collected, and on its own it does not make the answer erased: true.',
  },
  {
    claim: 'drop-registry-first',
    patterns: [
      /(?:writes? )?the tombstone first|registry first, then storage/i,
      /leaks? bytes, not correctness/i,
      /no load can publish onto/i,
      /nothing will ever point at it/i,
    ],
    summary:
      'dropSegment writes the tombstone before the storage sweep, deliberately, so a fault there leaks bytes, not correctness.',
    lookAlike: 'A tombstoned row has its bucket searched too.',
  },
  {
    claim: 'tombstones-purged-narrowly',
    patterns: [/retirement stamp/i, /tombstone[^.]{0,100}never purge[ds]/i],
    summary:
      'A tombstone a hand-run dropSegment, a crypto-shred or a cleartext destroy left is never purged by the library.',
    lookAlike:
      'A retired segment leaves a destroyed row behind, and one dead row per retired daily segment would accumulate forever.',
  },
  {
    claim: 'what-the-purge-removes',
    patterns: [/removes? (?:the )?rows? for good/i, /recoverable wherever the storage keeps/i],
    summary: 'Set conditionalDelete: true to remove rows for good;',
    lookAlike: 'Pass purgeTombstones: false to keep every tombstone.',
  },
  {
    claim: 'pointer-outlives-its-row',
    patterns: [/pointer can outlive its row/i, /outlive(?:s)? (?:its|the) row/i],
    summary: 'A pointer can outlive its row, and what removes it.',
    lookAlike:
      'The purge removes every pointer it read to the row, and the one its own grace would have filed.',
  },
  {
    claim: 'pin-shares-the-caches',
    patterns: [/never handed a chunk a live read fetched/i],
    summary:
      "A pin shares the store's bounded reader and chunk caches, under keys of its own, so it is never handed a chunk a live read fetched from another generation.",
    lookAlike:
      "Its decoded chunks share the store's chunk cache and its bound, under keys of their own that no live read writes.",
  },
  {
    claim: 'one-generation-per-call',
    patterns: [/one call reads a segment at one generation/i, /two generations is refused/i],
    summary: 'One call reads a segment at one generation.',
    lookAlike:
      "everyNth places its ranks from one generation's counts, so it reads only through a pin.",
  },
  {
    claim: 'pin-safe-across-re-creation',
    patterns: [/never reads (?:a|the) re-created segment/i, /pin is safe across a re-creation/i],
    summary: 'A pin is safe across a re-creation.',
    lookAlike:
      'A generation number is not an identity, and a re-created name can wear the very currentGen the tombstone held.',
  },
  {
    claim: 'seal-count',
    patterns: [/2³² seals|2\^32 seals|96-bit nonce/i],
    summary:
      'Each chunk is sealed with a fresh random 96-bit nonce, and a repeated nonce stays negligibly likely below about 2³² seals under one key, a limit nothing counts: a segment at the 65,536-chunk maximum reaches it after about 65,500 loads or erasure rewrites, 230 days at one every 5 minutes.',
    lookAlike: "Encrypted: the index's nonce and tag (section 8).",
  },
  {
    claim: 'never-half-encrypted',
    patterns: [/(?:is )?never half-encrypted/i, /cannot be half-encrypted/i],
    summary: 'The reason is that one segment cannot be half-encrypted.',
    lookAlike:
      'The seal count, and why a half-encrypted segment is refused either way round, are in How encryption stays correct.',
  },
  {
    claim: 'fault-costs-a-re-run',
    patterns: [/never correctness/i, /fault costs a read some latency/i],
    summary: 'A fault costs a read some latency and a write a re-run, never correctness.',
    lookAlike: 'Correctness does not depend on it either way.',
  },
  {
    claim: 'sdk-retry',
    patterns: [
      /(?:sdk's |the )?retry off/i,
      /(?:is|are) sent once/i,
      /sends? (?:each|a) (?:conditional |registry |row )*write once/i,
      /retried only where (?:that|it) is safe/i,
      /safe to send twice/i,
    ],
    summary: "The registry's writes are sent once.",
    lookAlike: 'No write goes through the read retry.',
  },
  {
    claim: 'tagged-writes',
    patterns: [
      /\bwrites? (?:that )?can meet itself/i,
      /tagged with a random id/i,
      /tags? each write/i,
      /registry row is overwritten by compare-and-swap/i,
    ],
    summary:
      'The Azure Blob package, whose retry has no per-request switch, tags each write and, on a conflict, reads the stored blob back to see whose write it is.',
    lookAlike:
      "Each carries a random id in the object's metadata (cbwid), outside the .crbm bytes and outside the registry row's body.",
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Reading text: blocks, sentences, links.

/** A string with the line each of its characters came from, so a sentence can be reported where it starts. */
function tracked(parts) {
  let s = '';
  const at = [];
  for (const p of parts) {
    if (s !== '') {
      s += ' ';
      at.push(p.line);
    }
    s += p.text;
    for (let k = 0; k < p.text.length; k++) at.push(p.line);
  }
  return { s, at };
}

/** `t` with every match of the global `re` replaced by what `fn` returns, each line kept with its text. */
function replaceTracked(t, re, fn) {
  let s = '';
  const at = [];
  let last = 0;
  for (const m of t.s.matchAll(re)) {
    const i = m.index;
    s += t.s.slice(last, i);
    for (let k = last; k < i; k++) at.push(t.at[k]);
    const rep = fn(m);
    s += rep;
    for (let k = 0; k < rep.length; k++) at.push(t.at[i]);
    last = i + m[0].length;
  }
  s += t.s.slice(last);
  for (let k = last; k < t.s.length; k++) at.push(t.at[k]);
  return { s, at };
}

const ENTITIES = {
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  rarr: '→',
  larr: '←',
  harr: '↔',
  times: '×',
  divide: '÷',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  minus: '−',
  le: '≤',
  ge: '≥',
  plusmn: '±',
  deg: '°',
  sup2: '²',
  sup3: '³',
};
/** Every line ending a page can use: `\n`, `\r\n`, or a lone `\r`. */
const LINE_BREAK = /\r\n?|\n/;

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;
function decodeEntity(m) {
  const e = m[1];
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n).replace(/\s/g, ' ') : ' ';
  }
  return ENTITIES[e.toLowerCase()] ?? ' ';
}

/**
 * One pass over a Markdown unit's inline text: a code span is kept as it is (its backticks go later, with emphasis); a
 * link reads as its text and an image as its alt text, each target recorded, a reference link's and a shortcut
 * reference's (`[text]` with a `[text]: url` definition) included; a comment or a tag goes, a `<br>` reads as a space, an
 * `href` is recorded, quoted or not; a bare URL stays and is recorded, as GitHub links one.
 */
const INLINE = new RegExp(
  [
    /(?<tick>`+)(?!`)(?<code>[\s\S]*?[^`])\k<tick>(?!`)/.source,
    /!\[(?<alt>[^\]]*)\]\([^)]*\)/.source,
    /\[(?<text>(?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?(?<target>[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.source,
    /\[(?<refText>[^\]]+)\]\[(?<ref>[^\]]*)\]/.source,
    /\[(?<shortcut>[^[\]]+)\](?![[(])/.source,
    /<!--[\s\S]*?-->/.source,
    /<(?<br>br|wbr)\b[^<>]*>/.source,
    /<[a-zA-Z][^<>]*?\bhref\s*=\s*(?:"(?<href>[^"]*)"|'(?<hrefSingle>[^']*)'|(?<hrefBare>[^\s"'<>]+))[^<>]*>/
      .source,
    /<\/?[a-zA-Z][^<>]*>/.source,
    /(?<url>https?:\/\/[^\s<>()`"']+)/.source,
  ].join('|'),
  'g',
);

function inline(t, refs, links) {
  return replaceTracked(t, INLINE, (m) => {
    const g = m.groups;
    if (g.code !== undefined) return `\`${g.code}\``;
    if (g.alt !== undefined) return g.alt;
    if (g.target !== undefined) {
      links.push(g.target);
      return g.text;
    }
    if (g.refText !== undefined) {
      const target = refs.get((g.ref === '' ? g.refText : g.ref).toLowerCase());
      if (target !== undefined) links.push(target);
      return g.refText;
    }
    if (g.shortcut !== undefined) {
      const target = refs.get(g.shortcut.toLowerCase());
      if (target === undefined) return m[0];
      links.push(target);
      return g.shortcut;
    }
    if (g.br !== undefined) return ' ';
    const href = g.href ?? g.hrefSingle ?? g.hrefBare;
    if (href !== undefined) {
      links.push(href);
      return '';
    }
    if (g.url !== undefined) {
      links.push(g.url.replace(/[.,;:!?*]+$/, ''));
      return g.url;
    }
    return '';
  });
}

/** A sentence ends at a stop, after any emphasis, code span, quote or bracket that closes on it. */
const SENTENCE_END = /(?<=[.!?:][*_`"')\]]*)\s+(?=[A-Z`*[(])/g;

/** Emphasis and strikethrough markers gone from text outside code: `**`, `__`, a single `*` or `_` at a word's edge, `~~`. */
const unemphasised = (s) =>
  s
    .replace(/\*\*|__|~~/g, '')
    .replace(/(?<![\w*])\*(?=[^\s*])|(?<=[^\s*])\*(?![\w*])/g, '')
    .replace(/(?<![\w_])_(?=[^\s_])|(?<=[^\s_])_(?![\w_])/g, '');

const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

/**
 * A sentence's text as a reader is given it: code spans as plain text, emphasis and strikethrough gone outside them,
 * entities decoded, a non-breaking or Unicode hyphen read as `-` and a soft hyphen dropped.
 */
function plainOf(s) {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    out += unemphasised(s.slice(last, m.index)) + m[2];
    last = m.index + m[0].length;
  }
  out += unemphasised(s.slice(last));
  return out
    .replace(/`/g, '')
    .replace(ENTITY, (...m) => decodeEntity(m))
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentences of a unit (a paragraph, a list item, a table cell), each with the line it starts on. */
function sentencesOf(t) {
  const flat = replaceTracked(t, /\s+/g, () => ' ');
  const out = [];
  let last = 0;
  const push = (from, to) => {
    const raw = flat.s.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const plain = plainOf(raw);
    if (plain !== '') out.push({ line: flat.at[from + lead] ?? flat.at[from], text: plain });
  };
  for (const m of flat.s.matchAll(SENTENCE_END)) {
    push(last, m.index);
    last = m.index + m[0].length;
  }
  push(last, flat.s.length);
  return out;
}

/** The cells of a table row, split on pipes that are not escaped and not inside a code span. */
function splitCells(line) {
  const cells = [];
  let cur = '';
  let tick = 0;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '`') {
      let n = 1;
      while (body[i + n] === '`') n++;
      if (tick === 0) tick = n;
      else if (tick === n) tick = 0;
      cur += body.slice(i, i + n);
      i += n - 1;
    } else if (c === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|' && tick === 0) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** `line` with the text inside each code span blanked, its length kept, so a search for markup passes over code. */
function maskCode(line) {
  return line.replace(CODE_SPAN, (m, tick, code) => tick + ' '.repeat(code.length) + tick);
}

/**
 * `line` with every comment outside a code span gone, and whether a comment it opens is still open at its end. A
 * comment in a code span or in fenced code is text: the caller never passes a fenced line.
 */
function uncommented(line) {
  let out = line;
  for (;;) {
    const masked = maskCode(out);
    const open = masked.indexOf('<!--');
    if (open === -1) return { line: out, open: false };
    const close = masked.indexOf('-->', open + 4);
    if (close === -1) return { line: out.slice(0, open), open: true };
    out = out.slice(0, open) + out.slice(close + 3);
  }
}

/**
 * A Markdown (or plain-text) page as blocks: a heading, a paragraph, a list item, a table row. Fenced code, comments,
 * thematic breaks and reference definitions are not blocks; a block quote reads as its text.
 */
function markdownBlocks(text) {
  const lines = text.split(LINE_BREAK);
  const raw = [];
  const refs = new Map();
  let cur = null;
  let fence = null;
  let comment = false;
  const flush = () => {
    if (cur !== null) raw.push(cur);
    cur = null;
  };
  lines.forEach((full, i) => {
    const n = i + 1;
    let line = full;
    if (comment) {
      // A comment's lines are not text, and they end the paragraph before them.
      const close = line.indexOf('-->');
      if (close === -1) return flush();
      comment = false;
      line = line.slice(close + 3);
    }
    const quote = /^\s{0,3}(?:>\s?)+/.exec(line);
    if (quote !== null) line = line.slice(quote[0].length);
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (f !== null && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (f !== null) {
      flush();
      fence = f[1];
      return;
    }
    const stripped = uncommented(line);
    line = stripped.line;
    comment = stripped.open;
    if (line.trim() === '') return flush();
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h !== null) {
      flush();
      raw.push({ kind: 'heading', level: h[1].length, text: h[2], line: n, endLine: n });
      return;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return flush();
    const def = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/.exec(line);
    if (def !== null) {
      flush();
      refs.set(def[1].toLowerCase(), def[2]);
      return;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return;
      raw.push({
        kind: 'row',
        line: n,
        endLine: n,
        first: line.trim(),
        cells: splitCells(line),
        cellLine: n,
      });
      return;
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      flush();
      const ordered = /\d/.test(item[2]);
      cur = {
        kind: 'text',
        item: ordered ? 'ordered' : 'bullet',
        line: n,
        endLine: n,
        first: item[3],
      };
      cur.parts = [{ text: item[3], line: n }];
      return;
    }
    if (cur === null)
      cur = { kind: 'text', item: null, line: n, endLine: n, first: line.trim(), parts: [] };
    cur.parts.push({ text: line.trim(), line: n });
    cur.endLine = n;
  });
  flush();
  return raw.map((b) => {
    if (b.kind === 'heading') return b;
    const links = [];
    const units =
      b.kind === 'row'
        ? b.cells.map((c) => sentencesOf(inline(tracked([{ text: c, line: b.line }]), refs, links)))
        : [sentencesOf(inline(tracked(b.parts), refs, links))];
    return {
      kind: 'text',
      item: b.item ?? null,
      line: b.line,
      endLine: b.endLine,
      first: b.first,
      links,
      units,
    };
  });
}

/** Elements whose content is not prose a reader is given. */
const HTML_DROP =
  /<(script|style|pre|svg|template|noscript|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;
const HTML_BLOCK = new Set(
  (
    'p li tr div section article header footer main nav aside table thead tbody tfoot ul ol dl dt dd blockquote ' +
    'figure figcaption caption details summary form fieldset legend body head html hr label button option select'
  ).split(' '),
);

/** An HTML page as blocks: a heading (h1 to h6, the title), and each block element's text, its cells apart. */
function htmlBlocks(text) {
  const src = removeAll(text, HTML_DROP, (m) => m.replace(/[^\n]/g, ''));
  const newlines = [];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) newlines.push(i);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const out = [];
  let cur = null;
  let heading = 0;
  const open = (offset) => {
    if (cur === null)
      cur = { line: lineAt(offset), endLine: lineAt(offset), cells: [[]], links: [], heading };
    return cur;
  };
  const flush = () => {
    if (cur !== null) {
      const cells = cur.cells.map((parts) => tracked(parts)).filter((t) => t.s.trim() !== '');
      if (cells.length > 0) {
        if (cur.heading > 0) {
          const t = cells
            .map((c) => c.s)
            .join(' ')
            .replace(ENTITY, (...m) => decodeEntity(m));
          out.push({
            kind: 'heading',
            level: cur.heading,
            text: t.replace(/\s+/g, ' ').trim(),
            line: cur.line,
          });
        } else {
          const units = cells.map((c) => sentencesOf(replaceTracked(c, ENTITY, decodeEntity)));
          out.push({
            kind: 'text',
            item: null,
            line: cur.line,
            endLine: cur.endLine,
            first: '',
            links: cur.links,
            units,
          });
        }
      }
    }
    cur = null;
  };
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b([^<>]*)>|([^<]+)|</g)) {
    if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      const closing = m[1] === '/';
      if (HTML_BLOCK.has(name) || /^h[1-6]$/.test(name) || name === 'title') {
        flush();
        heading =
          !closing && (/^h[1-6]$/.test(name) || name === 'title') ? Number(name[1]) || 1 : 0;
      } else if (name === 'td' || name === 'th') {
        if (cur !== null && cur.cells[cur.cells.length - 1].length > 0) cur.cells.push([]);
      } else if (name === 'br' || name === 'wbr') {
        if (cur !== null)
          cur.cells[cur.cells.length - 1].push({ text: ' ', line: lineAt(m.index) });
      } else if (!closing && name === 'a') {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
        if (href !== null) open(m.index).links.push(href[1] ?? href[2] ?? href[3]);
      }
      continue;
    }
    const chunk = m[4] ?? m[0];
    if (chunk.trim() === '' && cur === null) continue;
    const b = open(m.index);
    let offset = m.index;
    for (const piece of chunk.split('\n')) {
      if (piece !== '') b.cells[b.cells.length - 1].push({ text: piece, line: lineAt(offset) });
      offset += piece.length + 1;
    }
    b.endLine = lineAt(m.index + chunk.length);
  }
  flush();
  return out;
}

/** GitHub's heading slug: lower-case, every character but a letter, number, mark, `_`, space or `-` dropped, each space a `-`. */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/** A heading's text as a reader sees it: links as their text, code spans and emphasis gone. */
const headingText = (text) =>
  removeAll(text, /<[^<>]*>/g)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A page's blocks, each with the slug of the heading it sits under. A `\r\n` or a lone `\r` ends a line as `\n` does. */
function blocksOf(path, text) {
  const lf = text.replace(/\r\n?/g, '\n');
  const blocks = path.endsWith('.html') ? htmlBlocks(lf) : markdownBlocks(lf);
  const seen = new Set();
  let under = { slug: '', text: '', level: 0 };
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const base = slugify(b.text);
      let slug = base;
      for (let i = 1; seen.has(slug); i++) slug = `${base}-${i}`;
      seen.add(slug);
      b.slug = slug;
      under = { slug, text: headingText(b.text), level: b.level };
    } else {
      b.under = under;
      b.sentences = b.units.flat();
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------------
// The source: claims, keys, sections.

const ANCHOR = /^<a id="([^"]*)"><\/a>/;
const KEY_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const words = (s) => s.toLowerCase().match(/[a-z0-9][a-z0-9'_.-]*[a-z0-9]|[a-z0-9]/g) ?? [];
function grams(s) {
  const w = words(s);
  const out = [];
  for (let i = 0; i + 4 <= w.length; i++) out.push(w.slice(i, i + 4).join(' '));
  return out;
}

/**
 * correctness.md's claims, keyed, with their text and 4-grams, its sections, and every R1 problem. A claim runs from its
 * anchor to the next anchor or heading. Its `raw` is its source lines, fenced code and link targets included, with
 * whitespace collapsed: what `--changed` compares, so an edit there is a change too.
 */
function readSource(text) {
  const blocks = blocksOf(SOURCE, text);
  const lines = text.split(LINE_BREAK);
  const problems = [];
  const claims = new Map();
  const headings = new Set();
  const sections = [];
  const bounds = [];
  let cur = null;
  let section = null;
  const fail = (line, message) => problems.push({ rule: 'R1', file: SOURCE, line, message });
  for (const b of blocks) {
    if (b.kind === 'heading') {
      headings.add(b.slug);
      bounds.push(b.line);
      if (b.level >= 2) {
        sections.push({ slug: b.slug, text: headingText(b.text), level: b.level, line: b.line });
        section = { text: headingText(b.text), reported: false };
      } else section = null;
      cur = null;
      continue;
    }
    const anchor = ANCHOR.exec(b.first);
    const opensBold = b.item !== 'ordered' && /^(?:<a id="[^"]*"><\/a>)?\*\*/.test(b.first);
    const stray = (
      b.first.slice(anchor === null ? 0 : anchor[0].length).match(/<a\s+(?:id|name)=/g) ?? []
    ).length;
    if (stray > 0)
      fail(b.line, 'an anchor that does not open its block: put it at the start of the block');
    if (anchor !== null) {
      const key = anchor[1];
      if (!KEY_SHAPE.test(key))
        fail(b.line, `the key "${key}" is not lower-case words joined by hyphens`);
      if (claims.has(key)) fail(b.line, `two anchors share the key "${key}"`);
      cur = { key, line: b.line, under: b.under, blocks: [] };
      claims.set(key, cur);
      bounds.push(b.line);
    } else if (opensBold) {
      fail(
        b.line,
        `a claim with no key: "${b.sentences[0]?.text.slice(0, 80) ?? ''}" opens with a bold claim and no anchor. ` +
          'Start it with `<a id="<key>"></a>`, a key no other claim has.',
      );
    } else if (cur === null && section !== null && !section.reported) {
      section.reported = true;
      fail(
        b.line,
        `the text under "${section.text}" before its first anchor is a claim with no key. Start it with ` +
          '`<a id="<key>"></a>`, a key that names what it says rather than the heading.',
      );
    }
    if (cur !== null) cur.blocks.push(b);
  }
  bounds.sort((a, b) => a - b);
  for (const c of claims.values()) {
    if (headings.has(c.key)) fail(c.line, `the key "${c.key}" is a heading's slug on the page`);
    c.text = c.blocks.map((b) => b.sentences.map((s) => s.text).join(' ')).join('\n');
    c.grams = new Set(grams(c.text));
    const end = bounds.find((n) => n > c.line) ?? lines.length + 1;
    c.raw = lines
      .slice(c.line - 1, end - 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return { claims, headings, sections, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// Scope, links and ties.

/** Whether the exclusion `e` covers `path`: the path itself, a path under a directory, or one its pattern matches. */
const covers = (e, path) =>
  e.pattern !== undefined
    ? e.pattern.test(path)
    : e.path.endsWith('/')
      ? path.startsWith(e.path)
      : path === e.path;

function excludedBy(path, exclusions = EXCLUDED) {
  return exclusions.find((e) => covers(e, path));
}

/** The fragment of a link into correctness.md, '' for the page itself, or undefined for any other target. */
function sourceFragment(from, target) {
  let path;
  let frag;
  const t = target.trim();
  const self =
    /^https:\/\/github\.com\/cloudbitmaps\/cloudbitmaps\/(?:blob|tree)\/main\/(.+)$/.exec(t);
  const split = (p) => {
    const hash = p.indexOf('#');
    return hash === -1 ? [p, ''] : [p.slice(0, hash), p.slice(hash + 1)];
  };
  if (self !== null) [path, frag] = split(self[1]);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return undefined;
  else if (t.startsWith('#')) [path, frag] = [from, t.slice(1)];
  else {
    const [p, f] = split(t);
    path = posix.normalize(posix.join(posix.dirname(from), p.split('?')[0]));
    frag = f;
  }
  if (path.split('?')[0] !== SOURCE) return undefined;
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag;
  }
}

/** How a page links a claim: relative in docs/ and the root pages, absolute where it is read off this repository. */
function tieForm(path, key) {
  if (/^(?:packages|site)\//.test(path)) return `${ABSOLUTE}${SOURCE}#${key}`;
  return `${posix.relative(posix.dirname(path), SOURCE)}#${key}`;
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const starts = (s) => s.split(' ').slice(0, 8).join(' ');

// ---------------------------------------------------------------------------------------------------------------------
// The checks.

/**
 * Every check but R6's comparison with the merge base, over `files` (a Map of path to text holding correctness.md and
 * every page that might be in scope), against `baseline` (its rows).
 */
function analyse({
  files,
  baseline = [],
  exclusions = EXCLUDED,
  signatures = SIGNATURES,
  minShared = MIN_SHARED,
}) {
  const problems = [];
  const sourceText = files.get(SOURCE);
  if (sourceText === undefined) throw new Error(`${SOURCE} is not in the tree the gate was given`);
  const page = readSource(sourceText);
  problems.push(...page.problems);
  const sectionSlugs = new Set(page.sections.map((s) => s.slug));
  const scope = [...files.keys()].filter((p) => excludedBy(p, exclusions) === undefined).sort();

  for (const e of exclusions) {
    const named = [...files.keys()].some((p) => covers(e, p));
    if (!named) {
      problems.push({
        rule: 'scope',
        file: e.path ?? e.label,
        line: 0,
        message: `the exclusion of ${e.path ?? e.label} names no tracked file: remove it, or point it at the file`,
      });
    }
  }

  const compiled = signatures.map((s) => ({ ...s, alive: s.patterns.map(() => false) }));
  const matchSignatures = (text) => {
    const hit = [];
    for (const s of compiled) {
      let found = false;
      s.patterns.forEach((p, i) => {
        // Every place the pattern matches, not only the first: a negated match does not hide a later one.
        const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
        for (let m = re.exec(text); m !== null; m = re.exec(text)) {
          if (!NEGATED.test(text.slice(Math.max(0, m.index - 60), m.index))) {
            s.alive[i] = true;
            found = true;
            break;
          }
          re.lastIndex = m.index + 1;
        }
      });
      if (found) hit.push(s.claim);
    }
    return hit;
  };
  for (const c of page.claims.values()) for (const t of c.text.split('\n')) matchSignatures(t);

  const gramClaims = new Map();
  for (const c of page.claims.values()) {
    for (const g of c.grams) {
      if (!gramClaims.has(g)) gramClaims.set(g, []);
      gramClaims.get(g).push(c.key);
    }
  }
  /**
   * For each claim a sentence shares 4-grams with: how many it shares, and its longest run of them in a row, which is
   * the stretch of words most plainly copied from it.
   */
  const shared = (text) => {
    const g = grams(text);
    const count = new Map();
    const longest = new Map();
    const counted = new Set();
    let runs = new Map();
    g.forEach((gram, i) => {
      const next = new Map();
      for (const k of gramClaims.get(gram) ?? []) {
        const run = { from: runs.get(k)?.from ?? i, length: (runs.get(k)?.length ?? 0) + 1 };
        next.set(k, run);
        if (run.length > (longest.get(k)?.length ?? 0)) longest.set(k, run);
        if (!counted.has(`${k}\0${gram}`)) {
          counted.add(`${k}\0${gram}`);
          count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
      runs = next;
    });
    const quote = (k) => {
      const run = longest.get(k);
      return words(text)
        .slice(run.from, run.from + run.length + 3)
        .join(' ');
    };
    return { count, longest, quote };
  };

  const rows = new Map();
  for (const r of baseline) {
    const id = `${r.file}\0${r.claim}\0${r.sentence}`;
    if (rows.has(id)) {
      problems.push({
        rule: 'R6',
        file: BASELINE,
        line: 0,
        message: `a row twice: ${r.file}, ${r.claim}, "${r.starts}"`,
      });
    }
    rows.set(id, { row: r, used: false });
  }

  const hits = [];
  const regions = [];
  const blocks = [];
  for (const path of scope) {
    const pageBlocks = blocksOf(path, files.get(path));
    const isGuide = path.startsWith('docs/guide/') && path.endsWith('.md');
    let region = null;
    for (const b of pageBlocks) {
      if (b.kind === 'heading') {
        region = null;
        const text = headingText(b.text);
        if (isGuide && (text === SUMMARY_HEADING || page.sections.some((s) => s.text === text))) {
          region = { file: path, line: b.line, heading: text, blocks: [] };
          regions.push(region);
        }
        continue;
      }
      b.file = path;
      b.ties = new Set();
      b.sections = new Set();
      for (const target of b.links) {
        const frag = sourceFragment(path, target);
        if (frag === undefined) continue;
        if (sectionSlugs.has(frag)) b.sections.add(frag);
        if (page.claims.has(frag)) b.ties.add(frag);
        else if (frag !== '' && !page.headings.has(frag)) {
          problems.push({
            rule: 'R2',
            file: path,
            line: b.line,
            message: `a link into correctness.md names neither a claim nor a heading: "${target}"`,
          });
        }
      }
      if (region !== null) {
        b.region = region;
        region.blocks.push(b);
      }
      blocks.push(b);
      for (const s of b.sentences) {
        const found = matchSignatures(s.text).map((claim) => ({ rule: 'R3', claim }));
        const { count, longest, quote } = shared(s.text);
        let top = 0;
        for (const n of count.values()) top = Math.max(top, n);
        if (top >= minShared) {
          const best = [...count].filter(([, n]) => n === top).map(([k]) => k);
          const claim = best.sort()[0];
          // The claim the longest run of copied words comes from, among those sharing enough. It is often the claim
          // sharing the most; where it is a neighbour, the message names both, and a tie to either passes.
          const source = [...count]
            .filter(([, n]) => n >= minShared)
            .map(([k]) => k)
            .sort(
              (x, y) =>
                longest.get(y).length - longest.get(x).length ||
                count.get(y) - count.get(x) ||
                (x < y ? -1 : 1),
            )[0];
          const tied = b.ties.has(source) || best.some((k) => b.ties.has(k));
          if (!tied) {
            const run = longest.get(source).length > longest.get(claim).length ? source : claim;
            found.push({ rule: 'R3b', claim, shared: top, run: quote(run), runClaim: run });
          }
        }
        for (const f of found) {
          if (f.rule === 'R3' && b.ties.has(f.claim)) continue;
          const id = `${path}\0${f.claim}\0${sha(s.text)}`;
          const hit = {
            ...f,
            file: path,
            line: s.line,
            sentence: s.text,
            hash: sha(s.text),
            region: b.region,
          };
          const excuse = b.region === undefined ? rows.get(id) : undefined;
          if (excuse !== undefined) {
            excuse.used = true;
            hit.excused = true;
          }
          hits.push(hit);
        }
      }
    }
  }

  for (const h of hits) {
    if (h.excused) continue;
    const how =
      h.rule === 'R3'
        ? `matches the signature of \`${h.claim}\``
        : `shares ${h.shared} word 4-grams with \`${h.claim}\`, ` +
          (h.runClaim === h.claim
            ? `copying "${h.run}"`
            : `but its longest copied run, "${h.run}", is from \`${h.runClaim}\` (a tie to either passes)`);
    problems.push({
      rule: h.rule,
      file: h.file,
      line: h.line,
      claim: h.claim,
      message:
        `"${h.sentence.length > 160 ? `${h.sentence.slice(0, 157)}...` : h.sentence}" ${how}, and its block ` +
        `does not tie it. If that claim states what the sentence says, link it from this block: ` +
        `[...](${tieForm(h.file, h.claim)}); if it does not, reword the sentence.` +
        (h.region === undefined ? '' : ' A summary region is never excused by the baseline.'),
    });
  }

  for (const r of regions) {
    for (const b of r.blocks) {
      if (b.ties.size === 0) {
        problems.push({
          rule: 'R4',
          file: r.file,
          line: b.line,
          message: `a block under the summary heading "${r.heading}" ties no claim: link each claim it restates`,
        });
      }
    }
    const named = new Set(r.blocks.flatMap((b) => [...b.sections]));
    r.section = named.size === 1 ? [...named][0] : undefined;
    if (named.size !== 1) {
      problems.push({
        rule: 'R4',
        file: r.file,
        line: r.line,
        message:
          named.size === 0
            ? `the summary "${r.heading}" names no section of correctness.md: link its section's heading once`
            : `the summary "${r.heading}" names ${named.size} sections of correctness.md (${[...named].join(', ')}): one region summarises one section`,
      });
    }
    const own = page.sections.find((s) => s.text === r.heading);
    if (own !== undefined && r.section !== undefined && r.section !== own.slug) {
      problems.push({
        rule: 'R4',
        file: r.file,
        line: r.line,
        message: `the summary "${r.heading}" names the section ${r.section}, not its own`,
      });
    }
  }
  for (const s of page.sections) {
    const of = regions.filter((r) => r.section === s.slug);
    if (of.length !== 1) {
      problems.push({
        rule: 'R4',
        file: SOURCE,
        line: s.line,
        message:
          of.length === 0
            ? `the section "${s.text}" has no summary region: a guide keeps one under a "${SUMMARY_HEADING}" heading, or under the section's own heading`
            : `the section "${s.text}" has ${of.length} summary regions (${of.map((r) => `${r.file}:${r.line}`).join(', ')}): keep one`,
      });
    }
  }

  const stale = [];
  for (const { row, used } of rows.values()) {
    if (!used) {
      stale.push(row);
      problems.push({
        rule: 'R6',
        file: BASELINE,
        line: 0,
        message: `the row for ${row.file}, ${row.claim}, "${row.starts}" excuses nothing: run \`pnpm docs:ties --update\``,
      });
    }
  }

  for (const s of compiled) {
    if (!page.claims.has(s.claim)) {
      problems.push({
        rule: 'R7',
        file: 'scripts/summary-ties.cjs',
        line: 0,
        message: `a signature names no claim: "${s.claim}"`,
      });
    }
    s.patterns.forEach((p, i) => {
      if (!s.alive[i]) {
        problems.push({
          rule: 'R7',
          file: 'scripts/summary-ties.cjs',
          line: 0,
          message: `the signature ${p} of \`${s.claim}\` matches nothing in the scope or in correctness.md: remove it, or reword it to the claim's own wording`,
        });
      }
    });
  }

  return { page, scope, blocks, regions, hits, stale, problems, notes: [] };
}

/** Rows `head` has that `base` does not: a restatement excused by hand rather than tied. */
function baselineGrowth(head, base) {
  if (base === undefined) return [];
  const had = new Set(base.map((r) => `${r.file}\0${r.claim}\0${r.sentence}`));
  return head
    .filter((r) => !had.has(`${r.file}\0${r.claim}\0${r.sentence}`))
    .map((r) => ({
      rule: 'R6',
      file: BASELINE,
      line: 0,
      message:
        `the row for ${r.file}, ${r.claim}, "${r.starts}" is not in the baseline at the merge base: the baseline only ` +
        'shrinks, so tie the sentence instead',
    }));
}

/**
 * The pairs the docs-fidelity review reads, between `base` and `head`: each claim whose source changed (its text, a link
 * target in it, its fenced code) with the blocks that tie it and the restatements of it the baseline excuses, and each
 * tied block that is new, changed, or tied to other claims than before, with the claims it ties.
 */
function changedPairs(base, head, baseline = [], gate = {}) {
  const was = analyse({ ...gate, files: base, baseline: [] });
  const now = analyse({ ...gate, files: head, baseline });
  const claims = [];
  for (const [key, c] of now.page.claims) {
    const before = was.page.claims.get(key);
    if (before !== undefined && before.raw === c.raw) continue;
    claims.push({
      key,
      line: c.line,
      text: c.text,
      added: before === undefined,
      tiedBy: now.blocks.filter((b) => b.ties.has(key)),
      untied: now.hits.filter((h) => h.excused && h.claim === key),
    });
  }
  for (const [key, c] of was.page.claims) {
    if (!now.page.claims.has(key))
      claims.push({ key, line: c.line, text: c.text, removed: true, tiedBy: [], untied: [] });
  }
  const textOf = (b) => b.sentences.map((s) => s.text).join(' ');
  const blockKey = (b) => `${b.file}\0${textOf(b)}\0${[...b.ties].sort().join(' ')}`;
  const baseBlocks = new Set(was.blocks.map(blockKey));
  const summaries = now.blocks
    .filter((b) => b.ties.size > 0 && !baseBlocks.has(blockKey(b)))
    .map((b) => ({
      file: b.file,
      line: b.line,
      text: textOf(b),
      claims: [...b.ties].map((k) => now.page.claims.get(k)),
    }));
  return { claims, summaries };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tree on disk and in git.

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** The tracked pages the gate can read, a symlink's own file aside, and correctness.md. */
function trackedPages(root = ROOT) {
  return git(root, 'ls-files', '-s', '-z', '--', '*.md', 'site/*.html', 'site/*.txt')
    .split('\0')
    .filter(Boolean)
    .map((line) => /^(\d+) \S+ \d+\t(.+)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ mode: m[1], path: m[2] }));
}

/** Every tracked page, read from disk, as `analyse` takes it. A symlink is read as the link it is. */
function readTree(root = ROOT) {
  const files = new Map();
  for (const { path } of trackedPages(root)) {
    const abs = join(root, path);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    files.set(path, stat.isSymbolicLink() ? '' : readFileSync(abs, 'utf8'));
  }
  return files;
}

/** A reason the gate cannot run, which the command line prints as it is. */
class GateError extends Error {}

/** The baseline's rows in `json`, read from `where`, or a thrown error when it holds no list of them. */
function rowsOf(json, where) {
  if (!Array.isArray(json?.untied)) throw new GateError(`${where} holds no "untied" list of rows`);
  return json.untied;
}

function readBaseline(root = ROOT) {
  return rowsOf(JSON.parse(readFileSync(join(root, BASELINE), 'utf8')), BASELINE);
}

const FETCH =
  'fetch the history and the base branch (`git fetch --unshallow origin main`, or check out with `fetch-depth: 0`)';

/** The merge base of the head with `against`, or a thrown error naming the command that makes one findable. */
function mergeBase(root = ROOT, against = BASE) {
  if (git(root, 'rev-parse', '--is-shallow-repository').trim() !== 'false') {
    throw new GateError(`a shallow checkout: ${FETCH}`);
  }
  try {
    git(root, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${against}^{commit}`);
  } catch {
    throw new GateError(`no ${against} to compare with: ${FETCH}`);
  }
  try {
    return git(root, 'merge-base', '--end-of-options', 'HEAD', against).trim();
  } catch {
    throw new GateError(`the head and ${against} share no history: ${FETCH}`);
  }
}

/**
 * The baseline's rows at `sha`, or undefined where that commit has no baseline file (the change that adds the gate).
 * Any other failure to read it is thrown: a gate that cannot read the base must not compare with nothing.
 */
function baselineAt(root, sha) {
  let listed;
  try {
    listed = git(root, 'ls-tree', '-z', '--end-of-options', sha, '--', BASELINE);
  } catch (err) {
    throw new GateError(
      `cannot read the tree of ${sha}: ${String(err.stderr ?? err.message).trim()}`,
    );
  }
  if (listed === '') return undefined;
  let text;
  try {
    text = git(root, 'show', `${sha}:${BASELINE}`);
  } catch (err) {
    throw new GateError(
      `cannot read ${BASELINE} at ${sha}: ${String(err.stderr ?? err.message).trim()}`,
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GateError(`${BASELINE} at ${sha} is not JSON: ${err.message}`);
  }
  return rowsOf(json, `${BASELINE} at ${sha}`);
}

/** Every page at `sha` that the head tracks, as `analyse` takes it. */
function treeAt(root, sha, paths) {
  const files = new Map();
  const at = new Set(
    git(root, 'ls-tree', '-r', '-z', '--name-only', '--end-of-options', sha)
      .split('\0')
      .filter(Boolean),
  );
  for (const path of paths) if (at.has(path)) files.set(path, git(root, 'show', `${sha}:${path}`));
  return files;
}

/**
 * The whole gate over the checked-out tree at `root`: every problem, R6's comparison with the merge base included.
 * `gate` passes `analyse` its other options (a test's own signatures or exclusions).
 */
function check(root = ROOT, gate = {}) {
  const files = readTree(root);
  const baseline = readBaseline(root);
  const result = analyse({ ...gate, files, baseline });
  const sha = mergeBase(root);
  const base = baselineAt(root, sha);
  if (base === undefined) {
    result.notes.push(
      `the merge base ${sha.slice(0, 12)} has no ${BASELINE}, so there are no rows to compare: ` +
        'R6 cannot refuse a row this branch adds until the baseline is on origin/main',
    );
  } else result.problems.push(...baselineGrowth(baseline, base));
  return result;
}

function report(problems) {
  return problems
    .map((p) => `${p.rule}  ${p.file}${p.line > 0 ? `:${p.line}` : ''}  ${p.message}`)
    .join('\n');
}

/** The problems, or the line that says there are none, and the exit code for them. */
function verdict(result, io) {
  for (const n of result.notes) io.log(`note: ${n}`);
  if (result.problems.length > 0) {
    io.error(report(result.problems));
    io.error(`\n${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}`);
    return 1;
  }
  io.log('every restatement found ties the claim it restates');
  return 0;
}

function changedReport(sha, { claims, summaries }) {
  const out = [];
  out.push(
    `Against the merge base ${sha.slice(0, 12)}. Read each summary against each claim beside it.`,
  );
  out.push('', `Claims changed (${claims.length}):`);
  for (const c of claims) {
    const state = c.removed ? ' (removed)' : c.added ? ' (new)' : '';
    out.push('', `## ${c.key}${state}  ${SOURCE}:${c.line}`, c.text.replace(/\n/g, '\n\n'));
    if (c.tiedBy.length === 0 && !c.removed) out.push('', '  tied by no block');
    for (const b of c.tiedBy)
      out.push(
        '',
        `  tied by ${b.file}:${b.line}`,
        `  ${b.sentences.map((s) => s.text).join(' ')}`,
      );
    if (c.untied.length > 0) {
      out.push(
        '',
        `  restated untied, excused by the baseline, not checked against it (${c.untied.length}):`,
      );
      for (const h of c.untied) out.push(`  - ${h.file}:${h.line}  ${h.sentence}`);
    }
  }
  out.push('', `Tied blocks changed, new or re-pointed (${summaries.length}):`);
  for (const s of summaries) {
    out.push('', `## ${s.file}:${s.line}`, s.text);
    for (const c of s.claims)
      out.push('', `  ties ${c.key} (${SOURCE}:${c.line})`, `  ${c.text.replace(/\n/g, ' ')}`);
  }
  return out.join('\n');
}

function run(argv, { root, gate, io }) {
  if (argv.includes('--update')) {
    const baseline = readBaseline(root);
    const { stale } = analyse({ ...gate, files: readTree(root), baseline });
    const kept = baseline.filter((r) => !stale.includes(r));
    const path = join(root, BASELINE);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    json.untied = kept;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    for (const r of stale) io.log(`dropped: ${r.file}, ${r.claim}, "${r.starts}"`);
    io.log(`${stale.length} rows dropped, ${kept.length} kept`);
    const after = check(root, gate);
    if (after.problems.length > 0) {
      io.error(report(after.problems));
      io.error(
        `\nthe gate still fails: ${after.problems.length} problem${after.problems.length === 1 ? '' : 's'}`,
      );
      return 1;
    }
    return 0;
  }
  if (argv.includes('--changed')) {
    const at = argv.indexOf('--against');
    const against = at === -1 ? BASE : argv[at + 1];
    if (against === undefined || against.startsWith('-'))
      throw new GateError('--against needs the ref to compare with, such as origin/feature/x');
    const sha = mergeBase(root, against);
    const head = readTree(root);
    const base = treeAt(root, sha, [...head.keys()]);
    io.log(changedReport(sha, changedPairs(base, head, readBaseline(root), gate)));
    return 0;
  }
  return verdict(check(root, gate), io);
}

/**
 * The command line: `argv` as the header's usage says, over the tree at `root`. A reason the gate cannot run is printed
 * as a message, exit 2; any other throw is a bug and keeps its stack.
 */
function main(argv, { root = ROOT, gate = {}, io = console } = {}) {
  try {
    return run(argv, { root, gate, io });
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    io.error(`summary-ties: ${err.message}`);
    return 2;
  }
}

module.exports = {
  ABSOLUTE,
  BASELINE,
  EXCLUDED,
  GateError,
  MIN_SHARED,
  SIGNATURES,
  SOURCE,
  SUMMARY_HEADING,
  analyse,
  baselineAt,
  baselineGrowth,
  blocksOf,
  changedPairs,
  check,
  excludedBy,
  grams,
  main,
  mergeBase,
  readBaseline,
  readSource,
  readTree,
  report,
  sha,
  sourceFragment,
  words,
  starts,
  tieForm,
  trackedPages,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
