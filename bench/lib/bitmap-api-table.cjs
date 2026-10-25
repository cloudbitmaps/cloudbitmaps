/*
 * The "against native" table of the public bitmap class, generated from the bench's record
 * (`bench/bitmap-api-results.json`, taken by `bench/bitmap-api.cjs`), and the check that a page's copy of it is what the
 * record says. Pure: text in, text out. `bench/bitmap-api-table.cjs` writes the regions into the pages and
 * `tests/bench/bitmap-api-table.test.ts` holds them to the record.
 *
 * A region sits between `<!-- BITMAP_API:TABLE:START -->` and `<!-- BITMAP_API:TABLE:END -->`, once on each page the
 * table appears on. While the record holds no pass that is not a smoke pass, a region says `NOT_MEASURED` and nothing
 * else; the moment the record holds one, only its table is accepted. Nothing outside a region may carry the words
 * "close to native": they appear in a region, for a group, only when the group's worst cell is within 3 times native
 * and every control of the group is in band (stop rule 2), and a method with a cell above 10 times native is named
 * (stop rule 3). `problemsOf` reports every disagreement of a region with the record, a figure, a commit, a Node
 * version or a phrase included.
 */
'use strict';

const verdict = require('./bitmap-api-verdict.cjs');

const START = '<!-- BITMAP_API:TABLE:START -->';
const END = '<!-- BITMAP_API:TABLE:END -->';
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];
/** What a region says while the record holds no pass. */
const NOT_MEASURED =
  'Not measured yet: `bench/bitmap-api-results.json` holds no pass, so this page states no figure of the class against `roaring`. The table is generated from that file by `pnpm bench:bitmap-api:table`.';

const times = (x) => x.toFixed(2);
const ms = (x) => (x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const short = (sha) => sha.slice(0, 8);

/** The cells of a pass keyed by `<data set> <op>`, in the order the pass lists them. */
function cellMap(pass) {
  return new Map(verdict.cellsOfPass(pass).map((c) => [verdict.cellName(c), c]));
}

/** The operations of a list of cells, in order of first appearance, each with its group. */
function opsOf(cells) {
  const seen = new Map();
  for (const c of cells) if (!seen.has(c.op)) seen.set(c.op, c.group);
  return [...seen.entries()].map(([op, group]) => ({ op, group }));
}

/** One figure of a cell as the table prints it: the ratio, starred when the cell's control was out of band. */
const figure = (c, field = 'vsNative') =>
  c === undefined ? '' : `${times(c[field])}${c.controlInBand ? '' : ' *'}`;

function ratioTable(pass, field, title, rowsFilter) {
  const map = cellMap(pass);
  const steady = (pass.cells ?? []).filter((c) => !c.malformed && rowsFilter(c));
  const lines = [
    `| ${title} | Group | ${DATASETS.join(' | ')} |`,
    `|---|---|${DATASETS.map(() => '---:').join('|')}|`,
  ];
  for (const { op, group } of opsOf(steady)) {
    lines.push(
      `| \`${op}\` | ${group} | ${DATASETS.map((d) => figure(map.get(`${d} ${op}`), field)).join(' | ')} |`,
    );
  }
  return lines.join('\n');
}

/** The sentences the stop rules allow, from the groups and methods of a pass. */
function ruleLines(pass) {
  const cells = (pass.cells ?? []).filter((c) => !c.malformed);
  const groups = verdict.groupsOf(cells);
  const close = groups.filter((g) => g.close).map((g) => g.group);
  const far = groups.filter((g) => !g.close);
  const lines = [];
  if (close.length > 0) {
    lines.push(
      `Close to native (within ${verdict.CLOSE_BAR} times native on every cell of the group, every control in band): ${close.join(', ')}.`,
    );
  }
  if (far.length > 0) {
    lines.push(
      `Not called close to native: ${far
        .map(
          (g) =>
            `${g.group} (worst ${times(g.worst)} times, ${g.worstCell}${g.unresolved > 0 ? `; ${g.unresolved} cell(s) with a control out of band` : ''})`,
        )
        .join('; ')}.`,
    );
  }
  const over = verdict.overShipBar(cells);
  lines.push(
    over.length === 0
      ? `No method is more than ${verdict.SHIP_BAR} times native on any data set.`
      : `More than ${verdict.SHIP_BAR} times native on some data set, so not shipped unless the maintainer decides otherwise having seen this table: ${over
          .map((o) => `\`${o.method}\` (${times(o.worst)} times, ${o.cell})`)
          .join('; ')}.`,
  );
  return lines;
}

/** What the record says of the count cells: the route the class ran, and rule 1's reading of `andCardinality`. */
function countLines(pass) {
  const route = pass.environment.countRoute;
  const routeText =
    route === 'kernels'
      ? 'the count kernels'
      : route === 'build-then-count'
        ? 'building the combination and counting it'
        : 'an unrecorded route';
  const rule = verdict.countKernelsRule((pass.cells ?? []).filter((c) => !c.malformed));
  const lines = [
    `The class answered \`andCardinality\`, \`orCardinality\`, \`xorCardinality\`, \`andNotCardinality\` and \`intersects\` by ${routeText} in this pass. The codec column of \`andCardinality\` and \`orCardinality\` is build-then-count, so a class figure below 1.00 there is a count that cost less than building the result and counting it.`,
  ];
  if (rule.perDataset.length > 0) {
    lines.push(
      rule.beats
        ? 'The count kernels took less time than build-then-count on every data set (`andCardinality`).'
        : `The count kernels did not take less time than build-then-count on every data set (\`andCardinality\`: ${rule.perDataset
            .map((d) => `${d.dataset} ${times(d.vsInternal)}${d.controlInBand ? '' : ' *'}`)
            .join(', ')}).`,
    );
  }
  return lines;
}

