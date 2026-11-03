'use strict';
/*
 * What the machine has to run the large suite with: the memory available and the disk free in the home directory, the
 * two things `free -m` and `df -h ~` report. Read with Node, so the same line is printed from CloudShell, a laptop or
 * a container. `calibrate-large-stages.cjs` holds the floors and judges what this reads.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIB = 1024 * 1024;

/**
 * The most memory a container lets its processes take, in MiB, from the cgroup the process runs in: cgroup v2's
 * `memory.max`, or cgroup v1's `memory.limit_in_bytes`. `null` where there is no limit (`max` in v2, or v1's value of about
 * 2^63 for none), where the files are not there, or where they hold anything but a number.
 */
function cgroupLimitMB(read = (f) => fs.readFileSync(f, 'utf8')) {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const text = String(read(file)).trim();
      if (!/^\d+$/.test(text)) continue;
      const bytes = Number(text);
      // Under 2^52 bytes is a limit someone set; v1 reports the page-rounded maximum when there is none.
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 52) return Math.floor(bytes / MIB);
    } catch {
      // Not there: the other file, or no limit.
    }
  }
  return null;
}

/**
 * The memory a process may use, in MiB: `MemAvailable` where the kernel says it, or the container's own limit
 * ({@link cgroupLimitMB}: the cap, not what is left under it) where that is lower, since in a container `MemAvailable` reports the host's and a limit would go
 * unseen (`kind: 'limit'`). Elsewhere Node can say only what is free this instant, which on a laptop is far below what a
 * process could take (the system keeps its caches in the rest), so the machine's total stands in and the report says so.
 */
function availableMemoryMB(read = (f) => fs.readFileSync(f, 'utf8')) {
  const limit = cgroupLimitMB(read);
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(read('/proc/meminfo'));
    if (m !== null) {
      const mb = Math.floor(Number(m[1]) / 1024);
      return limit !== null && limit < mb
        ? { mb: limit, kind: 'limit' }
        : { mb, kind: 'available' };
    }
  } catch {
    // Not Linux, or no /proc.
  }
  if (limit !== null) return { mb: limit, kind: 'limit' };
  const total = os.totalmem();
  return Number.isFinite(total)
    ? { mb: Math.floor(total / MIB), kind: 'total' }
    : { mb: null, kind: 'total' };
}

/** The disk free for a user in the home directory, in MiB, or null when the machine cannot say. */
function freeDiskMB(dir = os.homedir(), statfs = fs.statfsSync) {
  try {
    const s = statfs(dir);
    const bytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(bytes) ? Math.floor(bytes / MIB) : null;
  } catch {
    return null;
  }
}

/** What the machine has now, and the one line a run prints about it. */
function resourcesNow() {
  const memory = availableMemoryMB();
  const have = {
    memoryMB: memory.mb,
    memoryKind: memory.kind,
    diskMB: freeDiskMB(),
    totalMemoryMB: Math.floor(os.totalmem() / MIB),
    cpus: os.availableParallelism(),
  };
  const show = (v) => (v === null ? 'unknown' : `${v} MiB`);
  return {
    have,
    line:
      `${show(have.memoryMB)} memory ${
        have.memoryKind === 'available'
          ? 'available'
          : have.memoryKind === 'limit'
            ? '(the container limit, below what the host reports available)'
            : '(total; this platform reports no available figure)'
      }, ` + `${show(have.diskMB)} free in the home directory, ${have.cpus} CPUs`,
  };
}

/**
 * The text of the entry files of the installed `@cloudbitmaps/core` and `@cloudbitmaps/s3`: from a checkout's built
 * packages, or from the `node_modules` of the scratch directory the CloudShell script installs the published ones in.
 * A package that is in neither place reads as an empty text, which names nothing.
 */
function installedSources(root, read = (f) => fs.readFileSync(f, 'utf8')) {
  const first = (names) => {
    for (const rel of names) {
      try {
        return read(path.join(root, rel));
      } catch {
        // Not there: the other place.
      }
    }
    return '';
  };
  return {
    core: first(['packages/core/dist/index.js', 'node_modules/@cloudbitmaps/core/dist/index.js']),
    s3: first(['packages/s3/dist/index.js', 'node_modules/@cloudbitmaps/s3/dist/index.js']),
  };
}

module.exports = { installedSources, cgroupLimitMB, availableMemoryMB, freeDiskMB, resourcesNow };
