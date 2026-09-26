/*
 * A log–log chart as one self-contained SVG, in the style of the benchmarks page's crossover chart (bench/run.cjs),
 * drawn once for each theme. That chart is inlined into a site page, whose stylesheet themes it through
 * `var(--token)`; these are shown as images on GitHub, where no stylesheet reaches inside an SVG, so each theme's
 * palette is written into its own file and the page picks one with `<picture>` and `prefers-color-scheme`. Both
 * palettes were run through the dataviz palette validator on their own card: lightness, chroma, colour-vision
 * separation and contrast. Every shape carries an explicit fill, and nothing is encoded by colour alone: each line
 * and each region is labelled in words beside it.
 *
 * Used by bench/sizing.cjs. It draws what it is given and refuses what it cannot draw honestly, rather than
 * clamping or overlapping it silently: a point outside the axes, a label past the card's edge, closer to another
 * label than a third of an em, across a line or a marker's dot, or on the wrong side of the region it names, and an
 * axis a log scale cannot start from.
 */
'use strict';

/** Each theme's palette. Text colours are 4.5:1 or more on the card; the two series, 3:1 or more. */
const THEMES = {
  light: {
    card: '#ffffff',
    hair: '#e4e8ed',
    ink: '#15181e',
    inkSoft: '#3c4450',
    muted: '#69737f',
    // The project's indigo, one step lighter than the crossover chart's: mid-lightness, like the orange, and well
    // apart from it for every kind of colour vision.
    cloudbitmaps: '#3f44b0',
    // Redis, as on the crossover chart. 4.30:1 on the card, under the 4.5:1 small text needs: marks only.
    redis: '#d9480f',
  },
  dark: {
    card: '#161b22',
    hair: '#30363d',
    ink: '#e6edf3',
    inkSoft: '#c9d1d9',
    muted: '#9198a1',
    cloudbitmaps: '#7278ee',
    redis: '#e0712f',
  },
};
/** The colours a spec may name: a series, or ink. */
const ROLES = ['cloudbitmaps', 'redis', 'ink'];
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
/**
 * A generous estimate of a label's width, as a share of its font size a character: wider than the system fonts
 * average, so a label that fits here fits in the wider fonts a Linux reader may fall back to.
 */
const EM_PER_CHAR = 0.62;

const W = 760;
const H = 470;
const PLOT = { l: 92, r: 724, t: 112, b: 404 };

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const f1 = (n) => (Math.round(n * 10) / 10).toString();

/**
 * @param {object} spec
 * @param {string} spec.title
 * @param {string[]} spec.subtitle  one or two lines
 * @param {string} spec.label  the chart's claim, for readers who cannot see it (aria-label)
 * @param {{min:number,max:number,ticks:{at:number,text:string}[],title:string}} spec.x  a tick with no text draws its gridline only
 * @param {{min:number,max:number,ticks:{at:number,text:string}[],title:string}} spec.y
 * @param {{points:[number,number][],color:string,text:string,textAt?:[number,number],dashed?:boolean}[]} [spec.lines]
 * @param {{points:[number,number][],toward:'min'|'max',color:string,text:string,textAt:[number,number]}[]} [spec.areas]
 * @param {{at:[number,number],text:string,anchor?:'start'|'end',dy?:number,hollow?:boolean}[]} [spec.markers]
 * @param {'light'|'dark'} theme
 */
