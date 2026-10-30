'use strict';
/*
 * The requests and bytes of counting a combine three ways, counted by running the real engine over the in-memory backend and
 * written to `bench/combine-counts-results.json`:
 *
 *   count    the engine's combine count (`SegmentEngine.combineCount`): the size of the combine, with a chunk only one operand
 *            holds answered from the index and every other chunk decoded as the combine reads it;
 *   recipe   the stream-and-count recipe: stream the combine in batches and add up the lengths of the arrays;
 *   into     the `*Into` workaround: `intersectInto` / `unionInto` / `andNotInto` into a scratch segment, then `count()` on it.
 *
 * Nothing here is measured on a cloud and no time is recorded: a count of requests and bytes is the same on every machine.
 * `requests` is every call the storage driver and the registry are asked; `bytesRead` is what the reads returned (range reads
 * and tail reads); the `*Into` run's writes are counted apart (`requestsWritten`, `bytesWritten`) and its requests include them.
 *
 * THE STOP RULE, written before the first run and applied to every cell (shape x layout x op):
 *
 *   The count ships only if it makes NO MORE requests than the recipe on every cell, and reads FEWER bytes than the recipe on
 *   union and andNot on the PACKED layout, and NO MORE bytes than the recipe on every other cell (the spread layout, and
 *   intersect on either layout). The `*Into` run is reported, not judged. If any cell fails, the record is committed with the
 *   failing verdict and the engine is not changed to pass it.
 *
 * Shapes: two operands of 500,000 / 1M / 5M / 10M ids over 1,999 chunks each, sharing 100 of them; and a 31-operand union of
 * 500,000-id operands over 1,999 chunks each, sharing 100. Layouts: `packed` (the shared chunks first in each object) and
 * `spread` (the shared chunks spread over each object, each operand's own chunks between them).
 *
 * Run: `pnpm build && node bench/combine-counts.cjs` rewrites the file and prints the verdict per cell and overall; `--check`
 * (what `pnpm bench:combine-counts:check` runs) counts again and fails if the committed file is not what the engine makes;
 * `--only <shape id>` prints one shape and writes nothing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { packageFor } = require('./lib/codec-engine.cjs');
const { idsOfChunks, run } = require('./lib/range-counts.cjs');

const FILE = path.join(__dirname, 'combine-counts-results.json');
const CHUNKS = 1_999;
const SHARED = 100;
const LAYOUTS = ['packed', 'spread'];
const OPS = ['intersect', 'union', 'andNot'];
const SHAPES = [
  { id: '500k', operands: 2, ids: 500_000, ops: OPS },
  { id: '1M', operands: 2, ids: 1_000_000, ops: OPS },
  { id: '5M', operands: 2, ids: 5_000_000, ops: OPS },
  { id: '10M', operands: 2, ids: 10_000_000, ops: OPS },
  { id: 'union31', operands: 31, ids: 500_000, ops: ['union'] },
];

const STOP_RULE =
  'The count ships only if it makes no more requests than the stream-and-count recipe on every cell, and reads fewer bytes ' +
  'than the recipe on union and andNot on the packed layout, and no more bytes than the recipe on every other cell (the ' +
  'spread layout, and intersect on either layout). The Into run is reported, not judged.';

/**
 * The chunk keys of operand `j` of `n`, each holding `CHUNKS` chunks, all sharing the first `SHARED` keys of the layout.
 * Keys ascend, and no two operands' own chunks collide.
 */
function operandKeys(n, j, layout) {
  const own = CHUNKS - SHARED;
  if (layout === 'packed') return [...run(0, SHARED), ...run(2_000 + j * 2_000, own)];
  const stride = Math.floor(60_000 / SHARED);
  const width = Math.ceil(own / SHARED);
  if (1 + n * width > stride)
    throw new Error('combine-counts: the spread layout has no room for this many operands');
  const keys = [];
  let placed = 0;
  for (let m = 0; m < SHARED; m += 1) {
    keys.push(m * stride);
    const upTo = Math.floor(((m + 1) * own) / SHARED);
    for (; placed < upTo; placed += 1) {
      keys.push(m * stride + 1 + j * width + (placed - Math.floor((m * own) / SHARED)));
    }
  }
  return keys;
}

/** What the verdict of one cell is, from its count and recipe figures; the test recomputes it the same way. */
function judge(layout, op, count, recipe) {
  const fewerBytesRequired = layout === 'packed' && (op === 'union' || op === 'andNot');
  const requestsOk = count.requests <= recipe.requests;
  const bytesOk = fewerBytesRequired
    ? count.bytesRead < recipe.bytesRead
    : count.bytesRead <= recipe.bytesRead;
  return { fewerBytesRequired, requestsOk, bytesOk, pass: requestsOk && bytesOk };
}