/** The text of a region for a results file: the table of its last pass that is not a smoke pass, or `NOT_MEASURED`. */
function render(file) {
  const pass = verdict.passOfRecord(file);
  if (pass === undefined) return NOT_MEASURED;
  const e = pass.environment;
  const parts = [];
  parts.push(
    `**Measured** on ${e.cpu} (${e.cores} cores), ${e.platform}, Node ${e.node}, commit \`${short(e.head)}\` (${e.tree} tree), \`roaring\` ${e.roaring}, ${e.rounds} rounds a figure, pass ${pass.pass}, started ${pass.started.slice(0, 10)}. ` +
      `Each figure is the median over the rounds of the class's time divided by the \`roaring\` package's in the same round, so 2.00 means twice as slow and 0.50 half the time. ` +
      `One subject per process, rotated orders, an A/A control per cell, wall-clock on one machine; the kept rounds ended at a load of at most ${pass.load.maxLoadAtEnd.toFixed(2)} and ${pass.load.discardedRounds} round(s) were set aside at ${verdict.MAX_LOAD} or more. Recorded, never asserted.`,
  );
  parts.push(
    ratioTable(pass, 'vsNative', 'Against `roaring` (class time / native time)', () => true),
  );
  parts.push(
    ratioTable(
      pass,
      'vsInternal',
      "The shell against the codec's own call (class time / codec time)",
      (c) => c.vsInternal !== undefined,
    ),
  );
  const cold = (pass.cold ?? []).filter((c) => !c.malformed);
  if (cold.length > 0) {
    parts.push(
      [
        '| The first call in a fresh process (`mixed`) | Class / native | Class / codec |',
        '|---|---:|---:|',
        ...cold.map(
          (c) =>
            `| \`${c.op}\` | ${figure(c)} | ${c.vsInternal === undefined ? '' : figure(c, 'vsInternal')} |`,
        ),
      ].join('\n'),
    );
  }
  const loads = pass.loadRoundTrip ?? [];
  if (loads.length > 0) {
    parts.push(
      [
        '| `store.load(ref, { bitmap })` | Load (ms) | `serialize` (ms) | `deserialize` (ms) | Round trip, share of a load |',
        '|---|---:|---:|---:|---:|',
        ...loads.map(
          (l) =>
            `| ${l.dataset} | ${ms(l.loadMedian)} | ${ms(l.serializeMedian)} | ${ms(l.decodeMedian)} | ${(l.roundTripShare * 100).toFixed(1)}% |`,
        ),
      ].join('\n'),
    );
  }
  if ((pass.cells ?? []).some((c) => !c.malformed && !c.controlInBand)) {
    parts.push(
      '\\* The A/A control of this cell differed from the class by more than 2%, so the figure is not resolved.',
    );
  }
  parts.push(ruleLines(pass).join('\n'));
  parts.push(countLines(pass).join('\n'));
  return parts.join('\n\n');
}

/** The region of a page: `{ i, j }` with the text between the markers at `text.slice(i, j)`; throws unless exactly one. */
function regionIn(doc, text) {
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `${doc} must hold exactly one BITMAP_API:TABLE region (${starts} start, ${ends} end marker)`,
    );
  }
  const i = text.indexOf(START) + START.length;
  const j = text.indexOf(END);
  if (j < i) throw new Error(`${doc}: the BITMAP_API:TABLE end marker comes before its start`);
  return { i, j };
}

