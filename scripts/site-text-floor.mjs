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
 * one a reader can see: not hidden, faded to nothing, painted clear, or moved off the page.
 * A region is also announced by name, and its names drifted twice as well, a run of panels sharing one and a panel
 * taking a file name from the one above it: each region needs a name of its own on the page, and one inside a panel
 * is named for that panel's head.
 *
 * It drives Chrome over the DevTools Protocol with Node's global `WebSocket`, as `site-screenshots.mjs` does, so it
 * adds no dependency. CI runs it on `site-next/`.
 *
 * Usage:  node scripts/site-text-floor.mjs [site|site-next]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
const { CLAIM, plain } = createRequire(import.meta.url)('./lib/home-figures.cjs');
/** The pages the visibility probe ran on, which the report names so a run that probed none says so. */
const probed = new Set();
const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920];
const PORT = 9444;
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
 * Runs in a page that says every figure on it is gated: each run of text outside the generated regions must be
 * one a reader can see, since a check that verified text a sheet then hides, moves off the page or paints clear
 * proves nothing. The generated regions are held byte for byte elsewhere, and a drawing swapped for the one that
 * fits, or a caption between two frames of an animation, is hidden there on purpose.
 */
const UNSEEN = `(() => {
  const out = [];
  const W = document.documentElement.scrollWidth;
  const H = document.documentElement.scrollHeight;
  const alpha = (c) => {
    if (!c || c === 'none' || c === 'transparent') return 0;
    const m = /rgba?\\(([^)]*)\\)/.exec(c);
    if (!m) return 1;
    const parts = m[1].split(/[\\s,/]+/).filter(Boolean);
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  };
  let region = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE) {
      if (/^ BENCH:[A-Z]+:START $/.test(n.data)) region++;
      else if (/^ BENCH:[A-Z]+:END $/.test(n.data)) region--;
      continue;
    }
    const text = n.data.trim();
    const el = n.parentElement;
    if (!text || region > 0 || !el || el.closest('script, style')) continue;
    // A skip link is off the page until it has focus, which is what a skip link is.
    if (el.closest('a.skip[href^="#"]') && !/\\d/.test(text)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const box = range.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const paint = el instanceof SVGElement ? cs.fill : cs.webkitTextFillColor || cs.color;
    // Text further along a frame that scrolls is reachable; text past the page's own edge is not.
    let frame = el.parentElement;
    while (frame && !/(auto|scroll)/.test(getComputedStyle(frame).overflowX + getComputedStyle(frame).overflowY)) {
      frame = frame.parentElement;
    }
    const onPage =
      frame !== null ||
      (box.right + scrollX > 0 && box.bottom + scrollY > 0 && box.left + scrollX < W && box.top + scrollY < H);
    // Faded, filtered, clipped, masked or blended by anything above it is not seen whole, and the homepage has none.
    let opacity = 1;
    let veiled = false;
    let ground = null;
    for (let a = el; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      opacity *= parseFloat(as.opacity);
      if (as.filter !== 'none' || as.clipPath !== 'none' || as.maskImage !== 'none' || as.mixBlendMode !== 'normal') {
        veiled = true;
      }
      if (ground === null && alpha(as.backgroundColor) >= 0.9) ground = as.backgroundColor;
    }
    ground = ground ?? getComputedStyle(document.documentElement).backgroundColor;
    const rgb = (c) => (/rgba?\\(([^)]*)\\)/.exec(c)?.[1] ?? '0 0 0').split(/[\\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgb(c).map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(paint), lum(ground)].sort((a, b) => b - a);
    const contrast = (hi + 0.05) / (lo + 0.05);
    const seen =
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      box.width > 0 && box.height > 0 && onPage &&
      opacity >= 0.9 && !veiled && cs.webkitTextSecurity !== 'disc' && cs.webkitTextSecurity !== 'circle' &&
      cs.webkitTextSecurity !== 'square' &&
      alpha(paint) >= 0.9 && alpha(cs.color) >= 0.9 && contrast >= 3;
    if (!seen) out.push(text.slice(0, 60));
    continue;
    if (!seen) out.push(text.slice(0, 60));
  }
  return out;
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
  for (const page of PAGES) {
    for (const width of WIDTHS) {
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
            "document.querySelector('section.cb-stack.is-hero') !== null",
          returnByValue: true,
        })
      ).result.value;
      if (claims) {
        probed.add(page);
        const unseen = (
          await cdp.send('Runtime.evaluate', { expression: UNSEEN, returnByValue: true })
        ).result.value;
        for (const t of unseen) {
          problems.push(
            `${TREE}/${page} at ${width}px: "${t}" is on the page, and no reader can see it`,
          );
        }
        // And as a reader who asked for less motion gets it, every animation on its final frame, in each colour
        // scheme: a class that holds text on a first frame while motion is allowed can leave it faded out at
        // rest, and a rule can hide text in one theme only.
        for (const scheme of ['light', 'dark']) {
          await cdp.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-reduced-motion', value: 'reduce' },
              { name: 'prefers-color-scheme', value: scheme },
            ],
          });
          const reloaded = cdp.once('Page.loadEventFired');
          await cdp.send('Page.reload', { ignoreCache: true });
          await reloaded;
          await sleep(150);
          const atRest = (
            await cdp.send('Runtime.evaluate', { expression: UNSEEN, returnByValue: true })
          ).result.value;
          for (const t of atRest) {
            problems.push(
              `${TREE}/${page} at ${width}px, ${scheme}, with less motion: "${t}" is on the page, and no reader ` +
                'can see it',
            );
          }
        }
      }
      if (width === WIDTHS[0]) {
        const names = (
          await cdp.send('Runtime.evaluate', { expression: NAMES, returnByValue: true })
        ).result.value;
        for (const n of names) problems.push(`${TREE}/${page}: ${n}`);
      }
      cdp.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
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
  `site-text-floor: ${measured} page loads (${PAGES.length} pages × ${WIDTHS.length} widths), nothing under ${FLOOR}px, ` +
    'no page scrolling sideways or cutting off text, every region that scrolls reachable by keyboard and named for ' +
    `itself, and every word in view on ${probed.size ? [...probed].join(', ') : 'no page (none says its figures are gated)'}.`,
);
