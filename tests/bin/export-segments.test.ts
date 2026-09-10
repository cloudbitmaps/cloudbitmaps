import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsSink, main, parseConfig } from '@/bin/export-segments';
import {
  LocalFsColdDriver,
  LocalFsRegistryDriver,
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
    it('treats an empty CR_EXPORT_NAMESPACE as no filter', () => {
      expect(
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_NAMESPACE: '' })
          .namespace,
      ).toBeUndefined();
      expect(
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_NAMESPACE: 'ns' })
          .namespace,
      ).toBe('ns');
    });
    it('ignores an unknown variable rather than failing (CR_EXPORT_SEGMENTS is retired)', () => {
      // The escape hatch existed for a segment that had no registry row because it was written by `add()`
      // alone. Every loaded segment publishes a row, so the registry is complete by construction and there is
      // nothing left for the variable to reach. An operator's stale script must still run.
      expect(() =>
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_SEGMENTS: 'a,ns/b' }),
      ).not.toThrow();
      expect(
        parseConfig({ CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o', CR_EXPORT_SEGMENTS: 'a' }),
      ).toEqual({ root: '/x', out: '/o', format: 'roaring', namespace: undefined });
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

    it('exports every registered segment to portable roaring files + a complete manifest', async () => {
      // Seed two segments through the SAME LocalFs dirs the CLI reads, and give `a` a second generation so the
      // export is pinned to the CURRENT one rather than to whatever was published first.
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
      await bulkLoadCrbmGeneration(cold, { namespace: 'ns', segment: 'b', generation: 0 }, [9], {
        registry,
      });
      await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 1 }, [1, 2, 3, 4], {
        registry,
      });

      const manifest = await main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out }, () => 0);
      expect(manifest.totalSegments).toBe(2);

      // Files decode to the current generation of each segment.
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

    it('needs no escape hatch: a segment written without a registry is invisible, and says so', async () => {
      // What replaced CR_EXPORT_SEGMENTS. A load that passes a registry publishes a row, so the registry is a
      // complete index of every loaded segment and enumeration cannot miss one. A load that passes NO registry
      // writes an object nothing points at — the object is still readable by any roaring library (that is the
      // format's promise), but this CLI enumerates the registry it was given, so such a segment is absent from
      // the dump rather than silently half-exported. Pinned because it is the one gap the retired variable used
      // to paper over.
      const cold = new LocalFsColdDriver(join(root, 'cold'));
      const registry = new LocalFsRegistryDriver(join(root, 'registry'));
      await bulkLoadCrbmGeneration(cold, { segment: 'reg', generation: 0 }, [1], { registry });
      await bulkLoadCrbmGeneration(cold, { segment: 'orphan', generation: 0 }, [1000]); // no registry

      const manifest = await main({ CR_EXPORT_ROOT: root, CR_EXPORT_OUT: out }, () => 0);
      expect(manifest.segments.map((s) => s.segment)).toEqual(['reg']);
      expect(manifest.failed).toEqual([]); // not a failure — it was never enumerated
      expect(await readdir(join(out, '_default'))).toEqual(['reg.roaring']);
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
