/**
 * Audit sink — an injected, no-op-by-default seam for **security/compliance** events, distinct
 * from the metrics sink (`IMetricsSink`). Different audience (an audit log / SIEM, not a dashboard), different
 * retention, and only the compliance-relevant *state changes* — never routine reads/writes (that's the metrics
 * sink). It doubles as the GDPR Art. 30 "record of processing" surface: publishes, refused loads, rollbacks,
 * rewrites, an erasure's deletion of the generations holding an id, crypto-shreds and disposals.
 *
 * Like `Clock`/`Rng`/`IMetricsSink`, it's injected (into the operations that emit — a load, the `*Into`
 * verbs, a rollback, the erasure rewrite, crypto-shred, disposal and the retention sweep) and wrapped
 * exception-safe, so a buggy sink can never break the operation it observes.
 * Events are vendor-neutral and carry no timestamp/actor — the sink runs synchronously at the event, so it
 * stamps its own time / attaches the caller identity (keeps `core/` free of ambient time). As with metrics,
 * `segment`/`namespace` are caller-controlled strings that may be PII — treat them accordingly when routing.
 *
 * Not (yet) emitted: **KEK rotation** — rotation here is operator-side keystore reconfiguration (key-id-tagged
 * wrappings, no data re-encryption), so there is no library call to hook. A future `rewrapSegment()` op would
 * add a `kek.rotate` variant; until then, audit key changes at your keystore-config layer.
 */

import { ValidationError } from './errors';

/**
 * A security/compliance-relevant state change. Vendor-neutral; the sink adds its own timestamp/actor.
 *
 * Every event about a segment carries `incarnation`: the id of the registry row's incarnation the operation acted on.
 * A segment's name can be purged and created again, and its generations then start again at `0`, so a segment and a
 * generation number alone can name two different generations; with the incarnation they name one. It is absent when
 * the row's token carries no incarnation id, as a registry of the caller's own may issue tokens in another form, and on
 * a `segment.load-refused` from a load that found no row.
 */
export type AuditEvent =
  | {
      /** A new immutable Storage generation *became the segment's current generation*, by a load's publish. */
      readonly kind: 'segment.publish';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row whose pointer the publish moved. */
      readonly incarnation?: string;
      readonly generation: number;
    }
  | {
      /**
       * A segment's pointer was moved by a rollback to a generation still in the bucket that the caller named:
       * **backwards**, or forward with `allowForward`, which undoes an earlier rollback.
       *
       * The only non-forward-only pointer move in the library, and the only one no automatic path can perform —
       * a human decided the current generation was wrong and named the one they wanted. Every other pointer move
       * can be reconstructed from "a load happened"; this one is someone overriding the ordering rule the rest of
       * the system relies on, which is precisely what an incident review or an Art. 30 record wants to find.
       *
       * `fromGeneration` is `null` when the segment had a row but no current generation.
       */
      readonly kind: 'segment.rollback';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row whose pointer the rollback moved. */
      readonly incarnation?: string;
      readonly fromGeneration: number | null;
      readonly generation: number;
    }
  | {
      /**
       * A load was **refused**: it did not publish, because its result failed a guard or another writer got there
       * first. The security-relevant fact is that a replacement the caller asked for did NOT happen, which a
       * downstream system reconciling "the segment should now contain X" needs as much as it needs the publish.
       *
       * `reason` is `'empty'` (an empty result over a non-empty segment, with no `allowEmpty`),
       * `'min-cardinality'`, `'min-retained'`, `'max-growth'`, or `'superseded'` (another load took the generation number, or the
       * segment's registry row changed while the load was writing). `cardinality` is what the refused generation
       * would have contained, and `0` for a load that lost its generation number and wrote nothing.
       *
       * `unanswered` is present, and `true`, on a `'superseded'` refusal whose registry write ended without an answer
       * before the row was found to have moved on: that write may have landed, so the generation may have been the
       * segment's current one for a while before another writer replaced it. The refusal says only that it is not
       * current now. Absent when every write the load made was answered.
       */
      readonly kind: 'segment.load-refused';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row the load read before it wrote; absent when it found no row. */
      readonly incarnation?: string;
      readonly generation: number;
      readonly reason: 'empty' | 'min-cardinality' | 'min-retained' | 'max-growth' | 'superseded';
      readonly cardinality: number;
      readonly unanswered?: true;
    }
  | {
      /**
       * A generation was **rewritten**: a new generation derived from `fromGeneration` became current in its
       * place. Today the one emitter is `eraseIdFromSegment` (a subject erasure clearing one id), and the event is
       * emitted at the publish — before the superseded generation is collected — so the record exists the moment
       * the generation without the id is authoritative. A `segment.publish` is NOT also emitted for a rewrite: a
       * rewrite derives its content from the segment itself, a publish brings content in from outside. An erasure
       * that finds the id only outside the current generation rewrites nothing and emits `segment.collect`.
       */
      readonly kind: 'segment.rewrite';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row the rewrite read `fromGeneration` from and published on. */
      readonly incarnation?: string;
      readonly fromGeneration: number;
      readonly generation: number;
    }
  | {
      /**
       * An erasure of one id **deleted the generations that held it** and rewrote none, because the generation the
       * pointer names does not hold it. Two cases reach it: an id that only older generations hold (someone who
       * left the segment, whose bit the reader grace window or a rollback target keeps), and objects left under a
       * tombstone (a cleartext destroy, or a drop whose sweep left one). The one emitter is `eraseIdFromSegment`, once
       * a listing of the bucket shows no generation holding the id, so the record exists only for a finished erasure;
       * one that ends otherwise throws or reports `erased: false`, and its re-run emits.
       *
       * `fromGeneration` is the newest generation found holding the id. `collected` is every generation this call
       * deleted, ascending: below the pointer that is every generation, holder or not, since the deletion takes them
       * all, and above it only the holders. A holder another collection deleted first is not in it.
       */
      readonly kind: 'segment.collect';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row the erasure read: the active row, or the tombstone. */
      readonly incarnation?: string;
      readonly fromGeneration: number;
      readonly collected: readonly number[];
    }
  | {
      /**
       * A segment was **crypto-shredded** — its wrapped DEK(s) are gone, so its at-rest Storage bytes are now
       * permanently unreadable. Emitted only for a genuine key shred, never for a cleartext tombstone (which
       * leaves the Storage bytes readable) or an idempotent re-run.
       */
      readonly kind: 'segment.erase';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the row the shred turned into a tombstone. */
      readonly incarnation?: string;
    }
  | {
      /**
       * A segment was **disposed of** — tombstoned and its storage reclaimed (its Storage generations deleted) by
       * `dropSegment`, *without* a key shred.
       *
       * Deliberately a separate kind from {@link AuditEvent} `segment.erase`, and the distinction is the point.
       * `segment.erase` attests that bytes are unreadable **everywhere, backups included** — the only claim that
       * survives WORM. Deleting an object is strictly weaker: a noncurrent version, a cross-region replica or a
       * PITR snapshot can still hold the cleartext. Emitting one kind for both would make a compliance dashboard
       * over-attest, so a cleartext drop gets this instead.
       *
       * An **encrypted** segment dropped via `dropSegment` emits **both** — `segment.erase` for the key shred and
       * this for the storage reclamation — because both things genuinely happened.
       *
       * `generationsDeleted` is how many Storage generations went. It can be 0 (a segment whose bytes were already
       * gone), and it does not promise the storage is now fully reclaimed: check `DropResult.generationsRemaining`
       * for that.
       */
      readonly kind: 'segment.dispose';
      readonly namespace?: string;
      readonly segment: string;
      /** The incarnation of the tombstone the drop wrote or found. */
      readonly incarnation?: string;
      readonly generationsDeleted: number;
    }
  | {
      /** A namespace erasure was executed. `segmentsShredded` is the count actually crypto-shredded (may be 0). */
      readonly kind: 'namespace.erase';
      readonly namespace: string;
      readonly segmentsShredded: number;
    };

