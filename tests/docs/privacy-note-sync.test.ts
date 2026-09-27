import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The privacy note npm publishes says what the repository's says.
 *
 * WHY THIS EXISTS. `packages/roaring/PRIVACY.md` ships in the package, and its header promises it is "kept identical
 * in substance" to the root `PRIVACY.md`. The two drifted twice: a change to the root copy's table of how soon other
 * stores see an erasure reached the root alone, so the page an installer reads kept the old bounds. It differs only
 * where a published file must: the header saying which copy it is, and links written absolute, since a relative link
 * on npm points nowhere.
 */
const ROOT = join(__dirname, '..', '..');
const REPO = 'https://github.com/cloudbitmaps/cloudbitmaps/blob/main/';

/** The published copy's header, which the repository copy does not have, exactly as it is written. */
const HEADER =
  '\n> This is the copy published with the npm package; it is kept identical in substance to\n' +
  `> [\`PRIVACY.md\`](${REPO}PRIVACY.md) in the repository.\n\n\n`;

/** The published copy with its differences of form taken out: the copy's header, and absolute links. */
function asTheRepoCopy(published: string): string {
  return published.replace(HEADER, '\n').replaceAll(`](${REPO}`, '](');
}

/** Each link target a page holds, inline or as a reference definition. */
function linkTargets(page: string): string[] {
  return [
    ...[...page.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1] ?? ''),
    ...[...page.matchAll(/^[ \t]*\[[^\]\n]+\]:[ \t]*<?(\S+?)>?(?:[ \t]|$)/gm)].map(
      (m) => m[1] ?? '',
    ),
  ];
}

/** A link that still leads somewhere from npm: to the web, or to a heading on the same page. */
const reachableFromNpm = (target: string) => /^(?:https:\/\/|#)/.test(target);

describe('the published privacy note says what the repository one says', () => {
  const repo = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
  const published = readFileSync(join(ROOT, 'packages/roaring/PRIVACY.md'), 'utf8');

  it('names itself the published copy, so the one difference of substance is stated', () => {
    expect(published.split(HEADER).length - 1, 'the header, word for word, once').toBe(1);
    expect(published.startsWith(`# ${repo.split('\n')[0]?.slice(2)}\n${HEADER}`)).toBe(true);
  });

  it('links only where a reader on npm can follow: to the web, or within the page', () => {
    // A relative link reads the same in both copies, so the line-for-line check below cannot see it; on npm it
    // points nowhere.
    expect(linkTargets(published).length).toBeGreaterThan(0);
    expect(linkTargets(published).filter((t) => !reachableFromNpm(t))).toEqual([]);
  });

  it('reads a link as npm would: relative targets are refused, absolute ones and anchors are not', () => {
    const page = [
      'See [the guide](docs/guide/getting-started.md) and [the ADR](../docs/adr.md).',
      'Also [the repo](https://github.com/cloudbitmaps/cloudbitmaps) and [a heading](#retention).',
      '[ref]: ./SECURITY.md',
      '[web]: https://example.com/page',
      'An angle-bracketed [one](<docs/a b.md>).',
    ].join('\n');
    expect(linkTargets(page).filter((t) => !reachableFromNpm(t))).toEqual([
      'docs/guide/getting-started.md',
      '../docs/adr.md',
      'docs/a',
      './SECURITY.md',
    ]);
  });

  it('matches the repository copy line for line, once its header and absolute links are set aside', () => {
    const want = repo.split('\n');
    const got = asTheRepoCopy(published).split('\n');
    const differing = want.flatMap((line, i) => (line === got[i] ? [] : [`line ${i + 1}`]));
    expect(differing, 'packages/roaring/PRIVACY.md has drifted from PRIVACY.md').toEqual([]);
    expect(got.length).toBe(want.length);
  });
});
