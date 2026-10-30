#!/usr/bin/env node
'use strict';

// Local mode: drive in this terminal. F / S speed up / slow down, T toggles the tunnel, q quits (Ctrl-C only shows the key legend).
// Usage: drive.js [--fps N] [--seed N]   (default 60 fps)
const { runLocal, DEFAULT_FPS } = require('../src/terminal');
const { parseFps } = require('../src/loop');

const argv = process.argv.slice(2);
const seedIdx = argv.indexOf('--seed');
const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : undefined;
runLocal({ seed, fps: parseFps(argv) || DEFAULT_FPS });
