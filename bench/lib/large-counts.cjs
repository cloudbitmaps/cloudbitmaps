'use strict';
/*
 * What the large suite's combines cost in storage requests, counted by running the real engine over the in-memory
 * backend on the layouts the suite will load.
 *
 * Like `range-counts.cjs`, nothing here restates the engine's rules: a count is taken by loading the operands, running
 * each verb on a store that has read nothing, and counting what the storage driver and the registry were asked. It
 * covers what that file does not: a union, the three `*Into` verbs repeated onto one destination, and the size of every
 * object, which sets the parts of a multipart upload and the most range requests a read of it can make.
 *
 * What it counts of a load is what a materialising verb's load makes. A `store.load()` makes one request more on S3, a
 * HeadObject that checks the generation's number is free, which the in-memory driver does not model and a verb's
 * publish does not make: the operands' loads are counted by `firstLoadRequests`, not here.
 */
const { partsOf } = require('./calibrate-large-stages.cjs');

/** One storage and registry backend, with each request the engine makes of it counted. */
async function countedBackend(engine) {
  const { CloudRoaring, MemoryStorage } = engine ?? (await import('@cloudbitmaps/roaring'));
  const backend = new MemoryStorage();
  const calls = {};
  const zero = () => {
    for (const k of [
      'pointer',
      'tail',
      'range',
      'rangeBytes',
      'create',
      'swap',
      'list',
      'put',
      'putBytes',
    ]) {
      calls[k] = 0;
    }
  };
  zero();
  const count = (target, name, onCall) => {
    const original = target[name].bind(target);
    target[name] = (...args) => {
      onCall(args);
      return original(...args);
    };
  };
  count(backend.storage, 'getTail', () => {
    calls.tail += 1;
  });
  count(backend.storage, 'getRange', (a) => {
    calls.range += 1;
    calls.rangeBytes += a[2];
  });
  count(backend.storage, 'list', () => {
    calls.list += 1;
  });
  const putImmutable = backend.storage.putImmutable.bind(backend.storage);
  backend.storage.putImmutable = async (...args) => {
    const written = await putImmutable(...args);
    calls.put += 1;
    calls.putBytes = written.size;
    return written;
  };
  count(backend.registry, 'get', () => {
    calls.pointer += 1;
  });
  count(backend.registry, 'create', () => {
    calls.create += 1;
  });
  count(backend.registry, 'compareAndSwap', () => {
    calls.swap += 1;
  });
  /** A store that has read nothing, with the counts reset. */
  const cold = () => {
    zero();
    return new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  };
  return {
    loader: new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } }),
    cold,
    calls,
    zero,
  };
}

const drain = async (stream) => {
  let n = 0;
  for await (const id of stream) {
    void id;
    n += 1;
  }
  return n;
};

/**
 * Count the large suite's requests for one size: `layout` holds the two operand segments (`layoutIds(layout, 0)` and
 * `layoutIds(layout, 1)`), `engine` is the library's module (`CloudRoaring`, `MemoryStorage`; the installed package when
 * omitted), and each `*Into` runs `intos` times onto one destination, so the first is a first load and
 * the rest are not.
 *
 * Returns the operands' object bytes; each cold read's requests by kind; and each `*Into`'s, per call: the requests of
 * the read and of the destination's load together, the output's bytes and so its parts.
 */
async function countSize({ layout, layoutIds, intos, engine }) {
  const { loader, cold, calls, zero } = await countedBackend(engine);
  const operandBytes = [];
  for (let i = 0; i < 2; i += 1) {
    zero();
    await loader.load({ segment: `s${i}` }, layoutIds(layout, i));
    operandBytes.push(calls.putBytes);
  }
  const read = (c) => ({
    pointer: c.pointer,
    tail: c.tail,
    range: c.range,
    rangeBytes: c.rangeBytes,
    gets: c.pointer + c.tail + c.range,
  });
  const reads = {};
  const verbs = {
    intersect: (s) => s.segment('s0').intersect([s.segment('s1')]),
    union: (s) => s.segment('s0').union([s.segment('s1')]),
    andNot: (s) => s.segment('s0').andNot([s.segment('s1')]),
  };
  for (const [name, stream] of Object.entries(verbs)) {
    const store = cold();
    const ids = await drain(stream(store));
    reads[name] = { ...read(calls), ids };
  }
  const into = {};
  const intoVerbs = {
    intersectInto: (s, d) => s.segment('s0').intersectInto(d, [s.segment('s1')]),
    unionInto: (s, d) => s.segment('s0').unionInto(d, [s.segment('s1')]),
    andNotInto: (s, d) => s.segment('s0').andNotInto(d, [s.segment('s1')]),
  };
  for (const [name, run] of Object.entries(intoVerbs)) {
    into[name] = [];
    for (let g = 0; g < intos; g += 1) {
      const store = cold();
      const result = await run(store, store.segment(`d-${name}`));
      if (!result.published) throw new Error(`${name} was refused: ${result.reason}`);
      const objectBytes = calls.putBytes;
      const parts = partsOf(objectBytes);
      into[name].push({
        ids: result.cardinality,
        objectBytes,
        parts,
        // The object is one PUT, or a create, its parts and a complete; the pointer is a create the first time and a
        // swap after; a listing, which bills as a PUT, only when the load collects.
        put: (parts === 0 ? 1 : parts + 2) + calls.create + calls.swap + calls.list,
        // The read's pointers, tails and ranges and the load's pointer reads: what the in-memory driver was asked.
        get: calls.pointer + calls.tail + calls.range,
        first: g === 0,
      });
    }
  }
  return { operandBytes, reads, into };
}

module.exports = { countSize, countedBackend };
