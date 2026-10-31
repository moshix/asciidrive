'use strict';

// Road: endless, procedurally generated, perfectly flat night road seen from a
// low, wide-angle first-person camera. Real 3D geometry (the track is integrated
// from its curvature into world X/Z), projected with a pinhole camera whose
// principal point sits at the reference shot's vanishing point.
//
// Rendering is "high definition ASCII": every primitive (paint stripes, dashes,
// posts, signs, the distant car) is rasterised into a 4x8 sub-pixel coverage
// mask per terminal cell (sub-pixels are square because cells are ~2:1), then
// each cell's mask is matched against a table of glyph bitmaps (blurred SSD).
// That yields slope- and sub-position-aware anti-aliased glyphs: shallow
// curves step `__..--''`, thick near strokes fill with `#`, thin far strokes
// stay light. Same geometry -> same mask -> same glyph (cached), so motion is
// stable and sub-cell smooth.

// ---------------------------------------------------------------- constants
const K = {
  // Composition (fractions of the frame)
  VP_X: 0.42, // vanishing point / principal point x
  HORIZON_Y: 0.36, // horizon row
  FX: 0.438, // horizontal focal length, fraction of W (~100 deg across)
  FY: 0.7, // vertical focal length, fraction of H

  // Camera / road geometry (metres)
  CAM_H: 1.6, // eye height above the road (raised so the far road gets rows)
  CAM_LAT: 0.9, // eye position right of the road centre (right lane, LHD seat)
  HALF_W: 3.5, // half road width (two 3.5 m lanes)
  EDGE_INSET: 0.1, // paint centre inside the asphalt edge
  RIGHT_PAINT_W: 0.14,
  LEFT_PAINT_W: 0.12,
  CENTER_PAINT_W: 0.12,
  DASH_LEN: 3,
  DASH_PERIOD: 12,
  NEAR: 0.35, // near clip plane
  FAR: 320, // draw distance (arc length)
  FADE_START: 130, // road lines start thinning out here
  // Far bends running sideways squash into flat smears on the horizon rows.
  // The road is cut off from the first point where it is both nearly flat on
  // screen and close to the horizon; everything beyond stays hidden.
  FLAT_SLOPE: 0.08, // |dy/dx| of the projected centreline at which visibility is 0
  FLAT_SLOPE_FULL: 0.33, // ... and from which it is 1
  FLAT_ROWS: 2, // rows below the horizon where flat road is fully hidden
  FLAT_ROWS_FULL: 8, // rows below the horizon from which flat road is always drawn
  STEP: 0.5, // integration step for the per-frame road profile
  SAMPLES: 150, // geometric arc-length samples for the edge polylines
  S0: 0.6, // first sample arc length

  // Raster
  MIN_STROKE: 1.45, // minimum stroke width in sub-pixels (keeps far lines alive)

  // Tunnel (T key): two rows of ceiling light strips instead of posts / signs
  LIGHT_H: 5.0, // light height above the road
  LIGHT_LAT: 2.6, // light rows at +-this from the road centre
  LIGHT_W: 0.3, // strip width
  LIGHT_LEN: 4, // strip length
  LIGHT_PERIOD: 10, // strip spacing (start to start)

  // Sky (outside the tunnel): distant outlined clouds across the northern sky
  // (the road always heads roughly north). They hang at world bearings, so
  // bends swing them gently across the view, and drift slowly with the wind.
  SKY_TURN: 0.35, // fraction of the car's turning the sky follows (< 1 reads as
  //                 very far away: bends move it gently instead of sweeping it)
  MOUNTAIN_TURN: 0.1, // same for the mountain range: much less than the clouds
  MOUNTAIN_HOLD: 0.75, // columns the range's target must drift before it moves
  CLOUDS: 4, // clouds spread over the band of bearings CLOUD_SPAN wide
  CLOUD_SPAN: 3.2, // rad; wider than anything visible, so wrapping is off-screen
  CLOUD_DRIFT: 0.004, // rad/s the clouds drift with the wind (+ = to the right)
  CLOUD_EL: 0.27, // lowest elevation of a cloud base (rad): clear of the mountain peaks
  CLOUD_SIZE: 0.07, // radians per cloud shape unit (before per-cloud scale)
  SKY_STROKE: 1.6, // outline width (sub-pixels)

  // Reflector posts
  POST_H: 0.4, // height (m): low, so they read as small ticks along the verge
  POST_FAR: 90, // drawn up to this distance (as '.' once they get tiny)

  // Speed signs
  SIGN_TEXT: '60 mph',
  SIGN_HALF_W: 0.9, // panel half width (m); big enough to read from a distance
  SIGN_H: 1.2, // panel height (m)

  // Track
  K_MIN: 1 / 600, // gentlest bend (1/radius)
  K_MAX: 1 / 130, // sharpest bend
  HEAD_MAX: 0.6, // the road never strays more than this (rad) from due north
  K_NORM: 1 / 90, // curvature that maps to state.curve = +-1 (steering wheel)

  // Speed (km/h)
  SPEED_MIN: 90,
  SPEED_MAX: 120,
  // Driver override (F / S keys): an offset on top of the automatic cruise speed
  USER_STEP: 5, // km/h per key press (held keys auto-repeat)
  USER_MIN: 20, // the driver can never go slower than this ...
  USER_MAX: 200, // ... or faster than this
  USER_LAG: 0.8, // seconds, time constant of the override (feels like throttle)

  // Camera soft lag: driver looks slightly into the bend, lagging the road.
  LOOK_AHEAD: 1.5, // metres of curvature look-into (yaw = k * LOOK_AHEAD)
  CAM_LAG: 0.6, // seconds, time constant of the camera yaw follow
};

