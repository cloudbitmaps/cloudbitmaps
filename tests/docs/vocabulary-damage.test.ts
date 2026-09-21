import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Phrases that only a careless find-and-replace produces.
 *
 * WHY THIS EXISTS. The tier was renamed twice in this release — `cold` → `storage`, then `HOT` → `cache` —
 * and both passes were mechanical over ~160 files. A substitution has no idea that `cold storage` is a phrase,
 * that `storage.objects.get` is a **GCP permission name**, or that "plain objects" is about JavaScript rather
 * than about our tier. It produced, and shipped:
 *
 *   - `storage.storage.get` in the GCS registry's deployment requirements — an IAM permission that does not
 *     exist, in an instruction a reader copies into a policy.
 *   - "storage storage", "plain storage", "immutable storage", "Storage storage".
 *
 * They pass every gate: they compile, they lint, they render, and they are in prose nothing re-reads. This is
 * the second drift on this surface, which is what earns a check rather than another careful sweep.
 *
 * WHY A PHRASE LIST RATHER THAN A RULE. There is no rule — these are not wrong words, they are right words in
 * an impossible order. The list is the inventory, and it is cheap to extend the next time a rename lands.
 */

const ROOT = join(__dirname, '..', '..');

/** Everything a reader or a tool could see. `dist/` is build output; the CHANGELOG keeps its history. */
const files = execFileSync(
  'git',
  ['ls-files', '*.ts', '*.md', '*.html', '*.txt', '*.css', '*.yml'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== 'CHANGELOG.md' && !f.startsWith('tests/docs/vocabulary-damage'));

/** Each entry: the damaged phrase, and what it was meant to say. */
/**
 * Each entry: the damaged phrase, and what it was meant to say.
 *
 * `immutable`/`superseded storage` are listed only in **head-noun position** — followed by punctuation or the
 * end of the line. "the immutable Storage tier" and "superseded Storage generations" are this project's own
 * vocabulary and appear throughout; "deletes superseded storage." is the mass noun standing where a plural
 * count noun belongs. Widening these two to every occurrence flagged six correct sentences and no damage,
 * which is the gate that gets routed around rather than obeyed.
 */
/*
 * Every multi-word pattern joins on `\s+`, NOT a literal space.
 *
 * These files hard-wrap at about 110 characters, so a damaged phrase lands across a line break as often as
 * not — and a literal space cannot match a newline. Three shipped sentences proved it: `README.md` and
 * `docs/ROADMAP.md` each carried a wrapped "cache\ncache" while this gate ran green over both, which is the
 * exact failure the file's header says it exists to prevent. A pattern that only matches the unwrapped
 * spelling checks whichever half of the prose happens to be short.
 */
const DAMAGE: ReadonlyArray<readonly [RegExp, string]> = [
  [/storage\.storage\./g, '`storage.objects.*` — a real GCP permission name'],
  [/\bplain\s+storage\b/gi, '"plain objects" (JavaScript objects, not our tier)'],
  [/\bstorage\s+storage\b/gi, '"storage" once'],
  [/\bcache\s+cache\b/gi, '"cache" once'],
  [/\bstorage\s+exist\b/gi, '"objects exist"'],
  [/\bimmutable\s+storage\s*(?=[.,;:)]|$)/gim, '"immutable objects"'],
  [/\bsuperseded\s+storage\s*(?=[.,;:)]|$)/gim, '"superseded objects"'],
];

describe('the tier renames left no impossible phrasing', () => {
  it.each(files)('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const hits: string[] = [];
    for (const [pattern, meant] of DAMAGE) {
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${file}:${line} — "${m[0]}" should be ${meant}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
