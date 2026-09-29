/*
 * Shallow-water coastal flood simulation core.
 * Pure numeric module (no rendering) — owns the grid, terrain, defenses,
 * erosion, buildings and the finite-difference SWE solver.
 */

const GRID = {
  NX: 120,          // alongshore cells
  NZ: 100,          // cross-shore cells
  DX: 1.0,
  DZ: 1.0,
};
GRID.WIDTH = GRID.NX * GRID.DX;
GRID.DEPTH = GRID.NZ * GRID.DZ;

// Cross-shore zone boundaries (grid z index)
const ZONE = {
  oceanEnd: 46,     // z < oceanEnd : open / shallow ocean
  beachStart: 46,
  beachEnd: 58,     // [beachStart, beachEnd) : erodible sand
  inlandStart: 58,
};

const G = 9.81;
const SEA_LEVEL = 0;
const SUB_DT = 0.02;
const MAX_SUBSTEPS = 8;
const MAX_DEPTH = 26;
const VEL_CLAMP = 14;
const DRY_DEPTH = 0.02;
const PIPE_AREA = 1.4;
const FLUX_DAMP = 0.999;

const WAVE_PRESETS = {
  moderate: { amplitude: 3.0, duration: 4.0, label: 'Moderate' },
  severe: { amplitude: 5.2, duration: 4.6, label: 'Severe' },
  extreme: { amplitude: 7.6, duration: 5.4, label: 'Extreme' },
};

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// deterministic pseudo-noise (no Math.random dependency for terrain shape)
function hash2(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi), b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

class Simulation {
  constructor() {
    const N = GRID.NX * GRID.NZ;
    this.N = N;
    this.baseTerrain = new Float32Array(N);
    this.terrain = new Float32Array(N);
    this.erosion = new Float32Array(N);      // <= 0, accumulated
    this.defenseHeight = new Float32Array(N);
    this.isErodible = new Uint8Array(N);
    this.wetness = new Float32Array(N);       // for visual "wet sand after recede"

    this.h = new Float32Array(N);
    this.u = new Float32Array(N);        // derived velocity (for rendering/damage/erosion)
    this.v = new Float32Array(N);
    this.flowR = new Float32Array(N);    // outflow flux toward +x neighbor
    this.flowL = new Float32Array(N);    // outflow flux toward -x neighbor
    this.flowN = new Float32Array(N);    // outflow flux toward +z neighbor ("inland")
    this.flowS = new Float32Array(N);    // outflow flux toward -z neighbor ("seaward")
    this.turbulence = new Float32Array(N);

    this.defenses = [];      // {id,type,x,z,rot}
    this.buildings = [];     // {id,x,z,w,d,h,rotY,health,state,debris:[]}
    this.debrisSeq = 0;

    this.time = 0;
    this.running = false;
    this.wavePulse = null;   // {t0, amplitude, duration}
    this.speedMultiplier = 1;
    this.accumTime = 0;

    this.metrics = {
      maxFloodDepth: 0,
      floodedArea: 0,
      erosionPct: 0,
      buildingsDamaged: 0,
      buildingsDestroyed: 0,
    };

    this._generateTerrain();
    this._placeBuildings();
    this.resetWater();
  }

  idx(i, j) { return j * GRID.NX + i; }

