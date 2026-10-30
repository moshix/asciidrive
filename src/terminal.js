'use strict';

// Local mode: render to this process's own terminal (stdout).

const { FrameBuffer } = require('./framebuffer');
const { Scene, MIN_W, MIN_H } = require('./scene');
const output = require('./output');
const { startLoop } = require('./loop');

const DEFAULT_FPS = 60;

function runLocal({ seed, fps = DEFAULT_FPS, stdin = process.stdin, stdout = process.stdout } = {}) {
  const size = () => [stdout.columns || MIN_W, stdout.rows || MIN_H];
  const [w, h] = size();
  const fb = new FrameBuffer(w, h);
  const scene = new Scene({ seed });
  const writer = new output.FrameWriter({ diff: true, sync: true });

  let loop = null;
  let done = false;
  let dropped = 0;

  const restore = () => {
    if (done) return;
    done = true;
    if (loop) loop.stop();
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

  // Resize just changes the fb; the next frame clears + repaints in one write.
  function onResize() {
    const [nw, nh] = size();
    if (nw !== fb.width || nh !== fb.height) fb.resize(nw, nh);
  }

  function onData(buf) {
    for (const b of buf) {
      if (b === 0x71 || b === 0x51) return quit(0); // q Q
      if (b === 0x03) scene.showHelp(); // ^C: show the key legend instead of quitting
      if (b === 0x66 || b === 0x46) scene.adjustSpeed(1); // f F: faster
      else if (b === 0x73 || b === 0x53) scene.adjustSpeed(-1); // s S: slower
      else if (b === 0x74 || b === 0x54) scene.toggleTunnel(); // t T: tunnel on / off
    }
  }

  function frame(dt) {
    scene.update(dt);
    // If the terminal is not keeping up, drop this frame instead of queueing.
    if (stdout.writableLength > Math.max(32 * 1024, fb.width * fb.height)) {
      dropped++;
      return;
    }
    scene.render(fb);
    const s = writer.frame(fb);
    if (s) stdout.write(s);
  }

  stdout.write(output.enter({ altScreen: true }));
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  stdout.on('resize', onResize);
  process.on('SIGWINCH', onResize);
  process.on('SIGINT', () => scene.showHelp()); // Ctrl-C never quits: only q does
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('exit', restore);
  process.on('uncaughtException', (err) => {
    restore();
    console.error(err);
    process.exit(1);
  });

  loop = startLoop(frame, { fps });
  return { stop: restore, get dropped() { return dropped; } };
}

module.exports = { runLocal, DEFAULT_FPS };
