'use strict';

// Steady frame pacer: setTimeout with drift correction against an absolute
// schedule, so frames land on an even grid instead of accumulating timer lag.
// onFrame(dt) receives the measured wall-clock seconds since the last frame,
// clamped to maxDt.

function startLoop(onFrame, { fps = 30, maxDt = 0.1 } = {}) {
  const period = 1000 / fps;
  const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
  let next = nowMs();
  let last = next;
  let timer = null;
  let running = true;

  const tick = () => {
    if (!running) return;
    const now = nowMs();
    let dt = (now - last) / 1000;
    last = now;
    if (dt > maxDt) dt = maxDt;
    if (dt < 0) dt = 0;
    onFrame(dt);
    if (!running) return;
    next += period;
    const after = nowMs();
    // If we are more than a frame late (GC pause, slow terminal), resync the
    // grid rather than firing a burst of catch-up frames.
    if (after - next > period) next = after + period;
    timer = setTimeout(tick, Math.max(0, next - after));
  };

  timer = setTimeout(tick, 0);
  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Parse `--fps N` / `--fps=N` from argv; returns undefined if absent.
function parseFps(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v;
    if (a === '--fps') v = argv[i + 1];
    else if (a.startsWith('--fps=')) v = a.slice(6);
    if (v !== undefined) {
      const n = Number(v);
      if (n > 0 && n <= 240) return n;
    }
  }
  return undefined;
}

module.exports = { startLoop, parseFps };
