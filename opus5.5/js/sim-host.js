// Drives a FloodSim in real time and packs snapshots for the renderer.
// Used inside the Web Worker (preferred) or directly on the main thread (fallback).
import { FloodSim } from './sim.js';

const KIND_CODE = { chunk: 0, car: 1, boat: 2 };
const STATE_CODE = { intact: 0, damaged: 1, destroyed: 2 };
export const DEBRIS_STRIDE = 12;

export class SimHost {
  constructor() {
    this.sim = new FloodSim();
    this.speed = 1;
    this.paused = false;
    this.gen = 0;
    this.budget = 0;
    this.last = performance.now();
    this.stepsLastSecond = 0;
    this._stepCounter = 0;
    this._rateT = performance.now();
    this.dirty = true;
  }

  handle(m) {
    const sim = this.sim;
    switch (m.type) {
      case 'structures':
        sim.structures = m.list.map((s) => ({ id: s.id, type: s.type, x: s.x, z: s.z, angle: s.angle }));
        sim.rasterizeStructures();
        this.dirty = true;
        break;
      case 'launch':
        if (sim.launch(m.preset)) { this.budget = 0; this.last = performance.now(); }
        this.dirty = true;
        break;
      case 'reset':
        sim.reset();
        this.gen = m.gen;
        this.budget = 0;
        this.dirty = true;
        break;
      case 'speed': this.speed = m.speed; break;
      case 'pause': this.paused = m.paused; this.last = performance.now(); break;
    }
  }

  // Advance the simulation by wall-clock time; bounded by maxMs of compute.
  tick(maxMs) {
    const now = performance.now();
    let dtReal = (now - this.last) / 1000;
    this.last = now;
    if (dtReal > 0.25) dtReal = 0.25;
    const sim = this.sim;
    if (this.paused) return false;
    if (sim.phase === 'idle') {
      sim.advance(dtReal);
      return false;
    }
    this.budget += dtReal * this.speed;
    if (this.budget > 0.35) this.budget = 0.35;   // can't keep up: slow down instead of spiralling
    const t0 = performance.now();
    let n = 0;
    while (this.budget > 0.002 && performance.now() - t0 < maxMs) {
      const dt = Math.min(this.budget, sim.maxStableDt());
      sim.advance(dt, 1);
      this.budget -= dt;
      n++;
    }
    this._stepCounter += n;
    if (now - this._rateT > 1000) {
      this.stepsLastSecond = this._stepCounter * 1000 / (now - this._rateT);
      this._stepCounter = 0; this._rateT = now;
    }
    if (n) this.dirty = true;
    return true;
  }

  snapshot() {
    const sim = this.sim;
    const f32 = (a) => new Float32Array(a);
    const nb = sim.buildings.length;
    const bld = new Float32Array(nb * 4);
    for (let k = 0; k < nb; k++) {
      const b = sim.buildings[k];
      bld[k * 4] = b.health; bld[k * 4 + 1] = STATE_CODE[b.state]; bld[k * 4 + 2] = b.flowX; bld[k * 4 + 3] = b.flowZ;
    }
    const np = sim.props.length;
    const props = new Float32Array(np * 2);
    for (let k = 0; k < np; k++) { props[k * 2] = sim.props[k].fallen; props[k * 2 + 1] = sim.props[k].fallDir; }
    const nd = sim.debris.length;
    const debris = new Float32Array(nd * DEBRIS_STRIDE);
    for (let k = 0; k < nd; k++) {
      const d = sim.debris[k], o = k * DEBRIS_STRIDE;
      if (!d.active) continue;
      debris[o] = 1; debris[o + 1] = KIND_CODE[d.kind]; debris[o + 2] = d.x; debris[o + 3] = d.y; debris[o + 4] = d.z;
      debris[o + 5] = d.yaw; debris[o + 6] = d.tilt || 0; debris[o + 7] = d.len; debris[o + 8] = d.wid; debris[o + 9] = d.hgt;
      debris[o + 10] = d.color; debris[o + 11] = d.kind === 'chunk' ? d.building : d.vehicle;
    }
    const spray = new Float32Array(sim.sprayEvents);
    sim.sprayEvents.length = 0;
    const events = sim.events.map((e) => ({ type: e.type, id: e.building.id }));
    sim.events.length = 0;
    const msg = {
      type: 'state', gen: this.gen, time: sim.time, phase: sim.phase, status: sim.status(),
      presetKey: sim.presetKey || null, metrics: { ...sim.metrics }, stepsPerSec: this.stepsLastSecond,
      h: f32(sim.h), eta: f32(sim.eta), cu: f32(sim.cu), cv: f32(sim.cv), foam: f32(sim.foam), sed: f32(sim.sed),
      terrain: null, sand: null, bld, props, debris, spray, events,
    };
    if (sim.terrainDirty) {
      msg.terrain = f32(sim.terrain); msg.sand = f32(sim.sand);
      sim.terrainDirty = false;
    }
    const transfer = [msg.h.buffer, msg.eta.buffer, msg.cu.buffer, msg.cv.buffer, msg.foam.buffer, msg.sed.buffer,
      bld.buffer, props.buffer, debris.buffer, spray.buffer];
    if (msg.terrain) transfer.push(msg.terrain.buffer, msg.sand.buffer);
    this.dirty = false;
    return { msg, transfer };
  }
}
