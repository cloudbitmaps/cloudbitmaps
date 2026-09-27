import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, compositeActionFiles, jobs, workflowFiles } from '../helpers/workflows';

/**
 * Every third-party action CI uses is pinned to a full commit SHA, with a `# vX` comment naming its release, as
 * SECURITY.md promises: a tag can be moved to code nobody reviewed, and a commit cannot. A local action or workflow
 * (`./…`) is read from the commit the workflow runs at, so it has nothing to pin.
 */
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

interface UsesLine {
  uses: string;
  /** The rest of the line, after the action: where its release comment is. */
  rest: string;
}

/** Each `uses:` line of a file, read as text, since a comment does not survive parsing. */
function usesLines(text: string): UsesLine[] {
  return [...text.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*(['"]?)([^'"\s#]+)\1(.*)$/gm)].map(
    (m) => ({ uses: m[2] ?? '', rest: m[3] ?? '' }),
  );
}

/** What is wrong with one `uses:` line, if anything. */
function problem({ uses, rest }: UsesLine): string | undefined {
  if (uses.startsWith('./')) return undefined;
  if (!PINNED.test(uses)) return `is not pinned to a full commit SHA: ${uses}`;
  if (!/^[ \t]+#[ \t]*v\d/.test(rest)) return `has no \`# vX\` comment naming its release: ${uses}`;
  return undefined;
}

const FILES = [...workflowFiles(), ...compositeActionFiles()];
const text = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** Every `uses:` the runner will act on, by file: each job's own, for a reusable workflow, and each step's. */
function parsedUses(file: string): string[] {
  return jobs()
    .filter(({ where }) => where === file || where.startsWith(`${file} › `))
    .flatMap(({ job }) => [
      ...(job.uses === undefined ? [] : [job.uses]),
      ...(job.steps ?? []).flatMap((s) => (s.uses === undefined ? [] : [s.uses])),
    ]);
}

describe('every third-party action CI uses is pinned to a commit', () => {
  it('reads a pin: a full SHA with its release named, or a local path', () => {
    const sha = 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
    const cases: [string, boolean][] = [
      [`      - uses: ${sha} # v6.1.0`, true],
      [`      - uses: '${sha}' # v6.1.0`, true],
      [`    uses: ${sha} # v6`, true],
      ['      - uses: ./.github/actions/docker-images-save', true],
      ['      - uses: actions/cache@v6', false],
      ['      - uses: actions/cache@55cc834 # v6.1.0', false],
      [`      - uses: ${sha}`, false],
      [`      - uses: ${sha} # the cache`, false],
      ['      - uses: docker://alpine:3', false],
    ];
    for (const [line, ok] of cases) {
      const [found] = usesLines(line);
      expect(found, line).toBeDefined();
      expect(problem(found as UsesLine) === undefined, line).toBe(ok);
    }
  });

  it.each(FILES)('%s: the text read holds every uses: the runner acts on', (file) => {
    // The comment is read from the text, so the text must hold what parsing finds, or a pin could go unread.
    expect(
      usesLines(text(file))
        .map((l) => l.uses)
        .sort(),
    ).toEqual(parsedUses(file).sort());
  });

  it('finds third-party actions in workflows and in composite actions (an empty sweep would prove nothing)', () => {
    const thirdParty = (files: string[]) =>
      files.flatMap((f) => usesLines(text(f))).filter((l) => !l.uses.startsWith('./'));
    expect(thirdParty(workflowFiles()).length).toBeGreaterThan(0);
    expect(thirdParty(compositeActionFiles()).length).toBeGreaterThan(0);
  });

  it.each(FILES)('%s', (file) => {
    expect(
      usesLines(text(file)).flatMap((l) => {
        const p = problem(l);
        return p === undefined ? [] : [p];
      }),
    ).toEqual([]);
  });
});