/** The page with its region rewritten from the record. */
function withRegion(doc, text, file) {
  const { i, j } = regionIn(doc, text);
  return `${text.slice(0, i)}\n\n${render(file)}\n\n${text.slice(j)}`;
}

/** The text of a page's region, trimmed. */
function regionText(doc, text) {
  const { i, j } = regionIn(doc, text);
  return text.slice(i, j).trim();
}

/**
 * Every way a page disagrees with the record, as messages. The region must equal what `render` makes from the record
 * (so every figure, the commit, the Node version and the machine are the record's); the same figures are read back out
 * of the region's text and recomputed from the rounds, so a renderer that drifted from the record would not hide a
 * wrong figure; and the words "close to native" may stand nowhere but in the region, and there only for a group that
 * stop rule 2 allows.
 */
function problemsOf(doc, text, file) {
  const problems = [];
  let region;
  try {
    region = regionText(doc, text);
  } catch (err) {
    return [err.message];
  }
  const pass = verdict.passOfRecord(file);
  const phrase = verdict.CLOSE_PHRASE;
  const outside = text.slice(0, regionIn(doc, text).i) + text.slice(regionIn(doc, text).j);
  if (outside.toLowerCase().includes(phrase)) {
    problems.push(`${doc}: "${phrase}" stands outside the generated region`);
  }
  if (pass === undefined) {
    if (region !== NOT_MEASURED)
      problems.push(`${doc}: the record holds no pass, so the region must say it is not measured`);
    return problems;
  }
  if (region === NOT_MEASURED)
    problems.push(`${doc}: the record holds a pass, but the region says it is not measured`);
  const expected = render(file);
  if (region !== expected)
    problems.push(`${doc}: the region is not what bench/bitmap-api-results.json renders to`);
  // Read the figures back out of the page's own text.
  const e = pass.environment;
  if (!region.includes(`Node ${e.node}`))
    problems.push(`${doc}: the Node version is not the record's (${e.node})`);
  if (!region.includes(`commit \`${short(e.head)}\``))
    problems.push(`${doc}: the commit is not the record's (${short(e.head)})`);
  const rows = new Map();
  for (const line of region.split('\n')) {
    const m = /^\| `([^`]+)` \| ([^|]+) \| (.*) \|$/.exec(line);
    if (m === null) continue;
    const cols = m[3].split('|').map((s) => s.trim());
    if (cols.length === DATASETS.length && !rows.has(m[1])) rows.set(m[1], cols);
  }
  for (const c of pass.cells ?? []) {
    if (c.malformed) continue;
    const cols = rows.get(c.op);
    const at = DATASETS.indexOf(c.dataset);
    if (cols === undefined || at < 0) {
      problems.push(`${doc}: no row for ${verdict.cellName(c)}`);
      continue;
    }
    const recomputed = verdict.median(c.rounds.map((r) => r[2] / r[1]));
    const printed = Number(cols[at].replace(/ \*$/, ''));
    if (printed !== Number(times(recomputed))) {
      problems.push(
        `${doc}: ${verdict.cellName(c)} prints ${cols[at]}, the rounds say ${times(recomputed)}`,
      );
    }
  }
  const allowed = verdict
    .groupsOf((pass.cells ?? []).filter((c) => !c.malformed))
    .filter((g) => g.close);
  const said = /Close to native \([^)]*\): ([^.]*)\./.exec(region);
  const saidGroups = said === null ? [] : said[1].split(', ');
  for (const g of saidGroups) {
    if (!allowed.some((a) => a.group === g))
      problems.push(`${doc}: "${phrase}" is said of ${g}, which stop rule 2 does not allow`);
  }
  if (
    region.toLowerCase().split(phrase).length - 1 !==
    (said === null ? 0 : 1) + (/Not called close to native/i.test(region) ? 1 : 0)
  ) {
    problems.push(`${doc}: "${phrase}" stands more often than the generated sentences say it`);
  }
  for (const o of verdict.overShipBar((pass.cells ?? []).filter((c) => !c.malformed))) {
    if (!region.includes(`\`${o.method}\` (${times(o.worst)} times`)) {
      problems.push(
        `${doc}: ${o.method} is above ${verdict.SHIP_BAR} times native and the region does not say so`,
      );
    }
  }
  return problems;
}

module.exports = {
  START,
  END,
  DATASETS,
  NOT_MEASURED,
  render,
  regionIn,
  regionText,
  withRegion,
  problemsOf,
};
