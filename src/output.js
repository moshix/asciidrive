'use strict';

// Turns FrameBuffers into VT100 byte strings. Only printable ASCII plus a few
// standard CSI escapes are ever emitted, so any VT100-compatible terminal can show it.

const ESC = '\x1b';
const CSI = ESC + '[';

const HOME = CSI + 'H';
const CLEAR = CSI + '2J';
const HIDE_CURSOR = CSI + '?25l';
const SHOW_CURSOR = CSI + '?25h';
const RESET_ATTRS = CSI + '0m';
const ALT_SCREEN_ON = CSI + '?1049h';
const ALT_SCREEN_OFF = CSI + '?1049l';
// Synchronized update (DEC mode 2026): terminal paints the frame atomically.
// Terminals without support ignore it.
const SYNC_BEGIN = CSI + '?2026h';
const SYNC_END = CSI + '?2026l';

// Sequence to take over the screen, optionally on the alternate screen.
function enter({ altScreen = false } = {}) {
  return (altScreen ? ALT_SCREEN_ON : '') + RESET_ATTRS + HIDE_CURSOR + CLEAR + HOME;
}

// Sequence to give the screen back.
function leave({ altScreen = false } = {}) {
  return RESET_ATTRS + (altScreen ? ALT_SCREEN_OFF : CLEAR + HOME) + SHOW_CURSOR;
}

// Full frame: home, then rows joined by CRLF, no trailing newline (a trailing
// newline on the last row would scroll the screen).
function fullFrame(fb) {
  return HOME + fb.toLines().join('\r\n');
}

// Stateful writer: emits the full frame the first time (or after resize /
// invalidate), then only rows that changed, each as ESC[row;1H + row. The
// screen is cleared only on resize; each frame is wrapped in sync markers and
// returned as one string so the caller does exactly one write per frame.
class FrameWriter {
  constructor({ diff = true, sync = true } = {}) {
    this.diff = diff;
    this.sync = sync;
    this.prev = null;
    this.prevW = -1;
    this.prevH = -1;
  }

  invalidate() {
    this.prev = null;
  }

  // Returns the string to write ('' when nothing changed). Callers that skip
  // writing (e.g. backpressure) should simply not call this, so the "previous
  // frame" always matches what the terminal actually shows.
  frame(fb) {
    const lines = fb.toLines();
    const sizeChanged = fb.width !== this.prevW || fb.height !== this.prevH;
    let out;
    if (!this.diff || !this.prev || sizeChanged) {
      out = (sizeChanged && this.prevW !== -1 ? CLEAR : '') + HOME + lines.join('\r\n');
    } else {
      const parts = [];
      for (let y = 0; y < lines.length; y++) {
        if (lines[y] !== this.prev[y]) parts.push(`${CSI}${y + 1};1H${lines[y]}`);
      }
      out = parts.join('');
      // If most rows changed a plain full frame is a bit smaller.
      const full = HOME + lines.join('\r\n');
      if (out.length > full.length) out = full;
    }
    this.prev = lines;
    this.prevW = fb.width;
    this.prevH = fb.height;
    if (!out) return '';
    return this.sync ? SYNC_BEGIN + out + SYNC_END : out;
  }
}

module.exports = {
  ESC, CSI, HOME, CLEAR, HIDE_CURSOR, SHOW_CURSOR, RESET_ATTRS, ALT_SCREEN_ON, ALT_SCREEN_OFF,
  SYNC_BEGIN, SYNC_END,
  enter, leave, fullFrame, FrameWriter,
};
