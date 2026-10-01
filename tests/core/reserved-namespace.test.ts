import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { clearSegmentRetention, getSegmentRetention, setSegmentRetention } from '@/core/retention';
import { destroySegment, dropSegment, eraseNamespace } from '@/core/erasure';
import { eraseIdFromSegment } from '@/core/erase-id';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import { listSegments, segmentExists } from '@/core/discover';
import { loadSegment } from '@/core/load';
import { retireExpired } from '@/core/retention-sweep';
import { runConsistencyCheck } from '@/core/consistency';
import { runExport } from '@/export/index';
import { validateSegmentRef } from '@/driver-kit';
import { isDueIndexRow, dueNamespace } from '@/core/due-index';
import {
  RESERVED_NAMESPACE_PREFIX,
  isReservedNamespace,
  validateUserNamespace,
  validateUserRef,
} from '@/core/validate';
import {
  RESERVED_NAMESPACE_PREFIX as FLAVOR_PREFIX,
  refuseReservedNamespace,
} from '@/reserved-namespace';
import type { SegmentRef } from '@/index';

/**
 * `cbm.due.` is the namespace the due index keeps its own pointer rows in, and every fleet-wide scan skips a
 * row there as bookkeeping. A user's segment in `cbm.due.eu` was therefore invisible to an erasure (an empty
 * ledger with `scannedSegments: 0`), a consistency check, an export, `segments()` and the unscoped sweep, with no
 * error anywhere. The name is refused where an application passes it in; the library's own writes to it, which
 * go through the drivers, are not.
 *
 * The refusal is an internal check of core (`validateUserRef`, `validateUserNamespace`) that the user-facing
 * functions call, and a small copy of the prefix in the flavor for the facade's own checks. The one public
 * `validateSegmentRef`, on `@cloudbitmaps/core/driver-kit`, checks the name rules only, as a driver needs.
 */
const DAY = 86_400_000;
const RESERVED = 'cbm.due.x';
const BAD: SegmentRef = { namespace: RESERVED, segment: 's' };
const FUTURE = Date.now() + 30 * DAY;

function world() {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const store = new CloudRoaring({ storage: backend, retry: false });
  return { storage, registry, store, deps: { storage, registry } };
}

async function rejectsValidation(run: () => unknown): Promise<void> {
  await expect(Promise.resolve().then(run)).rejects.toBeInstanceOf(ValidationError);
}

