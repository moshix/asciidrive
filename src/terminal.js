'use strict';

// Local mode: render to this process's own terminal (stdout).

const { MIN_W, MIN_H } = require('./scene');
const output = require('./output');
const { startDrive } = require('./drive');

const DEFAULT_FPS = 60;

function runLocal({ seed, fps = DEFAULT_FPS, stdin = process.stdin, stdout = process.stdout } = {}) {
  const size = () => [stdout.columns || MIN_W, stdout.rows || MIN_H];
  const [w, h] = size();
  let done = false;

  const restore = () => {
    if (done) return;
    done = true;
    drive.stop();
    if (stdout.off) stdout.off('resize', onResize);
    process.off('SIGWINCH', onResize);
    try {
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    } catch (_) { /* ignore */ }
    stdin.off('data', onData);
    stdin.pause();
    stdout.write(output.leave({ altScreen: true }));
  };

  const quit = (code = 0) => {
    restore();
    process.exit(code);
  };

  function onResize() {
    drive.resize(...size());
  }

  function onData(buf) {
    drive.input(buf);
  }

  stdout.write(output.enter({ altScreen: true }));
  const drive = startDrive({
    seed,
    fps,
    width: w,
    height: h,
    write: (s) => stdout.write(s),
    backedUp: () => {
      const [cw, ch] = size();
      return stdout.writableLength > Math.max(32 * 1024, cw * ch);
    },
    onQuit: () => quit(0),
  });
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  stdout.on('resize', onResize);
  process.on('SIGWINCH', onResize);
  process.on('SIGINT', () => drive.showHelp()); // Ctrl-C never quits: only q does
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('exit', restore);
  process.on('uncaughtException', (err) => {
    restore();
    console.error(err);
    process.exit(1);
  });

  return { stop: restore, get dropped() { return drive.dropped; } };
}

module.exports = { runLocal, DEFAULT_FPS };
