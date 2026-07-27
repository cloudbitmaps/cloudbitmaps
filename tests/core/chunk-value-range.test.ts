import { RoaringBitmap32, SerializationFormat } from 'roaring';
import { roaringCodec } from '@/roaring-codec';
import { decodeDelta, encodeDelta, emptyDelta } from '@/core/chunk';
import { joinId, MAX_REMAINDER } from '@/core/bit-route';
import { IntegrityError } from '@/core/errors';

// A chunk payload holds REMAINDERS — 16-bit offsets within one chunk. Nothing enforced that: the byte/length
// caps bound size, and CRC/AEAD only prove the bytes are the bytes that were written, which anyone able to
// write the tier satisfies. A value >= 65536 then reached `joinId`, which masks it and emitted a FABRICATED id
// in a different chunk's id space — indistinguishable from real data, inflating count() and creating spurious
// intersect matches. Invariant 5 says every byte read back from a tier is untrusted; this was the one place
// "well-formed" was assumed rather than checked.
//
// NOTE ON PLACEMENT. The first attempt put this check inside `SafeBitmap.safeDeserialize` and broke two tests
// immediately: that is the codec's GENERAL entry point, also used for full-segment exports where u32 values
// are entirely legitimate. The 16-bit rule belongs where a payload is interpreted AS A CHUNK — the warm-delta
// decode here, and the cold-chunk read in the engine — not in the codec.
const CAP = 1 << 20;

/** Hand-build a warm delta row whose `adds` half carries an illegal value, bypassing every writer guard. */
function forgeDeltaRow(addValues: number[]): Uint8Array {
  const adds = new RoaringBitmap32(addValues).serialize(SerializationFormat.portable);
  const removes = new RoaringBitmap32([]).serialize(SerializationFormat.portable);
  const out = new Uint8Array(1 + 4 + adds.length + removes.length);
  const legit = encodeDelta(emptyDelta(roaringCodec)); // borrow the real version byte + header layout
  out[0] = legit[0] as number;
  new DataView(out.buffer).setUint32(1, adds.length, true);
  out.set(adds, 5);
  out.set(removes, 5 + adds.length);
  return out;
}

describe('chunk payload value range', () => {
  it('rejects a warm delta whose adds half holds a value past the remainder range', () => {
    const row = forgeDeltaRow([1, 2, 70_000]);
    expect(() => decodeDelta(row, CAP, roaringCodec)).toThrow(IntegrityError);
    expect(() => decodeDelta(row, CAP, roaringCodec)).toThrow(/70000/);
  });

  it('accepts the boundary value and rejects boundary + 1', () => {
    expect(() => decodeDelta(forgeDeltaRow([MAX_REMAINDER]), CAP, roaringCodec)).not.toThrow();
    expect(() => decodeDelta(forgeDeltaRow([MAX_REMAINDER + 1]), CAP, roaringCodec)).toThrow(
      IntegrityError,
    );
  });

  it('accepts an ordinary round-tripped delta (no false positives)', () => {
    const d = emptyDelta(roaringCodec);
    d.adds.addMany([0, 5, MAX_REMAINDER]);
    d.removes.addMany([7]);
    const back = decodeDelta(encodeDelta(d), CAP, roaringCodec);
    expect(back.adds.toArray()).toEqual([0, 5, MAX_REMAINDER]);
    expect(back.removes.toArray()).toEqual([7]);
  });

  it('leaves the general codec entry point free to hold u32 values', () => {
    // Exports serialize a whole segment's ids, which legitimately exceed 16 bits. The check must NOT live here
    // — this assertion is what caught the first, wrong placement.
    const big = new RoaringBitmap32([100_000, 4_000_000_000]).serialize(
      SerializationFormat.portable,
    );
    expect(() => roaringCodec.safeDeserialize(big, CAP)).not.toThrow();
    expect(roaringCodec.safeDeserialize(big, CAP).toArray()).toEqual([100_000, 4_000_000_000]);
  });

  it('documents the fabrication that used to result', () => {
    // Why it mattered, concretely: the bad value did not error downstream — it became a real-looking id
    // belonging to a different chunk.
    expect(joinId(3, 70_000)).toBe(joinId(3, 70_000 & MAX_REMAINDER));
    expect(joinId(3, 70_000)).not.toBe(70_000);
  });

  it('exposes maximum() as O(1) on the roaring codec, so the check is per-chunk not per-id', () => {
    const b = roaringCodec.safeDeserialize(
      new RoaringBitmap32([1, 9, 4242]).serialize(SerializationFormat.portable),
      CAP,
    );
    expect(b.maximum?.()).toBe(4242);
    expect(roaringCodec.empty().maximum?.()).toBeUndefined();
  });
});
