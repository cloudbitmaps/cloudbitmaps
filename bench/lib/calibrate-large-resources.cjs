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
 * The memory a process can still take, in MiB: `MemAvailable` where the kernel says it. Elsewhere Node can say only what
 * is free this instant, which on a laptop is far below what a process could take (the system keeps its caches in the
 * rest), so the machine's total stands in and the report says so.
 */
function availableMemoryMB(read = (f) => fs.readFileSync(f, 'utf8')) {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(read('/proc/meminfo'));
    if (m !== null) return { mb: Math.floor(Number(m[1]) / 1024), kind: 'available' };
  } catch {
    // Not Linux, or no /proc.
  }
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
      `${show(have.memoryMB)} memory ${have.memoryKind === 'available' ? 'available' : '(total; this platform reports no available figure)'}, ` +
      `${show(have.diskMB)} free in the home directory, ${have.cpus} CPUs`,
  };
}

/**
 * The text of the entry files of the installed `@cloudbitmaps/core` and `@cloudbitmaps/s3`: from a checkout's built
 * packages, or from the `node_modules` of the scratch directory the CloudShell script installs the published ones in.
 * An entry is read with the chunks it imports (`from "./chunk-….js"`), where the build puts the code two entry points
 * share, so a constant the bundler moved into one is still read. A package that is in neither place reads as an empty
 * text, which names nothing.
 */
function installedSources(root, read = (f) => fs.readFileSync(f, 'utf8')) {
  const withChunks = (file) => {
    const text = read(file);
    const chunks = new Set(
      [...text.matchAll(/\bfrom\s*["'](\.\/chunk-[\w-]+\.js)["']/g)].map((m) => m[1]),
    );
    return [text, ...[...chunks].map((rel) => read(path.join(path.dirname(file), rel)))].join('\n');
  };
  const first = (names) => {
    for (const rel of names) {
      try {
        return withChunks(path.join(root, rel));
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

module.exports = { installedSources, availableMemoryMB, freeDiskMB, resourcesNow };
