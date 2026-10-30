/*
 * Removes the work folders its parent named on stdin once stdin closes (the parent has ended). It refuses anything that
 * is not an absolute path to a folder made by the system's temp-folder call (a name ending in six letters or digits, not at the root).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let pending = '';
const dirs = [];

function safe(dir) {
  const parent = path.dirname(dir);
  return (
    path.isAbsolute(dir) &&
    parent !== dir &&
    parent !== path.dirname(parent) &&
    /-[A-Za-z0-9]{6}$/.test(dir)
  );
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) if (line !== '' && safe(line)) dirs.push(line);
});
process.stdin.on('end', () => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
// A signal meant for the process group must not stop it before its parent's folders are gone.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