describe('the reserved namespace prefix', () => {
  it('is one constant, which the due index reads', () => {
    expect(RESERVED_NAMESPACE_PREFIX).toBe('cbm.due.');
    expect(dueNamespace(20356)).toBe(`${RESERVED_NAMESPACE_PREFIX}20356`);
    expect(isDueIndexRow({ namespace: `${RESERVED_NAMESPACE_PREFIX}1` })).toBe(true);
    expect(isReservedNamespace(`${RESERVED_NAMESPACE_PREFIX}1`)).toBe(true);
  });

  it('refuses it in a segment ref and a namespace option, whatever follows the prefix', () => {
    for (const namespace of ['cbm.due.x', 'cbm.due.', 'cbm.due.20356', 'cbm.due.eu.west']) {
      expect(() => validateUserRef({ namespace, segment: 's' }), namespace).toThrow(
        ValidationError,
      );
      expect(() => validateUserNamespace(namespace), namespace).toThrow(ValidationError);
      expect(() => refuseReservedNamespace(namespace), namespace).toThrow(ValidationError);
    }
    expect(() => validateUserRef(BAD)).toThrow(/reserved/);
    expect(() => refuseReservedNamespace(RESERVED)).toThrow(/reserved/);
  });

  it('allows look-alikes: only the exact prefix is reserved, not `cbm.` as a whole', () => {
    for (const namespace of [
      'cbm.dueX',
      'cbm.due',
      'cbm.dues.eu',
      'cbmdue.eu',
      'cbm.',
      'cbm.other',
      'xcbm.due.eu',
      'CBM.DUE.eu',
    ]) {
      expect(() => validateUserRef({ namespace, segment: 's' }), namespace).not.toThrow();
      expect(() => validateUserNamespace(namespace), namespace).not.toThrow();
      expect(() => refuseReservedNamespace(namespace), namespace).not.toThrow();
    }
    // The prefix constrains the namespace, not the segment name, and no namespace is never reserved.
    expect(() => validateUserRef({ segment: 'cbm.due.x' })).not.toThrow();
    expect(() => validateUserRef({ namespace: 'eu', segment: 'cbm.due.x' })).not.toThrow();
    expect(() => refuseReservedNamespace(undefined)).not.toThrow();
  });

  it('is accepted by the one public validateSegmentRef, which checks the name rules only', () => {
    // A driver takes the due index's own rows, which live in the reserved namespace.
    expect(() => validateSegmentRef(BAD)).not.toThrow();
    expect(() => validateSegmentRef({ namespace: 'cbm.due.20356', segment: 's' })).not.toThrow();
    // …and still refuses what the name rules refuse.
    expect(() => validateSegmentRef({ namespace: 'eu', segment: '' })).toThrow(ValidationError);
    expect(() => validateSegmentRef({ namespace: '', segment: 's' })).toThrow(ValidationError);
  });

  it("the flavor's copy of the prefix equals core's, so the facade's checks cannot drift from core's", () => {
    expect(FLAVOR_PREFIX).toBe(RESERVED_NAMESPACE_PREFIX);
    // Behaviourally too: the two refuse and accept the same namespaces around the boundary.
    for (const namespace of [
      `${RESERVED_NAMESPACE_PREFIX}x`,
      RESERVED_NAMESPACE_PREFIX,
      RESERVED_NAMESPACE_PREFIX.slice(0, -1),
      `${RESERVED_NAMESPACE_PREFIX.slice(0, -1)}X`,
      RESERVED_NAMESPACE_PREFIX.toUpperCase(),
    ]) {
      const refusedByFacade = (): boolean => {
        try {
          refuseReservedNamespace(namespace);
          return false;
        } catch (err) {
          return err instanceof ValidationError;
        }
      };
      expect(refusedByFacade(), namespace).toBe(isReservedNamespace(namespace));
    }
  });

  it('a look-alike namespace holds segments that every scan sees', async () => {
    const { store } = world();
    const ref = { namespace: 'cbm.dueX', segment: 's' };
    await store.load(ref, [7]);
    const listed: string[] = [];
    for await (const info of store.segments()) listed.push(`${info.namespace}/${info.segment}`);
    expect(listed).toEqual(['cbm.dueX/s']);
    const report = await store.subjectReport(7, { namespace: 'cbm.dueX' });
    expect(report).toMatchObject({ scannedSegments: 1 });
    const erased = await store.eraseSubject(7, { allNamespaces: true });
    expect(erased.erasedFrom).toHaveLength(1);
  });
});

