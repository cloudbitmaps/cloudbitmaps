'use strict';
/*
 * What the machine has to run the large suite with: the memory available and the disk free in the home directory, the
 * two things `free -m` and `df -h ~` report. Read with Node, so the same line is printed from CloudShell, a laptop or
 * a container. `calibrate-large-stages.cjs` holds the floors and judges what this reads.
 */
const fs = require('node:fs');
const os = require('node:os');

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

module.exports = { availableMemoryMB, freeDiskMB, resourcesNow };
