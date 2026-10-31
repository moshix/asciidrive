'use strict';

// SSH server mode: every login gets its own drive, and nothing else. There is
// no shell, no exec, no sftp, no forwarding and no agent: the only thing a
// connection can do is watch the road and press f / s / t / q. q (or closing
// the client) ends the connection.
//
// Users and the port come from a config file (default ./ascidrive.cnf):
//
//   port=2828
//   tom/password1
//   anna/another secret
//
// Lines starting with # are comments. A password runs to the end of the line
// and may contain '/' or '='. The user list is re-read when the file changes;
// the port is read once at startup.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server, utils } = require('ssh2');
const output = require('./output');
const { startDrive } = require('./drive');

const LIMITS = {
  MAX_CONN: 20, // concurrent connections overall
  MAX_CONN_PER_IP: 3,
  AUTH_TIMEOUT_MS: 60 * 1000, // time to log in after connecting
  MAX_AUTH_TRIES: 3, // failed passwords per connection
  FAIL_DELAY_MS: 2000, // pause before answering a wrong password
  BAN_FAILS: 10, // failed passwords from one IP ...
  BAN_WINDOW_MS: 15 * 60 * 1000, // ... within this window ...
  BAN_MS: 30 * 60 * 1000, // ... block that IP for this long
  MAX_TRACKED_IPS: 10000, // cap on the failure table
  IDLE_MS: 30 * 60 * 1000, // no keypress for this long ends the drive
  STALL_MS: 60 * 1000, // client not reading output for this long: disconnect
  MAX_COLS: 300, // larger pty sizes are clamped (bounds memory and CPU per session)
  MAX_ROWS: 100,
  MAX_FIELD: 128, // longest user name / password accepted
};

// ------------------------------------------------------------------ config

