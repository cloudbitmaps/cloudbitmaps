/**
 * Capture full-page screenshots of `site/` — the attachments for the design brief.
 *
 * These existed before as four PNGs someone took by hand, and they drifted: by the time anyone looked again
 * they showed an older version badge and a page that had since gained two table rows. A brief is only as good
 * as the artefacts attached to it, so this makes them reproducible — `pnpm site:screenshots` and they are
 * current by construction.
 *
 * **No new dependencies.** It drives Chrome over the DevTools Protocol using the `WebSocket` that is global in
 * modern Node, rather than pulling in Playwright or Puppeteer (~300 MB of browser download) for four PNGs a
 * couple of times a year. Chrome's `--screenshot` CLI flag would have been simpler still, but it captures the
 * viewport only; a design brief needs the whole page, which needs `Page.getLayoutMetrics` and
 * `captureBeyondViewport`.
 *
 * Usage:  node scripts/site-screenshots.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? `${ROOT}/.site-screenshots`);
const PAGES = ['index', 'usage', 'architecture', 'benchmarks', 'flavors', 'flavors/roaring'];
/**
 * Both themes, every time.
 *
 * Light is a designed theme rather than an inversion, so a change that looks right on the graphite ground can
 * be unreadable on paper — and nobody would notice from a dark-only screenshot set. Captured by seeding
 * `localStorage` before the page loads, which is the same path a returning visitor takes.
 */
const THEMES = ['dark', 'light'];
/** Desktop width a reviewer actually uses; height only seeds the viewport before the full-page override. */
const WIDTH = 1440;
const PORT = 9222;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const chrome = process.env.CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
if (chrome === undefined) {
  console.error('No Chrome/Chromium found. Set CHROME_PATH to the binary.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the DevTools endpoint rather than guessing a startup delay. */
async function waitForDevtools(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

/** Minimal CDP client: send(method, params) -> Promise<result>. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) =>
      rej(new Error(`CDP socket error: ${String(e.message ?? e.type)}`)),
    );
  });
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.id === undefined) {
      // An event. `once`-style: fire and forget the handler.
      const cb = listeners.get(msg.method);
      if (cb !== undefined) {
        listeners.delete(msg.method);
        cb(msg.params);
      }
      return;
    }
    const slot = pending.get(msg.id);
    if (slot === undefined) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.method ?? ''})`));
    else slot.resolve(msg.result);
  });
  return {
    ready,
    close: () => ws.close(),
    /** Resolve the next time `method` fires, or reject after `timeoutMs` rather than hanging forever. */
    once(method, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(method);
          reject(new Error(`timed out waiting for ${method}`));
        }, timeoutMs);
        listeners.set(method, (params) => {
          clearTimeout(timer);
          resolve(params);
        });
      });
    },
    send(method, params = {}, timeoutMs = 20_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // A CDP call that never replies must fail loudly. `Page.getLayoutMetrics` did exactly that on
        // Chrome 150 — no reply, no error — and without a deadline the whole script simply wedged.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, timeoutMs);
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
      });
    },
  };
}

mkdirSync(OUT, { recursive: true });

const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${WIDTH},900`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitForDevtools();
  for (const { page, theme } of PAGES.flatMap((page) => THEMES.map((theme) => ({ page, theme })))) {
    // Open a BLANK target and navigate over CDP rather than passing the URL to `/json/new?<url>`. That query
    // form does not reliably honour a `file://` URL, and the failure is silent: the target exists, the socket
    // opens, `Page.enable` succeeds, and then `Page.getLayoutMetrics` simply never returns because the page is
    // stuck mid-navigation. Navigating explicitly also gives a real `Page.loadEventFired` to wait on instead of
    // a guessed sleep.
    const target = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' })
    ).json();
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    // Seed the stored preference before any document loads, so the page's own head script picks it up and
    // paints the right theme first time — exactly as it would for a returning visitor.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('cb-theme', '${theme}'); } catch (e) {}`,
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${ROOT}/site/${page}.html` });
    await loaded;
    await sleep(400); // let webfonts and the logo SVG paint before capturing

    // Height from the DOM rather than `Page.getLayoutMetrics`, which hangs without replying on Chrome 150.
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'Math.ceil(document.documentElement.scrollHeight)',
      returnByValue: true,
    });
    const height = result.value;
    // Resize the viewport to the full document, so `captureBeyondViewport` has nothing left to stitch.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);

    // The viewport override above already spans the whole document, so `captureBeyondViewport` has nothing to
    // add — and asking for both made `Page.captureScreenshot` hang on a tall page. Generous deadline because a
    // ~5,000px surface genuinely takes a few seconds to encode.
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 60_000);
    const file = `${OUT}/${page}-${theme}.png`;
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${`${page}-${theme}`.padEnd(24)} ${WIDTH}x${height}  →  ${file}`);
    cdp.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }
} finally {
  proc.kill();
}
