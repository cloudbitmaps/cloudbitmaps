/**
 * Nothing on the site is drawn below 9.5px: every visible run of text, SVG labels included, at six widths.
 *
 * The floor is a design rule the stylesheet can only state, and it drifted twice where nothing measured it: labels in
 * a diagram's `viewBox` shrink with the diagram, so a label authored at 10 units is 10px only at the width the diagram
 * was drawn for, and a comment saying the floor held was wrong at most widths. This measures what renders. For an
 * HTML element it is the computed font size; for SVG text it is that size through the element's screen transform,
 * which is what the viewBox does to it. A diagram that cannot shrink without breaking the floor keeps a minimum
 * width and scrolls in its own frame instead, and this is what proves the minimum is enough.
 *
 * It drives Chrome over the DevTools Protocol with Node's global `WebSocket`, as `site-screenshots.mjs` does, so it
 * adds no dependency. CI runs it on `site-next/`.
 *
 * Usage:  node scripts/site-text-floor.mjs [site|site-next]
 */
import { spawn } from 'node:child_process';
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
const WIDTHS = [320, 390, 768, 1024, 1280, 1440];
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
    }
    if (px < ${FLOOR} - 0.005) {
      small.push({ px: Math.round(px * 100) / 100, text: text.slice(0, 48), cls: el.getAttribute('class') || el.tagName.toLowerCase() });
    }
  }
  return small;
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
      cdp.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
    }
  }
} finally {
  // Chrome writes to its profile as it exits, so the profile goes only once the process has.
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await Promise.race([exited, sleep(5_000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (problems.length > 0) {
  console.error(`site-text-floor: ${problems.length} text run(s) below ${FLOOR}px:`);
  for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
  if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
  console.error(
    '\n  A diagram that cannot shrink without dropping a label below the floor keeps a minimum width and scrolls\n' +
      '  in its own frame (`.cb-scroll`): viewBox width × 9.5 ÷ its smallest label size.',
  );
  process.exit(1);
}
console.log(
  `site-text-floor: ${measured} page loads (${PAGES.length} pages × ${WIDTHS.length} widths), nothing under ${FLOOR}px.`,
);