// Returns { port, users: Map(name -> sha256(password)) }. Throws on a broken
// port line; skips (and reports) malformed user lines.
function readConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const users = new Map();
  let port;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^port\s*=\s*(\S*)$/i.exec(line);
    if (m) {
      const p = Number(m[1]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${file}:${i + 1}: bad port "${m[1]}"`);
      port = p;
      return;
    }
    const slash = line.indexOf('/');
    const name = slash > 0 ? line.slice(0, slash) : '';
    const pass = slash > 0 ? line.slice(slash + 1) : '';
    if (!name || !pass || /\s/.test(name) || name.length > LIMITS.MAX_FIELD || pass.length > LIMITS.MAX_FIELD) {
      log(`config ${file}:${i + 1}: ignored (expected user/password)`);
      return;
    }
    users.set(name, sha256(pass));
  });
  return { port, users };
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

// Constant-time check; an unknown user costs the same as a wrong password.
const DUMMY = sha256(crypto.randomBytes(32));
function checkPassword(users, name, pass) {
  const want = users.get(name);
  const ok = crypto.timingSafeEqual(want || DUMMY, sha256(pass));
  return ok && want !== undefined;
}

// Host key: created on first start next to the config file, kept private.
function loadHostKey(file) {
  if (!fs.existsSync(file)) {
    const { private: key } = utils.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    log(`created host key ${file}`);
  }
  return fs.readFileSync(file);
}

// --------------------------------------------------------------- abuse guards

class Guard {
  constructor() {
    this.perIp = new Map(); // ip -> open connections
    this.total = 0;
    this.fails = new Map(); // ip -> { times: [ms], bannedUntil }
  }

  // Returns a reason string when this IP may not connect right now.
  refuse(ip) {
    const f = this.fails.get(ip);
    if (f && f.bannedUntil > Date.now()) return 'banned';
    if (this.total >= LIMITS.MAX_CONN) return 'server full';
    if ((this.perIp.get(ip) || 0) >= LIMITS.MAX_CONN_PER_IP) return 'too many connections from this address';
    return null;
  }

  open(ip) {
    this.total++;
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
  }

  close(ip) {
    this.total--;
    const n = (this.perIp.get(ip) || 1) - 1;
    if (n > 0) this.perIp.set(ip, n);
    else this.perIp.delete(ip);
  }

  failed(ip) {
    const now = Date.now();
    if (!this.fails.has(ip) && this.fails.size >= LIMITS.MAX_TRACKED_IPS) this._prune(now);
    const f = this.fails.get(ip) || { times: [], bannedUntil: 0 };
    f.times = f.times.filter((t) => now - t < LIMITS.BAN_WINDOW_MS);
    f.times.push(now);
    if (f.times.length >= LIMITS.BAN_FAILS) {
      f.bannedUntil = now + LIMITS.BAN_MS;
      f.times = [];
      log(`${ip} banned for ${LIMITS.BAN_MS / 60000} min after repeated failed logins`);
    }
    this.fails.set(ip, f);
  }

  _prune(now) {
    for (const [ip, f] of this.fails) {
      if (f.bannedUntil <= now && f.times.every((t) => now - t >= LIMITS.BAN_WINDOW_MS)) this.fails.delete(ip);
    }
    // Still full (e.g. a flood from many addresses): forget the oldest entries.
    for (const ip of this.fails.keys()) {
      if (this.fails.size < LIMITS.MAX_TRACKED_IPS) break;
      this.fails.delete(ip);
    }
  }
}

// ------------------------------------------------------------------- server

function runServer({ configFile, hostKeyFile, fps, seed }) {
  let config = readConfig(configFile);
  if (!config.port) throw new Error(`${configFile}: no port=N line`);
  if (config.users.size === 0) log(`warning: ${configFile} has no users yet; nobody can log in`);
  warnIfReadable(configFile);
  const port = config.port;

  // Pick up user changes without a restart (the port needs one).
  fs.watchFile(configFile, { interval: 2000 }, () => {
    try {
      const next = readConfig(configFile);
      config = { port, users: next.users };
      log(`reloaded ${configFile}: ${next.users.size} user(s)`);
    } catch (err) {
      log(`reload of ${configFile} failed, keeping the old users: ${err.message}`);
    }
  });

  const guard = new Guard();
  const server = new Server({ hostKeys: [loadHostKey(hostKeyFile)], ident: 'ascidrive' }, (client, info) => {
    const ip = info.ip || '?';
    const reason = guard.refuse(ip);
    if (reason) {
      log(`${ip} refused: ${reason}`);
      client.on('error', () => {});
      client.end();
      return;
    }
    guard.open(ip);
    log(`${ip} connected`);
    handleClient(client, ip, () => config.users, guard, { fps, seed });
  });

  server.on('error', (err) => log(`server error: ${err.message}`));
  server.listen(port, () => log(`ascidrive ssh server listening on port ${port}`));
  return server;
}

function handleClient(client, ip, getUsers, guard, { fps, seed }) {
  let user = null;
  let tries = 0;
  let closed = false;
  let drive = null;

  const authTimer = setTimeout(() => {
    if (!user) {
      log(`${ip} disconnected: login timeout`);
      client.end();
    }
  }, LIMITS.AUTH_TIMEOUT_MS);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    if (drive) drive.stop();
    guard.close(ip);
    log(`${ip} ${user ? `(${clean(user)}) ` : ''}disconnected`);
  };
  client.on('close', cleanup);
  client.on('end', cleanup);
  client.on('error', (err) => log(`${ip} error: ${err.message}`));

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'password') return ctx.reject(['password']);
    const name = String(ctx.username || '');
    const pass = String(ctx.password || '');
    const ok = name.length <= LIMITS.MAX_FIELD && pass.length <= LIMITS.MAX_FIELD && checkPassword(getUsers(), name, pass);
    if (ok) {
      user = name;
      log(`${ip} login ACCEPTED: user ${clean(name)} password ${clean(pass)}`);
      return ctx.accept();
    }
    tries++;
    guard.failed(ip);
    log(`${ip} login REJECTED: user ${clean(name)} password ${clean(pass)}`);
    // Slow down guessing; drop the connection after a few tries.
    setTimeout(() => {
      if (closed) return;
      if (tries >= LIMITS.MAX_AUTH_TRIES) client.end();
      else ctx.reject(['password']);
    }, LIMITS.FAIL_DELAY_MS);
  });

  client.on('ready', () => {
    clearTimeout(authTimer);
    let sessionTaken = false;
    client.on('session', (accept, reject) => {
      // One drive per connection; extra channels are refused.
      if (sessionTaken) return reject();
      sessionTaken = true;
      runSession(accept(), client, ip, user, { fps, seed }, (d) => {
        drive = d;
      });
    });
    // Forwarding of any kind is never allowed.
    client.on('tcpip', (accept, reject) => reject());
    client.on('openssh.streamlocal', (accept, reject) => reject());
    client.on('request', (accept, reject) => {
      if (reject) reject();
    });
  });
}

function runSession(session, client, ip, user, { fps, seed }, setDrive) {
  let cols = 0;
  let rows = 0;
  let drive = null;
  let started = false;

  const size = (info) => [
    clamp(info.cols | 0, 1, LIMITS.MAX_COLS),
    clamp(info.rows | 0, 1, LIMITS.MAX_ROWS),
  ];

  session.on('pty', (accept, reject, info) => {
    [cols, rows] = size(info);
    if (accept) accept();
  });
  session.on('window-change', (accept, reject, info) => {
    [cols, rows] = size(info);
    if (drive) drive.resize(cols, rows);
    if (accept) accept();
  });
  // Everything that could run or reach anything else is refused.
  for (const ev of ['exec', 'subsystem', 'sftp', 'x11', 'auth-agent', 'signal', 'env']) {
    session.on(ev, (accept, reject) => {
      if (reject) reject();
    });
  }

  session.on('shell', (accept, reject) => {
    if (started) return reject && reject();
    started = true;
    const stream = accept();
    if (!cols) {
      // No terminal (e.g. `ssh -T`): nothing to draw on.
      stream.write('ascidrive needs a terminal: connect with plain `ssh -p PORT user@host`.\r\n');
      stream.exit(1);
      stream.end();
      return;
    }

    let lastKey = Date.now();
    let stalledSince = 0;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (drive) drive.stop();
      try {
        stream.write(output.leave({ altScreen: true }));
        stream.exit(0);
        stream.end();
      } catch (_) { /* already gone */ }
      client.end();
    };

    stream.write(output.enter({ altScreen: true }));
    drive = startDrive({
      seed: seed !== undefined ? seed : crypto.randomInt(1, 2 ** 31),
      fps,
      width: cols,
      height: rows,
      write: (s) => stream.write(s),
      backedUp: () => {
        const behind = stream.writableLength > Math.max(32 * 1024, cols * rows);
        const now = Date.now();
        if (!behind) stalledSince = 0;
        else if (!stalledSince) stalledSince = now;
        else if (now - stalledSince > LIMITS.STALL_MS) {
          log(`${ip} (${clean(user)}) not reading output, disconnecting`);
          end();
        }
        if (now - lastKey > LIMITS.IDLE_MS) {
          log(`${ip} (${clean(user)}) idle, disconnecting`);
          end();
        }
        return behind;
      },
      onQuit: end,
    });
    setDrive(drive);

    stream.on('data', (buf) => {
      lastKey = Date.now();
      drive.input(buf);
    });
    stream.on('error', () => end());
    stream.on('close', end);
  });
}

// --------------------------------------------------------------- helpers

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// User-supplied text in logs: printable ASCII only, bounded length.
function clean(s) {
  return JSON.stringify(String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 40));
}

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function warnIfReadable(file) {
  try {
    if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) {
      log(`warning: ${file} holds passwords but is readable by others; run: chmod 600 ${path.basename(file)}`);
    }
  } catch (_) { /* ignore */ }
}

module.exports = { runServer, readConfig, checkPassword, LIMITS };
