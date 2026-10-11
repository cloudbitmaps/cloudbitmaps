import { MemoryStorage, CloudRoaring } from '@/index';
import type { ExportSink, ExportWriter, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A segment destroyed after the registry listing named it and before its export pinned it is a tombstone by the
 * time it is read: it exports no ids. The dump must account for it as skipped, never as a successful empty file.
 */
function recordingSink(): { sink: ExportSink; committed: string[]; aborted: string[] } {
  const committed: string[] = [];
  const aborted: string[] = [];
  const sink: ExportSink = {
    open(ref: SegmentRef, ext: string): ExportWriter {
      const key = `${ref.namespace ?? '_default'}/${ref.segment}${ext}`;
      return {
        write() {},
        close() {
          committed.push(key);
        },
        abort() {
          aborted.push(key);
        },
      };
    },
  };
  return { sink, committed, aborted };
}

/** A registry whose listing destroys (or deletes) `victim` and then yields the stale, still-active row. */
function racingRegistry(
  base: IRegistryDriver,
  victim: string,
  act: () => Promise<void>,
): IRegistryDriver {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'list') {
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return async function* (namespace?: string) {
        const rows = [];
        for await (const r of target.list(namespace)) rows.push(r);
        await act();
        for (const r of rows) yield r;
        void receiver;
        void victim;
      };
    },
  });
}

for (const format of ['roaring', 'ndjson'] as const) {
  describe(`runExport (${format}) — a segment destroyed after the listing`, () => {
    for (const how of ['destroyed', 'removed'] as const) {
      it(`records a segment ${how} after the listing as skipped, writes no file`, async () => {
        const backend = new MemoryStorage();
        const { storage, registry } = backend;
        await bulkLoadCrbmGeneration(storage, { segment: 'live', generation: 0 }, [1, 2], {
          registry,
        });
        await bulkLoadCrbmGeneration(storage, { segment: 'victim', generation: 0 }, [3], {
          registry,
        });
        const racing = racingRegistry(registry, 'victim', async () => {
          const rec = (await registry.get({ segment: 'victim' }))!;
          if (how === 'destroyed') {
            await registry.compareAndSwap({ segment: 'victim' }, rec.token, {
              status: 'destroyed',
            });
          } else {
            await registry.delete({ segment: 'victim' }, rec.token);
          }
        });
        const store = new CloudRoaring({
          storage: brandAsBackend({ storage, registry: racing }),
          retry: false,
          cache: { genTtlMs: 0 },
        });
        const { sink, committed, aborted } = recordingSink();
        const manifest = await store.exportSegments(sink, { format });

        expect(manifest.segments.map((s) => s.segment)).toEqual(['live']);
        expect(manifest.skipped).toEqual([{ segment: 'victim', reason: 'destroyed' }]);
        expect(manifest.failed).toEqual([]);
        expect(committed).toEqual([`_default/live.${format === 'roaring' ? 'roaring' : 'ndjson'}`]);
        expect(aborted).toEqual([`_default/victim.${format}`]);
      });
    }

    it('still exports a live segment that holds no ids as an empty file', async () => {
      const backend = new MemoryStorage();
      const { storage, registry } = backend;
      await bulkLoadCrbmGeneration(storage, { segment: 'empty', generation: 0 }, [], { registry });
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        retry: false,
        cache: { genTtlMs: 0 },
      });
      const { sink, committed } = recordingSink();
      const manifest = await store.exportSegments(sink, { format });
      expect(manifest.skipped).toEqual([]);
      expect(manifest.segments.map((s) => s.segment)).toEqual(['empty']);
      expect(committed.length).toBe(1);
    });
  });
}

/** A sink whose `abort` can be made to fail, recording what it was asked to commit and to discard. */
function sinkWith(abortFails: boolean): {
  sink: ExportSink;
  committed: string[];
  aborted: string[];
} {
  const committed: string[] = [];
  const aborted: string[] = [];
  const sink: ExportSink = {
    open(ref: SegmentRef, ext: string): ExportWriter {
      const key = `${ref.namespace ?? '_default'}/${ref.segment}${ext}`;
      return {
        write() {},
        close() {
          committed.push(key);
        },
        abort() {
          aborted.push(key);
          if (abortFails) throw new Error('abort refused');
        },
      };
    },
  };
  return { sink, committed, aborted };
}

/** A registry whose listing runs `act` and then yields the rows it read before it. */
function staleListing(base: IRegistryDriver, act: () => Promise<void>): IRegistryDriver {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'list') {
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return async function* (namespace?: string) {
        const rows = [];
        for await (const r of target.list(namespace)) rows.push(r);
        await act();
        for (const r of rows) yield r;
      };
    },
  });
}

for (const format of ['roaring', 'ndjson'] as const) {
  for (const abortFails of [false, true]) {
    // The open writer is aborted (so the CLI's sink leaves no `.part` temp), the skip names its namespace, and a
    // fault from `abort` does not turn the skip into a failure.
    it(`(${format}) a namespaced segment destroyed after the listing is aborted exactly once and skipped with its namespace${abortFails ? ' even when abort throws' : ''}`, async () => {
      const { storage, registry } = new MemoryStorage();
      const ref = { namespace: 'ns', segment: 'victim' };
      await bulkLoadCrbmGeneration(storage, { ...ref, generation: 0 }, [3], { registry });
      const racing = staleListing(registry, async () => {
        const rec = (await registry.get(ref))!;
        await registry.compareAndSwap(ref, rec.token, { status: 'destroyed' });
      });
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry: racing }),
        retry: false,
        cache: { genTtlMs: 0 },
      });
      const { sink, committed, aborted } = sinkWith(abortFails);
      const manifest = await store.exportSegments(sink, { format });
      expect(manifest.skipped).toEqual([
        { segment: 'victim', namespace: 'ns', reason: 'destroyed' },
      ]);
      expect(manifest.failed).toEqual([]);
      expect(committed).toEqual([]);
      expect(aborted).toEqual([`ns/victim.${format}`]);
    });
  }
}