function logChart(spec, theme) {
  const C = THEMES[theme];
  if (C === undefined) throw new Error(`log-chart: no theme ${JSON.stringify(theme)}`);
  const colour = (role) => {
    if (!ROLES.includes(role)) throw new Error(`log-chart: no colour ${JSON.stringify(role)}`);
    return C[role];
  };
  const { x, y } = spec;
  for (const [name, a] of [
    ['x', x],
    ['y', y],
  ]) {
    // A log scale has no zero: an axis from 0 or below would put every coordinate at NaN.
    if (!(a.min > 0 && a.max > a.min)) {
      throw new Error(
        `log-chart: the ${name} axis must run from above 0 upwards, not ${a.min}–${a.max}`,
      );
    }
  }
  const span = (a) => Math.log10(a.max) - Math.log10(a.min);
  const px = (v) => PLOT.l + ((Math.log10(v) - Math.log10(x.min)) / span(x)) * (PLOT.r - PLOT.l);
  const py = (v) => PLOT.b - ((Math.log10(v) - Math.log10(y.min)) / span(y)) * (PLOT.b - PLOT.t);
  const inside = ([a, b], what) => {
    if (!(a >= x.min && a <= x.max && b >= y.min && b <= y.max)) {
      throw new Error(`log-chart: ${what} (${a}, ${b}) is outside the axes — widen them`);
    }
  };

  // Every label, as the box it is estimated to take, so none leaves the card or lands on another. Two labels closer
  // than a third of an em read as one, so that is the least room between them.
  const boxes = [];
  const meet = (a, b, gap = 0) =>
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap;
  const text = (X, Y, size, content, attrs, anchor = 'start') => {
    const w = String(content).length * size * EM_PER_CHAR;
    const left = anchor === 'end' ? X - w : anchor === 'middle' ? X - w / 2 : X;
    // A line of text rises about 0.8 em above its baseline and drops about 0.2 em below it.
    const box = {
      left,
      right: left + w,
      top: Y - size * 0.8,
      bottom: Y + size * 0.2,
      content,
      size,
    };
    if (box.left < 4 || box.right > W - 4 || box.top < 4 || box.bottom > H - 4) {
      throw new Error(
        `log-chart: "${content}" would run past the card's edge — shorten or move it`,
      );
    }
    for (const b of boxes) {
      if (meet(box, b, 0.3 * Math.max(size, b.size))) {
        throw new Error(`log-chart: "${content}" would crowd "${b.content}" — move one of them`);
      }
    }
    boxes.push(box);
    const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
    return `<text x="${f1(X)}" y="${f1(Y)}" font-size="${size}"${attrs}${a}>${esc(content)}</text>`;
  };
  // A label inside the plot is ringed in the card's colour, so a gridline or a line behind it stops short of every
  // letter rather than running through the word.
  const halo = ` stroke="${C.card}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
  /** Where a polyline, in pixels and in order of x, crosses `X`; undefined off its ends. */
  const yAt = (q, X) => {
    for (let i = 1; i < q.length; i++) {
      const [x1, y1] = q[i - 1];
      const [x2, y2] = q[i];
      if (X >= Math.min(x1, x2) && X <= Math.max(x1, x2)) {
        return x1 === x2 ? Math.min(y1, y2) : y1 + ((X - x1) / (x2 - x1)) * (y2 - y1);
      }
    }
    return undefined;
  };

  /** Whether a segment crosses a label's box, by clipping it to the box (Liang–Barsky). */
  const crosses = (b, [x1, y1], [x2, y2]) => {
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    for (const [p, q] of [
      [-dx, x1 - b.left],
      [dx, b.right - x1],
      [-dy, y1 - b.top],
      [dy, b.bottom - y1],
    ]) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return true;
  };
  /** Every drawn line, in pixels, so that no label is set across one. */
  const drawn = [];

  /**
   * A polyline's points, simplified by Ramer–Douglas–Peucker to within half a pixel of the full line: a smooth curve
   * keeps its shape, and a step keeps whatever of its corners half a pixel can show, with the points between
   * dropped.
   */
  const path = (points, what) => {
    const q = points.map((p) => {
      inside(p, what);
      return [px(p[0]), py(p[1])];
    });
    const keep = new Uint8Array(q.length);
    keep[0] = keep[q.length - 1] = 1;
    const stack = [[0, q.length - 1]];
    while (stack.length > 0) {
      const [a, b] = stack.pop();
      const [ax, ay] = q[a];
      const [bx, by] = q[b];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let far = -1;
      let farDist = 0.5;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - q[i][1]) - (ax - q[i][0]) * (by - ay)) / len;
        if (d > farDist) {
          far = i;
          farDist = d;
        }
      }
      if (far !== -1) {
        keep[far] = 1;
        stack.push([a, far], [far, b]);
      }
    }
    return q.filter((_, i) => keep[i] === 1);
  };
  const points = (q) => q.map(([a, b]) => `${f1(a)},${f1(b)}`).join(' ');

  const subtitles = [spec.subtitle].flat();
  if (subtitles.length < 1 || subtitles.length > 2) {
    throw new Error('log-chart: a subtitle is one line or two');
  }
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-label="${esc(spec.label)}">`,
    `<title>${esc(spec.title)}</title>`,
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="${C.card}" stroke="${C.hair}"/>`,
    text(28, 36, 17, spec.title, ` font-weight="700" fill="${C.ink}"`),
    ...subtitles.map((line, i) => text(28, 58 + i * 17, 12.5, line, ` fill="${C.muted}"`)),
  );

  // Regions first, under everything: a faint fill.
  for (const a of spec.areas ?? []) {
    const edge = a.toward === 'min' ? y.min : y.max;
    const pts = [[a.points[0][0], edge], ...a.points, [a.points[a.points.length - 1][0], edge]];
    parts.push(
      `<polygon points="${points(path(pts, a.text))}" fill="${colour(a.color)}" fill-opacity="0.08" stroke="none"/>`,
    );
  }

  // Grid and axes: solid hairlines, one shade off the card.
  for (const t of x.ticks) {
    inside([t.at, y.min], `the x tick ${t.text}`);
    const X = px(t.at);
    parts.push(
      `<line x1="${f1(X)}" y1="${PLOT.t}" x2="${f1(X)}" y2="${PLOT.b}" stroke="${C.hair}" stroke-width="1"/>`,
    );
    if (t.text !== '')
      parts.push(text(X, PLOT.b + 20, 11.5, t.text, ` fill="${C.muted}"`, 'middle'));
  }
  for (const t of y.ticks) {
    inside([x.min, t.at], `the y tick ${t.text}`);
    const Y = py(t.at);
    parts.push(
      `<line x1="${PLOT.l}" y1="${f1(Y)}" x2="${PLOT.r}" y2="${f1(Y)}" stroke="${C.hair}" stroke-width="1"/>`,
      text(PLOT.l - 8, Y + 4, 11.5, t.text, ` fill="${C.muted}"`, 'end'),
    );
  }
  parts.push(
    text((PLOT.l + PLOT.r) / 2, PLOT.b + 44, 12.5, x.title, ` fill="${C.inkSoft}"`, 'middle'),
    text(28, PLOT.t - 16, 12.5, y.title, ` fill="${C.inkSoft}"`),
  );

  // The regions' names, each on its own side of the boundary it names a side of: a name set across it, or beyond
  // it, would call the other region by this one's name.
  for (const a of spec.areas ?? []) {
    inside(a.textAt, a.text);
    parts.push(
      text(
        px(a.textAt[0]),
        py(a.textAt[1]),
        13,
        a.text,
        ` font-weight="600" fill="${C.inkSoft}"${halo}`,
      ),
    );
    const b = boxes[boxes.length - 1];
    const edge = path(a.points, a.text);
    const xs = [b.left, b.right, ...edge.map(([X]) => X).filter((X) => X > b.left && X < b.right)];
    for (const X of xs) {
      const Y = yAt(edge, X);
      if (Y !== undefined && (a.toward === 'min' ? Y > b.top : Y < b.bottom)) {
        throw new Error(`log-chart: "${a.text}" would sit outside the region it names — move it`);
      }
    }
  }

  // Lines, each named in words at its end or at a point of the caller's choosing.
  for (const l of spec.lines ?? []) {
    const dash = l.dashed ? ' stroke-dasharray="6 4"' : '';
    const q = path(l.points, l.text);
    drawn.push(q);
    parts.push(
      `<polyline points="${points(q)}" fill="none" stroke="${colour(l.color)}" stroke-width="2" stroke-linejoin="round"${dash}/>`,
    );
    const end = l.points[l.points.length - 1];
    if (l.textAt !== undefined) inside(l.textAt, l.text);
    const [tx, ty] = l.textAt ? [px(l.textAt[0]), py(l.textAt[1])] : [PLOT.r - 4, py(end[1]) - 8];
    parts.push(
      text(
        tx,
        ty,
        12.5,
        l.text,
        ` font-weight="600" fill="${C.ink}"${halo}`,
        l.textAt ? 'start' : 'end',
      ),
    );
  }

  // Markers: a dot with a ring of the card around it, named beside it; a hollow one for an example. Each dot, ring
  // and stroke included, is kept clear of every label, as a label is of a line.
  const dots = [];
  for (const m of spec.markers ?? []) {
    inside(m.at, m.text);
    const X = px(m.at[0]);
    const Y = py(m.at[1]);
    const end = m.anchor === 'end';
    const r = m.hollow ? 5.5 : 6;
    dots.push({ left: X - r, right: X + r, top: Y - r, bottom: Y + r, content: m.text });
    parts.push(
      m.hollow
        ? `<circle cx="${f1(X)}" cy="${f1(Y)}" r="4.5" fill="${C.card}" stroke="${C.ink}" stroke-width="2"/>`
        : `<circle cx="${f1(X)}" cy="${f1(Y)}" r="5" fill="${C.ink}" stroke="${C.card}" stroke-width="2"/>`,
      text(
        end ? X - 10 : X + 10,
        Y + 4 + (m.dy ?? 0),
        12,
        m.text,
        ` fill="${C.ink}"${halo}`,
        end ? 'end' : 'start',
      ),
    );
  }

  // No label is set across a line or a dot, with a clear margin of 2 pixels, whichever was drawn first; a line is
  // 2 pixels wide, so the margin is taken from its edge, not its middle.
  for (const b of boxes) {
    for (const d of dots) {
      if (meet(b, d, 2))
        throw new Error(
          `log-chart: "${b.content}" would sit on the dot of "${d.content}" — move it`,
        );
    }
    const m = { left: b.left - 3, right: b.right + 3, top: b.top - 3, bottom: b.bottom + 3 };
    for (const q of drawn) {
      for (let i = 1; i < q.length; i++) {
        if (crosses(m, q[i - 1], q[i])) {
          throw new Error(`log-chart: "${b.content}" would sit on a line — move it`);
        }
      }
    }
  }

  parts.push(`</svg>`);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${parts.join('\n')}\n`;
  // A coordinate that failed to compute must not reach the file as a word.
  const bad = /\b(?:NaN|undefined|Infinity)\b/.exec(svg);
  if (bad !== null) throw new Error(`log-chart: "${spec.title}" draws "${bad[0]}"`);
  return svg;
}

module.exports = { esc, logChart, THEMES };
