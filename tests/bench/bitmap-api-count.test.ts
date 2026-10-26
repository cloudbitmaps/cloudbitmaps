import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The count kernels' decision as the bitmap bench reads it (`bench/lib/bitmap-api-count.cjs`): the last line of the
 * count bench's gate, `RESULT kept`, `RESULT derived` or `RESULT invalid`, and nothing else counts as one.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const count = require_('./lib/bitmap-api-count.cjs') as { parseResult: (output: string) => string };

describe('the decision read from the count bench', () => {
  it('is the status of the last line', () => {
    expect(count.parseResult('judged  dense andCardinality: x\nRESULT kept: all groups\n')).toBe(
      'kept',
    );
    expect(count.parseResult('recorded a\nRESULT derived: not on spread8k (slower)')).toBe(
      'derived',
    );
    expect(count.parseResult('RESULT invalid: 3 problem(s); the record decides nothing\n')).toBe(
      'invalid',
    );
  });

  it('is unavailable for output with no RESULT line last: an older gate, an empty run, a line that is not last', () => {
    expect(count.parseResult('keep andCardinality: faster than building on every group\n')).toBe(
      'unavailable',
    );
    expect(count.parseResult('')).toBe('unavailable');
    expect(count.parseResult('RESULT kept: x\nnote: afterwards')).toBe('unavailable');
    expect(count.parseResult('RESULT kept')).toBe('kept');
  });

  it('does not take a look-alike for a decision', () => {
    for (const text of [
      'RESULTS kept',
      'result kept',
      'RESULT maybe',
      'a RESULT kept',
      'RESULT keptish',
    ]) {
      expect(count.parseResult(text), text).toBe('unavailable');
    }
  });
});
