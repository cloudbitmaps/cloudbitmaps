/*
 * The size of a reader's first (speculative tail) read, read out of the source that sets it rather than restated: a
 * constant copied into a second file is a constant that can disagree with the first. Used by the at-scale bench's
 * rendered sentence and by the /demo replay check, which both count that read, because the byte counter leaves it out.
 * The source is parsed as text (core's internals are not imported); a missing or non-positive constant fails loudly.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FORMAT_SOURCE = path.join('packages', 'core', 'src', 'core', 'crbm', 'format.ts');

/** The value of `DEFAULT_TAIL_BYTES` declared in `<root>/packages/core/src/core/crbm/format.ts` (a product of integers). */
function readTailBytes(root) {
  const file = path.join(root, FORMAT_SOURCE);
  const src = fs.readFileSync(file, 'utf8');
  const found = /export const DEFAULT_TAIL_BYTES\s*=\s*(\d+(?:\s*\*\s*\d+)*)\s*;/.exec(src);
  if (!found) {
    throw new Error(
      `DEFAULT_TAIL_BYTES is not declared in ${FORMAT_SOURCE} as a product of integers, where this script looks for it`,
    );
  }
  const value = found[1].split('*').reduce((product, factor) => product * Number(factor), 1);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`DEFAULT_TAIL_BYTES in ${FORMAT_SOURCE} is ${value}, not a positive integer`);
  }
  return value;
}

module.exports = { readTailBytes };
