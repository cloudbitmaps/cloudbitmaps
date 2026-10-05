import { readFileSync } from 'node:fs';

/**
 * A leased handle must throw past its lease at every site that reads, and a new read method that forgets the check is the
 * way that stops being true. This lists every method of `Segment` that reaches the engine, a combine, or a write, and
 * fails if one does not check a lease (directly, or through the refusal the `*Into` verbs share).
 */

const SOURCE = readFileSync(
  new URL('../../packages/roaring/src/index.ts', import.meta.url),
  'utf8',
);

/** What makes a method a read or a write of segment data. */
const REACHES = [
  /this\.engine\b/,
  /\{[^}]*\bengine\b[^}]*\} = this;/,
  /this\.combineEngine\(/,
  /this\.materialize\(/,
  /this\.pinned\(/,
];
/** What counts as checking a lease. */
const CHECKS = [/assertLeases\(/, /leaseError\(/, /refuseIfExpired\(/];
/** Methods that touch no data: they name the segment, hold the check itself, or time a call. */
const EXEMPT = new Set([
  'constructor',
  'key',
  'timed',
  'guarded',
  'release',
  'refsIn',
  'liveExcludes',
  'expired',
]);

/** `[name, body]` for each method of the class `Segment`, found by its two-space indent. */
function methodsOf(source: string): Array<[string, string]> {
  const start = source.indexOf('export class Segment {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end).split('\n');
  const starts: Array<{ name: string; at: number }> = [];
  body.forEach((line, i) => {
    const m =
      /^ {2}(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/.exec(
        line,
      );
    if (m !== null && !['if', 'for', 'while', 'switch', 'return'].includes(m[1] as string)) {
      starts.push({ name: m[1] as string, at: i });
    }
  });
  return starts.map((s, i) => [
    s.name,
    body.slice(s.at, starts[i + 1]?.at ?? body.length).join('\n'),
  ]);
}

/** Methods that reach data and do not check a lease. */
function unchecked(source: string): string[] {
  return methodsOf(source)
    .filter(([name, text]) => !EXEMPT.has(name) && REACHES.some((r) => r.test(text)))
    .filter(([, text]) => !CHECKS.some((c) => c.test(text)))
    .map(([name]) => name);
}

describe('every Segment method that reads checks a lease', () => {
  it('finds the read sites, and every one of them checks', () => {
    const reads = methodsOf(SOURCE)
      .filter(([name, text]) => !EXEMPT.has(name) && REACHES.some((r) => r.test(text)))
      .map(([name]) => name);
    expect(reads).toEqual(
      expect.arrayContaining([
        'has',
        'count',
        'stat',
        'iterate',
        'intersectAs',
        'unionAs',
        'andNotAs',
        'intersectInto',
        'unionInto',
        'andNotInto',
        'costReport',
        'everyNth',
        'pinAt',
      ]),
    );
    expect(unchecked(SOURCE)).toEqual([]);
  });

  it('fails when a read method does not check, and not for a method that reads nothing', () => {
    // A read site with its check removed.
    const mutated = SOURCE.replace(
      /(has\(id: number\): Promise<boolean> \{\n)[\s\S]*?(\n {4}if \(this\.expired\(\)\) return Promise\.resolve\(false\);)/,
      '$1$2',
    );
    expect(mutated).not.toBe(SOURCE);
    expect(unchecked(mutated)).toEqual(['has']);
    // A new method that reads and never checks.
    const added = SOURCE.replace(
      '  key(): string {',
      '  sneaky(): Promise<number> {\n    return this.engine.count(this.ref);\n  }\n\n  key(): string {',
    );
    expect(unchecked(added)).toEqual(['sneaky']);
    // A new route to the object that skips the check: the way `pinAt` reaches it.
    const pinned = SOURCE.replace(
      '  key(): string {',
      '  sneakyPin(): Promise<Segment> {\n    return this.pinned(this.ref, this.expiresAt);\n  }\n\n  key(): string {',
    );
    expect(unchecked(pinned)).toEqual(['sneakyPin']);
    // `key` reads no data, and is not flagged.
    expect(unchecked(SOURCE)).not.toContain('key');
  });
});
