/**
 * Nothing on the site is drawn below 9.5px: every visible run of text, SVG labels included, at seven widths.
 *
 * The floor is a design rule the stylesheet can only state, and it drifted twice where nothing measured it: labels in
 * a diagram's `viewBox` shrink with the diagram, so a label authored at 10 units is 10px only at the width the diagram
 * was drawn for, and a comment saying the floor held was wrong at most widths. This measures what renders. For an
 * HTML element it is the computed font size; for SVG text it is that size through the element's screen transform,
 * which is what the viewBox does to it. A diagram that cannot shrink without breaking the floor keeps a minimum
 * width and scrolls in its own frame instead, and this is what proves the minimum is enough.
 *
 * The same loads hold the two things that frame depends on, each of which also drifted twice where nothing measured
 * it: the page itself never scrolls sideways, and a region that does scroll can be reached by keyboard, through a
 * tab stop of its own or something enabled and visible inside it, across or down. Chrome makes a scroller focusable
 * by itself; Safari does not. Nor may a box cut off text that runs past it, which the page does not scroll to. And
 * on the page that says every figure on it is gated in CI, every run of text outside its generated regions must be
 * one a reader can see: not hidden, faded to nothing, painted clear, moved off the page, or laid under another box,
 * found where Chrome draws it once every band has played in each colour scheme, and again at rest with less motion
 * in each, printed, and with scripts off; at the seven widths and at one inside every band the sheet's media queries
 * mark out; each generated region must show every run it renders; no list item may draw a marker;
 * and the figures Chrome built into the page, text, attributes and generated content, must be the ones the figures
 * gate read, so a construct the two parse apart fails wherever it stands.
 * A region is also announced by name, and its names drifted twice as well, a run of panels sharing one and a panel
 * taking a file name from the one above it: each region needs a name of its own on the page, and one inside a panel
 * is named for that panel's head.
 *
 * It drives Chrome over the DevTools Protocol with Node's global `WebSocket`, as `site-screenshots.mjs` does, so it
 * adds no dependency. CI runs it on `site-next/`.
 *
 * Usage:  node scripts/site-text-floor.mjs [site|site-next]    (TEXT_FLOOR_PORT=9445 for a second run at once)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = process.argv[2] ?? 'site-next';
if (!['site', 'site-next'].includes(TREE)) {
  console.error(`site-text-floor: the tree must be site or site-next, not ${TREE}`);
  process.exit(2);
}
const FLOOR = 9.5;
/** What the display-tier homepage's footer says; a page that says it is also held to showing what it states. */
const homeFigures = createRequire(import.meta.url)('./lib/home-figures.cjs');
const { CLAIM, plain } = homeFigures;
/** The pages the visibility probe ran on, which the report names so a run that probed none says so. */
const probed = new Set();
const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920];
/** Chrome's debugging port; two runs at once need two, so a second run is given its own. */
const PORT = Number(process.env.TEXT_FLOOR_PORT ?? 9444);
const SITE = join(ROOT, TREE);
const PAGES = readdirSync(SITE, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.html'))
  .map((e) => relative(SITE, join(e.parentPath ?? e.path, e.name)))
  .sort();
if (PAGES.length === 0) {
  console.error(
    `site-text-floor: no pages under ${TREE}/, refusing to report success over nothing`,
  );
  process.exit(1);
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chrome = process.env.CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
if (chrome === undefined) {
  console.error('site-text-floor: no Chrome or Chromium found. Set CHROME_PATH to the binary.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client: send(method, params) -> Promise<result>, with a deadline on every call. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('CDP socket error')));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id === undefined) {
      const cb = listeners.get(msg.method);
      if (cb) {
        listeners.delete(msg.method);
        cb(msg.params);
      }
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });
  return {
    ready,
    close: () => ws.close(),
    once: (method, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
        listeners.set(method, (p) => {
          clearTimeout(timer);
          resolve(p);
        });
      }),
    send: (method, params = {}, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), ms);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
}

