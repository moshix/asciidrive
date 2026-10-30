'use strict';

// Scene: owns the Road, smooths steering, fakes an engine/gearbox, and draws
// road + cockpit into a FrameBuffer. Below MIN_W x MIN_H it draws a resize hint.

const { Road } = require('./road');
const { renderCockpit } = require('./cockpit');

const MIN_W = 120;
const MIN_H = 60;

// Fake gearbox: upper speed (km/h) of each gear. rpm sweeps within a gear and
// drops on upshift, which looks like real gear changes on the tachometer.
const GEAR_TOP = [32, 58, 88, 122, 160, 210, 400];
const IDLE_RPM = 0.14;
const SHIFT_LOW = 0.38; // rpm right after an upshift
const SHIFT_HIGH = 0.86; // rpm right before an upshift
const SIM_HZ = 120; // fixed simulation timestep
const SIM_DT = 1 / SIM_HZ;
const MAX_STEPS = 30; // never simulate more than 0.25 s per update call
const HELP_TEXT = 'f faster - s slower - t tunnel - q quit';
const HELP_SECONDS = 4; // how long Ctrl-C shows the key legend

class Scene {
  constructor(opts = {}) {
    this.road = new Road({ seed: opts.seed });
    this.t = 0;
    this.steer = 0;
    this.steerVel = 0;
    this.steerOmega = opts.steerOmega || 3.0; // spring stiffness (rad/s), critically damped
    this.steerGain = opts.steerGain == null ? 1.0 : opts.steerGain;
    this.rpm = IDLE_RPM;
    this.gear = 1;
    this.speedKmh = 0; // low-passed speed shown on the dash
    this.acc = 0; // fixed-timestep accumulator
    this.helpUntil = 0; // show the key legend until this sim time
  }

  // Advance by a wall-clock dt. Internally runs fixed SIM_DT steps so motion is
  // identical regardless of frame rate or timer jitter.
  update(dt) {
    if (!(dt > 0)) return;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS) {
      this.step(SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0; // fell far behind: drop the backlog
  }

  step(dt) {
    this.t += dt;
    this.road.update(dt);
    const st = this.road.state || {};

    // Critically damped spring toward the curvature under the car (a smooth
    // 2nd-order low-pass: no overshoot, no jumps).
    const target = clamp((st.curve || 0) * this.steerGain, -1, 1);
    const w = this.steerOmega;
    const a = w * w * (target - this.steer) - 2 * w * this.steerVel;
    this.steerVel += a * dt;
    this.steer = clamp(this.steer + this.steerVel * dt, -1, 1);

    // Speed low-pass (~0.5 s time constant).
    const vRaw = Math.max(0, st.speedKmh || 0);
    this.speedKmh += (vRaw - this.speedKmh) * (1 - Math.exp(-dt / 0.5));

    // Engine: gear from speed, rpm interpolated inside the gear's speed band.
    const v = this.speedKmh;
    let g = 0;
    while (g < GEAR_TOP.length - 1 && v > GEAR_TOP[g]) g++;
    this.gear = g + 1;
    let target_rpm;
    if (g === 0) {
      target_rpm = IDLE_RPM + (SHIFT_HIGH - IDLE_RPM) * (v / GEAR_TOP[0]);
    } else {
      const lo = GEAR_TOP[g - 1];
      const hi = GEAR_TOP[g];
      target_rpm = SHIFT_LOW + (SHIFT_HIGH - SHIFT_LOW) * ((v - lo) / (hi - lo));
    }
    target_rpm = clamp(target_rpm, 0, 1);
    // Needle low-pass (~0.2 s): shifts read as a quick but smooth drop.
    this.rpm += (target_rpm - this.rpm) * (1 - Math.exp(-dt / 0.2));
    this.rpm = clamp(this.rpm, 0, 1);
  }

  // Driver input: +1 = faster (F), -1 = slower (S).
  adjustSpeed(dir) {
    this.road.adjustSpeed(dir);
  }

  // Ctrl-C: show the key legend in the bottom right corner for a few seconds.
  showHelp() {
    this.helpUntil = this.t + HELP_SECONDS;
  }

  // T: drive into / out of the tunnel.
  toggleTunnel() {
    this.road.toggleTunnel();
  }

  render(fb) {
    if (fb.width < MIN_W || fb.height < MIN_H) {
      renderResizeMessage(fb);
      return;
    }
    fb.clear();
    this.road.render(fb);
    renderCockpit(fb, {
      steer: this.steer,
      speedKmh: this.speedKmh,
      rpm: this.rpm,
      t: this.t,
    });
    if (this.t < this.helpUntil) {
      const text = ` ${HELP_TEXT} `; // padded so it stands off whatever is behind it
      const x0 = Math.max(0, fb.width - text.length - 1);
      for (let i = 0; i < text.length; i++) fb.set(x0 + i, fb.height - 1, text[i]);
    }
  }
}

function renderResizeMessage(fb) {
  fb.clear();
  const msg = `Please resize to at least ${MIN_W}x${MIN_H} (now ${fb.width}x${fb.height})`;
  const lines = [];
  if (msg.length <= fb.width) {
    lines.push(msg);
  } else {
    // Word-wrap on very narrow terminals.
    let cur = '';
    for (const word of msg.split(' ')) {
      if (cur && (cur + ' ' + word).length > fb.width) {
        lines.push(cur);
        cur = word;
      } else {
        cur = cur ? cur + ' ' + word : word;
      }
    }
    if (cur) lines.push(cur);
  }
  const y0 = Math.floor((fb.height - lines.length) / 2);
  lines.forEach((line, i) => {
    const x0 = Math.max(0, Math.floor((fb.width - line.length) / 2));
    for (let j = 0; j < line.length; j++) fb.set(x0 + j, y0 + i, line[j]);
  });
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = { Scene, MIN_W, MIN_H, SIM_HZ, renderResizeMessage };
