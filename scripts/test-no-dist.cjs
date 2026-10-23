#!/usr/bin/env node
'use strict';
// `pnpm test:no-dist [vitest arguments]`: the unit suite with no `packages/*/dist` reachable, as in CI, whose test step
// runs before the build. A test that resolves a package through its `dist/` (an `exports` path, a spawned CLI, a script
// that imports a built entry) passes on a machine with an old build and fails only there.
//
// It hides each `dist/` (scripts/lib/no-dist.cjs), runs `vitest run` with the arguments given (a file, `-t`,
// `--maxWorkers=2`), and puts every `dist/` back whatever the outcome. `node scripts/test-no-dist.cjs --restore` only
// puts back what a killed run left; the next run does it too.
//
// CB_NO_DIST_ROOT names the tree to work on (the default is this repository); the test of this script points it at a
// temporary one.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { hide, restore } = require('./lib/no-dist.cjs');

const root = path.resolve(process.env.CB_NO_DIST_ROOT || path.join(__dirname, '..'));
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--restore') {
  const restored = restore(root);
  console.log(restored.length ? `restored dist for: ${restored.join(', ')}` : 'nothing to restore');
  process.exit(0);
}

let put;
try {
  put = hide(root);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const vitest = path.join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
const child = spawn(process.execPath, [vitest, 'run', ...args], { cwd: root, stdio: 'inherit' });

// A signal for this process goes to the run, which then ends and lets the code below restore. A second signal ends it.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    else {
      put();
      process.exit(1);
    }
  });
}
process.on('exit', () => put());

child.on('error', (err) => {
  console.error(err.message);
  put();
  process.exit(1);
});
child.on('close', (code, signal) => {
  put();
  process.exit(code ?? (signal ? 128 : 1));
});