/** Runs in the page: every visible element holding text, and the size its text is drawn at. */
const MEASURE = `(() => {
  const small = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || seen.has(el)) continue;
    seen.add(el);
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    let px = parseFloat(cs.fontSize);
    if (el instanceof SVGElement) {
      const m = el.getScreenCTM();
      if (!m) continue;
      px *= Math.hypot(m.a, m.b);
    } else {
      // A transform on the element or above it draws its text at its scale, on the axis it shrinks most, and a
      // turn is no scale at all; a zoom scales it too.
      for (let a = el; a; a = a.parentElement) {
        const t = getComputedStyle(a).transform;
        if (!t || t === 'none') continue;
        const m = new DOMMatrixReadOnly(t);
        px *= Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
      }
      px *= el.currentCSSZoom ?? 1;
    }
    if (px < ${FLOOR} - 0.005) {
      small.push({ px: Math.round(px * 100) / 100, text: text.slice(0, 48), cls: el.getAttribute('class') || el.tagName.toLowerCase() });
    }
  }
  return small;
})()`;

/**
 * Runs in a page that says every figure on it is gated: each run of text must be one a reader can see, since a check
 * that verified text a sheet then hides, moves off the page or paints clear proves nothing. Colours are read as the
 * pixel they paint, so any colour a sheet can write is measured. A generated region swaps one drawing for another by
 * width, and may hold one on a first frame before it plays; once everything has played, every run it renders is held
 * to the same test, and it must show something.
 *
 * With `hit`, each run is also found where it is drawn: every frame it sits in, and then the page, is scrolled to it,
 * and its first letters must be in view, inside every frame that scrolls or cuts off, with the element there its own,
 * so a run laid under another box, drawn below its section's ground, fixed out of view or out of any scroll's reach is
 * not seen. Every element takes pointer events while it looks (the sheet may not out-rank that), so a box that lets
 * clicks through still counts as covering; a positioned pseudo-element, which hit-tests as its element, covers the
 * run if it is its own element's and lies over its letters, and is a ground the run must stand out from if it lies
 * under them. A \`display: contents\` element is read through the box its parent draws. And no list item may draw a marker, a number the page's checks do not read.
 */
