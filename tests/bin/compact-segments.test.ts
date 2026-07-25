import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFsDeps, parseConfig, runOnce, main } from '@/bin/compact-segments';
import { CloudRoaring, CrbmColdChunkSource, bulkLoadCrbmGeneration } from '@/index';

describe('compact-segments CLI', () => {
  describe('parseConfig', () => {
    it('requires CR_COMPACT_ROOT', () => {
      expect(() => parseConfig({})).toThrow(/CR_COMPACT_ROOT/);
    });
    it('defaults mode=once / interval / threshold / keep and derives an owner', () => {
      const c = parseConfig({ CR_COMPACT_ROOT: '/x' });
      expect(c).toMatchObject({
        root: '/x',
        mode: 'once',
        intervalMs: 30_000,
        threshold: 1,
        keep: 1,
      });
      expect(c.owner).toMatch(/.+:\d+/);
    });
    it('rejects a bad mode or a negative number', () => {
      expect(() => parseConfig({ CR_COMPACT_ROOT: '/x', CR_COMPACT_MODE: 'forever' })).toThrow(
        /CR_COMPACT_MODE/,
      );
      expect(() => parseConfig({ CR_COMPACT_ROOT: '/x', CR_COMPACT_THRESHOLD: '-1' })).toThrow(
        /CR_COMPACT_THRESHOLD/,
      );
    });
    it('parses shard / totalShards / maxSegments (shard 0 is preserved, not a falsy default)', () => {
      const c = parseConfig({
        CR_COMPACT_ROOT: '/x',
        CR_COMPACT_SHARD: '0',
        CR_COMPACT_TOTAL_SHARDS: '4',
        CR_COMPACT_MAX_SEGMENTS: '50',
      });
      expect(c).toMatchObject({ shard: 0, totalShards: 4, maxSegments: 50 });
    });
    it('requires both CR_COMPACT_SHARD and CR_COMPACT_TOTAL_SHARDS, or neither', () => {
      expect(() => parseConfig({ CR_COMPACT_ROOT: '/x', CR_COMPACT_SHARD: '0' })).toThrow(/both/);
      expect(() => parseConfig({ CR_COMPACT_ROOT: '/x', CR_COMPACT_TOTAL_SHARDS: '4' })).toThrow(
        /both/,
      );
    });
    it('rejects a zero / negative / non-integer maxSegments (must be >= 1)', () => {
      for (const v of ['0', '-1', '1.5']) {
        expect(() => parseConfig({ CR_COMPACT_ROOT: '/x', CR_COMPACT_MAX_SEGMENTS: v })).toThrow(
          /MAX_SEGMENTS/,
        );
      }
    });
    it('treats an empty env value as unset — no falsy-trap (empty ≠ 0)', () => {
      const c = parseConfig({
        CR_COMPACT_ROOT: '/x',
        CR_COMPACT_INTERVAL_MS: '',
        CR_COMPACT_SHARD: '',
        CR_COMPACT_TOTAL_SHARDS: '',
      });
      expect(c.intervalMs).toBe(30_000); // empty → default, not Number('') === 0
      expect(c.shard).toBeUndefined();
      expect(c.totalShards).toBeUndefined();
    });
  });

  describe('runOnce / main (once mode) over a LocalFs root', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'crbm-cli-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('compacts a dirty segment end-to-end', async () => {
      const deps = localFsDeps(root);
      const config = parseConfig({ CR_COMPACT_ROOT: root });
      // Seed a generation + a warm delta through the SAME backing dirs the CLI uses.
      await bulkLoadCrbmGeneration(deps.cold, { segment: 's', generation: 0 }, [1, 2], {
        registry: deps.registry,
      });
      const store = new CloudRoaring({
        warm: deps.warm,
        cold: new CrbmColdChunkSource(deps.cold, { registry: deps.registry }),
        retry: false,
      });
      await store.segment('s').add(3);

      const cycle = await runOnce(deps, config);
      expect(cycle).toMatchObject({ candidates: 1, compacted: 1, deferred: 0 });
      expect(cycle.results).toHaveLength(1);
      expect(cycle.results[0]).toMatchObject({ segment: 's', compacted: true, toGen: 1 });

      // A fresh read reflects the merged generation.
      const fresh = new CloudRoaring({
        warm: deps.warm,
        cold: new CrbmColdChunkSource(deps.cold, { registry: deps.registry }),
        retry: false,
      });
      const out: number[] = [];
      for await (const id of fresh.segment('s').iterate()) out.push(id);
      expect(out).toEqual([1, 2, 3]);
    });

    it('main() in once mode runs a cycle and exits without throwing', async () => {
      await expect(
        main({ CR_COMPACT_ROOT: root, CR_COMPACT_MODE: 'once' }),
      ).resolves.toBeUndefined();
    });
  });
});
