/**
 * Audit sink (Phase 5d) — an injected, no-op-by-default seam for **security/compliance** events, distinct
 * from the metrics sink (5a). Different audience (an audit log / SIEM, not a dashboard), different retention,
 * and only the compliance-relevant *state changes* — never routine reads/writes (that's the metrics sink).
 * It doubles as the GDPR Art. 30 "record of processing" surface: publishes, compactions, and erasures.
 *
 * Like `Clock`/`Rng`/`IMetricsSink`, it's injected (into the lifecycle operations that emit — compaction,
 * bulk-load, erasure) and wrapped exception-safe, so a buggy sink can never break the operation it observes.
 * Events are vendor-neutral and carry no timestamp/actor — the sink runs synchronously at the event, so it
 * stamps its own time / attaches the caller identity (keeps `core/` free of ambient time). As with metrics,
 * `segment`/`namespace` are caller-controlled strings that may be PII — treat them accordingly when routing.
 *
 * Not (yet) emitted: **KEK rotation** — rotation here is operator-side keystore reconfiguration (key-id-tagged
 * wrappings, no data re-encryption), so there is no library call to hook. A future `rewrapSegment()` op would
 * add a `kek.rotate` variant; until then, audit key changes at your keystore-config layer.
 */

/** A security/compliance-relevant state change. Vendor-neutral; the sink adds its own timestamp/actor. */
export type AuditEvent =
  | {
      /** A new immutable Cold generation *became the segment's current generation* (via bulk-load publish). */
      readonly kind: 'segment.publish';
      readonly namespace?: string;
      readonly segment: string;
      readonly generation: number;
    }
  | {
      /** Compaction committed a new generation (emitted at the durable commit, before Warm-row purge). */
      readonly kind: 'segment.compact';
      readonly namespace?: string;
      readonly segment: string;
      readonly generation: number;
    }
  | {
      /**
       * A segment was **crypto-shredded** — its wrapped DEK(s) are gone, so its at-rest Cold bytes are now
       * permanently unreadable. Emitted only for a genuine key shred, never for a cleartext tombstone (which
       * leaves the Cold bytes readable) or an idempotent re-run.
       */
      readonly kind: 'segment.erase';
      readonly namespace?: string;
      readonly segment: string;
    }
  | {
      /**
       * A segment was **disposed of** — tombstoned and its storage reclaimed (Warm rows + Cold generations
       * deleted) by `dropSegment`, *without* a key shred.
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
       * `generationsDeleted` is how many Cold generations went. It can be 0 (a segment whose bytes were already
       * gone), and it does not promise the storage is now fully reclaimed: check `DropResult.generationsRemaining`
       * for that.
       */
      readonly kind: 'segment.dispose';
      readonly namespace?: string;
      readonly segment: string;
      readonly generationsDeleted: number;
    }
  | {
      /** A namespace erasure was executed. `segmentsShredded` is the count actually crypto-shredded (may be 0). */
      readonly kind: 'namespace.erase';
      readonly namespace: string;
      readonly segmentsShredded: number;
    };

/** The `kind` discriminant of an {@link AuditEvent}. */
export type AuditEventKind = AuditEvent['kind'];

/** Sink for {@link AuditEvent}s. Injected via the lifecycle options; the default is {@link NOOP_AUDIT}. */
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
 * strictly observation. Returns {@link NOOP_AUDIT} unchanged (so the no-op case skips even the try/catch alloc).
 */
export function safeAudit(sink: IAuditSink): IAuditSink {
  if (sink === NOOP_AUDIT) return sink;
  return {
    onEvent(event: AuditEvent): void {
      try {
        sink.onEvent(event);
      } catch {
        /* swallow — an audit sink must never break the operation it observes */
      }
    },
  };
}

/** A ready-made sink that records events into an in-memory list — handy for tests + simple audit trails. */
export class RecordingAuditSink implements IAuditSink {
  private readonly recorded: AuditEvent[] = [];

  onEvent(event: AuditEvent): void {
    this.recorded.push(event);
  }

  /** An independent copy of the recorded events, in emission order. */
  snapshot(): AuditEvent[] {
    return this.recorded.map((e) => ({ ...e }));
  }

  reset(): void {
    this.recorded.length = 0;
  }
}