const unseen = ({ hit }) => `(() => {
  const out = { unseen: [], blank: [], markers: [] };
  const W = document.documentElement.scrollWidth;
  const H = document.documentElement.scrollHeight;
  // Any colour a sheet can write, oklch(), color-mix() and system colours included, read as the pixel it paints.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = c || 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]) => {
    const [R, G, B] = [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const probe = document.createElement('style');
  probe.textContent = '*, *::before, *::after { pointer-events: auto !important; }';
  if (${hit}) document.head.append(probe);
  const first = (range) => [...range.getClientRects()].find((q) => q.width > 0 && q.height > 0);
  /** Every ancestor that scrolls or cuts off what runs past it: a run is seen only inside all of them. */
  const frames = (el) => {
    const out = [];
    for (let f = el.parentElement; f && f !== document.documentElement; f = f.parentElement) {
      const s = getComputedStyle(f);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) out.push(f);
    }
    return out;
  };
  const point = (range) => {
    const q = first(range);
    return q ? [q.left + Math.min(q.width / 2, 8), q.top + q.height / 2] : null;
  };
  /**
   * The run brought to where a reader would read it: each frame it sits in scrolled to it, innermost first, and the
   * page scrolled to its middle, so scroll-driven styles are read there too. What no scroll reaches stays out of view.
   */
  const bring = (range, el) => {
    for (const f of frames(el)) {
      const p = point(range);
      if (!p) return;
      const r = f.getBoundingClientRect();
      if (p[0] < r.left || p[0] > r.right) f.scrollLeft += p[0] - (r.left + r.width / 2);
      if (p[1] < r.top || p[1] > r.bottom) f.scrollTop += p[1] - (r.top + r.height / 2);
    }
    const p = point(range);
    if (p && (p[1] < 150 || p[1] > innerHeight - 150)) {
      window.scrollTo({ top: p[1] + scrollY - innerHeight / 2, behavior: 'instant' });
    }
  };
  /** Whether the run's first letters are in view, inside every frame they sit in, and the element there is its own. */
  const found = (range, el) => {
    const p = point(range);
    if (!p) return false;
    const [x, y] = p;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    for (const f of frames(el)) {
      const r = f.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    }
    // A box faded out entirely paints nothing there, so it covers nothing; the first box that paints must be the run's.
    const faded = (e) => {
      let o = 1;
      for (let a = e; a; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
      return o < 0.05;
    };
    if (document.elementsFromPoint(x, y).find((e) => !faded(e)) !== boxed(el)) return false;
    // The run's own element's pseudo-elements hit-test as the element: one laid over its letters covers them.
    return !pseudoBoxes(el).some((b) => !b.under && covers(b, p));
  };
  /** The element whose box draws a run: a \`display: contents\` element has none, and its parent's box draws its text. */
  const boxed = (e) => {
    let a = e;
    while (a && getComputedStyle(a).display === 'contents') a = a.parentElement;
    return a ?? e;
  };
  /**
   * The boxes an element's ::before and ::after paint when positioned: a pseudo-element hit-tests as its element,
   * so one laid over the element's own text, or under it in the text's colour, is found here or nowhere.
   */
  const pseudoBoxes = (e) =>
    ['::before', '::after'].flatMap((p) => {
      const ps = getComputedStyle(e, p);
      if (ps.content === 'none' || ps.content === 'normal' || !/^(absolute|fixed)$/.test(ps.position)) return [];
      const bg = rgba(ps.backgroundColor);
      const painted = bg[3] > 0.05 || ps.backgroundImage !== 'none' || ps.boxShadow !== 'none';
      const w = parseFloat(ps.width);
      const h = parseFloat(ps.height);
      if (!painted || !(w > 2 && h > 2)) return [];
      let cb = ps.position === 'fixed' ? null : e;
      while (cb && getComputedStyle(cb).position === 'static') cb = cb.parentElement;
      const base = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
      const cbs = cb ? getComputedStyle(cb) : null;
      const left = base.left + (cbs ? parseFloat(cbs.borderLeftWidth) || 0 : 0) + (parseFloat(ps.left) || 0);
      const top = base.top + (cbs ? parseFloat(cbs.borderTopWidth) || 0 : 0) + (parseFloat(ps.top) || 0);
      return [{ left, top, right: left + w, bottom: top + h, bg, under: parseInt(ps.zIndex, 10) < 0 }];
    });
  const covers = (b, [x, y]) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  const regions = [];
  const shows = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE) {
      const m = /^ BENCH:([A-Z]+):(START|END) $/.exec(n.data);
      if (m && m[2] === 'START') {
        regions.push(m[1]);
        if (!shows.has(m[1])) shows.set(m[1], false);
      } else if (m) regions.pop();
      continue;
    }
    const text = n.data.trim();
    const el = n.parentElement;
    if (!text || !el || el.closest('script, style')) continue;
    // A skip link is off the page until it has focus, which is what a skip link is.
    if (el.closest('a.skip[href^="#"]') && !/\\d/.test(text)) continue;
    // A generated region swaps one drawing for another by width, so a run it does not render is not unseen; before
    // anything has played it may hold its drawing on a first frame, so it is read only once everything has.
    const region = regions.at(-1);
    if (region !== undefined && (!${hit} || !boxed(el).checkVisibility())) continue;
    // The one run a generated region rests unseen by design: the chunk grid's first-phase caption, which its
    // animation shows and its final frame fades out. The regions' markup is held byte for byte, so nothing else can
    // wear the class.
    if (region !== undefined && el.closest('.k-ph1')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    if (${hit}) bring(range, el);
    const box = range.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const svg = el instanceof SVGElement;
    const paint = rgba(svg ? cs.fill : cs.webkitTextFillColor || cs.color);
    const onPage =
      frames(el).some((f) => /(auto|scroll)/.test(getComputedStyle(f).overflowX + getComputedStyle(f).overflowY)) ||
      (box.right + scrollX > 0 && box.bottom + scrollY > 0 && box.left + scrollX < W && box.top + scrollY < H);
    // Faded, filtered, clipped, masked or blended by anything above it is not seen whole, and the homepage has none;
    // nor is SVG text whose stroke is painted over its letters, or whose fill is faded.
    let opacity = 1;
    let veiled =
      svg &&
      ((cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0.5 && !/^stroke/.test(cs.paintOrder) && rgba(cs.stroke)[3] > 0) ||
        parseFloat(cs.fillOpacity) < 0.9);
    let ground = null;
    for (let a = el; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      opacity *= parseFloat(as.opacity);
      if (as.filter !== 'none' || as.clipPath !== 'none' || as.maskImage !== 'none' || as.mixBlendMode !== 'normal') {
        veiled = true;
      }
      if (ground === null && rgba(as.backgroundColor)[3] >= 0.9) ground = rgba(as.backgroundColor);
    }
    ground = ground ?? rgba(getComputedStyle(document.documentElement).backgroundColor);
    // The letters as painted: their colour laid over the ground at its own alpha.
    const drawn = paint.slice(0, 3).map((v, k) => v * paint[3] + ground[k] * (1 - paint[3]));
    const against = (g) => {
      const [hi, lo] = [lum(drawn), lum(g)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Against the ground, and against any box a pseudo-element here or above paints across the run's first letters.
    const at = ${hit} ? point(range) : null;
    const grounds = [ground];
    if (at) {
      for (let a = el; a; a = a.parentElement) {
        for (const b of pseudoBoxes(a)) if (b.bg[3] >= 0.9 && covers(b, at)) grounds.push(b.bg);
      }
    }
    const contrast = Math.min(...grounds.map(against));
    const seen =
      boxed(el).checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      cs.visibility === 'visible' &&
      box.width > 0 && box.height > 0 && onPage &&
      opacity >= 0.9 && !veiled && !/^(disc|circle|square)$/.test(cs.webkitTextSecurity) &&
      paint[3] >= 0.9 && rgba(cs.color)[3] >= 0.9 && contrast >= 3 &&
      (!${hit} || found(range, el));
    if (region !== undefined && seen) shows.set(region, true);
    if (!seen) out.unseen.push((region ? 'BENCH:' + region + ': ' : '') + text.slice(0, 60));
  }
  probe.remove();
  for (const [name, any] of shows) if (!any) out.blank.push(name);
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (/list-item/.test(cs.display) && (cs.listStyleType !== 'none' || cs.listStyleImage !== 'none')) {
      out.markers.push(el.tagName.toLowerCase() + ' (' + cs.listStyleType + ')');
    }
  }
  return out;
})()`;

