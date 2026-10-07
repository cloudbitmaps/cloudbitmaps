import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The guide and the changelog quote the requests of a refresh-shaped `materializeMany` call, and the figures are the
 * ones `bench/materialize-many-counts.cjs` counted into `bench/materialize-many-counts.json`. Nothing here recounts:
 * `pnpm bench:materialize-many-counts:check` does that for the small shape, and `--check --all` for the one quoted. This
 * holds the prose to the file, so a figure retyped by hand, or a file counted again and not the prose, fails here.
 *
 * KNOWN LIMIT. It reads the figures, not the sentences around them.
 */
const ROOT = join(__dirname, '..', '..');
const counts = JSON.parse(
  readFileSync(join(ROOT, 'bench', 'materialize-many-counts.json'), 'utf8'),
) as {
  shapes: Record<
    string,
    {
      operands: number;
      outputs: number;
      idsPerOperand: number;
      batch: Record<string, number>;
      into: Record<string, number>;
    }
  >;
};
interface Target {
  operands: number;
  outputs: number;
  idsPerOperand: number;
  chunksPerOperand: number;
  batch: Record<'default256MiB' | 'budget2GiB', Record<string, number>>;
}
const target = (counts.shapes as unknown as Record<string, Target>).target!;
const fmt = (n: number): string => n.toLocaleString('en-US');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

describe('the figures of a refresh-shaped call', () => {
  const refresh = counts.shapes.refresh!;

  it('has the shape the docs describe', () => {
    expect([refresh.operands, refresh.outputs, refresh.idsPerOperand]).toEqual([
      100, 1_000, 200_000,
    ]);
    expect(Object.keys(counts.shapes).sort()).toEqual(['refresh', 'small', 'target']);
  });

  it.each([['docs/guide/loading.md'], ['CHANGELOG.md']])('%s quotes the counted figures', (rel) => {
    const text = flat(rel);
    for (const n of [
      refresh.batch.getClass,
      refresh.batch.putClass,
      refresh.batch.rangeReads,
      refresh.into.getClass,
      refresh.into.putClass,
      refresh.into.rangeReads,
      refresh.into.scratchSegments,
    ]) {
      expect(text, `${rel} must quote ${fmt(n!)}`).toContain(fmt(n!));
    }
  });

  it('quotes the rows of the guide table whole', () => {
    const text = flat('docs/guide/loading.md');
    const row = (c: Record<string, number>) =>
      [c.rangeReads, c.tailReads, c.rowReads].map((n) => fmt(n!)).join(' | ');
    expect(text).toContain(row(refresh.batch));
    expect(text).toContain(row(refresh.into));
    expect(text).toContain(`${refresh.batch.groups} groups`);
  });

  it('does not quote a timing or a figure the file does not hold', () => {
    const page = flat('docs/guide/loading.md');
    const text = page.slice(
      page.indexOf('## Many outputs from one pass'),
      page.indexOf('## How it stays correct'),
    );
    expect(text.length).toBeGreaterThan(1_000);
    expect(text).not.toMatch(/\b\d+(\.\d+)? s\b/);
    expect(text).not.toContain('1.3 times');
  });

  it('counts a put as the drivers saw it', () => {
    for (const shape of [counts.shapes.small!, counts.shapes.refresh!]) {
      expect(shape.batch.putClass).toBe(
        shape.batch.objectWrites! + shape.batch.rowWrites! + shape.batch.listings!,
      );
      expect(shape.batch.getClass).toBe(
        shape.batch.rangeReads! + shape.batch.tailReads! + shape.batch.rowReads!,
      );
      const attributed = (shape.batch as unknown as { attributed: Record<string, number> })
        .attributed;
      expect(attributed.put).toBeLessThanOrEqual(shape.batch.putClass!);
      expect(attributed.get).toBeLessThanOrEqual(shape.batch.getClass!);
    }
  });
});

describe('the figures of the target-sized call', () => {
  const both = Object.values(target.batch);

  it('has the shape the docs describe', () => {
    expect([
      target.operands,
      target.outputs,
      target.idsPerOperand,
      target.chunksPerOperand,
    ]).toEqual([100, 1_000, 3_000_000, 1_500]);
  });

  it('is quoted by the guide, and its groups and range reads by the changelog', () => {
    const guide = flat('docs/guide/loading.md');
    const log = flat('CHANGELOG.md');
    for (const run of both) {
      for (const n of [run.groups, run.rangeReads, run.chunkReads]) {
        expect(guide, `the guide must quote ${fmt(n!)}`).toContain(fmt(n!));
      }
    }
    const [small, large] = [target.batch.default256MiB, target.batch.budget2GiB];
    for (const n of [small.groups, small.rangeReads, large.groups, large.rangeReads]) {
      expect(log, `the changelog must quote ${fmt(n!)}`).toContain(fmt(n!));
    }
  });

  it('shows the groups growing as the budget shrinks, and the same outputs published', () => {
    expect(target.batch.default256MiB.groups).toBeGreaterThan(target.batch.budget2GiB.groups!);
    expect(target.batch.default256MiB.rangeReads).toBeGreaterThan(
      target.batch.budget2GiB.rangeReads!,
    );
    expect(target.batch.default256MiB.published).toBe(target.batch.budget2GiB.published);
    for (const run of both) expect(run.ledgerHighWaterBytes).toBeLessThanOrEqual(2 * 1024 ** 3);
  });
});
