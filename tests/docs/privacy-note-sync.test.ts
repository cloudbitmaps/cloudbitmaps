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

/** The published copy with its differences of form taken out: the copy's header, and absolute links. */
function asTheRepoCopy(published: string): string {
  return published
    .replace(/\n> This is the copy published with the npm package;[^\n]*\n> [^\n]*\n\n+/, '\n')
    .replaceAll(`](${REPO}`, '](');
}

describe('the published privacy note says what the repository one says', () => {
  const repo = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
  const published = readFileSync(join(ROOT, 'packages/roaring/PRIVACY.md'), 'utf8');

  it('names itself the published copy, so the one difference of substance is stated', () => {
    expect(published).toContain('This is the copy published with the npm package');
  });

  it('matches the repository copy line for line, once its header and absolute links are set aside', () => {
    const want = repo.split('\n');
    const got = asTheRepoCopy(published).split('\n');
    const differing = want.flatMap((line, i) => (line === got[i] ? [] : [`line ${i + 1}`]));
    expect(differing, 'packages/roaring/PRIVACY.md has drifted from PRIVACY.md').toEqual([]);
    expect(got.length).toBe(want.length);
  });
});
