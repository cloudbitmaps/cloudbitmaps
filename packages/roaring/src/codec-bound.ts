/**
 * Codec-bound wrappers over the public `@cloudbitmaps/core` entry points that need a bitmap codec.
 *
 * `core` is codec-agnostic and therefore cannot default the codec (the concrete codec lives *here*, in a package
 * that depends on core — a default over there would invert the dependency arrow). But an application using
 * `@cloudbitmaps/roaring` should never have to pass one. So this module re-binds each such entry point with
 * {@link roaringCodec} and the facade re-exports these **explicitly**, which shadows the same names coming from
 * `export * from '@cloudbitmaps/core'` (an explicit export always wins over a star export). Net effect: every
 * call signature is unchanged from before the family split — you can still call
 * `bulkLoadCrbmGeneration(driver, key, ids)` with no options at all.
 *
 * A caller who *wants* a different codec passes it explicitly; the binding only fills an absent one — via
 * `?? roaringCodec` rather than spread order, so an explicit `codec: undefined` still gets the binding
 * (`exactOptionalPropertyTypes` is off, so that call typechecks and must not fall through to the throw).
 */
import {
  bulkLoadCrbmGeneration as coreBulkLoad,
  compactSegment as coreCompactSegment,
  runCompactionCycle as coreRunCompactionCycle,
  runExport as coreRunExport,
} from '@cloudbitmaps/core';
import { roaringCodec } from './roaring-codec';

type BulkLoad = typeof coreBulkLoad;
type CompactSegment = typeof coreCompactSegment;
type RunCompactionCycle = typeof coreRunCompactionCycle;
type RunExport = typeof coreRunExport;

/** {@link coreBulkLoad} with the roaring codec pre-bound. */
export const bulkLoadCrbmGeneration: BulkLoad = (driver, key, ids, options = {}) =>
  coreBulkLoad(driver, key, ids, { ...options, codec: options.codec ?? roaringCodec });

/** {@link coreCompactSegment} with the roaring codec pre-bound. */
export const compactSegment: CompactSegment = (ref, deps, options) =>
  coreCompactSegment(ref, { ...deps, codec: deps.codec ?? roaringCodec }, options);

/** {@link coreRunCompactionCycle} with the roaring codec pre-bound. */
export const runCompactionCycle: RunCompactionCycle = (deps, options) =>
  coreRunCompactionCycle({ ...deps, codec: deps.codec ?? roaringCodec }, options);

/** {@link coreRunExport} with the roaring codec pre-bound (only the `'roaring'` format needs it). */
export const runExport: RunExport = (reader, registry, sink, options = {}) =>
  coreRunExport(reader, registry, sink, { ...options, codec: options.codec ?? roaringCodec });