describe('every entry point that takes a namespace refuses the reserved one', () => {
  describe('CloudRoaring', () => {
    const { store } = world();
    const sink = {} as never;
    const cases: [string, () => unknown][] = [
      ['segment(name, { namespace })', () => store.segment('s', { namespace: RESERVED })],
      ['load(ref)', () => store.load(BAD, [1])],
      ['generations(ref)', () => store.generations(BAD)],
      ['exists(ref)', () => store.exists(BAD)],
      ['segments({ namespace })', () => store.segments({ namespace: RESERVED })],
      ['rollback(ref)', () => store.rollback(BAD, 0)],
      ['dropSegment(ref)', () => store.dropSegment(BAD, { confirmSegment: 's' })],
      ['setRetention(ref)', () => store.setRetention(BAD, { expiresAt: FUTURE })],
      ['getRetention(ref)', () => store.getRetention(BAD)],
      ['clearRetention(ref)', () => store.clearRetention(BAD)],
      ['invalidate(ref)', () => store.invalidate(BAD)],
      ['retireExpired({ namespace })', () => store.retireExpired({ namespace: RESERVED })],
      [
        "retireExpired({ scan: 'index', namespace })",
        () => store.retireExpired({ scan: 'index', namespace: RESERVED }),
      ],
      ['checkConsistency({ namespace })', () => store.checkConsistency({ namespace: RESERVED })],
      [
        'exportSegments(sink, { namespace })',
        () => store.exportSegments(sink, { namespace: RESERVED }),
      ],
      ['subjectReport(id, { namespace })', () => store.subjectReport(1, { namespace: RESERVED })],
      ['eraseSubject(id, { namespace })', () => store.eraseSubject(1, { namespace: RESERVED })],
      // `intersectInto` / `unionInto` / `andNotInto` take their destination, and every operand and `exclude`, as a
      // `Segment` handle, which only `segment()` makes, so the row above is their refusal.
    ];
    it.each(cases)('%s', async (_name, run) => {
      if (_name.startsWith('segments(')) {
        expect(run).toThrow(ValidationError); // a synchronous iterable factory
        return;
      }
      if (_name.startsWith('segment(name')) {
        expect(run).toThrow(ValidationError);
        return;
      }
      if (_name.startsWith('invalidate')) {
        expect(run).toThrow(ValidationError);
        return;
      }
      await rejectsValidation(run);
    });
  });

  describe('the free functions of @cloudbitmaps/core', () => {
    const { deps, registry, storage } = world();
    const sink = {} as never;
    const cases: [string, () => unknown][] = [
      ['validateUserRef', () => validateUserRef(BAD)],
      ['segmentExists', () => segmentExists(BAD, registry)],
      [
        'listSegments',
        async () => {
          for await (const _ of listSegments(registry, { namespace: RESERVED })) void _;
        },
      ],
      ['loadSegment', () => loadSegment(BAD, [], deps)],
      ['listGenerations', () => listGenerations(BAD, deps)],
      ['rollbackSegment', () => rollbackSegment(BAD, 0, deps)],
      ['eraseIdFromSegment', () => eraseIdFromSegment(BAD, 1, deps as never)],
      ['destroySegment', () => destroySegment(BAD, deps, { confirmSegment: 's' })],
      ['dropSegment', () => dropSegment(BAD, deps, { confirmSegment: 's' })],
      ['eraseNamespace', () => eraseNamespace(RESERVED, deps, { confirmNamespace: RESERVED })],
      ['setSegmentRetention', () => setSegmentRetention(BAD, { registry }, { expiresAt: FUTURE })],
      ['getSegmentRetention', () => getSegmentRetention(BAD, { registry })],
      ['clearSegmentRetention', () => clearSegmentRetention(BAD, { registry })],
      ['runConsistencyCheck', () => runConsistencyCheck(deps, { namespace: RESERVED })],
      [
        'retireExpired',
        () => retireExpired({ storage, registry }, { now: FUTURE, namespace: RESERVED }),
      ],
      ['runExport', () => runExport({} as never, registry, sink, { namespace: RESERVED })],
    ];
    it.each(cases)('%s', async (_name, run) => {
      await rejectsValidation(run);
    });
  });

  it('refuses before doing anything: no row, no object, no ledger, from every write', async () => {
    const { store, registry, storage, deps } = world();
    const writes: (() => unknown)[] = [
      () => store.load(BAD, [1]),
      () => store.rollback(BAD, 0, { allowForward: true }),
      () => store.dropSegment(BAD, { confirmSegment: 's' }),
      () => store.setRetention(BAD, { expiresAt: FUTURE }),
      () => store.clearRetention(BAD),
      () => loadSegment(BAD, [], deps),
      () => destroySegment(BAD, deps, { confirmSegment: 's' }),
      () => dropSegment(BAD, deps, { confirmSegment: 's' }),
      () => eraseNamespace(RESERVED, deps, { confirmNamespace: RESERVED }),
      () => setSegmentRetention(BAD, { registry }, { expiresAt: FUTURE }),
      () => clearSegmentRetention(BAD, { registry }),
    ];
    for (const run of writes) await rejectsValidation(run);
    const rows = [];
    for await (const r of registry.list()) rows.push(r);
    expect(rows).toEqual([]);
    const keys = [];
    for await (const k of storage.list(BAD)) keys.push(k);
    expect(keys).toEqual([]);
  });
});

