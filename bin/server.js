#!/usr/bin/env node
'use strict';

// SSH server mode: each login gets its own drive (and nothing else).
// Usage: server.js [--config FILE] [--hostkey FILE] [--fps N] [--seed N]
//   --config   users and port, default ./ascidrive.cnf
//   --hostkey  server host key, default ./ascidrive_host_key (created if missing)
//   --fps      frames per second per connection, default 30
//   --seed     same road for everyone (default: a random road per login)
const path = require('path');
const { runServer } = require('../src/sshserver');
const { parseFps } = require('../src/loop');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const seed = arg('--seed') !== undefined ? Number(arg('--seed')) : undefined;

try {
  runServer({
    configFile: path.resolve(arg('--config') || 'ascidrive.cnf'),
    hostKeyFile: path.resolve(arg('--hostkey') || 'ascidrive_host_key'),
    fps: parseFps(argv) || 30,
    seed,
  });
} catch (err) {
  console.error(`ascidrive: ${err.message}`);
  process.exit(1);
}
