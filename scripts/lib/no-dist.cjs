'use strict';
// Hides every `packages/*/dist` from a run and puts it back, so a command sees the tree as CI's test step does (CI runs
// the tests before the build, so no package has a `dist/` there).
//
//   <root>/packages/<pkg>/dist  --hide-->  <root>/node_modules/.no-dist-aside/<pkg>   (a rename on one filesystem)
//                               <-restore-
//
// The aside folder sits under `node_modules`, which git, eslint, prettier and tsc already ignore. A hidden `dist/` is
// restored by the run itself (normal end, failure, SIGINT, SIGTERM, SIGHUP), and by the next call of `hide` or
// `restore` for the one case no handler covers (the process was killed with SIGKILL, or the machine lost power). A lock
// file holding the running process's id stops two runs from hiding at once; a lock whose process is gone is stale and
// is replaced.
const fs = require('node:fs');
const path = require('node:path');

const ASIDE = path.join('node_modules', '.no-dist-aside');
const LOCK = 'lock';

const packageDirs = (root) => {
  const dir = path.join(root, 'packages');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Puts back every `dist/` a run left hidden. A package that already has a `dist/` (a build ran after the crash) keeps
// that one and the hidden copy, which is older, is deleted. Returns the packages it restored.
const restore = (root) => {
  const aside = path.join(root, ASIDE);
  if (!fs.existsSync(aside)) return [];
  const restored = [];
  for (const pkg of fs.readdirSync(aside)) {
    if (pkg === LOCK) continue;
    const hidden = path.join(aside, pkg);
    const dist = path.join(root, 'packages', pkg, 'dist');
    if (fs.existsSync(dist)) fs.rmSync(hidden, { recursive: true, force: true });
    else {
      fs.renameSync(hidden, dist);
      restored.push(pkg);
    }
  }
  fs.rmSync(path.join(aside, LOCK), { force: true });
  fs.rmdirSync(aside);
  return restored;
};

// Hides every `dist/`, after restoring what an earlier run left. Throws if another run is hiding right now. Returns the
// function that puts them back (safe to call twice).
const hide = (root) => {
  const aside = path.join(root, ASIDE);
  const lock = path.join(aside, LOCK);
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) {
      throw new Error(
        `another no-dist run (process ${pid}) has the dist folders hidden; wait for it to finish`,
      );
    }
  }
  restore(root);
  fs.mkdirSync(aside, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  for (const pkg of packageDirs(root)) {
    const dist = path.join(root, 'packages', pkg, 'dist');
    if (fs.existsSync(dist)) fs.renameSync(dist, path.join(aside, pkg));
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    restore(root);
  };
};

module.exports = { hide, restore, ASIDE };