/** Sink for {@link AuditEvent}s. Injected via the lifecycle options; omit it and nothing is recorded. */
export interface IAuditSink {
  onEvent(event: AuditEvent): void;
}

/** The default sink: records nothing. */
export const NOOP_AUDIT: IAuditSink = {
  onEvent(): void {
    /* discard */
  },
};

/**
 * Wrap a sink so a throwing/buggy `onEvent` can never break the lifecycle operation it observes — audit is
 * strictly observation. That covers an `async onEvent` that rejects, whose rejection would otherwise surface as an
 * unhandled one, which ends a Node process by default. Returns {@link NOOP_AUDIT} unchanged (so the no-op case
 * skips even the try/catch alloc).
 */
export function safeAudit(sink: IAuditSink): IAuditSink {
  if (sink === NOOP_AUDIT) return sink;
  return {
    onEvent(event: AuditEvent): void {
      try {
        ignoreRejection(sink.onEvent(event) as unknown);
      } catch {
        /* swallow — an audit sink must never break the operation it observes */
      }
    },
  };
}

/**
 * Refuse an `audit` that is not a sink. One without an `onEvent` method (a bare callback, a method named `emit`) would
 * receive nothing and say nothing, since {@link safeAudit} swallows what calling it throws. Called at the top of each
 * entry that takes one, before anything irreversible; `undefined` and `null` read as none.
 */
export function checkedAuditSink(sink: unknown, op: string): void {
  if (sink === undefined || sink === null) return;
  if (typeof (sink as { onEvent?: unknown }).onEvent !== 'function') {
    throw new ValidationError(
      `${op}: audit must be a sink with an onEvent(event) method, such as a RecordingAuditSink`,
    );
  }
}

/** Observe the rejection of what a sink's `onEvent` returned, when it returned a promise, so it is never unhandled. */
export function ignoreRejection(returned: unknown): void {
  if (typeof (returned as { then?: unknown } | null | undefined)?.then === 'function') {
    (returned as PromiseLike<unknown>).then(undefined, () => {
      /* swallow — a sink must never break the operation it observes, later included */
    });
  }
}

/** A ready-made sink that records events into an in-memory list — handy for tests + simple audit trails. */
export class RecordingAuditSink implements IAuditSink {
  private readonly recorded: AuditEvent[] = [];

  onEvent(event: AuditEvent): void {
    this.recorded.push(event);
  }

  /** An independent copy of the recorded events, in emission order. */
  snapshot(): AuditEvent[] {
    return this.recorded.map((e) =>
      e.kind === 'segment.collect' ? { ...e, collected: [...e.collected] } : { ...e },
    );
  }

  reset(): void {
    this.recorded.length = 0;
  }
}
