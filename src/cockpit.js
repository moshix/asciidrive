'use strict';

// Cockpit overlay: a left-hand-drive interior seen from the driver's seat,
// drawn on top of the already rendered road. Dim grey look: thin, light
// glyphs, anti-aliased by supersampling every cell.
//
// Geometry is computed in "pixel units": x in columns, y in rows * 2
// (terminal cells are ~2x taller than wide), so the dials stay round.

const CELL_ASPECT = 2; // pixel units per row

// Composition (fractions of screen width W / height H), see SPEC.md. The
// reference shot is mapped non-uniformly into the frame (like road.js does),
// so the wheel is an ellipse in pixel space whose centre is far below the screen.
const WHEEL_CX = 0.123; // wheel centre x (W)
const WHEEL_CY = 1.39; // wheel centre y (H)
const WHEEL_RX = 0.473; // outer rim semi-axis x (W)
const WHEEL_RY = 1.016; // outer rim semi-axis y (H)
const BAND_X = 0.078; // rim band thickness, outer arc -> grip line (W) ...
const BAND_Y = 0.2; // ... and (H)
const GRIP_WAVES = 28; // finger-grip bumps around the full wheel
const GRIP_AMP = 0.022; // bump amplitude, relative to the grip ellipse
const MAX_STEER_DEG = 25; // wheel rotation at steer = +-1
const SWAY_DEG = 0.4; // tiny low-frequency sway amplitude
const SWAY_HZ = 0.11;

const DASH_Y_LEFT = 0.76; // dashboard top edge, horizontal part (H)
const DASH_KNEE_X = 0.52; // where it starts to slope down (W)
const DASH_Y_RIGHT = 0.86; // at the right screen edge (H)

const GAUGES = [
  { x: 0.045, value: 'rpm' }, // gauge centres x (W)
  { x: 0.27, value: 'speed' },
];
const GAUGE_TOP_Y = 0.875; // top of the dial arcs (H)
const GAUGE_R_W = 0.095; // dial radius (round circle): fraction of W ...
const GAUGE_R_H = 0.25; // ... capped by a fraction of 2H
const GAUGE_A0 = 160; // dial start angle (deg, math convention: 90 = up)
const GAUGE_A1 = 20; // dial end angle
const GAUGE_TICKS = 5;
const SPEED_MAX_KMH = 220;

// Stroke widths in pixel units (scaled by size, clamped to stay >= ~1 cell).
const RIM_W = 0.02; // fraction of 2H
const GRIP_W = 0.017;
const DASH_W = 0.018;
const DIAL_W = 0.008;

// Supersampling grid per cell.
const SX = 3;
const SY = 4;

// ---------------------------------------------------------------------------
// Glyph choice from coverage, ink centroid and tangent direction.

// tx, ty: tangent in cell units (columns, rows); cov 0..1; ux, uy centroid in cell (0..1, uy 0 = top).
// side: +1 when the stroke bulges rightwards here (for ( ) on steep arcs), -1 left, 0 straight.
function pickGlyph(cov, ux, uy, tx, ty, thick, side) {
  const ax = Math.abs(tx);
  const ay = Math.abs(ty);
  const a = Math.atan2(ay, ax) * 57.29578; // 0 = horizontal, 90 = vertical
  const down = tx * ty > 0; // going down to the right
  if (thick && cov > 0.9) {
    if (a < 24) return '=';
    if (a < 64) return down ? '\\' : '/';
    return side > 0 ? ')' : side < 0 ? '(' : '|';
  }
  if (a < 24) {
    if (thick && cov > 0.55) {
      if (uy < 0.4) return '"';
      return '=';
    }
    if (uy < 0.3) return '\'';
    if (uy < 0.45) return '~';
    if (uy < 0.62) return '-';
    if (uy < 0.8) return '.';
    return '_';
  }
  if (a < 40) {
    // shallow diagonal: a lighter step glyph positioned by height
    if (down) return uy < 0.4 ? '`' : uy > 0.65 ? '.' : '\\';
    return uy < 0.4 ? '\'' : uy > 0.65 ? ',' : '/';
  }
  if (a < 64) return down ? '\\' : '/';
  if (side !== 0) return side > 0 ? ')' : '(';
  return '|';
}