// ------------------------------------------------------------------- PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Quintic smootherstep: C2 at both ends, so curvature (and thus heading
// acceleration / steering rate) eases in and out without kinks.
function smooth(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ------------------------------------------------------------------ glyphs
// 4 columns x 8 rows (row 0 = top). '#' = 1, '+' = 0.5, digits = n/10.
// [glyph, bitmap, bias]. Several bitmaps may map to one glyph (sub-cell
// variants); bias is a small extra cost so plain glyphs win close calls.
const GLYPH_DEFS = [
  [' ', ['....', '....', '....', '....', '....', '....', '....', '....'], 0],
  ['_', ['....', '....', '....', '....', '....', '....', '....', '####'], 0],
  ['_', ['....', '....', '....', '....', '....', '....', '####', '....'], 0.05],
  ['.', ['....', '....', '....', '....', '##..', '.##.', '..##', '....'], 0],
  ['.', ['....', '....', '....', '....', '....', '.##.', '.##.', '....'], 0.1],
  [',', ['....', '....', '....', '....', '..##', '.##.', '##..', '....'], 0],
  ['-', ['....', '....', '....', '####', '####', '....', '....', '....'], 0],
  ['-', ['....', '....', '####', '....', '....', '....', '....', '....'], 0.1],
  ['=', ['....', '....', '....', '####', '....', '####', '....', '....'], 0.1],
  ["'", ['..##', '.##.', '##..', '....', '....', '....', '....', '....'], 0],
  ["'", ['.##.', '.##.', '.##.', '....', '....', '....', '....', '....'], 0.1],
  ['`', ['##..', '.##.', '..##', '....', '....', '....', '....', '....'], 0],
  ['/', ['...#', '..+#', '..#.', '.+#.', '.#..', '+#..', '#...', '#...'], 0],
  ['\\', ['#...', '#+..', '.#..', '.#+.', '..#.', '..#+', '...#', '...#'], 0],
  ['|', ['.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.', '.##.'], 0],
  ['|', ['##..', '##..', '##..', '##..', '##..', '##..', '##..', '##..'], 0.1],
  ['|', ['..##', '..##', '..##', '..##', '..##', '..##', '..##', '..##'], 0.1],
  ['|', ['#...', '#...', '#...', '#...', '#...', '#...', '#...', '#...'], 0.05],
  ['|', ['.#..', '.#..', '.#..', '.#..', '.#..', '.#..', '.#..', '.#..'], 0.05],
  ['|', ['..#.', '..#.', '..#.', '..#.', '..#.', '..#.', '..#.', '..#.'], 0.05],
  ['|', ['...#', '...#', '...#', '...#', '...#', '...#', '...#', '...#'], 0.05],
  ['-', ['....', '....', '####', '....', '....', '....', '....', '....'], 0.05],
  ['-', ['....', '....', '....', '####', '....', '....', '....', '....'], 0.05],
  ['-', ['....', '....', '....', '....', '####', '....', '....', '....'], 0.05],
  ['-', ['....', '....', '....', '....', '....', '####', '....', '....'], 0.05],
  ['#', ['####', '####', '####', '####', '####', '####', '####', '####'], 0],
];
// Glyph that the fully covered mask maps to (paint interior).
const FULL_GLYPH = '#';
const FULL_MIN = 19; // covered sub-pixels (of 32) from which a cell is solid paint
const KEEP_MIN = 6; // covered sub-pixels from which a cell always gets a glyph

function blur32(src, out) {
  // separable [1 2 1]/4 blur on a 4x8 grid, zero padded
  const tmp = new Float32Array(32);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const v = src[r * 4 + c] * 2 + (c > 0 ? src[r * 4 + c - 1] : 0) + (c < 3 ? src[r * 4 + c + 1] : 0);
      tmp[r * 4 + c] = v * 0.25;
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const v = tmp[r * 4 + c] * 2 + (r > 0 ? tmp[(r - 1) * 4 + c] : 0) + (r < 7 ? tmp[(r + 1) * 4 + c] : 0);
      out[r * 4 + c] = v * 0.25;
    }
  }
  return out;
}

const GLYPHS = (() => {
  const list = [];
  for (const [ch, rows, bias] of GLYPH_DEFS) {
    const raw = new Float32Array(32);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 4; c++) {
        const p = rows[r][c];
        raw[r * 4 + c] = p === '#' ? 1 : p === '+' ? 0.5 : p >= '0' && p <= '9' ? (p.charCodeAt(0) - 48) / 10 : 0;
      }
    }
    list.push({ ch, blurred: blur32(raw, new Float32Array(32)), bias });
  }
  return list;
})();

const glyphCache = new Map();
const _raw = new Float32Array(32);
const _blr = new Float32Array(32);
function glyphForMask(mask) {
  let g = glyphCache.get(mask);
  if (g !== undefined) return g;
  let n = 0;
  for (let i = 0; i < 32; i++) {
    const v = (mask >>> i) & 1;
    _raw[i] = v;
    n += v;
  }
  if (n >= FULL_MIN) g = FULL_GLYPH;
  else {
    blur32(_raw, _blr);
    let best = ' ';
    let bestCost = Infinity;
    for (const gl of GLYPHS) {
      if (gl.ch === ' ' && n >= KEEP_MIN) continue; // enough ink: never drop it
      const b = gl.blurred;
      let cost = gl.bias;
      for (let i = 0; i < 32; i++) {
        const d = _blr[i] - b[i];
        cost += d * d;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = gl.ch;
      }
    }
    g = best;
  }
  if (glyphCache.size > 200000) glyphCache.clear();
  glyphCache.set(mask, g);
  return g;
}

