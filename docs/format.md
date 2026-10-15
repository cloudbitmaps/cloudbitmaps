# The `.crbm` format

This page is the reference for what a CloudBitmaps generation looks like in storage: every byte of the object, the
registry row that points at it, and the rules a reader follows to stay safe when it meets bytes it does not
understand. It is for someone writing a reader or a port in another language, and for anyone reasoning about what a
version change means.

> **The format is not frozen yet; it freezes at 1.0.** Until then the object layout and the registry row can change
> in a minor release, and a store moves to such a release by exporting its segments and loading them again (see
> [Versioning and compatibility](#11-versioning-and-compatibility)). From 1.0 the layout, the meaning of every field
> and the mechanisms for extending it are a SemVer promise.

## Contents

1. [What a generation is](#1-what-a-generation-is)
2. [The preamble](#2-the-preamble)
3. [The chunk payload region](#3-the-chunk-payload-region)
4. [The extension block](#4-the-extension-block)
5. [The index](#5-the-index)
6. [The footer](#6-the-footer)
7. [Checksums](#7-checksums)
8. [Encryption at rest](#8-encryption-at-rest)
9. [Identity: fingerprint, pins and the known-generations ledger](#9-identity-fingerprint-pins-and-the-known-generations-ledger)
10. [The registry row, schema 5](#10-the-registry-row-schema-5)
11. [Versioning and compatibility](#11-versioning-and-compatibility)
12. [Reserved fields and what is not decided before the freeze](#12-reserved-fields-and-what-is-not-decided-before-the-freeze)
13. [The golden corpus](#13-the-golden-corpus)

## How to read this page

Every statement here is read from the code in `packages/core/src` (the `.crbm` codec in
[`core/crbm/`](../packages/core/src/core/crbm/format.ts), the registry codec in
[`drivers/_shared/registry.ts`](../packages/core/src/drivers/_shared/registry.ts)), and every file in
[`tests/golden/`](../tests/golden) decodes as this page describes. Two labels separate what a port may
rely on from what this release happens to do:

- **Layout** is the format itself: the byte positions, widths and meanings. Layout is what freezes at 1.0.
- **Writer today** and **Reader today** are the behaviour of this release's code: what it writes, and what it checks
  or refuses. A later minor release can write other values where the layout allows them, and a reader of your own
  should accept what the layout allows, not only what the writer happens to write. Where a reader today is stricter
  than the layout needs, the text says so.

Notation. `u8`, `u16`, `u32` and `u64` are unsigned integers, **little-endian** throughout. `a ‖ b` is the bytes of
`a` followed by the bytes of `b`. A **varint** is an unsigned LEB128 integer of at most 5 bytes whose value fits in 32
bits: seven bits per byte, low bits first, the high bit of a byte set when another byte follows. Offsets are from the
start of the object, and the first byte is offset 0.

## 1. What a generation is

A **segment** is a named set of 32-bit ids. Its data lives in **generations**: each is one immutable object holding
the whole set as it was at one load. A load writes a new generation and then moves the segment's pointer (a field of
its registry row, [section 10](#10-the-registry-row-schema-5)) to it with a compare-and-swap. The library never
changes an object after it is complete: an erasure or a later load writes another generation.

**Object key.** Layout of the key on an object store (S3, GCS, Azure Blob):

```
<prefix><namespace>/segments/<segment>.<generation>.crbm
```

- `<prefix>` is the caller's key prefix with no leading or trailing slash, followed by `/`, or nothing when there is
  none.
- `<namespace>` and `<segment>` are the caller's names, each encoded with the object-key name codec: every character
  outside `A-Z a-z 0-9 . _ : -` is written as `%XX` for each of its UTF-8 bytes (uppercase hex), `%` itself is written
  `%25`, and a **leading** `_` is written `%5F`. An absent namespace is the literal `_default`; the leading-underscore
  rule is what keeps a caller's own `_default` (written `%5Fdefault`) from reaching it.
- `<generation>` is a non-negative integer in canonical decimal: no sign, no leading zeros. A key whose middle is not
  canonical, or that names another segment sharing the prefix, is not a generation of this segment.

The local-filesystem driver stores the same object at `<root>/<namespace>/segments/<segment>.<generation>.crbm`, with
a path-safe variant of the codec (it also escapes `:`, a Windows device-name stem and a trailing dot).

**Layout.**

```
offset 0                                                             size-104         size
 │                                                                       │               │
 ▼                                                                       ▼               ▼
 ┌──────────┬────────────────────────────┬──────────────┬─────────────┬────────────────┐
 │ preamble │ chunk payloads             │ extension    │ index       │ footer         │
 │ 8 bytes  │ one per non-empty chunk,   │ block        │ one entry   │ 104 bytes,     │
 │ §2       │ ascending by chunk key     │ (optional)   │ per chunk   │ fixed          │
 │          │ §3                         │ §4           │ §5          │ §6             │
 └──────────┴────────────────────────────┴──────────────┴─────────────┴────────────────┘
            ▲                            ▲              ▲
            offset 8                     payloads end   footer.indexOffset
                                         here (the block's start when
                                         there is a block)
```

A reader opens an object from its **tail**: it reads the last bytes of the object (the library asks for 256 KiB by
default, which holds the footer, the index and any extension block for nearly every object) and finds everything else
from the footer. The footer says where the index is; the extension block, when the footer's flag says there is one,
ends exactly where the index begins; payloads are read later, one range each, from offsets the index gives. This is
why the index and the footer sit at the end: their offsets are not known until every payload has been written, so a
writer streams payloads with constant memory and writes the index last.

**The chunk model.** A 32-bit id is split in two: its top 16 bits are the **chunk key** (0 to 65,535) and its low 16
bits are the **remainder**. A generation stores one payload per chunk that holds at least one id; an empty chunk is
never written. A generation with no chunks at all is valid: its object is the 8-byte preamble, an empty index and the
footer, 112 bytes.

**Size of an object.** The smallest object is 112 bytes (preamble plus footer). Offsets and lengths are `u64`, so an
object can pass 4 GiB. Fields that hold a size are read as JavaScript safe integers (up to 2^53 − 1); a reader in
another language should refuse a value past what it can represent exactly.

## 2. The preamble

The first 8 bytes of the object.

| Offset | Width | Field | Meaning |
|---:|---:|---|---|
| 0 | 4 | `magic` | the ASCII bytes `CRBM`: `43 52 42 4D` |
| 4 | 1 | `versionMajor` | the format's major version; 1 |
| 5 | 1 | `versionMinor` | the format's minor version; 0 |
| 6 | 2 | `reserved` | written as zero |

- **Layout.** The footer repeats `magic`, `versionMajor` and `versionMinor`, and the footer is the authority: a reader
  needs the preamble only to recognise a file from its first bytes. Chunk payloads start at offset 8.
- **Writer today.** Writes `CRBM`, 1, 0 and two zero bytes.
- **Reader today.** Never reads bytes 6 and 7. Compares the first six bytes with the footer, and refuses a
  disagreement with an `IntegrityError`, only when its first read happens to cover offset 0 (an object that fits in the
  tail read). A larger object is opened without looking at the preamble.

## 3. The chunk payload region

The chunk payloads sit between the preamble and the extension block (or the index, when there is no block). Each is a
byte range that the index describes by offset and length ([section 5](#5-the-index)); nothing in the region says where
one payload ends.

- **Writer today.** Payloads follow one another with no gap, in ascending chunk-key order, starting at offset 8. The
  region ends at `indexOffset` or, with an extension block, at the block's first byte.
- **Reader today.** Takes each payload's position from the index alone. The index can encode a gap between payloads
  ([section 5](#5-the-index)), so a reader written for the layout does not assume payloads are adjacent. It requires
  each payload to lie wholly inside the region, which ends where the extension block begins.

**What a payload is.** The footer's `payloadCodecId` ([section 6](#6-the-footer)) says which codec wrote the payloads.
The only id defined is **1, Roaring portable**. A payload under codec 1, cleartext, is the standard **portable
serialization of a 32-bit Roaring bitmap**, as the
[Roaring format specification](https://github.com/RoaringBitmap/RoaringFormatSpec) defines it, holding the chunk's
**remainders** (values 0 to 65,535). Any Roaring library reads it with its ordinary portable deserializer; the id is
`(chunkKey << 16) + value` for each value in the bitmap.

Because every value is below 65,536, a payload holds exactly one container, under container key 0. In the portable
format that gives three shapes, and the writer picks the smallest with ties going to the array, as Roaring does:

| Container | When | Bytes of the payload |
|---|---|---|
| array | up to 4,096 values | `3A 30 00 00` ‖ `01 00 00 00` ‖ `00 00` ‖ `u16(card−1)` ‖ `10 00 00 00` ‖ the values as ascending `u16` |
| bitset | more than 4,096 values | the same 16-byte header ‖ 8,192 bytes (65,536 bits) |
| run | when its runs are smaller than the array | `3B 30 00 00` ‖ `01` ‖ `00 00` ‖ `u16(card−1)` ‖ `u16(runs)` ‖ for each run `u16(start)` ‖ `u16(length−1)` |

The array and bitset headers are the cookie `12346` (`0x303A`), a container count of 1, the container's key (0) and
`cardinality − 1`, then the offset to the body (16). The run form is the cookie `12347` (`0x303B`, whose upper half
holds `count − 1 = 0`), one byte of run flags (bit 0 set), the key and `cardinality − 1`; with fewer than four
containers the portable format has no offset header. The golden file `v1.0-load.crbm`
([section 13](#13-the-golden-corpus)) holds all three: a 4-value array is 24 bytes, a 4,097-value bitset is 8,208, and
1,000 consecutive values as one run is 15.

- **Element width.** The footer's `elementWidth` is 32: ids are 32-bit and split 16/16 as above. 64 is reserved for a
  future major version ([section 12](#12-reserved-fields-and-what-is-not-decided-before-the-freeze)).
- **Container codec.** The footer's `containerCodec` is 0, *none*: the payload is the codec's bytes as they are, with
  no further transform. Any other value is refused.
- **Cardinality.** The index records each chunk's cardinality, between 1 and 65,536 ([section 5](#5-the-index)). The
  codec's own count is not compared with it when a payload is decoded: a payload whose bits disagree with its entry
  decodes to what it holds, and `count()` still answers the entry's number. A writer of your own must write them equal.
- **Decoding limits.** A reader of this library refuses a payload longer than 1 MiB, and checks a payload's structure
  (containers in ascending key order, array values strictly ascending, runs ascending and not touching, a bitset's
  popcount equal to its stated cardinality) before it hands the bytes to a decoder, because a native decoder checks
  only that it does not read past the buffer.
- **Encrypted.** An encrypted payload is `nonce ‖ ciphertext ‖ tag` in place of the bytes above
  ([section 8](#8-encryption-at-rest)): 28 bytes longer than the cleartext payload.

The codec is a field of the container, not of the format: `.crbm` is a shared container, and only the payload bytes
belong to a codec. Ids are permanent once published, and none is reserved for a codec that does not exist.

## 4. The extension block

An optional block between the last payload and the index. It holds typed sections the object may carry; today the one
section type is a generation's metadata.

**Layout.**

```
                  ┌── sections: 0 or more, strictly ascending by type ──┐┌──────── trailer, 12 bytes ────────┐
 ... payloads ... │ type u8 │ length u32 │ body │ type u8 │ length u32 │ ... ││ sectionsLength u32 │ crc u32 │ "CRBX" │ index ...
                  └──────────────────────────────────────────────────────┘└────────────────────────────────────┘
                  ▲ extStart = indexOffset − 12 − sectionsLength            ▲ indexOffset − 12                   ▲ indexOffset
```

| Part | Width | Meaning |
|---|---:|---|
| section `type` | 1 | the section's type; 0 is not a type |
| section `length` | 4 | the byte length of the body |
| section body | `length` | the section's bytes |
| trailer `sectionsLength` | 4 | the total length of all the sections, headers included, not counting the trailer |
| trailer `crc` | 4 | CRC32C ([section 7](#7-checksums)) of the sections ‖ `sectionsLength` (the bytes `[extStart, indexOffset − 8)`) |
| trailer `magic` | 4 | the ASCII bytes `CRBX`: `43 52 42 58` |

- **Presence.** The block is present exactly when the footer's `FLAG_EXTENSION` flag (bit 3, `0x08`) is set. A reader
  finds it from `indexOffset` alone: the trailer is the 12 bytes before the index, and `extStart` follows from
  `sectionsLength`. Chunk payloads end at `extStart`. A writer sets the flag only when there is something to put in the
  block, so an object with no metadata is the same bytes as an object written without the mechanism.
- **Size cap.** `sectionsLength` is at most **4,096** bytes (4 KiB), the sections only. A reader refuses a larger block
  from the trailer alone. A writer of any 1.x minor stays within the cap, so a section added later is still readable
  by this reader's size rule.
- **Sections.** The sections fill the region `[extStart, indexOffset − 12)` exactly. Types are in strictly ascending
  order: type 0, a repeated type and a type out of order are all refused. A section may not run past the region. **A
  reader skips the body of a section type it does not know** (after checking its header, its order and its length), so
  a section must be safe to ignore. A meaning every reader has to understand needs a footer flag bit of its own, which
  an older reader refuses ([section 6](#6-the-footer)).
- **Reader today.** When the flag is set, the block must be wholly valid, and a reader raises an `IntegrityError` for a
  flag with no room for a block, a trailer without `CRBX`, a block over the cap or out of bounds, a bad CRC, a section
  header that is cut off, a section out of order or running past the block, and metadata that breaks its rules. A reader
  reads the block together with the index, from the tail read or from the same range read, and makes one more request
  only when the tail ends inside the block.
- **What the block does not carry.** In a cleartext object the footer's CRC does not cover the block's bytes
  ([section 7](#7-checksums)), and the encrypted metadata's authentication does not stop whoever can write the object
  from removing the block and clearing the flag: the object then reads as one with no metadata.

**Section type 1: the generation's metadata.** A flat record of string and finite-number values, at most 1 KiB, stored
as its **canonical JSON** in UTF-8.

- The canonical form is RFC 8785 (the JSON Canonicalization Scheme) for one flat object of string and finite-number
  values: keys sorted by UTF-16 code unit, strings escaped as ECMAScript's `JSON.stringify` escapes them, numbers
  written as ECMAScript's `Number.prototype.toString` writes them (`-0` is `0`, `1e21` is `1e+21`, `5e-7` stays
  `5e-7`), and no whitespace. A language's ordinary JSON writer differs in places (Python writes `1e-07`; Go and Rust
  sort keys by code point), so [`tests/golden/metadata-canonical.json`](../tests/golden/metadata-canonical.json) holds
  vectors to check a port against.
- A reader accepts the bytes only if they are **exactly** the canonical form of a non-empty record: whitespace, a key
  out of order or listed twice, or a number or escape spelled another way is refused. A generation with empty metadata
  carries no block at all.
- The rules: at most 1,024 bytes of canonical JSON, braces and quotes included; keys non-empty, well-formed UTF-16, at
  most 128 UTF-8 bytes each, and not `__proto__`; values strings (well-formed UTF-16) or finite numbers; no nesting.
- Encrypted, the body is `nonce(12) ‖ ciphertext ‖ tag(16)` under the segment's key with the metadata scope of the
  associated data ([section 8](#8-encryption-at-rest)): between 29 and 1,052 bytes.

## 5. The index

The index is a run of entries, one per chunk, in ascending chunk-key order. It is found from the footer's `indexOffset`
and `indexLength` and fills its region exactly.

**Entry layout.** An entry is four varints and a fixed `u32`:

| Field | Encoding | Meaning |
|---|---|---|
| `keyDelta` | varint | this chunk's key minus the previous entry's key; for the first entry the previous key is 0, so the first entry's delta is its key |
| `gap` | varint | the number of bytes between the end of the previous payload and the start of this one; for the first entry the previous end is 8, the end of the preamble |
| `length` | varint | the length of the stored payload in bytes |
| `cardinality` | varint | the number of ids in the chunk, 1 to 65,536 |
| `crc32c` | `u32` | CRC32C of the stored payload bytes ([section 7](#7-checksums)) |

A decoder keeps two running values, `key = 0` and `end = 8`, and for each entry computes:

```
key    = key + keyDelta
offset = end + gap
end    = offset + length
```

so the payload is the bytes `[offset, offset + length)`. The CRC is fixed-width because a CRC is high-entropy and does
not shrink as a varint; the cardinality is a varint because 65,536 does not fit a `u16`.

- **Size.** An entry is 8 to 24 bytes: four varints of 1 to 5 bytes each, plus 4. The index of a generation of `n`
  chunks is the sum of its entries; there is no header, count or terminator, so the decoder reads until it has consumed
  `indexLength` bytes exactly, and a partial trailing entry is an error.
- **Ordering.** Keys strictly ascend: after the first entry a `keyDelta` of 0 is a duplicate and is refused; a key past
  65,535 is refused. A generation has at most 65,536 entries.
- **Writer today.** `gap` is always 0, so each payload starts where the previous one ended.
- **Reader today.** Accepts any `gap`. Refuses an entry whose `length` is 0 (cleartext) or under 28 (encrypted, the
  nonce and tag), or over the payload cap (1 MiB, plus 28 on an encrypted object); whose `cardinality` is outside 1 to
  65,536; or whose payload would end past the payload region. Because gaps are unsigned, payloads ascend and cannot
  overlap. A reader refuses an index region over 8 MiB, and sizes its tables from the region's length, never from a
  count the bytes claim.
- **Where the reader finds it.** From the footer: the index is `[indexOffset, indexOffset + indexLength)`. It must start
  at or after offset 8 and end at or before `size − 104`; the reader accepts bytes between the index's end and the
  footer, which the writer does not write.
- **Encrypted.** The stored index is the AES-256-GCM ciphertext of the entries above, the same length as the
  plaintext, with the nonce and tag in the footer ([section 8](#8-encryption-at-rest)). The index CRC is over the stored
  (encrypted) bytes. Each entry's `crc32c` covers the stored payload, the nonce and tag included.

## 6. The footer

The last 104 bytes of the object. Its position is fixed, so a reader finds it from the object's size alone.

| Offset | Width | Field | Type | Meaning |
|---:|---:|---|---|---|
| 0 | 8 | `indexOffset` | `u64` | where the index begins |
| 8 | 8 | `indexLength` | `u64` | the byte length of the index region as stored |
| 16 | 4 | `indexCrc32c` | `u32` | CRC32C of the stored index bytes |
| 20 | 4 | `flags` | `u32` | feature bits, below |
| 24 | 2 | `payloadCodecId` | `u16` | which codec wrote the chunk payloads; 1 is Roaring portable |
| 26 | 1 | `elementWidth` | `u8` | bits per id; 32 |
| 27 | 1 | `containerCodec` | `u8` | a transform over each payload; 0 is none |
| 28 | 1 | `versionMajor` | `u8` | the format's major version; 1 |
| 29 | 1 | `versionMinor` | `u8` | the format's minor version; 0 |
| 30 | 2 | `reserved2` | `u16` | reserved; written as zero |
| 32 | 8 | `generation` | `u64` | the generation number the object was written as |
| 40 | 12 | `indexNonce` | bytes | the index's AEAD nonce when encrypted, else zero |
| 52 | 16 | `indexTag` | bytes | the index's AEAD tag when encrypted, else zero |
| 68 | 16 | `keyId` | bytes | reserved; written as zero |
| 84 | 4 | `chunkCount` | `u32` | the number of index entries; zero when encrypted |
| 88 | 8 | `totalCardinality` | `u64` | the sum of every entry's cardinality; zero when encrypted |
| 96 | 4 | `footerCrc32c` | `u32` | CRC32C of footer bytes `[0, 96)` |
| 100 | 4 | `endMagic` | bytes | the ASCII bytes `CRBM` |

**Flags.** `flags` is a `u32` of independent bits:

| Bit | Mask | Name | Meaning |
|---:|---:|---|---|
| 0 | `0x01` | `FLAG_ENCRYPTED` | the payloads, the index and any metadata section are sealed ([section 8](#8-encryption-at-rest)) |
| 1 | `0x02` | reserved | no meaning; a writer leaves it clear |
| 2 | `0x04` | `FLAG_LITTLE_ENDIAN` | integers are little-endian; set by every writer, and a reader refuses an object without it |
| 3 | `0x08` | `FLAG_EXTENSION` | an extension block sits before the index ([section 4](#4-the-extension-block)) |
| 4 to 31 | | reserved | no meaning; a writer leaves them clear |

**The rule for an unknown bit.** A reader refuses an object that sets a bit it does not know, with an
`UnsupportedError`, rather than read past what it cannot see. This holds for the reserved bits 1 and 4 to 31 today. A
bit added later therefore means "a reader that does not understand this must stop", which is the mechanism for a change
that cannot be ignored. (A change that can be ignored is a new extension section type.)

**Field rules.**

- **`indexOffset`, `indexLength`.** Together they bound the index ([section 5](#5-the-index)). A reader refuses a value
  past 2^53 − 1.
- **`payloadCodecId`.** A reader accepts the ids it can decode (today only 1) and refuses any other with an
  `UnsupportedError` that names the id, so a reader built for one codec fails closed on another's generation.
- **`elementWidth`.** A reader refuses any value but 32 with an `UnsupportedError`. A 64-bit generation is a future
  major version, not a silent minor one.
- **`containerCodec`.** A reader refuses any value but 0.
- **`versionMajor`.** A reader refuses any value but its own major version, 1, with an `UnsupportedError` ([section
  11](#11-versioning-and-compatibility)).
- **`versionMinor`.** Written as 0. A reader does not branch on it today.
- **`reserved2`.** Written as zero and not read.
- **`generation`.** The number in the object's key; a generation is self-describing. A reader opening an object under a
  key refuses it with an `IntegrityError` when the footer names another generation. A value past 2^53 − 1 is refused.
- **`indexNonce`, `indexTag`.** Cleartext: all zero bytes. Encrypted: the index's nonce and tag
  ([section 8](#8-encryption-at-rest)).
- **`keyId`.** All zero bytes in every object written today; not read. The wrapped keys live in the registry row, not in
  the object.
- **`chunkCount`, `totalCardinality`.** Cleartext: the number of index entries and the sum of their cardinalities, and a
  reader checks both against the index (a mismatch is an `IntegrityError`), so `count()` of a cleartext generation is
  answerable from the footer with no index read. Encrypted: both are zero, so a leaked object reveals neither how many
  chunks nor how many ids it holds, and a reader refuses an encrypted footer whose values are not zero; the reader
  derives both from the decrypted index.
- **`footerCrc32c`.** Covers footer bytes `[0, 96)`: every field above, the CRC of the index (and through it every
  entry's CRC), the flags, the generation, the nonce and the tag. It **does not cover** the CRC field itself, the
  `endMagic`, the preamble, or the extension block. A reader checks `endMagic` and then this CRC before it trusts any
  other footer field.

**Check order today.** `endMagic`, then `footerCrc32c`, then `versionMajor`, then (a missing key on an encrypted object
is a `ValidationError`), then the little-endian flag, then unknown flag bits, then `elementWidth`, `payloadCodecId` and
`containerCodec`, then (a key given for an object that is not encrypted is an `IntegrityError`), then the index bounds and
the index CRC.

## 7. Checksums

Every checksum in the object is **CRC-32C** (Castagnoli): polynomial `0x1EDC6F41` (reflected `0x82F63B78`), initial
value `0xFFFFFFFF`, input and output reflected, final XOR `0xFFFFFFFF`. It is the checksum SSE 4.2, iSCSI and Btrfs use.
The check value is `CRC32C("123456789") = 0xE3069283`. A stored CRC is a little-endian `u32`; a fingerprint writes it
in decimal. The library's implementation is a table-driven one in plain TypeScript (slicing by 8); the output is the
standard algorithm's.

| Checksum | Stored at | Covers | Checked |
|---|---|---|---|
| per-chunk CRC | the index entry's last 4 bytes | the payload exactly as stored: for an encrypted object, `nonce ‖ ciphertext ‖ tag` | before a payload is decrypted or deserialized |
| index CRC | footer offset 16 | the index region exactly as stored (ciphertext when encrypted) | when an object is opened |
| extension CRC | the block's trailer, bytes 4 to 7 | the sections ‖ `sectionsLength` | when an object with the flag is opened |
| footer CRC | footer offset 96 | footer bytes `[0, 96)` | first, when an object is opened |

The chain of commitment: the footer CRC covers the index CRC, the index CRC covers every entry, and each entry holds
its payload's CRC. So the footer CRC commits, as far as a CRC can, to every id and to the object's shape. A CRC detects
damage; it does not authenticate. Whoever can write the object can write a consistent set of CRCs, and the AEAD of an
encrypted object ([section 8](#8-encryption-at-rest)) is what authenticates there.

## 8. Encryption at rest

An object is encrypted or it is not, as a whole: the footer's `FLAG_ENCRYPTED` bit says which, and a segment's
objects are all one or all the other. A reader opening an encrypted object needs the segment's data key; one that is
given a key for an object that is not encrypted refuses the object with an `IntegrityError`, and one that is not given
a key for an encrypted object raises a `ValidationError`.

**The cipher.** AES-256-GCM with a 12-byte nonce and a 16-byte tag, the nonce drawn at random for each seal. The key is
a per-segment 32-byte data key (DEK), shared by every generation of the segment.

**What is sealed**, each as its own AEAD message:

| Part | Stored form | Nonce and tag |
|---|---|---|
| each chunk payload | `nonce(12) ‖ ciphertext ‖ tag(16)` in place of the payload | inline, at the ends of the payload |
| the index | the ciphertext alone, in the index region | the footer's `indexNonce` and `indexTag` |
| the metadata section | `nonce(12) ‖ ciphertext ‖ tag(16)` as the section body | inline |
| the registry summary | base64 of `nonce(12) ‖ ciphertext ‖ tag(16)` ([section 10](#10-the-registry-row-schema-5)) | inline |

**Associated data.** Every message is bound to where it lives by authenticated, unstored associated data, so a message
moved to another segment, generation, chunk or scope fails to open. The bytes:

```
0x01 ‖ u16 len(namespace) ‖ namespace ‖ u16 len(segment) ‖ segment ‖ u64 generation ‖ u8 scope ‖ u32 chunkKey
```

- `namespace` and `segment` are the caller's names as raw UTF-8 (not the key-encoded form), and an absent namespace is
  the empty string.
- `generation` is the generation number.
- `scope` is 0 for a chunk payload, 1 for the index, 2 for the metadata section and 3 for a registry summary.
- `chunkKey` is the chunk's key for scope 0 and 0 for every other scope.

A summary's `generation` is its own generation; the other scopes use the object's.

**Wrapping the key.** The row's `wrappedDeks` ([section 10](#10-the-registry-row-schema-5)) holds the data key wrapped
under one or more key-encryption keys (KEKs): a list of `{ keyId, wrapped }`, one entry per KEK, where `wrapped` is
base64 of `nonce(12) ‖ ciphertext ‖ tag(16)`, the AES-256-GCM seal of the 32-byte data key under the KEK with the UTF-8
bytes of `keyId` as associated data, so a wrapping cannot be relabelled to another KEK. Discarding the list leaves the
segment's bytes unreadable. The footer's `keyId` field stays zero.

**What a reader without the key can still read.** The preamble, and every field of the footer, in the clear: the flags,
the generation, the object's size and the index's length and CRC, so it can check the footer CRC and the index CRC and
compute the object's fingerprint ([section 9](#9-identity-fingerprint-pins-and-the-known-generations-ledger)). It
cannot read the index (so not the number of chunks, their keys, sizes or cardinalities), the payloads, or the
metadata. The extension block's framing (its trailer and its section types and lengths) stays visible, so the presence
of a metadata section and its length are visible; its contents are not. The `chunkCount` and `totalCardinality` fields
are zero, so neither is leaked.

## 9. Identity: fingerprint, pins and the known-generations ledger

**The fingerprint** names one object by its bytes:

```
<size>:<footerCrc>
```

`size` is the object's length in bytes and `footerCrc` is the footer's `footerCrc32c`, each in canonical decimal (no sign,
no leading zeros). The golden file `v1.0-basic.crbm` is `145:3558123930`. A fingerprint is valid when the size is a
safe integer of at least 112 and the CRC fits in 32 bits. Two objects with the same fingerprint hold the same chunks, as
far as a CRC can tell. A fingerprint does not name a writer: another writer's object with the same bytes matches too.
Because the footer is stored in the clear, a reader computes the fingerprint of an encrypted object with no key, from
one read of a footer's worth of bytes. Compare fingerprints for equality; do not interpret them.

**Why a generation is never identified by its number alone.** A generation number is a counter a segment's loads
advance, and it is not unique over time:

- a segment whose row is purged and whose bucket is emptied starts again at 0, so a re-created name serves different data
  at a number the old one used;
- after a rollback, the numbers above the pointer are taken again by the next load.

So `(segment, generation)` can name two different objects at different times. Everything that has to know *which
object* carries the fingerprint, or the footer CRC that is half of it, beside the number:

```
 the object      "<size>:<footerCrc>"        ← what names the bytes
      ▲
      │ compared against, on every open of that number
      │
 ┌────┴───────────────────────┬───────────────────────────────┬──────────────────────────────┐
 │ row summary                │ known-generations entry       │ pin                          │
 │ { generation, fingerprint, │ { generation, footerCrc }     │ { generation, version,       │
 │   ... }                    │                               │   fingerprint }              │
 │ vouches for the current    │ vouches for a generation the  │ reopens the object a read    │
 │ generation's object        │ row made current              │ held, and refuses another    │
 └────────────────────────────┴───────────────────────────────┴──────────────────────────────┘
```

- **The summary** ([section 10](#10-the-registry-row-schema-5)) records the current generation's fingerprint. A reader
  checks every object it opens for the row's generation against it and refuses one that is another object under the
  number.
- **The `knownGens` entry** records `{ generation, footerCrc }`: the footer checksum half, because the size is not
  needed to tell two objects under one number apart once the ledger knows the number. A rollback moves only onto a
  generation the row knows, and an object whose footer carries another checksum is another object under that number.
- **A pin** records the generation, the driver's version of the object and the fingerprint. A pinned read checks the
  object against the fingerprint with one footer-sized read ([`sameObject`](guide/api-reference.md)): another size is
  another object, and at the same size the footer CRC decides.
- **`pointerId`** ([section 10](#10-the-registry-row-schema-5)) is the identity of the row's *resolution*: the token of
  the last write that changed what a read resolves through. A reader keys what it caches on a generation with it, so a
  lease or policy write leaves a warm cache standing while any write that changes the resolution never does.

## 10. The registry row, schema 5

A segment's **registry row** is the authoritative record of where the segment's current generation is. There is exactly
one row per segment. The generation's object stays the truth about its own contents; the row's summary and ledger are
copies and caches of it.

**Where a row is stored.** One JSON document per segment, the **envelope**:

```json
{ "schemaVersion": 5, "deleted": false, "record": { ... } }
```

| Envelope field | Type | Meaning |
|---|---|---|
| `schemaVersion` | integer | the row's schema; 5. A write always stamps it |
| `deleted` | boolean | `true` marks a tombstone: the row is kept, with its counter advanced, so a re-create continues the counter; a reader treats a tombstone as absent. On a store whose conditional delete the backend honours, a delete removes the object instead and nothing is left |
| `record` | object | the row, below |

An envelope with another field is refused with an `IntegrityError`.

| Driver | Where the envelope lives |
|---|---|
| S3 | an object `<prefix>registry/<namespace>/<segment>.reg`, `Content-Type: application/json`; create with `If-None-Match: *`, swap and conditional delete with `If-Match: <etag>` |
| GCS | the same key; create with `ifGenerationMatch: 0`, swap with `ifGenerationMatch: <generation>` |
| Azure Blob | the same key; create with `If-None-Match: *`, swap with `If-Match: <etag>` |
| local filesystem | a file `<root>/<namespace>/registry/<segment>.reg`, written to a temporary file, synced, atomically renamed, and the directory synced |
| in-memory | not persisted, and holds the same record in memory |

The three object stores share one codec and one key layout: `registry/` first, then the encoded namespace (`_default`
for none), then the encoded segment, then `.reg`, with the name codec of [section 1](#1-what-a-generation-is). A listing
of `<prefix>registry/` finds every segment, and `<prefix>registry/<namespace>/` one namespace. A row is read with a
1 MiB ceiling. The conditional write is what makes the pointer swap atomic: a store that accepts the precondition and
ignores it turns the swap into last-write-wins.

**The record, field by field.**

| Field | Type | Meaning |
|---|---|---|
| `namespace` | string, optional | the caller's namespace; absent for none. The row must name the segment it is stored under |
| `segment` | string | the segment's name; at most 256 characters once encoded |
| `currentGen` | integer or `null` | the pointer: the generation reads resolve to, a non-negative safe integer. `null` says the segment exists and has no generation yet; a row can exist before the first load |
| `status` | `"active"` or `"destroyed"` | `destroyed` is the tombstone left by a crypto-shred; the segment reads as empty |
| `wrappedDeks` | array, optional | the wrapped data keys of an encrypted segment ([section 8](#8-encryption-at-rest)): 1 to 8 entries `{ keyId, wrapped }`, both non-empty strings, `wrapped` at most 4,096 characters. Absent means the segment is cleartext |
| `keyId` | string, optional | reserved: an external key reference for a future key-management adapter; unused today |
| `summary` | object, optional | a cached description of the current generation, below |
| `knownGens` | array, optional | the generations the row knows it made current, below |
| `leases` | array, optional | the leases that keep a generation out of collection, below |
| `retention` | object, optional | a governance policy: a plain JSON object of at most 64 KiB. The key `expiresAt`, an epoch-millisecond number, is the one with meaning: once it has passed, a retention sweep may retire the segment. Every other key is the caller's and is kept |
| `residency` | object, optional | the same shape as `retention`; stored and returned, with no meaning attached |
| `createdAt` | integer | epoch milliseconds the row was created |
| `updatedAt` | integer | epoch milliseconds of the last write |
| `token` | string | the row's version for compare-and-swap, below |
| `pointerId` | string | the token of the last write that named a field a read resolves through, below |

A record with a field not in this list is refused with an `IntegrityError`; a field with no value is omitted from the
JSON.

**`token`.** Opaque to a caller, compared by equality. A shipped registry writes it as
`<incarnation>.<counter>.<write>`: 32 lowercase hex digits drawn when the row is created (its **incarnation**), a decimal
counter that every write advances by one and that carries on across a tombstone, and 16 lowercase hex digits drawn for
every write. The incarnation tells a re-created name from its earlier incarnations even when their rows are gone; the
write part tells a row restored from a backup from the tokens it had before. A token in another form is an
`IntegrityError` on read.

**`pointerId`.** The same form. A read resolves a segment through five fields: `currentGen`, `status`, `wrappedDeks`,
`keyId` and `summary`. `pointerId` is the token of the row's create or of the latest compare-and-swap whose patch named
any of the five, at any value, the one it already had included. A write that names only `leases`, `retention`,
`residency` or `knownGens` leaves it. A stored `pointerId` of another incarnation than the token, or with a higher
counter than the token's, is refused.

**`summary`.** A copy, written by the same write that moves the pointer, naming the generation it describes and used
only for that generation, on an active row. It takes one of two shapes, which the row's keys decide: clear on a row with
no `wrappedDeks`, sealed on a row with them. A summary of the wrong shape for its row is ignored by a reader.

| Shape | Fields |
|---|---|
| clear | `generation`; `cardinality` (0 to 2^32); `fingerprint` ([section 9](#9-identity-fingerprint-pins-and-the-known-generations-ledger)); `tailBytes`; `metadata` (the generation's metadata, omitted when it has none, never empty) |
| sealed | `generation`; `sealed`, padded standard base64 of `nonce(12) ‖ ciphertext ‖ tag(16)` |

`tailBytes` is the number of bytes from the end of the last chunk payload to the end of the object: the extension block
if there is one, the index and the footer. A cold open reads that many bytes from the object's end to open the
generation in one request. It is an integer from 104 to the object's size less 8, and at most 8,392,820 (an 8 MiB index
cap, a 4 KiB block, the 12-byte trailer and the 104-byte footer). For the golden file `v1.0-basic.crbm` it is 130:
145 − 15.

A sealed summary's plaintext is, in order: the cardinality as a `u64`, the object's size as a `u64`, its footer CRC as a
`u32`, `tailBytes` as a `u32`, then the metadata's canonical JSON if there is any. Every number is fixed-width, so the
ciphertext's length reveals only the metadata's size. The associated data is the summary scope (3) of
[section 8](#8-encryption-at-rest), with the summary's own generation. The base64 is canonical: its padding bits are
zero.

**`knownGens`.** The ledger of generations the row made current: an array of exactly `{ generation, footerCrc }`, the
generation a non-negative safe integer and unique, `footerCrc` an integer from 0 to 2^32 − 1 (the second half of that
object's fingerprint). Order is the order the generations were made current, oldest first, **the current one last**; a
generation appears once, at its most recent time current. The entries before the last are the kept window, the
generations a live lease holds, and what a rollback left; those numbered above `currentGen` are what a rollback left.
It is in the clear on every row, an encrypted one included: a footer checksum of an encrypted object covers a random
nonce and says nothing about its content. A writer writes at most 192 entries and a reader accepts 384; a writer
refuses a list whose last entry is not `currentGen`, or whose last entry's checksum disagrees with a clear summary's
fingerprint; a stored list that disagrees with its row is read and not used. A patch that moves `currentGen` without
naming the ledger drops it, as it drops the summary, so a writer that forgets the ledger leaves a row that lists the
bucket and never one that vouches for a generation it should not.

**`leases`.** An array of exactly `{ holder, generation, until }`: `holder` is 16 lowercase hex digits, unique in the
list; `generation` a non-negative safe integer; `until` an epoch-millisecond number the lease runs to on the holder's
clock. A collector holds a leased generation until the lease ends, plus a margin for clock skew. A writer writes at most
64 entries and a reader accepts 256; a row with no pointer holds none. A write that moves `currentGen` leaves the list
as it was.

**An example,** a cleartext row (the numbers are those of `v1.0-load.crbm`, [section 13](#13-the-golden-corpus)):

```json
{
  "schemaVersion": 5,
  "deleted": false,
  "record": {
    "namespace": "acme",
    "segment": "shoppers",
    "currentGen": 3,
    "status": "active",
    "retention": { "expiresAt": 1893456000000 },
    "summary": {
      "generation": 3,
      "cardinality": 70647,
      "fingerprint": "8505:4208818",
      "tailBytes": 167,
      "metadata": { "owner": "campaigns" }
    },
    "knownGens": [
      { "generation": 2, "footerCrc": 123456 },
      { "generation": 3, "footerCrc": 4208818 }
    ],
    "createdAt": 1790000000000,
    "updatedAt": 1790000100000,
    "token": "00112233445566778899aabbccddeeff.4.0123456789abcdef",
    "pointerId": "00112233445566778899aabbccddeeff.4.0123456789abcdef"
  }
}
```

An encrypted row has `wrappedDeks`, and its `summary` is `{ "generation": 3, "sealed": "<base64>" }`.

**An unknown schema version.** A reader refuses a row it does not read, and the whole listing that reaches it:

| The stamp | What a reader does |
|---|---|
| absent | `IntegrityError`: the row has no `schemaVersion` |
| not an integer of at least 1 | `IntegrityError`: the stamp is malformed |
| below 5 | `UnsupportedError`: "registry row schemaVersion N is one this build does not read: it reads schema 5 only. Export the segments with the release that wrote the row and load them with this one into a new prefix", naming the row's key and the changelog entry that gives the steps |
| above 5 | `UnsupportedError`: "registry row schemaVersion N is newer than this build reads (v5)", naming the row's key |

A listing that reaches a row it refuses stops with the row's error, naming its key: skipping the row would hide a
segment from the sweeps that decide which objects are still referenced.

## 11. Versioning and compatibility

There are two version numbers: the **object format** (`versionMajor` and `versionMinor` in the footer, 1.0 today) and
the **row schema** (`schemaVersion` in the envelope, 5 today). They move independently.

**What a reader does today.**

| It meets | It does | Error |
|---|---|---|
| a footer whose `versionMajor` is not its own (1) | refuses; a newer major says to upgrade, an older says no release writes that version | `UnsupportedError` |
| a `versionMinor` | does not branch on it | none |
| a footer flag bit it does not know (including the reserved ones), or without the little-endian bit | refuses | `UnsupportedError` |
| an `elementWidth`, `payloadCodecId` or `containerCodec` it does not know | refuses, naming the value | `UnsupportedError` |
| an extension section type it does not know | skips the body, after checking its header, order and length | none |
| an extension block that is malformed, or a flag with no valid block | refuses | `IntegrityError` |
| a footer, index, block or payload whose CRC or bounds fail | refuses; the message ends "re-load from source or roll back" | `IntegrityError` |
| a registry row whose `schemaVersion` is not 5 | refuses ([section 10](#10-the-registry-row-schema-5)) | `UnsupportedError`, or `IntegrityError` when the stamp is absent or malformed |
| a registry record or envelope with a field it does not declare | refuses | `IntegrityError` |

**Before 1.0.** The format and the row can change in a minor release. A change that makes the stored bytes of one
release unreadable by the next is listed under **Breaking** in the [changelog](../CHANGELOG.md), and a store moves by
**exporting its segments with the release that wrote them and loading them with the new one into a new prefix**: there
is no upgrade in place and no downgrade, and the rows of one prefix are all of one release. The changelog's Breaking
entries on registry schemas 4 and 5 give the steps and say what stays behind.

**What freezing at 1.0 means.** From 1.0 these become a SemVer promise:

- the object layout of sections 2 to 6, the byte position, width and meaning of every field, and the codec ids already
  published;
- the flag mechanism and the extension-section mechanism: a reader skips a section type it does not know, refuses a
  flag bit it does not know, and a writer of any 1.x minor keeps an extension block within 4 KiB;
- the registry row's schema: its envelope and the meaning of every field of schema 5;
- the identity rules of [section 9](#9-identity-fingerprint-pins-and-the-known-generations-ledger).

**How a 1.x release can add to the format.** Only through the mechanisms the layout already has: a new **extension
section type** for something a reader can ignore, and a new **footer flag bit** for something it cannot (an older
reader then refuses the object, which is the point). A new row field is a change to the schema and is refused by a
reader that does not declare it, so it is also a stamped change. **A change of meaning is a new major version**: moving
a field, narrowing a width, reusing a bit or a codec id, or reading an existing field differently. A major bump is
refused by every older reader with the typed error above.

## 12. Reserved fields and what is not decided before the freeze

These are the places the format leaves open. None carries meaning today, and the freeze fixes what each may mean
before 1.0.

| Where | Today | Open until the freeze |
|---|---|---|
| footer `flags` bit 1 and bits 4 to 31 | written clear; an object that sets one is refused | which bits get meanings, and in what order |
| footer `reserved2` (offset 30) | written zero, not read | whether it keeps a meaning of its own or joins the flag space |
| preamble bytes 6 and 7 | written zero, not read | the same |
| footer `keyId` (offset 68, 16 bytes) | written zero, not read; the wrapped keys are in the row | whether it names a key in the object or stays reserved |
| row `keyId` | optional string, unused | the external-key-reference semantics, if any |
| row `residency` | stored and returned | any semantics; today it has none |
| footer `versionMinor` | written 0, not branched on | what a minor bump changes for a reader, if anything |
| `elementWidth` other than 32 | refused | 64-bit ids, which are a future major version |
| `payloadCodecId` other than 1 | refused | ids are permanent once published; none is reserved ahead of a codec |
| `containerCodec` other than 0 | refused | a container-level transform, if one is ever defined |
| extension section types 2 to 255 | skipped | which sections exist; type 0 is never a section |

A per-write nonce in a footer slot is planned; a separate change will define it.

## 13. The golden corpus

[`tests/golden/`](../tests/golden) holds the objects any other implementation should decode, and reproduce, to show it
reads this format. Each is checked in this repository both ways: the writer must produce the file's bytes exactly from
its inputs, and the reader must decode it back to those inputs. The corpus does not change after a release: if a check
fails after a code change, the format changed, which needs a new format version, not a regenerated file.

| File | Size | Generation | Fingerprint | Contents |
|---|---:|---:|---|---|
| `v1.0-basic.crbm` | 145 | 7 | `145:3558123930` | three chunks, keys 0, 256 and 4096, of cardinalities 3, 1 and 2 (6 in all); payloads are the opaque bytes `de ad be ef`, `01 02` and `ff`, which pin the container, not a codec; no metadata, cleartext |
| `v1.0-metadata.crbm` | 220 | 7 | `220:3739725468` | the same chunks and an extension block holding the canonical JSON `{"def":"v41","landedAt":1790000000000,"owner":"campaigns"}`; the footer sets `FLAG_EXTENSION` |
| `v1.0-metadata-encrypted.crbm` | 332 | 7 | `332:940636896` | the same, encrypted: payloads, index and metadata sealed with AES-256-GCM under the key bytes `00 01 02 … 1f`, namespace `golden`, segment `metadata`; written under a counter nonce so the bytes repeat |
| `v1.0-load.crbm` | 8,505 | 0 | `8505:4208818` | what `store.load()` wrote from a fixed set of ids: seven real Roaring payloads (keys 0, 1, 2, 3, 4, 7 and 65,535) of 4, 4,097, 1,000, 3, 5, 65,536 and 2 ids, 70,647 in all, covering an array, a bitset, a run, two run-versus-array ties, a full chunk and the top of the id space; cleartext |
| `metadata-canonical.json` | | | | the canonical-JSON vectors for the metadata section: each input, the canonical text it must become and that text's UTF-8 bytes |

The three `basic`/`metadata` files use payload bytes that are not a Roaring bitmap on purpose: they pin the container
(preamble, index, footer, block, sealing), and `v1.0-load.crbm` pins the payload codec.

**Decoding `v1.0-basic.crbm` by hand.** The whole object, 145 bytes (`xxd` of the file):

```
00000000: 4352 424d 0100 0000 dead beef 0102 ff00  CRBM............
00000010: 0004 038e 77dc f180 0200 0201 529f f803  ....w.......R...
00000020: 801e 0001 0200 0000 ff0f 0000 0000 0000  ................
00000030: 001a 0000 0000 0000 0062 899d 5804 0000  .........b..X...
00000040: 0001 0020 0001 0000 0007 0000 0000 0000  ... ............
00000050: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000060: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000070: 0000 0000 0000 0000 0000 0000 0003 0000  ................
00000080: 0006 0000 0000 0000 009a a914 d443 5242  .............CRB
00000090: 4d                                       M
```

1. **Footer.** The last 104 bytes are offsets 41 to 144. They end in `43 52 42 4d` (`CRBM`). `footerCrc32c` is at footer
   offset 96, offset 137: `9a a9 14 d4`, so `0xD414A99A` = 3,558,123,930; CRC32C of footer bytes 0 to 95 is that
   value, and with the size the fingerprint is `145:3558123930`.
2. **Read the fields.** `indexOffset` (footer 0) = 15, `indexLength` (8) = 26, `flags` (20) = `04`: little-endian only,
   no encryption, no block. `payloadCodecId` (24) = 1, `elementWidth` (26) = `20` = 32, `containerCodec` (27) = 0,
   version 1.0, `generation` (32) = 7, `chunkCount` (84) = 3, `totalCardinality` (88) = 6.
3. **The index** is the 26 bytes at offsets 15 to 40, whose CRC32C is the footer's `indexCrc32c`. Its entries:

   | Bytes | keyDelta | gap | length | cardinality | crc32c |
   |---|---:|---:|---:|---:|---|
   | `00 00 04 03 8e 77 dc f1` | 0, so key 0 | 0 | 4 | 3 | `f1dc778e` |
   | `80 02 00 02 01 52 9f f8 03` | `80 02` = 256, so key 256 | 0 | 2 | 1 | `03f89f52` |
   | `80 1e 00 01 02 00 00 00 ff` | `80 1e` = 3,840, so key 4,096 | 0 | 1 | 2 | `ff000000` |

4. **Locate the payloads.** `end` starts at 8. Entry 1: offset 8 + 0 = 8, length 4: bytes `de ad be ef`; `end` = 12. Entry
   2: offset 12, length 2: `01 02`; `end` = 14. Entry 3: offset 14, length 1: `ff`; `end` = 15, which is `indexOffset`,
   so there is no extension block and no gap.
5. **Check.** The CRC32C of each payload equals its entry's; the cardinalities sum to 6, which is `totalCardinality`;
   the entries number 3, which is `chunkCount`.

For `v1.0-metadata.crbm` (220 bytes) the footer's flags are `0x0C` (little-endian and extension) and `indexOffset` is
90. The 12 bytes before it are the trailer: `3f 00 00 00` (63 bytes of sections), a CRC, and `CRBX`. The block starts at
90 − 12 − 63 = 15, right after the payloads, with the section header `01 3a 00 00 00` (type 1, 58 bytes) and then the 58
bytes of canonical JSON. For `v1.0-metadata-encrypted.crbm` (332 bytes) the flags are `0x0D`, the footer's `chunkCount`
and `totalCardinality` are zero, the index nonce at footer offset 40 is `00 00 00 00 00 00 00 00 00 00 00 05` with the tag
after it, each payload is 28 bytes longer than its cleartext (the nonce is the first 12 bytes), and the associated data
is built as in [section 8](#8-encryption-at-rest).
