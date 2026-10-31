'use strict';

// One drive session, independent of where its bytes come from or go to: the
// local terminal and every telnet connection each run one of these.

const { FrameBuffer } = require('./framebuffer');
const { Scene } = require('./scene');
const output = require('./output');
const { startLoop } = require('./loop');

// write(str) sends one frame; backedUp() says the peer is not keeping up, so
// the frame is dropped instead of queued; onQuit() runs when the driver hits q.
function startDrive({ seed, fps, width, height, write, backedUp, onQuit }) {
  const fb = new FrameBuffer(width, height);
  const scene = new Scene({ seed });
  const writer = new output.FrameWriter({ diff: true, sync: true });
  let dropped = 0;
  let loop = null;

  function frame(dt) {
    scene.update(dt);
    // If the terminal is not keeping up, drop this frame instead of queueing.
    if (backedUp()) {
      dropped++;
      return;
    }
    scene.render(fb);
    const s = writer.frame(fb);
    if (s) write(s);
  }

  // Raw input bytes from the driver. Nothing but q ends the drive.
  function input(buf) {
    for (const b of buf) {
      if (b === 0x71 || b === 0x51) return onQuit(); // q Q
      if (b === 0x03) scene.showHelp(); // ^C: show the key legend instead of quitting
      if (b === 0x66 || b === 0x46) scene.adjustSpeed(1); // f F: faster
      else if (b === 0x73 || b === 0x53) scene.adjustSpeed(-1); // s S: slower
      else if (b === 0x74 || b === 0x54) scene.toggleTunnel(); // t T: tunnel on / off
    }
  }

  // Resize just changes the fb; the next frame clears + repaints in one write.
  function resize(w, h) {
    if (w !== fb.width || h !== fb.height) fb.resize(w, h);
  }

  loop = startLoop(frame, { fps });
  return {
    input,
    resize,
    showHelp: () => scene.showHelp(),
    stop() {
      if (loop) loop.stop();
      loop = null;
    },
    get dropped() {
      return dropped;
    },
  };
}

module.exports = { startDrive };