// Cloud puffs [x, y, r] in cloud units (y up is negative, base at y = 0).
// The first and last dip below the base; the outline closes where they cross it.
const CLOUD_PUFFS = [
  [-1.55, -0.38, 0.5],
  [-0.75, -0.45, 0.62],
  [0.3, -0.6, 0.78],
  [1.25, -0.4, 0.58],
  [1.9, -0.33, 0.42],
]

// Mountain range on the horizon: hand-drawn ASCII, bottom row just above the
// horizon, tiled sideways. The last columns slope back down into the first, so
// tiles join seamlessly.
const MOUNTAINS = [
  "                    _._  Ae ,                                                            ",
  "                    ]_[ A%#V%A                            A\\    .                        ",
  "            A       ||AV%####A\\    .^. ,A             ,++A#%A.A#A.                       ",
  "       A+-A#\\       |A#%+' ._._..A%##VA%\\    ._    ,A+'A##%+V###A\\                       ",
  "      .A%#V%#A`._   A+'    ||||:V%+/A%+`  `.A%#A\\ A+'  A%+'   V#%+/` .   .^.      .      ",
  "    /A+'      `+'.`+       |||.'\\._._._.    `V%#AV'   :+'       +':   `.A#%+A    / `.    ",
  "   /+'      .__.'     ._._.|'    \\||||.__.    `VV  .'            /      `.`+%A  /    `.  ",
  ".-'         |/        ||||/       `.____|       \\._          _.'          \\`+v         `-",
  "            |'        |^^/           \\^^^|        `.`                       `            ",
  "                        '             `            .-._                      -           ",
];
const MOUNTAIN_PEAK = 26; // art column of the highest peak, centred on the road at the start

// ------------------------------------------------------------------- track
// Per-metre curvature samples, generated forever from random sections: a left
// bend, a right bend or a straight, each with random length / sharpness.
// Curvature is blended from the previous section's value with a smootherstep
// ease, so it is continuous with continuous derivatives.
class Track {
  constructor(rng) {
    this.rng = rng;
    this.base = 0; // absolute metre index of k[0]
    this.k = [];
    this.lastK = 0;
    this.heading = 0; // heading at the end of the generated track (0 = north)
    this.signs = []; // absolute s of signs
    this.posts = []; // absolute s of reflector posts
    this.nextSign = 150 + rng() * 300;
    this.postZoneEnd = 0;
    this.postZoneOn = false;
    this.nextPost = 0;
  }

  end() {
    return this.base + this.k.length;
  }

  _section() {
    const r = this.rng;
    const pick = r();
    const ease = 40 + r() * 70;
    const from = this.lastK;
    const h = this.heading;
    let target;
    let hold;
    if (pick < 0.26) {
      target = 0; // straight
      hold = 60 + r() * 280;
    } else {
      let dir = pick < 0.63 ? -1 : 1;
      // Keep heading north overall: the further the road has strayed, the
      // likelier the next bend turns it back.
      if (r() < Math.abs(h) / K.HEAD_MAX) dir = -Math.sign(h);
      const sharp = Math.pow(r(), 1.4); // more gentle bends than sharp ones
      let k = K.K_MIN + (K.K_MAX - K.K_MIN) * sharp;
      // Turn budget left before HEAD_MAX in this direction. Easing in turns
      // the road by ~(from + target) / 2 * ease, easing out later by up to
      // ~target * 55; the hold gets whatever remains.
      const room = K.HEAD_MAX - dir * (h + (from * ease) / 2);
      k = Math.max(0, Math.min(k, room / (ease / 2 + 55)));
      target = dir * k;
      const left = room - (k * ease) / 2 - k * 55;
      hold = 40 + r() * 260;
      if (k > 0) hold = Math.min(hold, Math.max(0, left / k));
    }
    for (let i = 0; i < ease; i++) this._push(from + (target - from) * smooth(i / ease));
    for (let i = 0; i < hold; i++) this._push(target);
    this.lastK = target;
  }

  _push(k) {
    this.k.push(k);
    this.heading += k;
  }

  _objects(upTo) {
    const r = this.rng;
    while (this.nextSign < upTo) {
      this.signs.push(this.nextSign);
      this.nextSign += 220 + r() * 650;
    }
    while (this.nextPost < upTo) {
      if (this.nextPost >= this.postZoneEnd) {
        this.postZoneOn = r() < 0.65;
        this.postZoneEnd = this.nextPost + 250 + r() * 700;
      }
      if (this.postZoneOn) this.posts.push(this.nextPost);
      this.nextPost += 50;
    }
  }

  ensure(sAbs) {
    while (this.end() < sAbs + 2) this._section();
    this._objects(this.end());
  }

  trim(sAbs) {
    const drop = Math.floor(sAbs - 200 - this.base);
    if (drop > 2000) {
      this.k.splice(0, drop);
      this.base += drop;
      const keep = (s) => s > sAbs - 50;
      this.signs = this.signs.filter(keep);
      this.posts = this.posts.filter(keep);
    }
  }

  curvature(sAbs) {
    const x = sAbs - this.base;
    const i = Math.floor(x);
    const f = x - i;
    const a = this.k[i] || 0;
    const b = this.k[i + 1] !== undefined ? this.k[i + 1] : a;
    return a + (b - a) * f;
  }
}

