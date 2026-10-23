#!/usr/bin/env node
'use strict';
// `pnpm test:no-dist [vitest arguments]`: the unit suite with no `packages/*/dist` reachable, as in CI, whose test step
// runs before the build. A test that resolves a package through its `dist/` (an `exports` path, a spawned `node` that
// resolves a package, a script that imports a built entry) passes on a machine with an old build and fails only there.
//
// It hides each `dist/` (scripts/lib/no-dist.cjs), runs `vitest run` with the arguments given (a file, `-t`,
// `--maxWorkers=2`), and puts every `dist/` back whatever the outcome. The folders are absent for the whole run, in
// every terminal, so build nothing and run nothing against `dist/` meanwhile. `node scripts/test-no-dist.cjs --restore`
// only puts back what a killed run left (and refuses while a run is live); the next run does it too.
//
// CB_NO_DIST_ROOT names the tree to work on (the default is this repository); the test of this script points it at a
// temporary one.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { hide, restore } = require('./lib/no-dist.cjs');

const root = path.resolve(process.env.CB_NO_DIST_ROOT || path.join(__dirname, '..'));
const args = process.argv.slice(2);

const report = (result) => {
  if (result.restored.length) console.log(`restored dist for: ${result.restored.join(', ')}`);
  for (const pkg of result.kept) {
    console.error(
      `kept a hidden dist for ${pkg} under .no-dist-aside/kept (its package has a dist again, or is gone)`,
    );
  }
  for (const failure of result.failed) console.error(`could not restore dist for ${failure}`);
  return result.failed.length ? 1 : 0;
};

if (args.includes('--restore') && args.length > 1) {
  console.error('--restore takes no other argument');
  process.exit(2);
}
if (args.length === 1 && args[0] === '--restore') {
  try {
    const result = restore(root);
    const code = report(result);
    if (!code && !result.restored.length && !result.kept.length) console.log('nothing to restore');
    process.exit(code);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

const vitest = path.join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(vitest)) {
  console.error('vitest is not installed here: run `pnpm install --frozen-lockfile` first');
  process.exit(2);
}

let child;
let put;
let signals = 0;
let code = 1;
const finish = (exitCode) => {
  try {
    if (put) {
      const result = put();
      code = report(result) || exitCode;
      if (result.kept.length && !code) {
        // A dist came back during the run (a build elsewhere, a test writing one) or a package folder went: the run did
        // not have CI's state, so a pass proves nothing.
        console.error(
          "the run did not have CI's state throughout, so its result cannot be trusted: run it again",
        );
        code = 1;
      }
    } else code = exitCode;
  } catch (err) {
    console.error(err.message);
    code = 1;
  }
  process.exit(code);
};

// The handlers come first, so a signal during hiding is held until `put` exists (hiding is synchronous). A signal for
// this process goes to the run, which ends and lets the close handler restore; a second one restores and ends now.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    signals++;
    if (!child) return;
    if (signals === 1 && child.exitCode === null && child.signalCode === null) child.kill(sig);
    else {
      child.kill('SIGKILL');
      finish(130);
    }
  });
}

process.on('exit', () => {
  if (put) put();
});

try {
  const hidden = hide(root);
  put = hidden.put;
  report(hidden.before);
} catch (err) {
  console.error(err.message);
  if (err.before) report(err.before);
  if (err.restore) report(err.restore);
  process.exit(2);
}

child = spawn(process.execPath, [vitest, 'run', ...args], { cwd: root, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(err.message);
  finish(1);
});
child.on('close', (status, signal) => finish(status ?? (signal ? 128 : 1)));
