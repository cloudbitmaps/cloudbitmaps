/*
 * The "against native" table of the public bitmap class, generated from the bench's record
 * (`bench/bitmap-api-results.json`, taken by `bench/bitmap-api.cjs`), and the check that a page's copy of it is what the
 * record says. Pure: text in, text out. `bench/bitmap-api-table.cjs` writes the regions into the pages and
 * `tests/bench/bitmap-api-table.test.ts` holds them to the record.
 *
 * A region sits between `<!-- BITMAP_API:TABLE:START -->` and `<!-- BITMAP_API:TABLE:END -->`, once on each page the
 * table appears on. While the record holds no complete pass, a region says `NOT_MEASURED` and nothing else; the moment
 * it holds one, only the table of its last complete pass is accepted. Every printed figure is recomputed from the
 * rounds (`verdict.fresh`), never copied from a stored field. Nothing on any public page outside a region may carry the
 * words "close to native" (whitespace, line breaks and no-break spaces between the words included): they appear in a
 * region, for a group, only when the group's worst cell, a cold row included, is within 3 times native and every
 * control of the group is in band, and a method with a cell above 10 times native is named. `problemsOf` reports every
 * disagreement of a region with the record, a figure, a commit, a Node version or a phrase included, and `phraseProblems`
 * holds every other public page to the phrase.
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

/** Every cell the rules read: the steady cells and the cold rows. */
const rated = (pass) => verdict.cellsOfPass(pass).filter((c) => !c.malformed);

