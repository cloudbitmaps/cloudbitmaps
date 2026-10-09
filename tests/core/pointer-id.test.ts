/**
 * A registry row's `pointerId`: the token of the most recent write that changed what the row resolves to. A create sets
 * it, and so does a compare-and-swap whose patch names `currentGen`, `status`, `wrappedDeks`, `keyId` or `summary`, at
 * any value, the one it already has included; a write of the leases, the retention or residency policy or the kept
 * window leaves it. The shipped registries apply the rule in the two shared record builders, and a third-party
 * registry applies it through the same helpers, from `@cloudbitmaps/core/driver-kit`.
 */
import {
  applyRegistryPatch,
  recordFromNew,
  validateNewRegistryRecord,
  validateRegistryPatch,
} from '@/drivers/_shared/registry';
import { RESOLVED_FIELDS, pointerIdOf, renewPointer, renewsPointer } from '@/core/pointer-id';
import * as driverKit from '@/driver-kit';
import { UnsupportedError, ValidationError } from '@/core/errors';
import type { RegistryPatch, RegistryRecord } from '@/core/ports';

const INC = '0123456789abcdef0123456789abcdef';
const token = (counter: number): string =>
  `${INC}.${counter}.${counter.toString(16).padStart(16, '0')}`;
const REF = { namespace: 'n', segment: 's' };
const SUMMARY = { generation: 3, cardinality: 5, fingerprint: '200:7' };

/** A row at generation 3, with a summary, a kept window and a lease, created by the write `token(0)`. */
function row(): RegistryRecord {
  const created = recordFromNew(
    REF,
    { currentGen: 3, summary: SUMMARY, keptGens: [1, 2] },
    1,
    token(0),
  );
  return applyRegistryPatch(
    created,
    { leases: [{ holder: 'aaaaaaaaaaaaaaaa', generation: 3, until: 99 }] },
    2,
    token(1),
  );
}

describe('the resolved fields', () => {
  it('are the five a read resolves through', () => {
    expect([...RESOLVED_FIELDS].sort()).toEqual(
      ['currentGen', 'keyId', 'status', 'summary', 'wrappedDeks'].sort(),
    );
  });

  it('a patch renews the pointer exactly when it names one of them, whatever the value', () => {
    for (const field of RESOLVED_FIELDS) {
      expect(renewsPointer({ [field]: undefined } as RegistryPatch), field).toBe(true);
    }
    for (const patch of [
      {},
      { leases: undefined },
      { retention: { note: 'x' } },
      { residency: {} },
      { keptGens: [] },
    ] as RegistryPatch[]) {
      expect(renewsPointer(patch), JSON.stringify(patch)).toBe(false);
    }
  });

  it('renewPointer names the pointer at the value it has, null included', () => {
    expect(renewPointer({ currentGen: 4 })).toEqual({ currentGen: 4 });
    expect(renewPointer({ currentGen: null })).toEqual({ currentGen: null });
    expect(renewsPointer(renewPointer({ currentGen: 4 }))).toBe(true);
  });

  it('are what a third-party registry builds against, from the driver kit', () => {
    expect(driverKit.RESOLVED_FIELDS).toBe(RESOLVED_FIELDS);
    expect(driverKit.renewsPointer).toBe(renewsPointer);
    expect(driverKit.renewPointer).toBe(renewPointer);
    expect(driverKit.pointerIdOf).toBe(pointerIdOf);
  });
});

describe('the shared record builders set it', () => {
  it('a create sets it to its own token', () => {
    const created = recordFromNew(REF, { currentGen: null }, 1, token(0));
    expect(created.pointerId).toBe(token(0));
  });

  it("a patch naming a resolved field sets it to that write's token; any other patch keeps it", () => {
    const before = row();
    expect(before.pointerId).toBe(token(0)); // the lease write kept it
    const renewing: RegistryPatch[] = [
      { currentGen: 4 },
      { currentGen: 3 },
      { status: 'destroyed' },
      { wrappedDeks: [{ keyId: 'k', wrapped: 'd3JhcHBlZA==' }] },
      { keyId: 'k2' },
      { keyId: undefined },
      { summary: undefined },
    ];
    for (const patch of renewing) {
      expect(applyRegistryPatch(before, patch, 3, token(2)).pointerId, JSON.stringify(patch)).toBe(
        token(2),
      );
    }
    const keeping: RegistryPatch[] = [
      { leases: undefined },
      { retention: { expiresAt: 5 } },
      { residency: { region: 'eu' } },
      { keptGens: [] },
      {},
    ];
    for (const patch of keeping) {
      expect(applyRegistryPatch(before, patch, 3, token(2)).pointerId, JSON.stringify(patch)).toBe(
        token(0),
      );
    }
  });

  it('a patch naming the pointer at the value it has keeps the summary, the kept window and the leases', () => {
    const before = row();
    const after = applyRegistryPatch(before, renewPointer(before), 3, token(2));
    expect(after.pointerId).toBe(token(2));
    expect(after.token).toBe(token(2));
    expect(after.currentGen).toBe(3);
    expect(after.summary).toEqual(before.summary);
    expect(after.keptGens).toEqual(before.keptGens);
    expect(after.leases).toEqual(before.leases);
  });
});

describe('a caller cannot set it, nor the token', () => {
  it('a new record naming either is refused (ValidationError)', () => {
    for (const field of ['pointerId', 'token']) {
      expect(() =>
        validateNewRegistryRecord({ currentGen: 0, [field]: token(9) } as never),
      ).toThrow(ValidationError);
    }
  });

  it('a patch naming either is refused (ValidationError)', () => {
    for (const field of ['pointerId', 'token']) {
      expect(() => validateRegistryPatch({ [field]: token(9) } as never)).toThrow(ValidationError);
      expect(() => validateRegistryPatch({ [field]: token(9) } as never)).toThrow(field);
    }
  });
});

describe('pointerIdOf', () => {
  it('reads the field', () => {
    expect(pointerIdOf(row())).toBe(token(0));
  });

  it('refuses a row with none, as a registry built against an earlier contract returns (UnsupportedError)', () => {
    const without: Record<string, unknown> = { ...row() };
    delete without.pointerId;
    expect(() => pointerIdOf(without as unknown as RegistryRecord)).toThrow(UnsupportedError);
    expect(() => pointerIdOf(without as unknown as RegistryRecord)).toThrow(/pointerId/);
    expect(() => pointerIdOf({ ...row(), pointerId: '' })).toThrow(UnsupportedError);
  });
});
