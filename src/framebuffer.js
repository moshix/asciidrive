'use strict';

// Character framebuffer shared by every renderer. Only printable ASCII (32..126)
// is ever stored, so frames show on any plain ASCII terminal.

class FrameBuffer {
  constructor(width, height) {
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.cells = new Array(this.width * this.height).fill(' ');
  }

  clear(ch = ' ') {
    this.cells.fill(ch);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x, y, ch) {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.inBounds(x, y)) return;
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) return;
    this.cells[y * this.width + x] = ch[0];
  }

  get(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    return this.inBounds(x, y) ? this.cells[y * this.width + x] : ' ';
  }

  // Fill a horizontal span [x0, x1] on row y.
  hspan(x0, x1, y, ch) {
    if (x1 < x0) [x0, x1] = [x1, x0];
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) this.set(x, y, ch);
  }

  fillRect(x0, y0, x1, y1, ch) {
    for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) this.hspan(x0, x1, y, ch);
  }

  // Draw a line choosing a glyph from its slope ('-', '/', '|', '\\') unless a
  // fixed glyph is given. Terminal cells are ~2x taller than wide, so slope is
  // measured with dy doubled.
  line(x0, y0, x1, y1, ch) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const glyph = ch || FrameBuffer.slopeChar(dx, dy);
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.set(x0 + dx * t, y0 + dy * t, glyph);
    }
  }

  static slopeChar(dx, dy) {
    if (dx === 0 && dy === 0) return '.';
    const a = Math.atan2(dy * 2, dx); // screen y grows downward
    let deg = (a * 180) / Math.PI;
    if (deg < 0) deg += 180;
    if (deg < 22.5 || deg >= 157.5) return '-';
    if (deg < 67.5) return '\\';
    if (deg < 112.5) return '|';
    return '/';
  }

  toLines() {
    const out = [];
    for (let y = 0; y < this.height; y++) {
      out.push(this.cells.slice(y * this.width, (y + 1) * this.width).join(''));
    }
    return out;
  }

  toString() {
    return this.toLines().join('\r\n');
  }
}

module.exports = { FrameBuffer };
