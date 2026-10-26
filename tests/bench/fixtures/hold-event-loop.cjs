/*
 * A preload that keeps the process it is loaded into alive, as a stray handle (a helper process the bench started and
 * never stopped) would. It leaves the bench's own child processes alone, which are named by a `--child...` argument.
 */
'use strict';
const { setInterval } = require('node:timers');
if (!process.argv.some((a) => a.startsWith('--child'))) setInterval(() => {}, 1000);
