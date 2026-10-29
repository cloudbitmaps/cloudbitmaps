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
 * If the sentinel cannot start, dies, or cannot be written to (a stage that copied `bench/` without it), cleanup after a
 * kill is not in force: one line on stderr names each folder that would be left behind, and the bench carries on.
 *
 *     parent process ──pipe──▶ sentinel (detached)       parent gone ⇒ pipe closes ⇒ sentinel removes the folders
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let sentinel;
let failure; // why the sentinel is not working, once it is known
const made = [];

function report(dir) {
  try {
    fs.writeSync(
      2,
      `work folder cleanup is not running (${failure}); left behind if this process stops: ${dir}\n`,
    );
  } catch {
    /* stderr is gone: nothing more to say */
  }
}

function fail(reason) {
  if (failure !== undefined) return;
  failure = reason;
  for (const dir of made) report(dir);
}

function sentinelFor() {
  if (sentinel === undefined) {
    sentinel = spawn(process.execPath, [path.join(__dirname, 'work-folder-sentinel.cjs')], {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    sentinel.unref();
    sentinel.stdin.unref();
    sentinel.on('error', (e) => fail(`sentinel did not start: ${e.code ?? e.message}`));
    sentinel.on('exit', (code) => fail(`sentinel exited with ${code}`));
    sentinel.stdin.on('error', (e) => fail(`sentinel not reachable: ${e.code ?? e.message}`));
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
  made.push(dir);
  sentinelFor().stdin.write(`${path.resolve(dir)}\n`);
  if (failure !== undefined) report(dir);
  return dir;
}

module.exports = { make };