// Draw a stroke given a signed-distance function d(px, py) (pixel units) of
// a curve, a half width, a cell bounding box and an optional side function.
function strokeLayer(fb, x0, y0, x1, y1, half, dist, thick, sideFn, mask) {
  const W = fb.width;
  const H = fb.height;
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W - 1, Math.ceil(x1));
  y1 = Math.min(H - 1, Math.ceil(y1));
  const reach = half + 1.2; // early out: cell center farther than this cannot be covered
  const cells = fb.cells;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const pcx = cx + 0.5;
      const pcy = (cy + 0.5) * CELL_ASPECT;
      const dc = dist(pcx, pcy);
      if (Math.abs(dc) > reach) continue;
      if (mask && !mask(pcx, pcy)) continue;
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let j = 0; j < SY; j++) {
        const fy = (j + 0.5) / SY;
        const py = (cy + fy) * CELL_ASPECT;
        for (let i = 0; i < SX; i++) {
          const fx = (i + 0.5) / SX;
          const d = dist(cx + fx, py);
          if (d >= -half && d <= half) {
            n++;
            sx += fx;
            sy += fy;
          }
        }
      }
      if (n === 0 || (!thick && n < 2)) continue;
      const cov = n / (SX * SY);
      // gradient -> tangent, converted to cell units
      const e = 0.25;
      const gx = dist(pcx + e, pcy) - dist(pcx - e, pcy);
      const gy = dist(pcx, pcy + e) - dist(pcx, pcy - e);
      const tx = -gy;
      const ty = gx / CELL_ASPECT;
      const side = sideFn ? sideFn(pcx, pcy) : 0;
      cells[cy * W + cx] = pickGlyph(cov, sx / n, sy / n, tx, ty, thick, side);
    }
  }
}

// ---------------------------------------------------------------------------

function layout(W, H) {
  const H2 = H * CELL_ASPECT;
  const rx = WHEEL_RX * W;
  const ry = WHEEL_RY * H2;
  const gr = Math.min(GAUGE_R_W * W, GAUGE_R_H * H2);
  return {
    W, H, H2,
    cx: WHEEL_CX * W,
    cy: WHEEL_CY * H2,
    rx, ry,
    grx: rx - BAND_X * W,
    gry: ry - BAND_Y * H2,
    rimHalf: Math.max(2.2, RIM_W * H2) / 2,
    gripHalf: Math.max(1.8, GRIP_W * H2) / 2,
    dashHalf: Math.max(1.8, DASH_W * H2) / 2,
    dialHalf: Math.min(1.1, Math.max(0.9, DIAL_W * H2)) / 2,
    dashY0: DASH_Y_LEFT * H2,
    dashY1: DASH_Y_RIGHT * H2,
    dashKnee: DASH_KNEE_X * W,
    dashSoft: 0.05 * W,
    gaugeR: gr,
    gaugeCy: GAUGE_TOP_Y * H2 + gr,
  };
}

// Approximate signed distance (pixel units) to a curve given in the
// normalised polar coordinates of an ellipse: r(th) = 1 + amp*sin(n*(th-rot)).
// u = dx/rx, v = dy/ry; f = r - g(th), divided by |grad f| in pixel space.
function ellipseDist(px, py, cx, cy, rx, ry, amp, rot) {
  const u = (px - cx) / rx;
  const v = (py - cy) / ry;
  const r = Math.hypot(u, v) || 1e-9;
  let g = 1;
  let gp = 0;
  if (amp) {
    const p = GRIP_WAVES * (Math.atan2(v, u) - rot);
    g = 1 + amp * Math.sin(p);
    gp = amp * GRIP_WAVES * Math.cos(p);
  }
  const r2 = r * r;
  const fu = u / r + (gp * v) / r2;
  const fv = v / r - (gp * u) / r2;
  return (r - g) / (Math.hypot(fu / rx, fv / ry) || 1e-9);
}

let cachedLayout = null;
function getLayout(W, H) {
  if (!cachedLayout || cachedLayout.W !== W || cachedLayout.H !== H) cachedLayout = layout(W, H);
  return cachedLayout;
}

