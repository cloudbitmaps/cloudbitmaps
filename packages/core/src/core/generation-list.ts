/**
 * The generations a segment's bucket holds.
 */
import type { IStorageDriver, SegmentRef } from './ports';
import { ascending } from './order';

/**
 * The generations the bucket holds for `ref`, from one listing, each once and in ascending order. A listing that spans
 * a purge and a re-create can yield one number twice (the objects are re-created under the numbers just swept), so the
 * duplicates are dropped here rather than counted by each caller. A caller that stops at the first object it wants
 * reads the listing itself.
 */
export async function generationsOf(storage: IStorageDriver, ref: SegmentRef): Promise<number[]> {
  const present = new Set<number>();
  for await (const key of storage.list(ref)) present.add(key.generation);
  return [...present].sort(ascending);
}