/**
 * Runs in the page, awaited: with `scroll`, scrolls it top to bottom, so every band that plays on sight plays; then
 * waits until every animation that ends has ended.
 */
const settle = ({ scroll }) => `(async () => {
  if (${scroll}) {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += innerHeight / 2) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }
  const deadline = performance.now() + 15000;
  const moving = () =>
    document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
  while (moving().length > 0) {
    if (performance.now() > deadline) return moving().length + ' animation(s) still running after 15s';
    await new Promise((r) => setTimeout(r, 50));
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  return '';
})()`;

/**
 * Runs in the page: how many times each figure stands in what Chrome built, read as the figures gate reads the page
 * (`readerFigures`): every text node but a script's or a sheet's, the prose attributes and descriptions, and what the
 * sheet puts before and after each element. Where the two counts disagree, the gate and the browser read the page
 * apart, and a figure the gate held may not be the figure a reader got.
 */
const FIGURES = `(() => {
  const NUMBER = new RegExp(${JSON.stringify(homeFigures.NUMBER.source)}, 'gu');
  const GLUED = new RegExp(${JSON.stringify(homeFigures.GLUED.source)}, 'gu');
  const NAMES = new Set(${JSON.stringify([...homeFigures.NAMES_WITH_DIGITS])});
  const PROSE = ${JSON.stringify(homeFigures.PROSE_ATTRS)};
  const NON_PROSE = new Set(${JSON.stringify([...homeFigures.NON_PROSE_METAS])});
  const counts = {};
  const add = (text) => {
    const glued = [...text.matchAll(GLUED)].map((m) => m[0]).filter((w) => !NAMES.has(w.toLowerCase()));
    for (const f of [...[...text.matchAll(NUMBER)].map((m) => m[0]), ...glued]) counts[f] = (counts[f] ?? 0) + 1;
  };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/^(script|style)$/i.test(n.parentNode?.localName ?? '')) continue;
    add(n.data);
  }
  for (const el of document.querySelectorAll('*')) {
    for (const a of PROSE) if (el.hasAttribute(a)) add(el.getAttribute(a));
    if (el.localName === 'meta' && el.hasAttribute('content')) {
      const keys = ['name', 'property', 'itemprop'].filter((k) => el.hasAttribute(k)).map((k) => el.getAttribute(k).toLowerCase());
      if (keys.some((k) => !NON_PROSE.has(k))) add(el.getAttribute('content'));
    }
    for (const pseudo of ['::before', '::after', '::marker']) {
      const content = getComputedStyle(el, pseudo).content;
      for (const m of (content ?? '').matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)) add(m[1]);
    }
  }
  return counts;
})()`;

