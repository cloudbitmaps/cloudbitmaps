'use strict';
/*
 * The requests of a refresh-shaped batch, counted: `store.materializeMany` against the same outputs written as one
 * `*Into` call each (a nested expression going through scratch segments), over the in-memory backend. The storage
 * driver and the registry are wrapped in place and every call they are asked is counted by kind, so the counts are
 * the requests the library makes, not an estimate of them; and they are written to `bench/materialize-many-counts.json`,
 * which the guide's and the changelog's figures are held to (`tests/docs/materialize-many-figures.test.ts`).
 *
 * Nothing here is measured on a cloud, and no time is recorded: a time on this machine is not a time on S3, and a
 * count is the one thing that does not depend on the machine. GET-class is range reads, tail reads and registry row
 * reads; PUT-class is object writes, registry writes and listings; deletes are counted apart, since they are free.
 *
 * Two shapes. `small` (20 operands, 100 outputs) is what CI recounts. `refresh` (100 operands of 200,000 ids and
 * 1,000 outputs, each a tree of one or two levels with the same opt-out list excluded) takes about a minute and a
 * half, so CI does not recount it; it is committed, and `--check --all` recounts it.
 *
 * Run: `pnpm build && node bench/materialize-many-counts.cjs` rewrites both shapes; `--shape refresh` (or `small`)
 * rewrites one and keeps the other; `--check` (what `pnpm bench:materialize-many-counts:check` runs) recounts `small` and
 * fails if the committed file differs; `--check --all` recounts both.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'materialize-many-counts.json');
const SHAPES = {
  small: { operands: 20, outputs: 100, idsPerOperand: 100_000 },
  refresh: { operands: 100, outputs: 1_000, idsPerOperand: 200_000 },
};

/** A seeded generator, so a count is the same on every machine. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}

function makeOperand(RoaringBitmap32, rnd, kind, ids) {
  const b = new RoaringBitmap32();
  if (kind === 0 || kind === 1) {
    for (let i = 0; i < ids; i++) b.add(Math.floor(rnd() * 2 ** 27));
  } else if (kind === 2) {
    const lo = Math.floor(rnd() * 2 ** 26);
    b.addRange(lo, lo + ids);
  } else {
    for (let r = 0; r < 200; r++) {
      const lo = Math.floor(rnd() * 2 ** 27);
      b.addRange(lo, lo + ids / 200);
    }
  }
  return b;
}

/** A tree of one or two levels of `and` / `or` / `andNot` over random operands. */
function makeTree(rnd, operands, depth) {
  const leaf = () => `op${Math.floor(rnd() * operands)}`;
  if (depth === 0 || rnd() < 0.25) return leaf();
  const kids = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () =>
    makeTree(rnd, operands, depth - 1),
  );
  const r = rnd();
  return r < 0.4 ? { and: kids } : r < 0.75 ? { or: kids } : { andNot: kids };
}

async function world(shape) {
  const { CloudRoaring, MemoryStorage } = await import('@cloudbitmaps/roaring');
  const { brandAsBackend } = await import('@cloudbitmaps/core/driver-kit');
  const roaring = require('roaring');
  const backend = new MemoryStorage();
  const calls = { range: 0, tail: 0, rowRead: 0, put: 0, rowWrite: 0, list: 0, delete: 0 };
  const wrap = (target, count) =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args) => {
          count(String(prop));
          return value.apply(t, args);
        };
      },
    });
  const storage = wrap(backend.storage, (m) => {
    if (m === 'getRange') calls.range++;
    else if (m === 'getTail') calls.tail++;
    else if (m === 'putImmutable') calls.put++;
    else if (m === 'list') calls.list++;
    else if (m === 'delete') calls.delete++;
  });
  const registry = wrap(backend.registry, (m) => {
    if (m === 'get') calls.rowRead++;
    else if (m === 'create' || m === 'compareAndSwap') calls.rowWrite++;
  });
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage, registry }),
    cache: { genTtlMs: 0 },
  });
  const rnd = lcg(777);
  for (let i = 0; i < shape.operands; i++) {
    await store.load(
      { segment: `op${i}` },
      { bitmap: makeOperand(roaring.RoaringBitmap32, rnd, i % 4, shape.idsPerOperand) },
    );
  }
  for (let i = 0; i < shape.outputs; i++) {
    await store.load({ segment: `d${i}` }, { bitmap: new roaring.RoaringBitmap32([1]) });
  }
  const reset = () => {
    for (const k of Object.keys(calls)) calls[k] = 0;
  };
  reset();
  const specs = [];
  const specRnd = lcg(99);
  for (let i = 0; i < shape.outputs; i++) {
    specs.push({
      expr: makeTree(specRnd, shape.operands, 1 + Math.floor(specRnd() * 2)),
      exclude: ['op0'],
    });
  }
  return { store, calls, specs, reset };
}