// -------------------------------------------------------------------- road
class Road {
  constructor(opts = {}) {
    const seed = opts.seed === undefined ? 1 : opts.seed;
    this.rng = mulberry32((seed * 2654435761) ^ 0x9e3779b9);
    this.track = new Track(this.rng);
    this.s = 0; // absolute distance travelled (m)
    this.t = 0;
    this.speed = 105 / 3.6; // m/s
    this.speedPhase = this.rng() * 100;
    this.cruise = this.speed; // automatic speed (m/s), before the driver override
    this.userKmh = 0; // driver override target (km/h)
    this.userNow = 0; // smoothed override actually applied (km/h)
    this.camYaw = 0; // radians, relative to the road tangent
    this.tunnel = false; // inside a tunnel: ceiling lights, no posts / signs
    this.heading = 0; // world heading of the road under the car (rad, + = right)
    // Clouds use their own PRNG so the road for a given seed is unchanged.
    const crng = mulberry32((seed * 2246822519) ^ 0x5bd1e995);
    this.clouds = [];
    for (let i = 0; i < K.CLOUDS; i++) {
      this.clouds.push({
        az: -K.CLOUD_SPAN / 2 + ((i + 0.25 + crng() * 0.5) * K.CLOUD_SPAN) / K.CLOUDS,
        el: K.CLOUD_EL * (1 + crng() * 0.2),
        size: K.CLOUD_SIZE * (0.75 + crng() * 0.5),
        flip: crng() < 0.5 ? -1 : 1,
      });
    }
    // distant car
    this.car = { active: false, gap: 0, rel: 0, relTarget: 0, timer: 3 + this.rng() * 5 };
    this.track.ensure(K.FAR + 50);
    this._mask = null;
    this._prof = null;
    this.state = { speedKmh: this.speed * 3.6, curve: 0, distance: 0 };
  }

  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25);
    this.t += dt;
    const tr = this.track;
    const kHere = tr.curvature(this.s + 4);

    // Speed: slow, layered sines between SPEED_MIN..SPEED_MAX, a bit slower in
    // sharp bends; followed with a long time constant (no sudden changes).
    const ph = this.speedPhase + this.t;
    const wave = 0.5 + 0.3 * Math.sin(ph * 0.071) + 0.2 * Math.sin(ph * 0.029 + 1.3);
    let target = K.SPEED_MIN + (K.SPEED_MAX - K.SPEED_MIN) * wave;
    const bend = Math.min(1, Math.max(Math.abs(tr.curvature(this.s + 40)), Math.abs(tr.curvature(this.s + 5))) / K.K_NORM);
    target -= 22 * bend;
    target = Math.max(K.SPEED_MIN - 15 * bend, Math.min(K.SPEED_MAX, target)) / 3.6;
    this.cruise += (target - this.cruise) * (1 - Math.exp(-dt / 4));
    this.userNow += (this.userKmh - this.userNow) * (1 - Math.exp(-dt / K.USER_LAG));
    this.speed = Math.max(K.USER_MIN, Math.min(K.USER_MAX, this.cruise * 3.6 + this.userNow)) / 3.6;

    const ds = this.speed * dt;
    this.heading += tr.curvature(this.s + ds * 0.5) * ds;
    for (const cl of this.clouds) {
      cl.az += K.CLOUD_DRIFT * dt;
      if (cl.az > K.CLOUD_SPAN / 2) cl.az -= K.CLOUD_SPAN;
    }
    this.s += ds;
    tr.ensure(this.s + K.FAR + 50);
    tr.trim(this.s);

    // Camera yaw: looks slightly into the bend, following with a soft lag.
    const yawTarget = tr.curvature(this.s + 10) * K.LOOK_AHEAD;
    this.camYaw += (yawTarget - this.camYaw) * (1 - Math.exp(-dt / K.CAM_LAG));

    // Distant car: appears now and then far ahead in our lane, drifts slowly.
    // c.rel = closing speed (m/s): > 0 we catch up, < 0 it pulls away.
    const c = this.car;
    if (!c.active) {
      c.timer -= dt;
      if (c.timer <= 0) {
        c.active = true;
        c.gap = K.FAR + 15;
        c.rel = 5 + this.rng() * 3;
        c.relTarget = c.rel;
        c.follow = 80 + this.rng() * 60; // gap at which we settle behind it
        c.hold = 20 + this.rng() * 30; // seconds spent following
      }
    } else {
      if (c.gap < c.follow + 20) {
        c.hold -= dt;
        c.relTarget = c.hold > 0 ? 0.08 * (c.gap - c.follow) + 0.5 * Math.sin(this.t * 0.13) : -4;
      }
      c.rel += (c.relTarget - c.rel) * (1 - Math.exp(-dt / 2.5));
      c.gap -= c.rel * dt;
      if (c.gap > K.FAR + 20 && c.rel < 0) {
        c.active = false;
        c.timer = 15 + this.rng() * 30;
      }
    }

    this.state = {
      speedKmh: this.speed * 3.6,
      curve: Math.max(-1, Math.min(1, tr.curvature(this.s + 2) / K.K_NORM)),
      distance: this.s,
    };
  }

  // Driver input: +1 speeds up, -1 slows down, by USER_STEP km/h per call.
  adjustSpeed(dir) {
    const base = this.cruise * 3.6;
    const v = base + this.userKmh + dir * K.USER_STEP;
    this.userKmh = Math.max(K.USER_MIN, Math.min(K.USER_MAX, v)) - base;
  }

  toggleTunnel() {
    this.tunnel = !this.tunnel;
  }

  // ----------------------------------------------------------- rendering
  render(fb) {
    const W = fb.width;
    const H = fb.height;
    if (!this._mask || this._mask.length !== W * H) this._mask = new Int32Array(W * H);
    const mask = this._mask;
    mask.fill(0);
    this.W = W;
    this.H = H;
    this.SW = W * 4; // sub-pixel width
    this.SH = H * 8;
    this.fx = K.FX * W * 4; // focal lengths in sub-pixels
    this.fy = K.FY * H * 8;
    this.cx = K.VP_X * W * 4;
    this.cy = K.HORIZON_Y * H * 8;
    this.cosY = Math.cos(this.camYaw);
    this.sinY = Math.sin(this.camYaw);

    this._buildProfile();
    this._buildVisibility();
    if (!this.tunnel) {
      this._drawMountains(fb);
      this._drawSky();
    }
    this._drawEdges();
    this._drawDashes();
    const sprites = [];
    if (this.tunnel) this._drawCeilingLights();
    else {
      this._drawPosts(sprites);
      this._drawSigns(sprites);
    }
    const carLights = this._drawCar();

    for (let i = 0, n = W * H; i < n; i++) {
      const m = mask[i];
      if (m === 0) continue;
      const ch = glyphForMask(m);
      if (ch !== ' ') fb.cells[i] = ch;
    }
    // posts never cover a line; sign panels cover whatever is behind them
    for (const p of sprites) if (p.force || fb.get(p.x, p.y) === ' ') fb.set(p.x, p.y, p.ch);
    for (const l of carLights) fb.set(l.x, l.y, l.ch);
  }

  // Integrate the track ahead of the car into world coordinates (X right,
  // Z forward, origin = road centre under the camera, Z along the road tangent).
  _buildProfile() {
    const n = Math.ceil(K.FAR / K.STEP) + 2;
    if (!this._prof || this._prof.n !== n) {
      this._prof = { n, X: new Float64Array(n), Z: new Float64Array(n), C: new Float64Array(n), S: new Float64Array(n) };
    }
    const p = this._prof;
    let th = 0;
    let x = 0;
    let z = 0;
    const tr = this.track;
    for (let i = 0; i < n; i++) {
      p.X[i] = x;
      p.Z[i] = z;
      p.C[i] = Math.cos(th);
      p.S[i] = Math.sin(th);
      const k = tr.curvature(this.s + (i + 0.5) * K.STEP);
      const thMid = th + k * K.STEP * 0.5;
      x += Math.sin(thMid) * K.STEP;
      z += Math.cos(thMid) * K.STEP;
      th += k * K.STEP;
    }
  }

  // Per profile sample: how visible the ground lines are there (0..1). Never
  // increases with distance, so once a far bend flattens onto the horizon the
  // rest of the road behind it is hidden too, and it fades in as it rises.
  _buildVisibility() {
    const p = this._prof;
    if (!p.V || p.V.length !== p.n) p.V = new Float64Array(p.n);
    const V = p.V;
    const a = {};
    const b = {};
    let vis = 1;
    this._point(0, 0, 0, a);
    for (let i = 0; i < p.n; i++) {
      this._point((i + 1) * K.STEP, 0, 0, b);
      if (a.z > K.NEAR && b.z > K.NEAR) {
        const slope = Math.abs(b.y - a.y) / (Math.abs(b.x - a.x) + 1e-9);
        const rows = (Math.min(a.y, b.y) - this.cy) / 8;
        const v = Math.max(
          smooth((slope - K.FLAT_SLOPE) / (K.FLAT_SLOPE_FULL - K.FLAT_SLOPE)),
          smooth((rows - K.FLAT_ROWS) / (K.FLAT_ROWS_FULL - K.FLAT_ROWS))
        );
        if (v < vis) vis = v;
      }
      V[i] = vis;
      a.x = b.x;
      a.y = b.y;
      a.z = b.z;
    }
  }

  _visibility(u) {
    const V = this._prof.V;
    let f = u / K.STEP;
    if (f <= 0) return V[0];
    const i = Math.floor(f);
    if (i >= V.length - 1) return V[V.length - 1];
    f -= i;
    return V[i] + (V[i + 1] - V[i]) * f;
  }

  // Road point at arc length u ahead, lateral offset lat (+ right), height h,
  // in camera space -> {x, y, z} with x,y in sub-pixels (z = depth).
  _point(u, lat, h, out) {
    const p = this._prof;
    let f = u / K.STEP;
    if (f < 0) f = 0;
    let i = Math.floor(f);
    if (i >= p.n - 1) i = p.n - 2;
    f -= i;
    const X = p.X[i] + (p.X[i + 1] - p.X[i]) * f;
    const Z = p.Z[i] + (p.Z[i + 1] - p.Z[i]) * f;
    const c = p.C[i] + (p.C[i + 1] - p.C[i]) * f;
    const s = p.S[i] + (p.S[i + 1] - p.S[i]) * f;
    const wx = X + lat * c - K.CAM_LAT;
    const wz = Z - lat * s;
    // yaw (camera looks into the bend)
    const xc = wx * this.cosY - wz * this.sinY;
    const zc = wx * this.sinY + wz * this.cosY;
    out.z = zc;
    out.x = this.cx + (xc * this.fx) / zc;
    out.y = this.cy + ((K.CAM_H - h) * this.fy) / zc;
    out.cx = xc; // camera-space x, needed for near-plane clipping
    return out;
  }

  // Stroke a ground line at lateral offset `lat`, from arc length u0 to u1,
  // physical width w (m). widthFade(u) scales the min width for far fade-out.
  // h > 0 lifts it off the road (flat ceiling strips in the tunnel).
  _groundLine(u0, u1, lat, w, steps, h = 0) {
    const a = {};
    const b = {};
    let prevOk = false;
    const pts = [];
    // sample positions: geometric in u (dense near, sparse far)
    for (let i = 0; i <= steps; i++) {
      const u = u0 * Math.pow(u1 / u0, i / steps);
      pts.push(u);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      let ua = pts[i];
      let ub = pts[i + 1];
      this._point(ua, lat, h, a);
      this._point(ub, lat, h, b);
      if (a.z < K.NEAR && b.z < K.NEAR) continue;
      if (a.z < K.NEAR || b.z < K.NEAR) {
        // bisect u to the near plane
        let lo = a.z < K.NEAR ? ua : ub;
        let hi = a.z < K.NEAR ? ub : ua;
        const m = {};
        for (let it = 0; it < 18; it++) {
          const mid = (lo + hi) / 2;
          this._point(mid, lat, h, m);
          if (m.z < K.NEAR) lo = mid;
          else hi = mid;
        }
        if (a.z < K.NEAR) {
          ua = hi;
          this._point(ua, lat, h, a);
        } else {
          ub = hi;
          this._point(ub, lat, h, b);
        }
      }
      this._strokeGround(a, b, w, ua, ub);
      prevOk = true;
    }
    return prevOk;
  }

  _fade(u) {
    if (u <= K.FADE_START) return 1;
    const t = (u - K.FADE_START) / (K.FAR - K.FADE_START);
    return Math.max(0, 1 - smooth(t));
  }

  // Ground stripe between projected points a,b with physical width w.
  _strokeGround(a, b, w, ua, ub) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-6;
    const sinA = Math.abs(dy) / len; // perpendicular factor for horizontal width
    // horizontal screen width of a ground stripe ~ w*fx/z; vertical ~ 0 (thin
    // in depth), so the perpendicular width is horizontal * |sin|.
    const va = this._visibility(ua);
    const vb = this._visibility(ub);
    if (va < 0.15 && vb < 0.15) return; // hidden behind a flattened far bend
    const wa = Math.max((w * this.fx * sinA) / a.z, K.MIN_STROKE * this._fade(ua)) * va;
    const wb = Math.max((w * this.fx * sinA) / b.z, K.MIN_STROKE * this._fade(ub)) * vb;
    this._capsule(a.x, a.y, wa, b.x, b.y, wb);
  }

  _drawEdges() {
    const rl = K.HALF_W - K.EDGE_INSET;
    this._groundLine(K.S0, K.FAR, rl, K.RIGHT_PAINT_W, K.SAMPLES);
    this._groundLine(K.S0, K.FAR, -rl, K.LEFT_PAINT_W, K.SAMPLES);
  }

  _drawDashes() {
    const P = K.DASH_PERIOD;
    const first = Math.floor((this.s + K.S0) / P) * P;
    for (let sa = first; sa < this.s + K.FAR; sa += P) {
      let u0 = sa - this.s;
      let u1 = u0 + K.DASH_LEN;
      if (u1 <= K.S0) continue;
      if (u0 < K.S0) u0 = K.S0;
      if (u1 > K.FAR) u1 = K.FAR;
      const steps = Math.max(1, Math.ceil((u1 - u0) / Math.max(1, u0 * 0.15)));
      this._groundLine(u0, u1, 0, K.CENTER_PAINT_W, steps);
    }
  }

  // Tunnel ceiling: two rows of flat light strips, following the road like the
  // centre dashes do (same geometry, just lifted to the ceiling).
  _drawCeilingLights() {
    const P = K.LIGHT_PERIOD;
    const first = Math.floor((this.s + K.S0) / P) * P;
    for (let sa = first; sa < this.s + K.FAR; sa += P) {
      let u0 = sa - this.s;
      let u1 = u0 + K.LIGHT_LEN;
      if (u1 <= K.S0) continue;
      if (u0 < K.S0) u0 = K.S0;
      if (u1 > K.FAR) u1 = K.FAR;
      const steps = Math.max(1, Math.ceil((u1 - u0) / Math.max(1, u0 * 0.15)));
      this._groundLine(u0, u1, -K.LIGHT_LAT, K.LIGHT_W, steps, K.LIGHT_H);
      this._groundLine(u0, u1, K.LIGHT_LAT, K.LIGHT_W, steps, K.LIGHT_H);
    }
  }

  // Sky direction (world bearing, 0 = north; elevation) -> sub-pixel
  // position, or null when it is behind / far outside the view.
  _skyPoint(az, el) {
    let a = az - (this.heading + this.camYaw) * K.SKY_TURN;
    a -= 2 * Math.PI * Math.round(a / (2 * Math.PI));
    const c = Math.cos(a);
    if (c < 0.2) return null;
    return { x: this.cx + (Math.sin(a) / c) * this.fx, y: this.cy - Math.tan(el) * this.fy };
  }

  _drawSky() {
    for (const cl of this.clouds) this._drawCloud(cl, K.SKY_STROKE);
  }

  // Mountains are written straight into the framebuffer before the mask is
  // flushed, so clouds, road and car all draw over them. They pan with the sky.
  _drawMountains(fb) {
    const P = MOUNTAINS[0].length;
    // Whole-column art can only step a full cell, so it pans slowly and only
    // moves once the target is clearly past the next column (no flip-flopping
    // between two columns while the camera sways).
    const pan = (-(this.heading + this.camYaw) * K.MOUNTAIN_TURN * this.fx) / 4;
    if (this.mtnPan === undefined || Math.abs(pan - this.mtnPan) > K.MOUNTAIN_HOLD) {
      this.mtnPan = Math.round(pan);
    }
    const x0 = Math.round(this.cx / 4) + this.mtnPan - MOUNTAIN_PEAK;
    const y0 = Math.floor(this.cy / 8) - MOUNTAINS.length;
    for (let r = 0; r < MOUNTAINS.length; r++) {
      const y = y0 + r;
      if (y < 0 || y >= this.H) continue;
      const row = MOUNTAINS[r];
      for (let x = 0; x < this.W; x++) {
        const ch = row[(((x - x0) % P) + P) % P];
        if (ch !== ' ') fb.cells[y * this.W + x] = ch;
      }
    }
  }

  // Cloud: outer outline of a few overlapping puffs over a flat base. The end
  // puffs sit above the base, so the outline rounds into it instead of
  // dropping straight down onto it.
  _drawCloud(cl, w) {
    const c = this._skyPoint(cl.az, cl.el);
    if (!c) return;
    // Base on the bottom sub-rows of a cell so it always reads as '_' (a thin
    // line straddling two cells would get too little ink in either to show).
    c.y = Math.floor(c.y / 8) * 8 + 6.5;
    const u = cl.size * this.fy;
    const SX = 1.3; // puffs are a bit wider than tall
    const P = CLOUD_PUFFS;
    const [lx, ly, lr] = P[0];
    const [rx, ry, rr] = P[P.length - 1];
    const baseL = lx - SX * Math.sqrt(lr * lr - ly * ly); // where the end puffs meet the base
    const baseR = rx + SX * Math.sqrt(rr * rr - ry * ry);
    const hidden = (x, y, skip) => {
      if (y > 1e-6) return true; // below the base
      if (x > baseL && x < baseR && y > -0.45) return true; // body above the base line
      for (let j = 0; j < P.length; j++) {
        if (j === skip) continue;
        const [qx, qy, qr] = P[j];
        if (((x - qx) / SX) ** 2 + (y - qy) ** 2 < qr * qr * 0.995) return true;
      }
      return false;
    };
    const toScreen = (x, y) => [c.x + x * u * cl.flip, c.y + y * u];
    for (let k = 0; k < P.length; k++) {
      const [ox, oy, or] = P[k];
      let prev = null;
      for (let i = 0; i <= 96; i++) {
        const t = (2 * Math.PI * i) / 96;
        const x = ox + Math.cos(t) * or * SX;
        const y = oy + Math.sin(t) * or;
        const cur = hidden(x, y, k) ? null : toScreen(x, y);
        if (cur && prev) this._capsule(prev[0], prev[1], w, cur[0], cur[1], w);
        prev = cur;
      }
    }
    const [ax, ay] = toScreen(baseL, 0);
    const [bx, by] = toScreen(baseR, 0);
    this._capsule(ax, ay, w, bx, by, w);
  }

  // Vertical stroke for an upright object (post): base at ground, top at h.
  _upright(u, lat, h, w, fade) {
    const a = this._point(u, lat, 0, {});
    if (a.z < K.NEAR) return;
    const b = this._point(u, lat, h, {});
    const ww = Math.max((w * this.fx) / a.z, K.MIN_STROKE) * fade;
    if (ww < 0.25) return;
    if (ww < 4) {
      // thinner than a cell: keep it in one column so it reads as a single '|'
      const sx = Math.floor(a.x / 4) * 4 + 2;
      this._capsule(sx, a.y, Math.max(ww, 1.2), sx, b.y, Math.max(ww, 1.2));
    } else this._capsule(a.x, a.y, ww, b.x, b.y, ww);
  }

  // Reflector posts: short ticks close to the ground. Drawn as fixed glyphs
  // (not rasterised): a small, fast object rasterised into the 4x8 mask
  // changes glyph every frame ('#', '|', '.', "'") and reads as jerky, while a
  // fixed '|' (or '.' far away) just glides cell to cell.
  _drawPosts(out) {
    const lat = K.HALF_W + 0.9;
    for (const ps of this.track.posts) {
      const u = ps - this.s;
      if (u < 0.5 || u > K.POST_FAR) continue;
      if (this._visibility(u) < 0.5) continue;
      const a = this._point(u, lat, 0, {});
      if (a.z < K.NEAR) continue;
      const hpx = (K.POST_H * this.fy) / a.z; // height in sub-pixels
      const x = Math.floor(a.x / 4);
      const y = Math.floor((a.y - 1) / 8); // cell holding the foot
      if (hpx < 5) {
        out.push({ x, y, ch: '.' });
        continue;
      }
      const rows = hpx < 14 ? 1 : 2;
      for (let i = 0; i < rows; i++) out.push({ x, y: y - i, ch: '|' });
    }
  }



  // Roadside speed signs. Far away the panel is a small filled shape; once it
  // is wide enough on screen it is drawn as a box with SIGN_TEXT written in
  // it (text needs real characters, so the box is placed as fixed glyphs).
  _drawSigns(out) {
    for (const ss of this.track.signs) {
      const u = ss - this.s;
      if (u < 0.5 || u > 300) continue;
      if (this._visibility(u) < 0.5) continue; // stands on a hidden far bend
      const fade = 1 - smooth((u - 180) / 120);
      const lat = K.HALF_W + 2.2;
      const halfW = K.SIGN_HALF_W * fade + 0.05;
      const bottom = 1.5;
      const top = 1.5 + K.SIGN_H * fade + 0.05;
      // post
      this._upright(u, lat, bottom, 0.08, fade);
      // panel (faces the road: spans along the cross-section direction)
      const p0 = this._point(u, lat - halfW, bottom, {});
      const p1 = this._point(u, lat + halfW, bottom, {});
      const p2 = this._point(u, lat + halfW, top, {});
      const p3 = this._point(u, lat - halfW, top, {});
      if (p0.z < K.NEAR || p1.z < K.NEAR) continue;
      const pts = [p0, p1, p2, p3];
      const x0 = Math.round(Math.min(...pts.map((p) => p.x)) / 4);
      const x1 = Math.round(Math.max(...pts.map((p) => p.x)) / 4) - 1;
      const y0 = Math.round(Math.min(...pts.map((p) => p.y)) / 8);
      const y1 = Math.round(Math.max(...pts.map((p) => p.y)) / 8) - 1;
      const cols = x1 - x0 + 1;
      const rows = y1 - y0 + 1;
      const T = K.SIGN_TEXT;
      if (cols < T.length) {
        this._fillPoly(pts);
        continue;
      }
      const put = (x, y, ch) => out.push({ x, y, ch, force: true });
      // text row; when it does not fit between the sides it spans the full width
      const textRow = (y, l, r) => {
        const sides = cols >= T.length + 2;
        const a = sides ? x0 + 1 : x0;
        const n = sides ? cols - 2 : cols;
        const pad = Math.floor((n - T.length) / 2);
        if (sides) {
          put(x0, y, l);
          put(x1, y, r);
        }
        for (let i = 0; i < n; i++) put(a + i, y, T[i - pad] || ' ');
      };
      if (rows < 3) {
        // too flat for a box: one row, [60 mph]
        textRow(Math.round((y0 + y1) / 2), '[', ']');
        continue;
      }
      //  ______
      // |      |
      // |60 mph|
      // |______|
      for (let i = 1; i < cols - 1; i++) put(x0 + i, y0, '_');
      const mid = Math.floor((y0 + 1 + y1 - 1) / 2);
      for (let y = y0 + 1; y < y1; y++) {
        if (y === mid) textRow(y, '|', '|');
        else for (let x = x0; x <= x1; x++) put(x, y, x === x0 || x === x1 ? '|' : ' ');
      }
      put(x0, y1, '|');
      for (let i = 1; i < cols - 1; i++) put(x0 + i, y1, '_');
      put(x1, y1, '|');
    }
  }


  _drawCar() {
    const c = this.car;
    const out = [];
    if (!c.active) return out;
    const u = c.gap;
    if (u > K.FAR - 10 || u < 5) return out;
    if (this._visibility(u) < 0.5) return out; // behind a hidden far bend
    const lat = 1.75;
    const L = this._point(u, lat - 0.72, 0.85, {});
    const R = this._point(u, lat + 0.72, 0.85, {});
    if (L.z < K.NEAR) return out;
    const fade = 1 - smooth((u - 240) / 80);
    if (fade <= 0.05) return out;
    const bl = this._point(u, lat - 0.9, 0.3, {});
    const br = this._point(u, lat + 0.9, 0.3, {});
    const tl = this._point(u, lat - 0.8, 1.4, {});
    const tr = this._point(u, lat + 0.8, 1.4, {});
    // the car body hides the road behind it
    this._clearRect(Math.min(bl.x, tl.x), Math.min(tl.y, tr.y), Math.max(br.x, tr.x), Math.max(bl.y, br.y));
    // body outline once it is big enough to read
    const bodyW = Math.abs(br.x - bl.x) / 4; // cells
    if (bodyW > 3) {
      this._capsule(bl.x, bl.y, 1.5, br.x, br.y, 1.5);
      this._capsule(tl.x, tl.y, 1.5, tr.x, tr.y, 1.5);
      this._capsule(bl.x, bl.y, 1.5, tl.x, tl.y, 1.5);
      this._capsule(br.x, br.y, 1.5, tr.x, tr.y, 1.5);
    }
    const ch = fade < 0.5 ? '.' : 'o';
    const lx = Math.floor(L.x / 4);
    const rx = Math.floor(R.x / 4);
    out.push({ x: lx, y: Math.floor(L.y / 8), ch });
    if (rx !== lx) out.push({ x: rx, y: Math.floor(R.y / 8), ch });
    return out;
  }

  // ---------------------------------------------------- raster primitives
  _clearRect(x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(this.SW - 1, Math.round(x1));
    y1 = Math.min(this.SH - 1, Math.round(y1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this._mask[(y >> 3) * this.W + (x >> 2)] &= ~(1 << (((y & 7) << 2) | (x & 3)));
      }
    }
  }

  _setSub(x, y) {
    const cell = (y >> 3) * this.W + (x >> 2);
    this._mask[cell] |= 1 << (((y & 7) << 2) | (x & 3));
  }

  // Tapered capsule from (ax,ay) width aw to (bx,by) width bw, sub-pixels.
  _capsule(ax, ay, aw, bx, by, bw) {
    const r = Math.max(aw, bw) * 0.5;
    let x0 = Math.floor(Math.min(ax, bx) - r);
    let x1 = Math.ceil(Math.max(ax, bx) + r);
    let y0 = Math.floor(Math.min(ay, by) - r);
    let y1 = Math.ceil(Math.max(ay, by) + r);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.SW - 1) x1 = this.SW - 1;
    if (y1 > this.SH - 1) y1 = this.SH - 1;
    if (x0 > x1 || y0 > y1) return;
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const inv = L2 > 1e-9 ? 1 / L2 : 0;
    const W = this.W;
    const mask = this._mask;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const rowBase = (y >> 3) * W;
      const bitRow = (y & 7) << 2;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        let t = ((px - ax) * dx + (py - ay) * dy) * inv;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const qx = ax + dx * t - px;
        const qy = ay + dy * t - py;
        const hw = (aw + (bw - aw) * t) * 0.5;
        if (qx * qx + qy * qy <= hw * hw) mask[rowBase + (x >> 2)] |= 1 << (bitRow | (x & 3));
      }
    }
  }

  // Convex polygon fill (sub-pixel centres).
  _fillPoly(pts) {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    // guarantee at least ~1.2 sub-pixels of height so tiny signs don't vanish
    y0 = Math.max(0, Math.floor(y0));
    y1 = Math.min(this.SH - 1, Math.ceil(y1));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      let xl = Infinity;
      let xr = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) {
          const x = a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y);
          if (x < xl) xl = x;
          if (x > xr) xr = x;
        }
      }
      if (xl > xr) continue;
      const xa = Math.max(0, Math.ceil(xl - 0.5));
      const xb = Math.min(this.SW - 1, Math.floor(xr - 0.5));
      for (let x = xa; x <= xb; x++) this._setSub(x, y);
    }
  }
}

module.exports = { Road, ROAD_CONSTANTS: K };