  // ---------- terrain ----------
  _elevationAt(x, z) {
    let e;
    if (z < ZONE.beachStart) {
      const t = z / ZONE.beachStart;
      e = -12 * Math.pow(1 - t, 1.4) - 0.5;
    } else if (z < ZONE.beachEnd) {
      // beach rises to a low foredune crest right at the back of the beach
      const t = (z - ZONE.beachStart) / (ZONE.beachEnd - ZONE.beachStart);
      e = -0.5 + Math.pow(t, 0.85) * 2.1;
    } else if (z < ZONE.beachEnd + 38) {
      // the town sits on a low floodplain BEHIND the dune crest — lower
      // than the crest itself, so surge that overtops the dune has
      // somewhere real to pool instead of climbing a permanent upslope
      const t = (z - ZONE.beachEnd) / 38;
      const dip = Math.sin(t * Math.PI) * 0.55; // gentle bowl, low mid-town
      e = 1.55 - dip + t * 0.35 + (noise2(x * 0.09, z * 0.09) - 0.5) * 1.1;
    } else {
      const t = z - (ZONE.beachEnd + 38);
      e = 1.9 + t * 0.22 + (noise2(x * 0.09, z * 0.09) - 0.5) * 1.6;
    }
    // gentle alongshore undulation of the coastline
    e += Math.sin(x * 0.07 + 1.3) * 0.5 * smoothstep(ZONE.beachStart - 6, ZONE.beachEnd + 10, z);
    // a shallow inland low-lying channel so flooding prefers a path
    const channel = Math.exp(-Math.pow((x - 34) / 9, 2)) * smoothstep(ZONE.beachEnd, ZONE.beachEnd + 25, z);
    e -= channel * 0.8;
    // keep dry land at rest strictly above sea level (no pre-existing ponds)
    if (z >= ZONE.beachEnd) e = Math.max(e, 0.2);
    return e;
  }

  _generateTerrain() {
    for (let j = 0; j < GRID.NZ; j++) {
      for (let i = 0; i < GRID.NX; i++) {
        const id = this.idx(i, j);
        const e = this._elevationAt(i, j);
        this.baseTerrain[id] = e;
        this.isErodible[id] = (j >= ZONE.beachStart && j < ZONE.beachEnd) ? 1 : 0;
      }
    }
    this._recomputeDefenseSnapshot();
  }

  _placeBuildings() {
    const rng = mulberry32(1337);
    const specs = [
      [18, 66, 6, 6, 5], [30, 63, 5, 5, 4], [46, 68, 7, 7, 7],
      [60, 62, 5, 5, 4.5], [74, 67, 6, 6, 6], [90, 63, 5, 5, 4],
      [22, 84, 6, 8, 8], [42, 88, 8, 8, 9], [64, 86, 6, 6, 5.5],
      [82, 90, 7, 7, 6.5], [100, 80, 5, 5, 4], [12, 92, 5, 6, 5],
      [55, 76, 5, 5, 4], [98, 95, 6, 6, 5],
    ];
    for (const [x, z, w, d, h] of specs) {
      const jitterX = x + (rng() - 0.5) * 3;
      const jitterZ = z + (rng() - 0.5) * 3;
      this.buildings.push({
        id: 'b' + this.buildings.length,
        x: jitterX, z: jitterZ, w, d, h,
        rotY: (rng() - 0.5) * 0.5,
        health: 100,
        state: 'intact',
        exposure: 0,
        debris: null,
        colorSeed: rng(),
      });
    }
  }

  groundHeightAt(x, z) {
    const i = Math.min(GRID.NX - 2, Math.max(0, Math.round(x)));
    const j = Math.min(GRID.NZ - 2, Math.max(0, Math.round(z)));
    return this.terrain[this.idx(i, j)];
  }

