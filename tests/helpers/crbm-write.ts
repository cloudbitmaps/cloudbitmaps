import {
  writeCrbmGeneration as write,
  writeCrbmGenerationStream as writeStream,
  writeEncodedChunks as writeEncoded,
} from '@/core/crbm-write';
import type { WriteOptions } from '@/core/crbm-write';
import { counterEntropy } from './entropy';

/**
 * The writers of `@/core/crbm-write` with a deterministic entropy filled in when a test names none, for the many tests
 * that write an object to read it back and care nothing about its identity. One counter source is shared by every
 * write a test file makes through this module, so two writes of the same ids at the same number draw different
 * identities and are two objects, as in production; a run replays the same draws, since the counter starts alike in each
 * file. A test of the identity passes its own source.
 */
type Given = Omit<WriteOptions, 'entropy'> & { readonly entropy?: WriteOptions['entropy'] };
const shared = counterEntropy();
const filled = (options: Given | undefined): WriteOptions => ({
  ...options,
  entropy: options?.entropy ?? shared,
});

export const writeCrbmGeneration = (
  ...[driver, key, chunks, options]: [
    Parameters<typeof write>[0],
    Parameters<typeof write>[1],
    Parameters<typeof write>[2],
    Given?,
  ]
): ReturnType<typeof write> => write(driver, key, chunks, filled(options));

export const writeEncodedChunks = (
  ...[driver, key, chunks, options]: [
    Parameters<typeof writeEncoded>[0],
    Parameters<typeof writeEncoded>[1],
    Parameters<typeof writeEncoded>[2],
    Given?,
  ]
): ReturnType<typeof writeEncoded> => writeEncoded(driver, key, chunks, filled(options));

export const writeCrbmGenerationStream = (
  ...[driver, key, chunks, options]: [
    Parameters<typeof writeStream>[0],
    Parameters<typeof writeStream>[1],
    Parameters<typeof writeStream>[2],
    Given?,
  ]
): ReturnType<typeof writeStream> => writeStream(driver, key, chunks, filled(options));
