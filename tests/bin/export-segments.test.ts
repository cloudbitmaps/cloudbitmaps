import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsSink, main, parseConfig } from '@/bin/export-segments';
import {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  LocalFsWarmDriver,
  SafeBitmap,
  bulkLoadCrbmGeneration,
} from '@/index';

const roaringIds = (bytes: Uint8Array): number[] =>
  SafeBitmap.safeDeserialize(bytes, 1 << 30)
    .toArray()
    .sort((a, b) => a - b);

describe('export-segments CLI', () => {
  describe('parseConfig', () => {
    it('requires CR_EXPORT_ROOT and CR_EXPORT_OUT', () => {
      expect(() => parseConfig({})).toThrow(/CR_EXPORT_ROOT/);
      expect(() => parseConfig({ CR_EXPORT_ROOT: '/x' })).toThrow(/CR_EXPORT_OUT/);
    });
    it('defaults format=roaring; rejects a bad format', () => {
      expect(parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o' })).toMatchObject({
        format: 'roaring',
      });
      expect(() =>
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_FORMAT: 'csv' }),
      ).toThrow(/CR_EXPORT_FORMAT/);
    });
    it('treats an empty CR_EXPORT_NAMESPACE as no filter; parses CR_EXPORT_SEGMENTS (seg / ns/seg)', () => {
      expect(
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_NAMESPACE: '' })
          .namespace,
      ).toBeUndefined();
      const cfg = parseConfig({
        CR_EXPORT_ROOT: '/x',
        CR_EXPORT_OUT: '/o',
        CR_EXPORT_SEGMENTS: 'a, ns/b ,',
      });
      expect(cfg.segments).toEqual([{ segment: 'a' }, { namespace: 'ns', segment: 'b' }]);
    });
    it('rejects a malformed CR_EXPORT_SEGMENTS entry (fails fast, not silently)', () => {
      expect(() =>
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_SEGMENTS: 'ns/../x' }),
      ).toThrow();
    });
  });

  describe('main() over a LocalFs root', () => {
    let root: string;
    let out: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'crbm-export-src-'));
      out = await mkdtemp(join(tmpdir(), 'crbm-export-out-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    });

    it('exports every registered segment to portable roaring files + a complete manifest (merges warm)', async () => {
      // Seed two segments through the SAME LocalFs dirs the CLI reads, plus a warm delta on `a`.
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      const warm = new LocalFsWarmDriver(join(root, 'warm'));
      await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
      await bulkLoadCrbmGeneration(cold, { namespace: 'ns', segment: 'b', generation: 0 }, [9], {
        registry,
      });
      await new CloudRoaring({ warm, cold, registry, retry: false }).segment('a').add(4);

      const manifest = await main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out }, () => 0);
      expect(manifest.totalSegments).toBe(2);

      // Files decode to the effective sets (a merged its warm add).
      expect(roaringIds(await readFile(join(out, '_default', 'a.roaring')))).toEqual([1, 2, 3, 4]);
      expect(roaringIds(await readFile(join(out, 'ns', 'b.roaring')))).toEqual([9]);

      // The manifest is present + self-describing (its presence = a complete export).
      const mani = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as {
        version: number;
        format: string;
        totalSegments: number;
        generatedAt: string;
        segments: Array<{ segment: string }>;
        failed: unknown[];
      };
      expect(mani.version).toBe(1);
      expect(mani.format).toBe('roaring');
      expect(mani.totalSegments).toBe(2);
      expect(mani.generatedAt).toBe(new Date(0).toISOString());
      expect(mani.segments.map((s) => s.segment).sort()).toEqual(['a', 'b']);
      expect(mani.failed).toEqual([]); // happy path: nothing failed

      // No leftover `.part` temp files anywhere — segment files AND the manifest use atomic temp→rename.
      const defaultDir = await readdir(join(out, '_default'));
      expect(defaultDir.some((f) => f.endsWith('.part'))).toBe(false);
      expect((await readdir(out)).some((f) => f.endsWith('.part'))).toBe(false); // no manifest.json.<uuid>.part
    });

    it('ndjson format writes newline-delimited ids', async () => {
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });

      await main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out, CR_EXPORT_FORMAT: 'ndjson' }, () => 0);
      const txt = await readFile(join(out, '_default', 'a.ndjson'), 'utf8');
      expect(txt.trim().split('\n').map(Number)).toEqual([1, 2, 3]);
    });

    it('fsSink writes to a .part temp then renames on close', async () => {
      const sink = fsSink(out);
      const writer = await sink.open({ segment: 's' }, '.roaring');
      await writer.write(Buffer.from('hello'));
      // Before close: only a unique `.part` temp exists (UUID suffix → concurrent-safe).
      const mid = await readdir(join(out, '_default'));
      expect(mid).toHaveLength(1);
      expect(mid[0]).toMatch(/^s\.roaring\..+\.part$/);
      await writer.close();
      // After close: renamed to the final name.
      expect(await readdir(join(out, '_default'))).toEqual(['s.roaring']);
    });

    it('leaves no manifest.json when the manifest WRITE itself faults (read-only OUT) — no torn marker', async () => {
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });

      // Read-only OUT: per-segment writes are isolated into failed[], then the manifest write itself faults
      // (EACCES) — so main rejects and no `manifest.json` is left behind (a crash/fault ⇒ no marker ⇒ re-run).
      await chmod(out, 0o500);
      try {
        await expect(main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out }, () => 0)).rejects.toThrow();
        expect(await readdir(out)).not.toContain('manifest.json');
      } finally {
        await chmod(out, 0o700); // restore so afterEach can clean up
      }
    });

    it('isolates a per-segment fault: writes the manifest with the bad segment in failed[], exports the healthy rest', async () => {
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      await bulkLoadCrbmGeneration(cold, { segment: 'bad', generation: 0 }, [1, 2, 3], {
        registry,
      });
      await bulkLoadCrbmGeneration(cold, { namespace: 'ok', segment: 'good', generation: 0 }, [9], {
        registry,
      });

      // Fault ONLY 'bad' while OUT stays writable: pre-create out/_default as a FILE so the sink's
      // mkdir(out/_default) throws for the default-namespace segment; 'good' lives under out/ok and succeeds.
      await writeFile(join(out, '_default'), 'not a dir');

      const manifest = await main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out }, () => 0);
      // The run FINISHED: manifest written, healthy segment exported, bad one recorded (not silently dropped).
      expect(manifest.failed.map((f) => f.segment)).toEqual(['bad']);
      expect(manifest.segments.map((s) => s.segment)).toEqual(['good']);
      expect(roaringIds(await readFile(join(out, 'ok', 'good.roaring')))).toEqual([9]);
      const mani = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as {
        failed: Array<{ segment: string; error: string }>;
      };
      expect(mani.failed.map((f) => f.segment)).toEqual(['bad']); // persisted so an operator sees the gap
    });

    it('CR_EXPORT_SEGMENTS includes an all-warm (unregistered) segment', async () => {
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      const warm = new LocalFsWarmDriver(join(root, 'warm'));
      await bulkLoadCrbmGeneration(cold, { segment: 'reg', generation: 0 }, [1], { registry });
      // 'warmonly' written via add() only — no registry row, so it's invisible without the escape hatch.
      await new CloudRoaring({ warm, cold, registry, retry: false }).segment('warmonly').add(1000);

      const manifest = await main(
        { CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out, CR_EXPORT_SEGMENTS: 'warmonly' },
        () => 0,
      );
      expect(manifest.segments.map((s) => s.segment).sort()).toEqual(['reg', 'warmonly']);
      expect(roaringIds(await readFile(join(out, '_default', 'warmonly.roaring')))).toEqual([1000]);
    });

    it('fsSink.abort discards the .part (no file committed)', async () => {
      const sink = fsSink(out);
      const writer = await sink.open({ segment: 's' }, '.roaring');
      await writer.write(Buffer.from('partial'));
      await writer.abort?.();
      // The .part was deleted and nothing was renamed into place.
      expect(await readdir(join(out, '_default'))).toEqual([]);
    });
  });
});