describe('the library’s own bookkeeping still works', () => {
  it('a retention policy writes a pointer into the reserved namespace, and the sweep retires through it', async () => {
    const { store, registry, storage } = world();
    const ref = { namespace: 'eu', segment: 's' };
    await store.load(ref, [1, 2, 3]);
    const expiresAt = Date.now() + 10 * DAY;
    const set = await store.setRetention(ref, { expiresAt });
    expect(set.indexed).toBe(true);

    const pointers = [];
    for await (const r of registry.list(dueNamespace(Math.floor(expiresAt / DAY))))
      pointers.push(r);
    expect(pointers).toHaveLength(1);
    expect(isDueIndexRow(pointers[0]!)).toBe(true);
    // The pointer is invisible to a fleet scan, as before.
    const listed: string[] = [];
    for await (const info of store.segments()) listed.push(info.segment);
    expect(listed).toEqual(['s']);

    // Moving the expiry moves the pointer (a delete and a create in the reserved namespace).
    const later = expiresAt + 3 * DAY;
    await store.setRetention(ref, { expiresAt: later });
    const old = [];
    for await (const r of registry.list(dueNamespace(Math.floor(expiresAt / DAY)))) old.push(r);
    expect(old).toEqual([]);

    // The fast sweep reads the pointer and retires the segment.
    const res = await store.retireExpired({ scan: 'index', now: later + 1 });
    expect(res).toMatchObject({ retired: 1 });
    expect(await store.exists(ref)).toBe(false);
    const gens = [];
    for await (const k of storage.list(ref)) gens.push(k);
    expect(gens).toEqual([]);
    // …and the pointer is forgotten.
    const left = [];
    for await (const r of registry.list(dueNamespace(Math.floor(later / DAY)))) left.push(r);
    expect(left).toEqual([]);
  });

  it('the fleet sweep, a scoped sweep and a consistency check run beside a pointer row', async () => {
    const { store } = world();
    const ref = { namespace: 'eu', segment: 's' };
    await store.load(ref, [1]);
    await store.setRetention(ref, { expiresAt: Date.now() + DAY });
    expect(await store.checkConsistency()).toMatchObject({ checked: 1, inconsistent: [] });
    expect(await store.checkConsistency({ namespace: 'eu' })).toMatchObject({ checked: 1 });
    expect(await store.retireExpired({ namespace: 'eu', dryRun: true })).toMatchObject({
      scanned: 1,
      wouldRetire: 0,
    });
    expect(await store.retireExpired({ now: Date.now() + 2 * DAY, dryRun: true })).toMatchObject({
      scanned: 1,
      wouldRetire: 1,
    });
  });

  it('a pointer left by an earlier version for a segment in the reserved namespace is skipped by the fast sweep', async () => {
    const { store, registry } = world();
    // What an earlier version could have written: a segment in `cbm.due.x` with a policy, and its pointer.
    const legacy = { namespace: RESERVED, segment: 'legacy' };
    const expiresAt = Date.now() - DAY;
    await registry.create(legacy, { currentGen: null, retention: { expiresAt } });
    const { dueIndexRef, dueBucket } = await import('@/core/due-index');
    await registry.create(dueIndexRef(dueBucket(expiresAt), legacy), { currentGen: null });

    const res = await store.retireExpired({ scan: 'index', now: Date.now() });
    expect(res).toMatchObject({ scanned: 0, retired: 0, entries: [] });
  });
});
