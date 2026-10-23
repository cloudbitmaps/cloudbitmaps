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
// created exclusively; a stale one (its process is gone, it is older than the last boot, the process now holding that id
// started after the lock was written, or it holds no process id and is five seconds old) is taken over under a second
// exclusive file, so one process at a time judges and replaces it. A clock step can still misjudge a lock.
// Restoring never deletes a build: a `dist/` that cannot go back where it came from is moved to `kept/` and reported.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ASIDE = '.no-dist-aside';
const STALE_EMPTY_LOCK_MS = 5000;
// How much later than the lock a process may have started and still be its writer. `ps` derives a start time from the boot
// time on Linux, which moves when the clock is stepped, so a few seconds would misjudge a live run after a step.
const REUSE_TOLERANCE_MS = 10 * 60 * 1000;

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

const busy = (who) =>
  new Error(
    `another no-dist run (${who}) has the dist folders hidden; wait for it to finish. If no run is going, ` +
      '`node scripts/test-no-dist.cjs --restore` puts them back, and deleting `.no-dist-aside/lock` clears a lock it refuses',
  );

// When a process started, from `ps` (only the start time is asked for), or null where that cannot be read.
const startedAt = (pid) => {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
};

// Whether the lock names a run that is over: its process is gone, the lock is older than the last boot, or the process
// that now has that id started after the lock was written (the id was reused).
const stale = (lock, pid) => {
  if (!alive(pid)) return true;
  const written = fs.statSync(lock).mtimeMs;
  if (written < Date.now() - os.uptime() * 1000 - 1000) return true;
  const started = startedAt(pid);
  return started !== null && started > written + REUSE_TOLERANCE_MS;
};

// Takes the lock, or throws when a live run holds it. A stale lock is taken over under a second exclusive file, so only
// one process at a time judges it, removes it and creates its own.
const acquire = (lock) => {
  const claim = (flag) => fs.writeFileSync(lock, String(process.pid), { flag });
  try {
    claim('wx');
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const verdict = () => {
    let pid;
    try {
      pid = lockHolder(lock);
      if (pid === null) return 'free';
      if (pid === 0)
        return Date.now() - fs.statSync(lock).mtimeMs < STALE_EMPTY_LOCK_MS ? 'starting' : 'stale';
      return pid !== process.pid && !stale(lock, pid) ? pid : 'stale';
    } catch (err) {
      if (err.code === 'ENOENT') return 'free';
      throw err;
    }
  };
  let first = verdict();
  if (first !== 'free' && first !== 'stale')
    throw busy(first === 'starting' ? 'one is starting' : `process ${first}`);
  const takeover = `${lock}.takeover`;
  try {
    fs.writeFileSync(takeover, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Left by a process that died while taking over: only an old file is stale.
    try {
      if (Date.now() - fs.statSync(takeover).mtimeMs > STALE_EMPTY_LOCK_MS)
        fs.rmSync(takeover, { force: true });
    } catch {
      // gone already
    }
    throw busy('one is starting');
  }
  try {
    first = verdict();
    if (first !== 'free' && first !== 'stale')
      throw busy(first === 'starting' ? 'one is starting' : `process ${first}`);
    if (first === 'stale') fs.rmSync(lock, { force: true });
    claim('wx');
  } finally {
    fs.rmSync(takeover, { force: true });
  }
};

// Removes a package's folder under `hidden/` once its `dist` is out of it. Anything else in it (a `.DS_Store` that Finder
// writes when someone opens the folder) goes too; a `dist` never does, so it throws if one is still there.
const dropFolder = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    if (name !== 'dist') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  fs.rmdirSync(dir);
};

// The same after a build went back: the build is safe by then, so a folder that will not go is no failure; the next run
// clears it.
const dropFolderQuietly = (dir) => {
  try {
    dropFolder(dir);
  } catch {
    // left for the next restore
  }
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
        dropFolder(path.join(p.hidden, pkg));
      } else if (fs.existsSync(path.join(root, 'packages', pkg)) && !fs.existsSync(to)) {
        rename(from, to);
        dropFolderQuietly(path.join(p.hidden, pkg));
        out.restored.push(pkg);
      } else {
        const dest = path.join(p.kept, `${stamp}-${pkg}`);
        fs.mkdirSync(dest, { recursive: true });
        rename(from, path.join(dest, 'dist'));
        dropFolderQuietly(path.join(p.hidden, pkg));
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
// `put`, which puts them back and releases the lock (safe to call twice; it returns what restoreHidden does), and
// `before`, what the restore before the run did. A throw carries the same two as `restore` and `before`.
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
  let before;
  try {
    before = restoreHidden(root);
    for (const pkg of packageDirs(root)) {
      const dist = path.join(root, 'packages', pkg, 'dist');
      if (!fs.existsSync(dist)) continue;
      fs.mkdirSync(path.join(p.hidden, pkg), { recursive: true });
      rename(dist, path.join(p.hidden, pkg, 'dist'));
    }
  } catch (err) {
    err.restore = put();
    err.before = before;
    throw err;
  }
  return { put, before };
};

// Puts back what a run that was killed left hidden. It takes the lock, so it refuses while a live run holds it (it would
// un-hide the folders under that run) and while another restore is going.
const restore = (root) => {
  const p = paths(root);
  if (!fs.existsSync(p.aside)) return { restored: [], kept: [], failed: [] };
  acquire(p.lock);
  const result = restoreHidden(root);
  if (!result.failed.length) fs.rmSync(p.lock, { force: true });
  tidy(root);
  return result;
};

module.exports = { hide, restore, ASIDE };
