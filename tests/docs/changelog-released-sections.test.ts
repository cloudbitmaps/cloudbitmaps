import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A release's notes are what the release shipped, and a reader of an upgrade finds them here. Once a version is
 * released its section of `CHANGELOG.md` is fixed: no line is removed, edited or added in a later commit. Only
 * `[Unreleased]` changes freely, until a release cuts it into a section.
 *
 * Each released section is compared with the section as the release's own tag has it (`v<version>:CHANGELOG.md`), so
 * a later commit that drops an entry, rewrites one or tidies a section fails here, whatever else the commit does. A
 * version with no tag yet, newer than every tagged one, is the release being cut and has nothing to compare with; it is
 * held from the tag on.
 *
 * A past release that really has to be corrected is named in {@link CORRECTIONS}, with the commit that corrected it
 * and the reason. The section at that commit becomes the baseline from then on, so the correction is allowed once and
 * any later change to the section still fails.
 *
 * The comparison needs the tags and the history, so a shallow checkout, or one with no release tags, fails with the
 * command that fetches them rather than passing with nothing to compare. CI checks out with `fetch-depth: 0`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Sections before this version are not in the public history, and have no baseline here. */
const FIRST_COVERED: readonly [number, number, number] = [0, 10, 0];

interface Correction {
  /** The version whose released section the commit changed. */
  readonly version: string;
  /** The commit that changed it. The section as this commit has it is the baseline from then on. */
  readonly commit: string;
  readonly reason: string;
}

/**
 * Corrections to a released section, each one allowed once. Nothing else is: to correct a past release, add the entry
 * here in the commit that does it, with the commit's hash once it exists, or the gate fails on the edit.
 */
const CORRECTIONS: readonly Correction[] = [
  {
    version: '0.10.0',
    commit: 'e48f62884d6c75f37ec4597e95c36a844077d09d',
    reason:
      "the public history starts at 0.10.0: the cycle's development log, under the release's own heading, was cut from the section, which keeps its summary",
  },
];

const FETCH =
  'fetch the history and the release tags (`git fetch --unshallow --tags`, or check out with `fetch-depth: 0`)';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const HEADING = /^## \[(\d+\.\d+\.\d+)\]/;

const parse = (v: string): [number, number, number] => {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
  return [a, b, c];
};
const compare = (a: string, b: string): number => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The released sections of a changelog by version: each heading line to the next, trailing blanks and spaces cut. */
export function releasedSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const version = HEADING.exec(line)?.[1];
      current = version === undefined ? undefined : [];
      if (version !== undefined && current !== undefined) sections.set(version, current);
    }
    current?.push(line.replace(/\s+$/, ''));
  }
  for (const lines of sections.values()) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }
  return sections;
}

/** The lines `before` has and `after` does not (`-`), and the ones `after` has and `before` does not (`+`), in order. */
export function lineDiff(before: readonly string[], after: readonly string[]): string[] {
  const n = before.length;
  const m = after.length;
  // Longest common subsequence, from the end, so the walk below reads forward.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push(`- ${before[i++]}`);
    } else {
      out.push(`+ ${after[j++]}`);
    }
  }
  return out;
}

/**
 * Every way `current` differs from the released baselines, as messages naming the version and the lines. `baselineOf`
 * gives a version's baseline section, or `undefined` for a version with none.
 */
export function releasedDrift(
  current: string,
  baselines: ReadonlyMap<string, readonly string[]>,
): string[] {
  const now = releasedSections(current);
  const problems: string[] = [];
  for (const [version, before] of baselines) {
    const after = now.get(version);
    if (after === undefined) {
      problems.push(
        `CHANGELOG.md no longer has the section for ${version}, which was released. ` +
          `Its ${before.length} lines are fixed once released.`,
      );
      continue;
    }
    const diff = lineDiff(before, after);
    if (diff.length === 0) continue;
    const shown = diff
      .slice(0, 12)
      .map((l) => `    ${l.length > 160 ? `${l.slice(0, 157)}...` : l}`);
    const more =
      diff.length > shown.length ? [`    ... and ${diff.length - shown.length} more`] : [];
    problems.push(
      `The released section for ${version} changed (${diff.filter((l) => l.startsWith('-')).length} lines removed or edited, ` +
        `${diff.filter((l) => l.startsWith('+')).length} added). A released section is fixed: put the change under [Unreleased], ` +
        `or, to correct a past release, name the commit in CORRECTIONS in this file.\n${[...shown, ...more].join('\n')}`,
    );
  }
  return problems;
}

/** The release tags, newest last, from the first version the public history covers. */
function releaseTags(): string[] {
  return git('tag', '--list', 'v*')
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && compare(t.slice(1), FIRST_COVERED.join('.')) >= 0)
    .sort((a, b) => compare(a.slice(1), b.slice(1)));
}

/**
 * The baseline of each tagged release, or of its correcting commit when {@link CORRECTIONS} names one. A version is
 * left out when its tag does not carry the section: nothing then says what it released.
 */