const classes = (calls) => ({
  rangeReads: calls.range,
  tailReads: calls.tail,
  rowReads: calls.rowRead,
  objectWrites: calls.put,
  rowWrites: calls.rowWrite,
  listings: calls.list,
  deletes: calls.delete,
  getClass: calls.range + calls.tail + calls.rowRead,
  putClass: calls.put + calls.rowWrite + calls.list,
});

async function countBatch(shape) {
  const w = await world(shape);
  const operands = Object.fromEntries(
    Array.from({ length: shape.operands }, (_, i) => [`op${i}`, w.store.segment(`op${i}`)]),
  );
  const run = await w.store.materializeMany({
    operands,
    outputs: w.specs.map((s, i) => ({ dest: w.store.segment(`d${i}`), ...s })),
    keep: 12,
    budget: false,
  });
  const r = run.stats.requests;
  return {
    published: run.outputs.filter((o) => o.published).length,
    groups: run.stats.groups,
    chunkReads: r.chunkReads,
    ledgerHighWaterBytes: run.stats.memory.highWaterBytes,
    ...classes(w.calls),
    attributed: {
      get: r.get,
      put: r.put,
      rangeReads: r.rangeReads,
      registryReads: r.registryReads,
    },
  };
}

async function countInto(shape) {
  const w = await world(shape);
  let scratch = 0;
  const lower = async (node) => {
    if (typeof node === 'string') return w.store.segment(node);
    const op = Object.keys(node)[0];
    const kids = [];
    for (const k of node[op]) kids.push(await lower(k));
    const into = w.store.segment(`scratch${scratch++}`);
    const [first, ...rest] = kids;
    const o = { allowEmpty: true };
    if (op === 'and') await first.intersectInto(into, rest, o);
    else if (op === 'or') await first.unionInto(into, rest, o);
    else await first.andNotInto(into, rest, o);
    return into;
  };
  let published = 0;
  const optOut = w.store.segment('op0');
  for (let i = 0; i < shape.outputs; i++) {
    const node = w.specs[i].expr;
    const dest = w.store.segment(`d${i}`);
    let r;
    if (typeof node === 'string') {
      r = await w.store.segment(node).unionInto(dest, [], { exclude: [optOut], keep: 12 });
    } else {
      const op = Object.keys(node)[0];
      const kids = [];
      for (const k of node[op]) kids.push(await lower(k));
      const [first, ...rest] = kids;
      if (op === 'and') r = await first.intersectInto(dest, rest, { exclude: [optOut], keep: 12 });
      else if (op === 'or') r = await first.unionInto(dest, rest, { exclude: [optOut], keep: 12 });
      else r = await first.andNotInto(dest, [...rest, optOut], { keep: 12 });
    }
    if (r.published) published++;
  }
  return { published, scratchSegments: scratch, ...classes(w.calls) };
}

async function countShape(id) {
  const shape = SHAPES[id];
  const batch = await countBatch(shape);
  const into = await countInto(shape);
  if (batch.published !== into.published) {
    throw new Error(
      `${id}: the batch published ${batch.published} outputs and the *Into route ${into.published}`,
    );
  }
  return { ...shape, batch, into };
}

(async () => {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const all = args.includes('--all');
  const shapeArg = args.includes('--shape') ? args[args.indexOf('--shape') + 1] : undefined;
  const onDisk = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { shapes: {} };
  const ids = check
    ? all
      ? Object.keys(SHAPES)
      : ['small']
    : shapeArg
      ? [shapeArg]
      : Object.keys(SHAPES);
  const counted = {};
  for (const id of ids) {
    if (!SHAPES[id]) throw new Error(`unknown shape "${id}"`);
    counted[id] = await countShape(id);
  }
  if (check) {
    for (const id of ids) {
      if (JSON.stringify(onDisk.shapes?.[id]) !== JSON.stringify(counted[id])) {
        console.error(
          `materialize-many-counts: the "${id}" shape in bench/materialize-many-counts.json is not what the library makes; run \`node bench/materialize-many-counts.cjs --shape ${id}\``,
        );
        process.exit(1);
      }
    }
    console.log(
      `materialize-many-counts: ${ids.join(', ')} in bench/materialize-many-counts.json is what the library makes`,
    );
    return;
  }
  const out = {
    note: 'Counted by running the library over the in-memory backend with its drivers wrapped; not measured on a cloud, and no time is recorded. Rewritten by bench/materialize-many-counts.cjs.',
    shapes: { ...onDisk.shapes, ...counted },
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`materialize-many-counts: wrote ${FILE} (${ids.join(', ')})`);
})();