// Dashboard top edge y(x) in pixel units, with a smooth knee.
function dashY(L, x) {
  const m = (L.dashY1 - L.dashY0) / (L.W - L.dashKnee);
  const s = L.dashSoft;
  const u = (x - L.dashKnee) / s;
  let f;
  if (u <= -1) f = 0;
  else if (u >= 1) f = u;
  else f = ((u + 1) * (u + 1)) / 4;
  return L.dashY0 + m * s * f;
}
function dashSlope(L, x) {
  const m = (L.dashY1 - L.dashY0) / (L.W - L.dashKnee);
  const u = (x - L.dashKnee) / L.dashSoft;
  if (u <= -1) return 0;
  if (u >= 1) return m;
  return (m * (u + 1)) / 2;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function renderCockpit(fb, opts = {}) {
  const steer = Math.max(-1, Math.min(1, +opts.steer || 0));
  const speedKmh = Math.max(0, +opts.speedKmh || 0);
  const rpm = Math.max(0, Math.min(1, +opts.rpm || 0));
  const t = +opts.t || 0;
  const W = fb.width;
  const H = fb.height;
  const L = getLayout(W, H);
  const cells = fb.cells;

  // 1. Dashboard body: blank everything below the top edge.
  for (let cx = 0; cx < W; cx++) {
    const yEdge = dashY(L, cx + 0.5) / CELL_ASPECT;
    for (let cy = Math.max(0, Math.floor(yEdge)); cy < H; cy++) {
      if (cy + 0.5 > yEdge) cells[cy * W + cx] = ' ';
    }
  }
  // 2. Dashboard top edge.
  strokeLayer(fb, 0, L.dashY0 / CELL_ASPECT - 2, W - 1, L.dashY1 / CELL_ASPECT + 2, L.dashHalf,
    (px, py) => (py - dashY(L, px)) / Math.hypot(1, dashSlope(L, px)), true, null);

  // 3. Gauges: one clean arc, single-character ticks, one needle.
  const gy = L.gaugeCy;
  const gr = L.gaugeR;
  for (const g of GAUGES) {
    const gx = g.x * W;
    const bx0 = gx - gr - 1;
    const bx1 = gx + gr + 1;
    const by0 = (gy - gr) / CELL_ASPECT - 1;
    strokeLayer(fb, bx0, by0, bx1, H - 1, L.dialHalf,
      (px, py) => Math.hypot(px - gx, py - gy) - gr, false,
      (px) => (px > gx ? 1 : -1));
    for (let k = 0; k < GAUGE_TICKS; k++) {
      const a = ((GAUGE_A0 + ((GAUGE_A1 - GAUGE_A0) * k) / (GAUGE_TICKS - 1)) * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const tr = gr - Math.max(2.2, gr * 0.16);
      const tx = gx + ca * tr;
      const ty = (gy - sa * tr) / CELL_ASPECT;
      if (ty >= H - 0.5) continue;
      const deg = (Math.atan2(sa / CELL_ASPECT, Math.abs(ca)) * 180) / Math.PI;
      const ch = deg < 27 ? '-' : deg > 63 ? '|' : ca < 0 ? '\\' : '/';
      fb.set(Math.floor(tx), Math.floor(ty), ch);
    }
    const v = g.value === 'speed' ? Math.min(1, speedKmh / SPEED_MAX_KMH) : rpm;
    const na = ((GAUGE_A0 + (GAUGE_A1 - GAUGE_A0) * v) * Math.PI) / 180;
    const nr = gr - Math.max(4, gr * 0.32);
    const nx = gx + Math.cos(na) * nr;
    const ny = gy - Math.sin(na) * nr;
    strokeLayer(fb, bx0, by0, bx1, H - 1, L.dialHalf,
      (px, py) => segDist(px, py, gx, gy, nx, ny), false, null);
  }

  // 4. Steering wheel (drawn over the dials). Rotation follows steer, plus a
  // tiny slow sway; only the grip bumps move, the rim stays put.
  const rot = ((steer * MAX_STEER_DEG + SWAY_DEG * Math.sin(t * SWAY_HZ * 2 * Math.PI)) * Math.PI) / 180;
  const { cx: wcx, cy: wcy, rx, ry, grx, gry } = L;
  const ampG = GRIP_AMP;
  const topRow = Math.max(0, Math.floor((wcy - ry) / CELL_ASPECT) - 2);
  const xMax = Math.min(W - 1, Math.ceil(wcx + rx + 2));
  // blank the rim band (between grip line and outer arc)
  for (let cy = topRow; cy < H; cy++) {
    const py = (cy + 0.5) * CELL_ASPECT;
    for (let cx = 0; cx <= xMax; cx++) {
      const px = cx + 0.5;
      if (ellipseDist(px, py, wcx, wcy, rx, ry, 0, 0) < 0 &&
          ellipseDist(px, py, wcx, wcy, grx, gry, ampG, rot) > 0) cells[cy * W + cx] = ' ';
    }
  }
  const sideFn = (px) => (px > wcx ? 1 : -1);
  strokeLayer(fb, 0, topRow, xMax, H - 1, L.rimHalf,
    (px, py) => ellipseDist(px, py, wcx, wcy, rx, ry, 0, 0), true, sideFn);
  strokeLayer(fb, 0, topRow, xMax, H - 1, L.gripHalf,
    (px, py) => ellipseDist(px, py, wcx, wcy, grx, gry, ampG, rot), true, sideFn);
}

module.exports = {
  renderCockpit,
  cockpitLayout: getLayout,
  CELL_ASPECT,
  MAX_STEER_DEG,
};