function baselines(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tag of releaseTags()) {
    const version = tag.slice(1);
    const fixed = CORRECTIONS.find((c) => c.version === version);
    const source = fixed === undefined ? tag : fixed.commit;
    const section = releasedSections(git('show', `${source}:CHANGELOG.md`)).get(version);
    if (section !== undefined) out.set(version, section);
  }
  return out;
}

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- a change on its way',
  '',
  '## [2.0.0] — 2030-01-02',
  '',
  '### Added',
  '',
  '- a thing',
  '- another thing',
  '',
  '## [1.0.0] — 2030-01-01',
  '',
  '### Added',
  '',
  '- the first thing',
  '',
].join('\n');
const sampleBaselines = (): Map<string, string[]> => {
  const all = releasedSections(SAMPLE);
  all.delete('2.0.0'); // the release being cut has no tag yet, so no baseline
  return all;
};

describe('a released section of CHANGELOG.md is fixed', () => {
  it('has the history and the release tags to compare with', () => {
    expect(git('rev-parse', '--is-shallow-repository').trim(), `a shallow checkout: ${FETCH}`).toBe(
      'false',
    );
    expect(releaseTags().length, `no release tags: ${FETCH}`).toBeGreaterThan(0);
  });

  it('matches the section each release tag carries, in every line', () => {
    const base = baselines();
    expect(base.size, `the tags carry no sections to compare with: ${FETCH}`).toBeGreaterThan(0);
    expect(releasedDrift(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), base)).toEqual([]);
  });

  it('has a tag for every released section but the newest, which may be the release being cut', () => {
    const tagged = new Set(releaseTags().map((t) => t.slice(1)));
    const latestTagged = [...tagged].sort(compare).pop() ?? '0.0.0';
    const untagged = [...releasedSections(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).keys()]
      .filter((v) => compare(v, FIRST_COVERED.join('.')) >= 0 && !tagged.has(v))
      .filter((v) => compare(v, latestTagged) < 0);
    expect(untagged, 'a section older than the latest tag with no tag of its own').toEqual([]);
  });

  it('names a correction only for a version the tags carry, with a commit that has it', () => {
    const tagged = new Set(releaseTags().map((t) => t.slice(1)));
    for (const c of CORRECTIONS) {
      expect(tagged.has(c.version), `${c.version} has no tag`).toBe(true);
      expect(c.reason.length).toBeGreaterThan(20);
      expect(
        releasedSections(git('show', `${c.commit}:CHANGELOG.md`)).has(c.version),
        `${c.commit} has no section for ${c.version}`,
      ).toBe(true);
    }
  });

  describe('as a check on a copy of the file', () => {
    it('passes the unchanged file', () => {
      expect(releasedDrift(SAMPLE, sampleBaselines())).toEqual([]);
    });

    it('passes any edit to [Unreleased]', () => {
      const edited = SAMPLE.replace(
        '- a change on its way',
        '- a different change\n- and one more',
      );
      expect(edited).not.toBe(SAMPLE);
      expect(releasedDrift(edited, sampleBaselines())).toEqual([]);
    });

    it('passes a new release section cut from [Unreleased]', () => {
      const cut = SAMPLE.replace(
        '## [Unreleased]\n\n- a change on its way\n',
        '## [Unreleased]\n\n## [2.1.0] — 2030-02-01\n\n- a change on its way\n',
      );
      expect(cut).not.toBe(SAMPLE);
      expect(releasedDrift(cut, sampleBaselines())).toEqual([]);
    });

    it('fails an entry removed from a released section, and names it', () => {
      const dropped = SAMPLE.replace('- the first thing\n', '');
      const problems = releasedDrift(dropped, sampleBaselines());
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('1.0.0');
      expect(problems[0]).toContain('- - the first thing');
    });

    it('fails an entry edited in a released section, showing the old line and the new', () => {
      const edited = SAMPLE.replace('- the first thing', '- the first thing, reworded');
      const [problem] = releasedDrift(edited, sampleBaselines());
      expect(problem).toContain('- - the first thing');
      expect(problem).toContain('+ - the first thing, reworded');
    });

    it('fails a line added to a released section', () => {
      const added = SAMPLE.replace('- the first thing\n', '- the first thing\n- a late note\n');
      expect(releasedDrift(added, sampleBaselines())).toHaveLength(1);
    });

    it('fails a released section removed whole', () => {
      const gone = SAMPLE.slice(0, SAMPLE.indexOf('## [1.0.0]'));
      const [problem] = releasedDrift(gone, sampleBaselines());
      expect(problem).toContain('no longer has the section for 1.0.0');
    });

    it('does not mistake a trailing blank line or space for a change', () => {
      expect(releasedDrift(`${SAMPLE}\n\n`, sampleBaselines())).toEqual([]);
      expect(
        releasedDrift(
          SAMPLE.replace('- the first thing', '- the first thing  '),
          sampleBaselines(),
        ),
      ).toEqual([]);
    });
  });
});
