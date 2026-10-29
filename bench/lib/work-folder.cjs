/*
 * Temp folders a bench makes, removed on every way the bench can end.
 *
 * `make(parent, prefix)` is `fs.mkdtempSync(path.join(parent, prefix))` plus a promise: the folder is removed when the
 * process ends however it ends: it returns, throws, calls `process.exit`, is stopped by SIGINT or SIGTERM, or is killed.
 * A bench measures in synchronous calls, so a JavaScript signal handler would not run until the call returned; instead
 * the first folder starts a small detached sentinel (`work-folder-sentinel.cjs`) holding the read end of a pipe from
 * this process, and the sentinel removes every folder it was told of when that pipe closes, which the operating system
 * does when this process is gone. The sentinel is not a child the process waits for and does not poll.
 *
 *     parent process ──pipe──▶ sentinel (detached)       parent gone ⇒ pipe closes ⇒ sentinel removes the folders
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let sentinel;

function sentinelFor() {
  if (sentinel === undefined) {
    sentinel = spawn(process.execPath, [path.join(__dirname, 'work-folder-sentinel.cjs')], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    sentinel.unref();
    sentinel.stdin.unref();
    sentinel.on('error', () => {});
    sentinel.stdin.on('error', () => {});
  }
  return sentinel;
}

/** Makes `<parent>/<prefix>XXXXXX` and has it removed when this process ends; returns its path. */
function make(parent, prefix) {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  if (dir.includes('\n')) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('a work folder path may not hold a newline');
  }
  sentinelFor().stdin.write(`${path.resolve(dir)}\n`);
  return dir;
}

module.exports = { make };