/** An in-memory backend whose every port method is counted in place into `tally`. */
async function countedWorld() {
  const { CloudRoaring, MemoryStorage } = await packageFor(
    'roaring',
    path.resolve(__dirname, '..'),
  );
  const backend = new MemoryStorage();
  const tally = {};
  const reset = () => {
    for (const k of ['getRange', 'getTail', 'putImmutable', 'delete', 'list']) tally[`s.${k}`] = 0;
    for (const k of ['get', 'create', 'compareAndSwap', 'list', 'delete']) tally[`r.${k}`] = 0;
    tally.rangeBytes = tally.tailBytes = tally.bytesWritten = 0;
  };
  reset();
  const wrap = (target, prefix, name, bytes) => {
    const original = target[name].bind(target);
    target[name] = (...args) => {
      tally[`${prefix}.${name}`] += 1;
      const out = original(...args);
      if (bytes === undefined || typeof out?.then !== 'function') return out;
      return out.then((r) => {
        bytes(r);
        return r;
      });
    };
  };
  wrap(backend.storage, 's', 'getRange', (r) => (tally.rangeBytes += r.length));
  wrap(backend.storage, 's', 'getTail', (r) => (tally.tailBytes += r.bytes.length));
  wrap(backend.storage, 's', 'putImmutable', (r) => (tally.bytesWritten += r.size));
  wrap(backend.storage, 's', 'delete');
  wrap(backend.storage, 's', 'list');
  for (const name of ['get', 'create', 'compareAndSwap', 'list', 'delete']) {
    wrap(backend.registry, 'r', name);
  }
  const loader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  const cold = () => new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  const figures = (result) => {
    const written = tally['s.putImmutable'] + tally['r.create'] + tally['r.compareAndSwap'];
    const requests = Object.entries(tally)
      .filter(([k]) => k.startsWith('s.') || k.startsWith('r.'))
      .reduce((a, [, v]) => a + v, 0);
    return {
      result,
      requests,
      getRange: tally['s.getRange'],
      getTail: tally['s.getTail'],
      pointerReads: tally['r.get'],
      requestsWritten: written,
      bytesRead: tally.rangeBytes + tally.tailBytes,
      bytesWritten: tally.bytesWritten,
    };
  };
  return { loader, cold, reset, figures };
}

/** The three ways of counting `op` over the operands `op0`..`op<n-1>` on a cold store; each returns its figures. */
async function countThreeWays(world, op, n) {
  const names = Array.from({ length: n }, (_, i) => `op${i}`);
  const measure = async (body) => {
    world.reset();
    const store = world.cold();
    return world.figures(
      await body(
        store,
        names.map((s) => store.segment(s)),
      ),
    );
  };
  const others = (segs) => segs.slice(1);
  const mode = op === 'union' ? 'any' : 'all';
  const count = await measure((store, segs) =>
    store.engine.combineCount(
      op === 'andNot' ? [segs[0].ref] : segs.map((s) => s.ref),
      op === 'andNot' ? others(segs).map((s) => s.ref) : [],
      mode,
      op,
    ),
  );
  const recipe = await measure(async (store, segs) => {
    const stream = segs[0][op](others(segs));
    let total = 0;
    for await (const ids of stream.batches()) total += ids.length;
    return total;
  });
  const into = await measure(async (store, segs) => {
    const dest = store.segment(`scratch-${op}`);
    await segs[0][`${op}Into`](dest, others(segs));
    return dest.count();
  });
  return { count, recipe, into };
}

async function countShape(shape) {
  const idsPerChunk = Math.round(shape.ids / CHUNKS);
  const cells = [];
  for (const layout of LAYOUTS) {
    const world = await countedWorld();
    for (let j = 0; j < shape.operands; j += 1) {
      await world.loader.load({ segment: `op${j}` }, [
        ...idsOfChunks(operandKeys(shape.operands, j, layout), idsPerChunk),
      ]);
    }
    for (const op of shape.ops) {
      const ways = await countThreeWays(world, op, shape.operands);
      cells.push({
        layout,
        op,
        ...ways,
        agree: ways.count.result === ways.recipe.result && ways.into.result === ways.recipe.result,
        verdict: judge(layout, op, ways.count, ways.recipe),
      });
    }
  }
  return {
    id: shape.id,
    operands: shape.operands,
    idsPerOperand: shape.ids,
    chunksPerOperand: CHUNKS,
    sharedChunks: SHARED,
    idsPerChunk,
    cells,
  };
}

async function count(only) {
  const shapes = [];
  for (const s of SHAPES) if (only === undefined || only === s.id) shapes.push(await countShape(s));
  const failing = shapes.flatMap((s) =>
    s.cells.filter((c) => !c.verdict.pass).map((c) => `${s.id}/${c.layout}/${c.op}`),
  );
  return {
    note: 'Counted by running the engine over the in-memory backend; not measured on a cloud, and no time is recorded. Rewritten by bench/combine-counts.cjs.',
    stopRule: STOP_RULE,
    shapes,
    verdict: { pass: failing.length === 0, failing },
  };
}

function print(record) {
  for (const s of record.shapes) {
    for (const c of s.cells) {
      const f = (w) =>
        `${String(w.requests).padStart(5)} req ${String(w.bytesRead).padStart(12)} B`;
      console.log(
        `${s.id.padEnd(8)} ${c.layout.padEnd(7)} ${c.op.padEnd(9)} count ${f(c.count)} | recipe ${f(c.recipe)} | into ${f(c.into)} | ${c.verdict.pass ? 'PASS' : 'FAIL'}${c.agree ? '' : ' (results disagree)'}`,
      );
    }
  }
  console.log(
    `combine-counts: stop rule ${record.verdict.pass ? 'PASSES' : `FAILS on ${record.verdict.failing.join(', ')}`}`,
  );
}

module.exports = { judge, operandKeys, SHAPES, STOP_RULE };

if (require.main === module) {
  (async () => {
    const i = process.argv.indexOf('--only');
    const only = i === -1 ? undefined : process.argv[i + 1];
    const record = await count(only);
    print(record);
    const text = JSON.stringify(record, null, 2) + '\n';
    if (only !== undefined) return;
    if (process.argv.includes('--check')) {
      const onDisk = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
      if (onDisk !== text) {
        console.error(
          'combine-counts: bench/combine-counts-results.json is not what the engine makes; run `node bench/combine-counts.cjs`',
        );
        process.exit(1);
      }
      console.log('combine-counts: bench/combine-counts-results.json is what the engine makes');
      return;
    }
    fs.writeFileSync(FILE, text);
    console.log(`combine-counts: wrote ${FILE}`);
  })();
}