/** Runs in the page once: each landmark region without a name, sharing one, or named for another panel. */
const NAMES = `(() => {
  const flat = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const seen = new Map();
  for (const r of document.querySelectorAll('[role="region"]')) {
    const by = r.getAttribute('aria-labelledby');
    const name = flat(by ? by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent).join(' ') : r.getAttribute('aria-label'));
    const head = flat(r.closest('.tpanel')?.querySelector(':scope > .tpanel-head > .label')?.textContent);
    if (!name) out.push('a region has no name');
    else if (head && name !== head) out.push('the region "' + name + '" sits in the panel headed "' + head + '"');
    if (name) seen.set(name, (seen.get(name) || 0) + 1);
  }
  for (const [name, n] of seen) if (n > 1) out.push(n + ' regions share the name "' + name + '"');
  return out;
})()`;

/** Runs in the page: how far it scrolls sideways, and each region that scrolls with no way in by keyboard. */
const LAYOUT = `(() => {
  const root = document.documentElement;
  const unreachable = [];
  const clipped = [];
  const nameOf = (el) => (el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '').trim().split(/\\s+/).join('.')).replace(/\\.$/, '');
  const inOrder = (el) => {
    const t = el.getAttribute('tabindex');
    return t !== null && Number.parseInt(t, 10) >= 0;
  };
  const reachable = (el) =>
    !el.disabled && el.checkVisibility() && !(el.hasAttribute('tabindex') && !inOrder(el));
  for (const el of document.body.querySelectorAll('*')) {
    if (el instanceof SVGElement) continue;
    const cs = getComputedStyle(el);
    const wide = el.scrollWidth > el.clientWidth + 1;
    const tall = el.scrollHeight > el.clientHeight + 1;
    const scrolls = (/^(auto|scroll)$/.test(cs.overflowX) && wide) || (/^(auto|scroll)$/.test(cs.overflowY) && tall);
    if (scrolls) {
      const inside = [...el.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].some(reachable);
      if (!inOrder(el) && !inside) unreachable.push(nameOf(el));
    }
    // Text that runs past a box which cuts it off is text no reader gets: a clip is for a drawing, not for words.
    const cuts = (/^(hidden|clip)$/.test(cs.overflowX) && wide) || (/^(hidden|clip)$/.test(cs.overflowY) && tall);
    // A visually-hidden box of a pixel is the idiom for words meant only for a screen reader, not a cut.
    const rect = el.getBoundingClientRect();
    if (cuts && el.innerText.trim() !== '' && rect.width > 1 && rect.height > 1) clipped.push(nameOf(el));
  }
  return { sideways: root.scrollWidth - root.clientWidth, unreachable, clipped };
})()`;

