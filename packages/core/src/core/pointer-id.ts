/**
 * A registry row's `pointerId`: which write set what the row resolves to.
 *
 * A read resolves a segment through five fields of its row: `currentGen` (the generation), `status` (a destroyed row
 * reads empty), `wrappedDeks` and `keyId` (the key), and `summary` (a count answered from the row). `pointerId` is the
 * token of the most recent write that named one of them: the row's create, or a compare-and-swap whose patch names any
 * of the five, at any value, the one it already has included. A write of the leases, the retention or residency policy
 * or the kept window leaves it as it was. So a reader that keys what it caches on a generation with the row's
 * `pointerId` keeps its cache across a lease or a policy write, and never keeps it across a write that changes what the
 * row resolves to.
 *
 * The registry sets it, never a caller: it is the token the registry gives that write, which the writer gets back, so a
 * writer knows its own new value without reading the row. It is compared by equality only, like the token, and is
 * never reused under one name, since a token is not. The shipped registries apply the rule in their shared record
 * builders; a third-party registry applies it through {@link renewsPointer}. Pure: no I/O.
 */
import { UnsupportedError } from './errors';
import type { RegistryPatch, RegistryRecord, Token } from './ports';

/** The fields a read resolves through: a patch that names any of them renews the row's `pointerId`. */
export const RESOLVED_FIELDS = [
  'currentGen',
  'status',
  'wrappedDeks',
  'keyId',
  'summary',
] as const satisfies readonly (keyof RegistryPatch)[];

/**
 * Whether a compare-and-swap of `patch` renews the row's `pointerId`: whether it names a resolved field, by presence
 * (`'field' in patch`), whatever the value, as every patch rule reads a patch.
 */
export function renewsPointer(patch: RegistryPatch): boolean {
  return RESOLVED_FIELDS.some((field) => field in patch);
}

/**
 * The patch that renews a row's `pointerId` and changes nothing a read resolves: the pointer, named at the value it
 * has. A same-value pointer keeps the summary and the kept window, which follow the pointer only when it changes value.
 */
export function renewPointer(row: Pick<RegistryRecord, 'currentGen'>): RegistryPatch {
  return { currentGen: row.currentGen };
}

/**
 * The row's `pointerId`, refusing a row that has none with {@link UnsupportedError}: a registry written against an
 * earlier port contract returns rows without it, and a reader that cannot tell which write set the row's resolution
 * cannot key a cache on it. A TypeScript registry fails to compile instead; this catches one in JavaScript.
 */
export function pointerIdOf(row: RegistryRecord): Token {
  const pointerId = (row as { readonly pointerId?: unknown }).pointerId;
  if (typeof pointerId !== 'string' || pointerId.length === 0) {
    throw new UnsupportedError(
      `the registry returned the row of "${row.segment}" with no pointerId: a registry must set it on every row ` +
        '(the token of the write that last named currentGen, status, wrappedDeks, keyId or summary; see ' +
        'renewsPointer in @cloudbitmaps/core/driver-kit)',
    );
  }
  return pointerId;
}
