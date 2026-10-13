import { expect } from 'vitest';

/** Every item of a stream, in order. */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

/**
 * Two byte arrays are equal, compared natively: the framework's deep equality walks a 100 KiB buffer element by
 * element, which takes seconds over a test's worth of chunks.
 */
export function expectSameBytes(
  got: Uint8Array | null | undefined,
  want: Uint8Array | null | undefined,
): void {
  expect(got, 'a chunk is missing').toBeTruthy();
  expect(want, 'the expected chunk is missing').toBeTruthy();
  const a = Buffer.from(got!.buffer, got!.byteOffset, got!.byteLength);
  const b = Buffer.from(want!.buffer, want!.byteOffset, want!.byteLength);
  expect(a.length, 'chunk length').toBe(b.length);
  expect(a.equals(b), 'chunk bytes').toBe(true);
}