/** The sentences the stop rules allow, from the groups and methods of a pass. */
function ruleLines(pass) {
  const cells = rated(pass);
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

/** What the record says of the count cells: the route the class ran, and the decision of the count kernels' own bench. */
function countLines(pass) {
  const route = pass.environment.countRoute;
  const result = pass.environment.countResult;
  const routeText =
    route === 'kernels'
      ? 'the count kernels'
      : route === 'build-then-count'
        ? 'building the combination and counting it'
        : 'an unrecorded route';
  const decision =
    result === 'kept'
      ? "the count kernels' own bench (`bench/count-kernels.cjs`) kept them: they took less time than building and counting on every operand-pair group it measures"
      : result === 'derived'
        ? "the count kernels' own bench (`bench/count-kernels.cjs`) did not keep them: the counts are derived by building the combination and counting it"
        : "no decision of the count kernels' own bench is recorded";
  return [
    `The class answered \`andCardinality\`, \`orCardinality\`, \`xorCardinality\`, \`andNotCardinality\` and \`intersects\` by ${routeText} in this pass; ${decision}. The codec column of \`andCardinality\` and \`orCardinality\` is build-then-count, so a class figure below 1.00 there is a count that cost less than building the result and counting it on that data set.`,
  ];
}

/** What a reader needs to know of how some rows differ from a like-for-like call. */
const NOTES = [
  "`deserialize` and `first deserialize`: the class caps the size and checks the layout of the bytes before it decodes them; the `roaring` package's decode is called with no validating option, so these rows compare the class with its check against native without one.",
  "`clone` and `clone then write`: the class's clone shares the containers and copies one on the first write that reaches it; native's clone copies everything at once. These rows are that policy difference, not two copies of the same work.",
  "`write after or`, `write after xor` and `write after andNot`: only the first operand's next write is timed, on an operand decoded fresh for each repetition, after a returning combine that flagged the containers it keeps by reference. The codec has no such flag, so its figure is the same write on an unflagged bitmap.",
  '`intersects overlapping` answers `true` at the first container the two bitmaps share, so it times how fast each subject finds a first hit; `intersects disjoint` answers `false` after walking every key. `isSubset` and `isEqual` answer `true`, which is the full scan.',
  '`serialize` is held to identical bytes on every subject; every other answer is held to the same value.',
];

/** The text of a region for a results file: the table of its last complete pass, or `NOT_MEASURED`. */
function render(file) {
  const recorded = verdict.passOfRecord(file);
  if (recorded === undefined) return NOT_MEASURED;
  const pass = verdict.fresh(recorded);
  const e = pass.environment;
  const load = verdict.loadFiguresOf(pass);
  const rounds = verdict.roundCountOf(pass);
  const parts = [];
  parts.push(
    `**Measured** on ${e.cpu} (${e.cores} cores), ${e.platform}, Node ${e.node}, commit \`${short(e.head)}\` (${e.tree} tree), \`roaring\` ${e.roaring}, ${rounds} rounds a figure, pass ${pass.pass}, started ${pass.started.slice(0, 10)}. ` +
      `Each figure is the median over the rounds of the class's time divided by the \`roaring\` package's in the same round, so 2.00 means twice as slow and 0.50 half the time. ` +
      `One subject per process, rotated orders, an A/A control per cell, wall-clock on one machine; the kept rounds ended at a load of at most ${load.maxLoadAtEnd.toFixed(2)} and ${load.discardedRounds} round(s) were set aside at ${verdict.MAX_LOAD} or more. Recorded, never asserted.`,
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
  if (rated(pass).some((c) => !c.controlInBand)) {
    parts.push(
      '\\* The A/A control of this cell differed from the class by more than 2%, so the figure is not resolved.',
    );
  }
  parts.push(ruleLines(pass).join('\n'));
  parts.push(countLines(pass).join('\n'));
  parts.push(
    `Notes on rows that are not a like-for-like call:\n\n${NOTES.map((n) => `- ${n}`).join('\n')}`,
  );
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

/** The text as a reader of the rendered page sees it: emphasis marks gone, every run of whitespace one space. */
const normalised = (text) =>
  text
    .replace(/[\u00a0\u200b\u00ad*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** A pattern for the words, hyphens and any whitespace between them allowed. */
const PHRASE = /\bclose[\s-]+to[\s-]+native\b/g;

/** How many times the words stand in a text, however they are wrapped or spaced. */
const phrasesIn = (text) => (normalised(text).match(PHRASE) ?? []).length;

/**
 * A page with no region: the words "close to native" may not stand anywhere on it, however the line is wrapped or the
 * space between the words is written (a plain space, a new line, a no-break space, a hyphen).
 */
function phraseProblems(doc, text) {
  return phrasesIn(text) > 0
    ? [`${doc}: "${verdict.CLOSE_PHRASE}" stands on a page that carries no generated table`]
    : [];
}

/** The figures of the table's `|`-separated rows, by the first cell's text, as printed. */
function printedRows(region) {
  const rows = [];
  for (const line of region.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((x) => x.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * Every way a page disagrees with the record, as messages. The region must equal what `render` makes from the record
 * (so every figure, the commit, the Node version and the machine are the record's, each recomputed from the rounds);
 * the same figures are read back out of the region's text and compared with a recomputation from the rounds, so a
 * renderer that drifted from the record would not hide a wrong figure; and the words "close to native" may stand
 * nowhere but in the region, and there only for a group that stop rule 2 allows.
 */
function problemsOf(doc, text, file) {
  const problems = [];
  let region;
  let at;
  try {
    region = regionText(doc, text);
    at = regionIn(doc, text);
  } catch (err) {
    return [err.message];
  }
  const recorded = verdict.passOfRecord(file);
  const phrase = verdict.CLOSE_PHRASE;
  const outside = text.slice(0, at.i) + '\n' + text.slice(at.j);
  if (phrasesIn(outside) > 0) {
    problems.push(`${doc}: "${phrase}" stands outside the generated region`);
  }
  if (recorded === undefined) {
    if (region !== NOT_MEASURED)
      problems.push(`${doc}: the record holds no pass, so the region must say it is not measured`);
    return problems;
  }
  const pass = verdict.fresh(recorded);
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
  if (!region.includes(`${verdict.roundCountOf(pass)} rounds a figure`))
    problems.push(`${doc}: the round count is not the rounds' (${verdict.roundCountOf(pass)})`);
  const load = verdict.loadFiguresOf(pass);
  if (
    !region.includes(
      `ended at a load of at most ${load.maxLoadAtEnd.toFixed(2)} and ${load.discardedRounds} round(s)`,
    )
  )
    problems.push(
      `${doc}: the load line is not the rounds' (${load.maxLoadAtEnd.toFixed(2)}, ${load.discardedRounds})`,
    );
  const rows = new Map();
  const coldRows = new Map();
  const loadRows = new Map();
  for (const cells of printedRows(region)) {
    const op = /^`([^`]+)`$/.exec(cells[0]);
    if (op !== null && cells.length === 2 + DATASETS.length && !rows.has(op[1]))
      rows.set(op[1], cells.slice(2));
    else if (op !== null && cells.length === 3 && !coldRows.has(op[1]))
      coldRows.set(op[1], cells.slice(1));
    else if (op === null && cells.length === 5 && DATASETS.includes(cells[0]))
      loadRows.set(cells[0], cells.slice(1));
  }
  for (const c of pass.cells ?? []) {
    if (c.malformed) continue;
    const cols = rows.get(c.op);
    const col = DATASETS.indexOf(c.dataset);
    if (cols === undefined || col < 0) {
      problems.push(`${doc}: no row for ${verdict.cellName(c)}`);
      continue;
    }
    // The record stores each ratio rounded to four places and the page prints that, so the check rounds the same way.
    const recomputed = +verdict.median(c.rounds.map((r) => r[2] / r[1])).toFixed(4);
    const printed = Number(cols[col].replace(/ \*$/, ''));
    if (printed !== Number(times(recomputed))) {
      problems.push(
        `${doc}: ${verdict.cellName(c)} prints ${cols[col]}, the rounds say ${times(recomputed)}`,
      );
    }
  }
  for (const c of pass.cold ?? []) {
    if (c.malformed) continue;
    const cols = coldRows.get(c.op);
    if (cols === undefined) {
      problems.push(`${doc}: no row for ${verdict.cellName(c)}`);
      continue;
    }
    // The record stores each ratio rounded to four places and the page prints that, so the check rounds the same way.
    const recomputed = +verdict.median(c.rounds.map((r) => r[2] / r[1])).toFixed(4);
    if (Number(cols[0].replace(/ \*$/, '')) !== Number(times(recomputed)))
      problems.push(
        `${doc}: ${verdict.cellName(c)} prints ${cols[0]}, the rounds say ${times(recomputed)}`,
      );
  }
  for (const l of pass.loadRoundTrip ?? []) {
    const cols = loadRows.get(l.dataset);
    if (cols === undefined) {
      problems.push(`${doc}: no load row for ${l.dataset}`);
      continue;
    }
    const share = verdict.median(l.rounds.map((r) => (r[1] + r[2]) / r[0]));
    if (cols[3] !== `${(share * 100).toFixed(1)}%`)
      problems.push(
        `${doc}: load ${l.dataset} prints ${cols[3]}, the rounds say ${(share * 100).toFixed(1)}%`,
      );
  }
  const allowed = verdict.groupsOf(rated(pass)).filter((g) => g.close);
  const said = /Close to native \([^)]*\): ([^.]*)\./.exec(region);
  const saidGroups = said === null ? [] : said[1].split(', ');
  for (const g of saidGroups) {
    if (!allowed.some((a) => a.group === g))
      problems.push(
        `${doc}: "${phrase}" is said of ${g}, which the bar of 3 times native does not allow`,
      );
  }
  if (
    phrasesIn(region) !==
    (said === null ? 0 : 1) + (/Not called close to native/i.test(region) ? 1 : 0)
  ) {
    problems.push(`${doc}: "${phrase}" stands more often than the generated sentences say it`);
  }
  for (const o of verdict.overShipBar(rated(pass))) {
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
  phraseProblems,
  phrasesIn,
};
