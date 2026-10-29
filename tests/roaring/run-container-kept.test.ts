import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { RUN } from '@/ts-roaring/containers';
import type { Container } from '@/ts-roaring/containers';

/**
 * A write that adds nothing to a run container keeps that container: `orInPlace` and `addMany` hand `containerOr` the
 * permission to return the run it was given (a run's storage is never written in place, so keeping it is safe even when a
 * clone shares it). The record below holds each call's operands, the permission and the result, so a bitmap that stopped
 * passing the permission, or a kept run that was written, shows here and not only as a lost saving.
 */
const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('@/ts-roaring/containers', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/ts-roaring/containers')>();
  return {
    ...real,
    containerOr: (a: Container, b: Container, inPlace?: boolean) => {
      const out = real.containerOr(a, b, inPlace);
      seen.calls.push([a, b, inPlace, out]);
      return out;
    },
  };
});

beforeEach(() => {
  seen.calls.length = 0;
});

const CAP = 1 << 27;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const wide = range(0, 200).flatMap((i) => range(i * 300, i * 300 + 120));

function stored(ids: number[]): TsBitmap {
  const m = TsBitmap.fromValues(ids);
  m.optimize();
  return TsBitmap.safeDeserialize(m.serialize(), CAP);
}

describe('a clone and a write that adds nothing to a run container', () => {
  const subset = wide.filter((_, i) => i % 11 === 0);

  for (const how of ['orInPlace', 'addMany'] as const) {
    it(`${how}: the cloned run container is passed in place, kept as it is, and neither copy changes`, () => {
      const m = stored(wide);
      expect(m.hasRunContainer()).toBe(true);
      const clone = m.clone();
      const bytesBefore = Buffer.from(clone.serialize());
      seen.calls.length = 0;
      if (how === 'orInPlace') m.orInPlace(TsBitmap.fromValues(subset));
      else m.addMany(subset);
      const runCalls = seen.calls.filter((c) => (c[0] as Container).kind === RUN);
      expect(runCalls.length).toBeGreaterThan(0);
      for (const [before, , inPlace, after] of runCalls) {
        // the permission is given for a run container, shared or not, and the same container comes back
        expect(inPlace, 'the run container is passed in place').toBe(true);
        expect(after, 'the run container is kept').toBe(before);
        expect((before as Container).kind).toBe(RUN);
      }
      expect(m.size).toBe(wide.length);
      expect(m.isEqual(clone)).toBe(true);
      expect(Buffer.from(clone.serialize()).equals(bytesBefore)).toBe(true);
      expect([...clone]).toEqual(wide);
      expect([...m]).toEqual(wide);
    });
  }

  it('a write that does add ids to one copy builds a new container and leaves the other copy as it was', () => {
    const m = stored(wide);
    const clone = m.clone();
    m.addMany([125, 20_000]);
    expect(m.has(125)).toBe(true);
    expect(clone.has(125)).toBe(false);
    expect(clone.has(20_000)).toBe(false);
    expect(clone.size).toBe(wide.length);
    expect([...clone]).toEqual(wide);
  });
});