  // ---------- defenses ----------
  _stampFootprint(target, x, z, rot, lengthU, lengthV, heightFn) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const halfDiag = Math.hypot(lengthU, lengthV) * 0.5 + 2;
    const iMin = Math.max(0, Math.floor(x - halfDiag));
    const iMax = Math.min(GRID.NX - 1, Math.ceil(x + halfDiag));
    const jMin = Math.max(0, Math.floor(z - halfDiag));
    const jMax = Math.min(GRID.NZ - 1, Math.ceil(z + halfDiag));
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const dx = i - x, dz = j - z;
        // rotate into local (u along length, v across thickness) frame
        const u = dx * cos + dz * sin;
        const v = -dx * sin + dz * cos;
        const hgt = heightFn(u, v);
        if (hgt > 0) {
          const id = this.idx(i, j);
          target[id] = Math.max(target[id], hgt);
        }
      }
    }
  }

  _defenseHeightFn(type, u, v, lengthU, lengthV, peak) {
    const halfL = lengthU * 0.5, halfT = lengthV * 0.5;
    if (Math.abs(u) > halfL + 1.2) return 0;
    if (Math.abs(v) > halfT + 1.2) return 0;
    const edgeU = smoothstep(halfL + 1.0, halfL - 0.6, Math.abs(u));
    switch (type) {
      case 'seawall': {
        const edgeV = smoothstep(halfT + 0.8, halfT - 0.4, Math.abs(v));
        return peak * edgeU * edgeV;
      }
      case 'breakwater': {
        const edgeV = smoothstep(halfT + 0.8, halfT - 0.4, Math.abs(v));
        return peak * edgeU * edgeV;
      }
      case 'embankment': {
        // wide, smoothly sloped cross-section (cosine ramp across thickness)
        const tv = Math.min(1, Math.abs(v) / halfT);
        const slope = 0.5 * (1 + Math.cos(tv * Math.PI));
        return peak * edgeU * slope;
      }
      default:
        return 0;
    }
  }

  addDefense(type, x, z, rot) {
    const id = 'd' + Date.now() + Math.floor(Math.random() * 1000);
    const def = { id, type, x, z, rot };
    this.defenses.push(def);
    this._recomputeDefenseSnapshot();
    return def;
  }

  removeDefense(id) {
    this.defenses = this.defenses.filter(d => d.id !== id);
    this._recomputeDefenseSnapshot();
  }

  clearDefenses() {
    this.defenses = [];
    this._recomputeDefenseSnapshot();
  }

  rotateDefense(id, deltaRad) {
    const d = this.defenses.find(d => d.id === id);
    if (d) { d.rot += deltaRad; this._recomputeDefenseSnapshot(); }
  }

  // geometry parameters shared with scene.js for consistent visuals
  static defenseParams(type) {
    switch (type) {
      case 'seawall': return { lengthU: 34, lengthV: 2.2, peak: 6.2, footH: 0.4 };
      case 'breakwater': return { lengthU: 28, lengthV: 4.5, peak: 2.6, footH: 0.2 };
      case 'segmented': return { lengthU: 5.5, lengthV: 4.0, peak: 2.6, footH: 0.2, segments: 5, gap: 2.6, totalU: 34 };
      case 'embankment': return { lengthU: 30, lengthV: 9, peak: 3.6, footH: 0.1 };
      default: return { lengthU: 10, lengthV: 2, peak: 3, footH: 0.2 };
    }
  }

  _recomputeDefenseSnapshot() {
    this.defenseHeight.fill(0);
    for (const d of this.defenses) {
      if (d.type === 'segmented') {
        const p = Simulation.defenseParams('segmented');
        const n = p.segments;
        const totalSpan = n * p.lengthU + (n - 1) * p.gap;
        const start = -totalSpan / 2 + p.lengthU / 2;
        for (let s = 0; s < n; s++) {
          const offsetU = start + s * (p.lengthU + p.gap);
          const cos = Math.cos(d.rot), sin = Math.sin(d.rot);
          const sx = d.x + offsetU * cos;
          const sz = d.z + offsetU * sin;
          this._stampFootprint(this.defenseHeight, sx, sz, d.rot, p.lengthU, p.lengthV,
            (u, v) => this._defenseHeightFn('breakwater', u, v, p.lengthU, p.lengthV, p.peak));
        }
      } else {
        const p = Simulation.defenseParams(d.type);
        this._stampFootprint(this.defenseHeight, d.x, d.z, d.rot, p.lengthU, p.lengthV,
          (u, v) => this._defenseHeightFn(d.type, u, v, p.lengthU, p.lengthV, p.peak));
      }
    }
    this._rebuildTerrain();
  }

  _rebuildTerrain() {
    for (let n = 0; n < this.N; n++) {
      this.terrain[n] = this.baseTerrain[n] + this.erosion[n] + this.defenseHeight[n];
    }
  }

  // ---------- water lifecycle ----------
  resetWater() {
    for (let j = 0; j < GRID.NZ; j++) {
      for (let i = 0; i < GRID.NX; i++) {
        const id = this.idx(i, j);
        this.h[id] = Math.max(SEA_LEVEL, this.terrain[id]);
        this.u[id] = 0; this.v[id] = 0;
        this.flowR[id] = 0; this.flowL[id] = 0; this.flowN[id] = 0; this.flowS[id] = 0;
        this.turbulence[id] = 0;
        this.wetness[id] = 0;
      }
    }
    this.time = 0;
    this.wavePulse = null;
    this.metrics.maxFloodDepth = 0;
    this.metrics.floodedArea = 0;
    this.metrics.buildingsDamaged = 0;
    this.metrics.buildingsDestroyed = 0;
  }

  resetAll() {
    // full reset: erosion undone, defenses KEPT
    this.erosion.fill(0);
    this._rebuildTerrain();
    this.resetWater();
    this.metrics.erosionPct = 0;
    for (const b of this.buildings) {
      b.health = 100; b.state = 'intact'; b.exposure = 0; b.debris = null;
    }
  }

  clearDefensesAndReset() {
    this.clearDefenses();
    this.erosion.fill(0);
    this._rebuildTerrain();
    this.resetWater();
    this.metrics.erosionPct = 0;
    for (const b of this.buildings) {
      b.health = 100; b.state = 'intact'; b.exposure = 0; b.debris = null;
    }
  }

  launchWave(presetKey) {
    const preset = WAVE_PRESETS[presetKey] || WAVE_PRESETS.moderate;
    this.wavePulse = { t0: this.time, amplitude: preset.amplitude, duration: preset.duration };
  }

  setSpeed(mult) { this.speedMultiplier = mult; }

  // ---------- stepping ----------
  step(dtFrame) {
    if (!this.running) return;
    this.accumTime += dtFrame * this.speedMultiplier;
    let steps = 0;
    while (this.accumTime >= SUB_DT && steps < MAX_SUBSTEPS) {
      this._substep(SUB_DT);
      this.accumTime -= SUB_DT;
      steps++;
    }
    if (steps >= MAX_SUBSTEPS) this.accumTime = 0;
    this._updateBuildings(dtFrame * this.speedMultiplier);
    this._updateMetrics();
  }

  // Unconditionally-stable "virtual pipes" shallow-water solver: each cell
  // exchanges flux with its 4 neighbors proportional to surface-height
  // difference, and outflow is clamped to the cell's available volume each
  // step, so depth can never go negative and the scheme cannot blow up
  // regardless of terrain steepness or wave amplitude.
  _substep(dt) {
    const { NX, NZ, DX, DZ } = GRID;
    const h = this.h, T = this.terrain;
    const fR = this.flowR, fL = this.flowL, fN = this.flowN, fS = this.flowS;
    const cellArea = DX * DZ;

    // wavemaker boundary: force offshore edge rows during the pulse window
    if (this.wavePulse) {
      const dtp = this.time - this.wavePulse.t0;
      if (dtp <= this.wavePulse.duration) {
        const shape = Math.sin(Math.PI * Math.min(1, dtp / this.wavePulse.duration));
        const amp = this.wavePulse.amplitude * shape;
        for (let j = 0; j < 3; j++) {
          for (let i = 0; i < NX; i++) {
            const id = this.idx(i, j);
            h[id] = Math.max(h[id], SEA_LEVEL + amp);
          }
        }
      } else {
        this.wavePulse = null;
      }
    }

    // 1) update the four outgoing fluxes of every interior cell
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const id = this.idx(i, j);
        const hc = h[id];
        const D = Math.max(hc - T[id], 0);
        const DE = Math.max(h[id + 1] - T[id + 1], 0);
        const DW = Math.max(h[id - 1] - T[id - 1], 0);
        const DN = Math.max(h[id + NX] - T[id + NX], 0);
        const DS = Math.max(h[id - NX] - T[id - NX], 0);
        const dhR = hc - h[id + 1];
        const dhL = hc - h[id - 1];
        const dhN = hc - h[id + NX];
        const dhS = hc - h[id - NX];
        // acceleration scales with the average depth of the pair (shallow
        // water momentum term g*D*dh/dx), so deep water carries a fast wave
        // that visibly slows and steepens as it shoals toward the coast.
        const DavgR = Math.max(0.05, PIPE_AREA * 0.5 * (D + DE));
        const DavgL = Math.max(0.05, PIPE_AREA * 0.5 * (D + DW));
        const DavgN = Math.max(0.05, PIPE_AREA * 0.5 * (D + DN));
        const DavgS = Math.max(0.05, PIPE_AREA * 0.5 * (D + DS));
        let vR = Math.max(0, fR[id] * FLUX_DAMP + dt * G * DavgR * dhR / DX * DZ);
        let vL = Math.max(0, fL[id] * FLUX_DAMP + dt * G * DavgL * dhL / DX * DZ);
        let vN = Math.max(0, fN[id] * FLUX_DAMP + dt * G * DavgN * dhN / DZ * DX);
        let vS = Math.max(0, fS[id] * FLUX_DAMP + dt * G * DavgS * dhS / DZ * DX);

        // clamp total outflow to the volume actually available in the cell
        const volume = D * cellArea;
        const totalOut = (vR + vL + vN + vS) * dt;
        if (totalOut > volume && totalOut > 1e-9) {
          const k = volume / totalOut;
          vR *= k; vL *= k; vN *= k; vS *= k;
        }
        fR[id] = vR; fL[id] = vL; fN[id] = vN; fS[id] = vS;
      }
    }
    // boundary cells: no outgoing flux (closed/absorbing edge)
    for (let i = 0; i < NX; i++) {
      const j0 = this.idx(i, 0), j1 = this.idx(i, NZ - 1);
      fR[j0] = fL[j0] = fN[j0] = fS[j0] = 0;
      fR[j1] = fL[j1] = fN[j1] = fS[j1] = 0;
    }
    for (let j = 0; j < NZ; j++) {
      const i0 = this.idx(0, j), i1 = this.idx(NX - 1, j);
      fR[i0] = fL[i0] = fN[i0] = fS[i0] = 0;
      fR[i1] = fL[i1] = fN[i1] = fS[i1] = 0;
    }

    // 2) integrate depth from net flux, and derive a cell-centered velocity
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const id = this.idx(i, j);
        const inflow = fR[id - 1] + fL[id + 1] + fN[id - NX] + fS[id + NX];
        const outflow = fR[id] + fL[id] + fN[id] + fS[id];
        let hNext = h[id] + dt * (inflow - outflow) / cellArea;
        if (hNext > T[id] + MAX_DEPTH) hNext = T[id] + MAX_DEPTH;
        if (hNext < T[id]) hNext = T[id];
        if (!isFinite(hNext)) hNext = T[id];
        h[id] = hNext;

        const Dc = Math.max(hNext - T[id], 0);
        const denom = Math.max(Dc, 0.06) * DZ;
        let uVal = (fR[id] - fL[id]) / denom;
        let vVal = (fN[id] - fS[id]) / denom;
        uVal = Math.max(-VEL_CLAMP, Math.min(VEL_CLAMP, uVal));
        vVal = Math.max(-VEL_CLAMP, Math.min(VEL_CLAMP, vVal));
        this.u[id] = Dc > DRY_DEPTH ? uVal : 0;
        this.v[id] = Dc > DRY_DEPTH ? vVal : 0;
      }
    }

    // sponge / absorbing layers near the domain edges to avoid reflection
    const spongeWidth = 7;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const id = this.idx(i, j);
        let s = 0;
        s = Math.max(s, smoothstep(spongeWidth, 0, i));
        s = Math.max(s, smoothstep(NX - 1 - spongeWidth, NX - 1, i));
        s = Math.max(s, smoothstep(NZ - 1 - spongeWidth, NZ - 1, j));
        if (j < spongeWidth && !this.wavePulse) {
          s = Math.max(s, smoothstep(spongeWidth, 0, j) * 0.6);
        }
        if (s > 0) {
          const restH = Math.max(SEA_LEVEL, T[id]);
          h[id] = h[id] * (1 - s * 0.4) + restH * (s * 0.4);
          this.u[id] *= (1 - s * 0.6);
          this.v[id] *= (1 - s * 0.6);
        }
      }
    }

    // turbulence proxy (vorticity magnitude) for foam shading
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const id = this.idx(i, j);
        const dvdx = (this.v[id + 1] - this.v[id - 1]) / (2 * DX);
        const dudz = (this.u[id + NX] - this.u[id - NX]) / (2 * DZ);
        const vort = Math.abs(dvdx - dudz);
        this.turbulence[id] = this.turbulence[id] * 0.85 + Math.min(1, vort * 0.4) * 0.15;
      }
    }

    this._erodeBeach(dt);
    this.time += dt;
  }

  _erodeBeach(dt) {
    const { NX, NZ } = GRID;
    const threshold = 1.1;
    const rate = 0.035;
    const maxErosionPerCell = -2.6;
    for (let j = ZONE.beachStart; j < ZONE.beachEnd; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const id = this.idx(i, j);
        const D = Math.max(this.h[id] - this.terrain[id], 0);
        if (D < 0.03) {
          if (D > 0.005) this.wetness[id] = 1;
          else this.wetness[id] = Math.max(0, this.wetness[id] - dt * 0.02);
          continue;
        }
        this.wetness[id] = 1;
        const speed2 = this.u[id] * this.u[id] + this.v[id] * this.v[id];
        const shear = D * speed2;
        if (shear > threshold) {
          const delta = -rate * (shear - threshold) * dt;
          const next = Math.max(maxErosionPerCell, this.erosion[id] + delta);
          if (next !== this.erosion[id]) {
            this.erosion[id] = next;
            this.terrain[id] = this.baseTerrain[id] + this.erosion[id] + this.defenseHeight[id];
          }
        }
      }
    }
  }

  // ---------- buildings ----------
  sampleFlow(x, z) {
    const i = Math.min(GRID.NX - 2, Math.max(1, Math.round(x)));
    const j = Math.min(GRID.NZ - 2, Math.max(1, Math.round(z)));
    const id = this.idx(i, j);
    const D = Math.max(this.h[id] - this.terrain[id], 0);
    return { depth: D, u: this.u[id], v: this.v[id], speed: Math.hypot(this.u[id], this.v[id]) };
  }

  _updateBuildings(dt) {
    if (dt <= 0) return;
    for (const b of this.buildings) {
      if (b.state === 'destroyed') continue;
      const flow = this.sampleFlow(b.x, b.z);
      if (flow.depth > 0.08) {
        b.exposure += dt;
        const impact = flow.depth * flow.speed * 7.5;
        const standing = Math.max(0, flow.depth - 1.0) * 2.4;
        const duration = Math.min(b.exposure, 6) * 0.35;
        const damageRate = impact + standing + duration;
        b.health -= damageRate * dt;
      } else {
        b.exposure = Math.max(0, b.exposure - dt * 0.5);
      }
      b.health = Math.max(0, Math.min(100, b.health));
      if (b.health <= 0 && b.state !== 'destroyed') {
        b.state = 'destroyed';
      } else if (b.health <= 55 && b.state === 'intact') {
        b.state = 'damaged';
      }
    }
  }

  _updateMetrics() {
    const { NX, NZ } = GRID;
    let maxDepthNow = 0;
    let floodedCells = 0;
    for (let j = ZONE.beachEnd; j < NZ; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const id = this.idx(i, j);
        const D = Math.max(this.h[id] - this.terrain[id], 0);
        if (D > 0.05) {
          floodedCells++;
          if (D > maxDepthNow) maxDepthNow = D;
        }
      }
    }
    this.metrics.maxFloodDepth = Math.max(this.metrics.maxFloodDepth, maxDepthNow);
    this.metrics.floodedArea = floodedCells * GRID.DX * GRID.DZ;

    let erosionSum = 0, erodibleCount = 0;
    for (let n = 0; n < this.N; n++) {
      if (this.isErodible[n]) { erosionSum += -this.erosion[n]; erodibleCount++; }
    }
    this.metrics.erosionPct = erodibleCount ? Math.min(100, (erosionSum / (erodibleCount * 2.6)) * 100) : 0;

    let damaged = 0, destroyed = 0;
    for (const b of this.buildings) {
      if (b.state === 'damaged') damaged++;
      else if (b.state === 'destroyed') destroyed++;
    }
    this.metrics.buildingsDamaged = damaged;
    this.metrics.buildingsDestroyed = destroyed;
  }
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