const profile = mkdtempSync(join(tmpdir(), 'cb-text-floor-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const problems = [];
let measured = 0;
/** The loads at widths between the sheet's breakpoints, on the page that says its figures are gated. */
let between = 0;
try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Chrome DevTools endpoint never came up');
    await sleep(150);
  }
  const sheet = existsSync(join(SITE, 'cloudbitmaps.css'))
    ? readFileSync(join(SITE, 'cloudbitmaps.css'), 'utf8')
    : '';
  for (const page of PAGES) {
    // On the page that says its figures are gated, a width inside every band the sheet's media queries mark out too.
    const bands =
      page === 'index.html' && homeFigures.isDisplayTier(readFileSync(join(SITE, page), 'utf8'))
        ? homeFigures.widthsToProbe(sheet, WIDTHS)
        : [];
    between += bands.length;
    for (const width of [...WIDTHS, ...bands]) {
      // A page the probe cannot finish is a problem with that page, reported beside the others.
      try {
        const target = await (
          await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' })
        ).json();
        const cdp = connect(target.webSocketDebuggerUrl);
        await cdp.ready;
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // The first load is in the light scheme wherever this runs, so a local run and CI look at the same page.
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'light' }],
        });
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: `file://${join(SITE, page)}` });
        await loaded;
        await sleep(150);
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: MEASURE,
          returnByValue: true,
        });
        measured++;
        for (const s of result.value) {
          problems.push(
            `${TREE}/${page} at ${width}px: "${s.text}" (${s.cls}) is drawn at ${s.px}px`,
          );
        }
        const layout = (
          await cdp.send('Runtime.evaluate', { expression: LAYOUT, returnByValue: true })
        ).result.value;
        if (layout.sideways > 0) {
          problems.push(
            `${TREE}/${page} at ${width}px: the page scrolls sideways by ${layout.sideways}px`,
          );
        }
        for (const el of layout.unreachable) {
          problems.push(
            `${TREE}/${page} at ${width}px: ${el} scrolls, and nothing in it can be reached by keyboard`,
          );
        }
        for (const el of layout.clipped) {
          problems.push(`${TREE}/${page} at ${width}px: ${el} cuts off text that runs past it`);
        }
        const claims = (
          await cdp.send('Runtime.evaluate', {
            expression:
              "document.body.innerText.normalize('NFKC').replace(/[\\p{Cf}\\u00ad]/gu, '').replace(/\\s+/g, ' ')" +
              `.toLowerCase().includes(${JSON.stringify(plain(CLAIM))}) || ` +
              // On the homepage, the display tier's own classes, as the figures gate knows it (`isDisplayTier`).
              `(${JSON.stringify(page)} === 'index.html' && document.querySelector('[class^="cb-"], [class*=" cb-"]') !== null)`,
            returnByValue: true,
          })
        ).result.value;
        if (claims) {
          probed.add(page);
          const evaluate = async (expression, awaitPromise = false) =>
            (
              await cdp.send(
                'Runtime.evaluate',
                { expression, returnByValue: true, awaitPromise },
                60_000,
              )
            ).result.value;
          const report = (when, r, { regions = true } = {}) => {
            const at = `${TREE}/${page} at ${width}px${when}`;
            for (const t of r.unseen)
              problems.push(`${at}: "${t}" is on the page, and no reader can see it`);
            if (regions) {
              for (const name of r.blank) {
                problems.push(
                  `${at}: the generated region BENCH:${name} shows nothing a reader can see`,
                );
              }
            }
            for (const m of r.markers)
              problems.push(`${at}: a list item draws a marker, ${m}, which no check reads`);
          };
          const wait = async (when, scroll) => {
            const stuck = await evaluate(settle({ scroll }), true);
            if (stuck) problems.push(`${TREE}/${page} at ${width}px${when}: ${stuck}`);
          };
          // Once per page: the figures Chrome built against the figures the gate read.
          if (width === WIDTHS[0]) {
            const want = homeFigures.readerFigures(readFileSync(join(SITE, page), 'utf8'));
            const got = await evaluate(FIGURES);
            for (const f of new Set([...want.keys(), ...Object.keys(got)])) {
              if ((want.get(f) ?? 0) !== (got[f] ?? 0)) {
                problems.push(
                  `${TREE}/${page}: Chrome shows ${f} ${got[f] ?? 0} time(s) and the figures gate read it ` +
                    `${want.get(f) ?? 0}, so the two read the page apart`,
                );
              }
            }
          }
          // As it loads, before anything has played: a band may hold its drawing on a first frame, and the rest shows.
          report('', await evaluate(unseen({ hit: false })), { regions: false });
          // Then reloaded as each reader who gets a different page: with motion, played at twenty times the speed, in
          // each scheme; with less motion, every animation on its final frame, in each scheme; printed; and with scripts
          // off. In each, once everything has come to rest, every run is found where it is drawn: a fade that starts
          // late, a rule for one theme, for paper or for a reader without scripts, or text laid under another box.
          const passes = [
            { when: ', once played, light', scheme: 'light', motion: true },
            { when: ', once played, dark', scheme: 'dark', motion: true },
            { when: ', light, with less motion', scheme: 'light' },
            { when: ', dark, with less motion', scheme: 'dark' },
            { when: ', printed', scheme: 'light', media: 'print' },
            { when: ', with scripts off', scheme: 'light', scriptsOff: true },
          ];
          await cdp.send('Animation.enable');
          for (const pass of passes) {
            await cdp.send('Emulation.setScriptExecutionDisabled', {
              value: pass.scriptsOff === true,
            });
            await cdp.send('Emulation.setEmulatedMedia', {
              media: pass.media ?? '',
              features: [
                { name: 'prefers-reduced-motion', value: pass.motion ? 'no-preference' : 'reduce' },
                { name: 'prefers-color-scheme', value: pass.scheme },
              ],
            });
            const reloaded = cdp.once('Page.loadEventFired');
            await cdp.send('Page.reload', { ignoreCache: true });
            await reloaded;
            await sleep(150);
            await cdp.send('Animation.setPlaybackRate', { playbackRate: pass.motion ? 20 : 1 });
            await wait(pass.when, pass.motion === true);
            report(pass.when, await evaluate(unseen({ hit: true })));
          }
          await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
          await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
        }
        if (width === WIDTHS[0]) {
          const names = (
            await cdp.send('Runtime.evaluate', { expression: NAMES, returnByValue: true })
          ).result.value;
          for (const n of names) problems.push(`${TREE}/${page}: ${n}`);
        }
        cdp.close();
        await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
      } catch (err) {
        problems.push(`${TREE}/${page} at ${width}px: the probe could not finish (${err.message})`);
      }
    }
  }
} finally {
  // Chrome is closed through the protocol, not by a signal. A signal ends the browser process but not at once its
  // helpers, and on Linux they went on writing to the profile after it exited: removing the profile raced them and
  // failed a run whose every page had passed. `Browser.close` shuts the helpers down and flushes the profile first.
  const gone = () => proc.exitCode !== null || proc.signalCode !== null;
  const exited = gone() ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  const exitWithin = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
  try {
    const { webSocketDebuggerUrl } = await (
      await fetch(`http://127.0.0.1:${PORT}/json/version`)
    ).json();
    const browser = connect(webSocketDebuggerUrl);
    await browser.ready;
    // Chrome may exit before it replies, which is a close that worked.
    await browser.send('Browser.close', {}, 3_000).catch(() => {});
  } catch {
    proc.kill();
  }
  if (!(await exitWithin(10_000))) {
    proc.kill('SIGKILL');
    await exitWithin(5_000);
  }
  // What this reports is the pages, not the cleanup: a profile left in the temp directory is warned about, and
  // does not fail a run.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(
      `site-text-floor: left the Chrome profile at ${profile} (${err.code ?? err.message})`,
    );
  }
}

if (problems.length > 0) {
  console.error(`site-text-floor: ${problems.length} problem(s) with what renders:`);
  for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
  if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
  console.error(
    '\n  A diagram that cannot shrink without dropping a label below the floor keeps a minimum width and scrolls\n' +
      '  in its own frame (`.cb-scroll`): viewBox width × 9.5 ÷ its smallest label size. A frame that scrolls\n' +
      '  takes `tabindex="0"`, and a page must fit its width without scrolling sideways.',
  );
  process.exit(1);
}
console.log(
  `site-text-floor: ${measured} page loads (${PAGES.length} pages × ${WIDTHS.length} widths, and ${between} between ` +
    `the sheet's breakpoints), nothing under ${FLOOR}px, no page scrolling sideways or cutting off text, every region ` +
    'that scrolls reachable by keyboard and named for itself, and every word in view, found where it is drawn, once ' +
    'played and at rest in each colour scheme, printed and with scripts off, every generated region showing, no list ' +
    'marker, and Chrome reading the same figures as the figures gate, on ' +
    `${probed.size ? [...probed].join(', ') : 'no page (none says its figures are gated)'}.`,
);
