import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';

/**
 * The runnable example on `docs/guide/roaring-codec.md` runs, and prints what its comments say it prints.
 *
 * The page's one `js` fence is taken out of the file, its import line is replaced by the names this test injects (the
 * source of the package the page tells a reader to install), and its body is run. What it logs is compared with the
 * value in the comment beside each `console.log`, so a change to the example's output or to what the page says it
 * prints fails here. A page whose fence is missing or changed beyond reading fails too, so the scan cannot pass by
 * matching nothing.
 */
const PAGE = join(__dirname, '..', '..', 'docs', 'guide', 'roaring-codec.md');

function exampleSource(markdown: string): string {
  const fences = [...markdown.matchAll(/```js\n([\s\S]*?)```/g)];
  expect(fences).toHaveLength(1);
  return fences[0]![1]!;
}

/** Runs the example with `RoaringBitmap` injected and returns each logged line as its arguments joined. */
async function run(source: string): Promise<string[]> {
  const body = source.replace(/^import \{ RoaringBitmap \} from '@cloudbitmaps\/roaring';\n/m, '');
  expect(body).not.toBe(source);
  const logged: string[] = [];
  const log = (...args: unknown[]): void => {
    logged.push(args.map((a) => (Array.isArray(a) ? `[ ${a.join(', ')} ]` : String(a))).join(' '));
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<void>;
  await new AsyncFunction('RoaringBitmap', 'console', body)(RoaringBitmap, { log });
  return logged;
}

describe('the codec page example', () => {
  const source = exampleSource(readFileSync(PAGE, 'utf8'));

  it('prints what its comments say', async () => {
    const expected = [...source.matchAll(/console\.log\([^\n]*\); \/\/ ([^\n]+)/g)].map(
      (m) => m[1]!,
    );
    expect(expected).toHaveLength(10);
    expect(await run(source)).toEqual(expected);
  });

  it('fails when its output differs from a comment (the check fires)', async () => {
    const changed = source.replace('// 2\n', '// 3\n');
    expect(changed).not.toBe(source);
    const expected = [...changed.matchAll(/console\.log\([^\n]*\); \/\/ ([^\n]+)/g)].map(
      (m) => m[1]!,
    );
    expect(await run(changed)).not.toEqual(expected);
  });

  it('refuses a truncated copy of the bytes, as the page says (a ValidationError)', () => {
    expect(() =>
      RoaringBitmap.deserialize(Uint8Array.from([0x3a, 0x30, 0x00, 0x00, 0x01])),
    ).toThrow(ValidationError);
  });
});
