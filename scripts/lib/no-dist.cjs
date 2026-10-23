'use strict';
// Hides every `packages/*/dist` from a run and puts it back, so a command sees the tree as CI's test step does (CI runs
// the tests before the build, so no package has a `dist/` there).
//
//   <root>/packages/<pkg>/dist  --hide-->  <root>/.no-dist-aside/hidden/<pkg>/dist   (a rename on one filesystem)
//                               <-restore-
//   <root>/.no-dist-aside/lock                 the process id of the run that has them hidden
//   <root>/.no-dist-aside/kept/<time>-<pkg>/   a hidden dist that could not go back (see restore)
//
// The aside folder is at the repository root, outside `node_modules`, so `rm -rf node_modules` or a reinstall does not
// delete a hidden build; `git clean -x` still would (git ignores the folder). It is ignored by git, eslint and prettier,
// and the `dist` folders inside it by tsc.
//
// A hidden `dist/` is restored by the run itself (normal end, failure, SIGINT, SIGTERM, SIGHUP, an error while hiding),
// and by the next call of `hide` or `restore` for the one case no handler covers (SIGKILL, power loss). The lock is
// created exclusively, so two runs cannot both hide; a lock whose process is gone, or that holds no process id, is stale.
// Restoring never deletes a build: a `dist/` that cannot go back where it came from is moved to `kept/` and reported.
const fs = require('node:fs');
const path = require('node:path');

const ASIDE = '.no-dist-aside';
const STALE_EMPTY_LOCK_MS = 5000;

const paths = (root) => {
  const aside = path.join(root, ASIDE);
  return {
    aside,
    hidden: path.join(aside, 'hidden'),
    kept: path.join(aside, 'kept'),
    lock: path.join(aside, 'lock'),
  };
};

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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A directory rename on Windows fails with EPERM or EBUSY while something (an indexer, a scanner) holds a file in it.
const rename = (from, to) => {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || attempt >= 5) throw err;
      sleep(100 * (attempt + 1));
    }
  }
};

// The process id in the lock, 0 when the file holds none, and null when there is no lock.
const lockHolder = (lock) => {
  let text;
  try {
    text = fs.readFileSync(lock, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
};

const busy = (pid) =>
  new Error(
    `another no-dist run (process ${pid}) has the dist folders hidden; wait for it to finish. ` +
      'If that process is gone, `node scripts/test-no-dist.cjs --restore` puts them back',
  );

// Takes the lock, or throws when a live run holds it.
const acquire = (lock) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = lockHolder(lock);
    if (pid === null) continue;
    if (pid > 0 && pid !== process.pid && alive(pid)) throw busy(pid);
    // No process id: another run may be between creating the file and writing it, so only an old file is stale.
    if (pid === 0 && Date.now() - fs.statSync(lock).mtimeMs < STALE_EMPTY_LOCK_MS)
      throw busy('starting');
    fs.rmSync(lock, { force: true });
  }
  throw busy('unknown');
};

// Puts back every hidden `dist/`, each entry on its own: one that fails does not stop the rest. A package whose
// `dist/` exists again (a build ran meanwhile) or whose folder is gone keeps the hidden copy under `kept/`, never
// deleted, because nothing shows the new one is complete. Returns { restored, kept, failed }, each a list of packages.
const restoreHidden = (root) => {
  const p = paths(root);
  const out = { restored: [], kept: [], failed: [] };
  if (!fs.existsSync(p.hidden)) return out;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const pkg of fs.readdirSync(p.hidden)) {
    const from = path.join(p.hidden, pkg, 'dist');
    const to = path.join(root, 'packages', pkg, 'dist');
    try {
      if (!fs.existsSync(from)) {
        fs.rmSync(path.join(p.hidden, pkg), { recursive: true, force: true });
      } else if (fs.existsSync(path.join(root, 'packages', pkg)) && !fs.existsSync(to)) {
        rename(from, to);
        fs.rmdirSync(path.join(p.hidden, pkg));
        out.restored.push(pkg);
      } else {
        const dest = path.join(p.kept, `${stamp}-${pkg}`);
        fs.mkdirSync(dest, { recursive: true });
        rename(from, path.join(dest, 'dist'));
        fs.rmdirSync(path.join(p.hidden, pkg));
        out.kept.push(pkg);
      }
    } catch (err) {
      out.failed.push(
        `${pkg} (${err.code || err.message}; its build is in ${path.join(p.hidden, pkg)})`,
      );
    }
  }
  return out;
};

// Removes the aside folder when nothing is left in it.
const tidy = (root) => {
  const p = paths(root);
  for (const dir of [p.hidden, p.kept, p.aside]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty, or already gone
    }
  }
};

// Hides every `dist/`, after restoring what an earlier run left. Throws if a live run holds them. Returns the function
// that puts them back and releases the lock (safe to call twice); it returns what restoreHidden does.
const hide = (root) => {
  const p = paths(root);
  fs.mkdirSync(p.aside, { recursive: true });
  try {
    acquire(p.lock);
  } catch (err) {
    tidy(root);
    throw err;
  }
  let result;
  const put = () => {
    if (result) return result;
    result = restoreHidden(root);
    if (!result.failed.length) fs.rmSync(p.lock, { force: true });
    tidy(root);
    return result;
  };
  try {
    restoreHidden(root);
    for (const pkg of packageDirs(root)) {
      const dist = path.join(root, 'packages', pkg, 'dist');
      if (!fs.existsSync(dist)) continue;
      fs.mkdirSync(path.join(p.hidden, pkg), { recursive: true });
      rename(dist, path.join(p.hidden, pkg, 'dist'));
    }
  } catch (err) {
    put();
    throw err;
  }
  return put;
};

// Puts back what a run that was killed left hidden. Refuses while a live run holds the lock, since it would un-hide the
// folders under that run.
const restore = (root) => {
  const p = paths(root);
  const pid = lockHolder(p.lock);
  if (pid && pid !== process.pid && alive(pid)) throw busy(pid);
  const result = restoreHidden(root);
  if (!result.failed.length) fs.rmSync(p.lock, { force: true });
  tidy(root);
  return result;
};

module.exports = { hide, restore, ASIDE };
