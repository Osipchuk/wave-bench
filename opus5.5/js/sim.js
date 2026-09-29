// ---------------------------------------------------------------------------
// Coastal flood simulation core.
//
// A 2D shallow-water solver on a staggered (MAC) grid:
//   * water depth h at cell centres, velocities u / v on cell faces
//   * semi-Lagrangian momentum advection
//   * hydrostatic pressure gradient, Manning bed friction, structure drag
//   * upwind, positivity-preserving mass fluxes (wetting & drying)
//   * Flather radiation boundary offshore that injects the incoming long wave
// On top of that: sediment erosion / transport / deposition, foam,
// building loading & collapse, floating debris and knock-down props.
//
// Pure JS with no rendering dependencies so it can run headless in Node.
// ---------------------------------------------------------------------------

export const NX = 240;
export const NZ = 200;
export const DX = 2;                      // metres per cell
export const G = 9.81;
export const X0 = -NX * DX / 2;
export const Z0 = -NZ * DX / 2;
export const SEA_LEVEL = 0;

const EPS = 0.004;
const VMAX = 16;
const NONE = -1e9;
const FR_TAB = new Float64Array(1024);
for (let k = 0; k < 1024; k++) FR_TAB[k] = G / Math.pow(Math.max(0.05, (k + 0.5) / 100), 4 / 3);

export const cellX = (i) => X0 + (i + 0.5) * DX;
export const cellZ = (j) => Z0 + (j + 0.5) * DX;

// ---------------------------------------------------------------- utilities
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const ab = a + (b - a) * sx, cd = c + (d - c) * sx;
  return ab + (cd - ab) * sz;
}
export function fbm(x, z) {
  return vnoise(x, z) * 0.5 + vnoise(x * 2.1 + 5.2, z * 2.1 + 1.3) * 0.3 + vnoise(x * 4.3 + 9.1, z * 4.3 + 7.7) * 0.2;
}
export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------- landscape
export function baseShore(x) { return 28 + 30 * (x / 240) ** 2; }
export function headMask(x) { return smoothstep(112, 188, x); }
export function shoreZ(x) {
  return baseShore(x) + 5 * Math.sin(x / 37 + 1.3) + 2.5 * Math.sin(x / 15.7) + 78 * headMask(x);
}
export function riverX(z) { return -88 + 12 * Math.sin(z / 38 + 0.4); }
export const POND = { x: 55, z: -78, r: 24 };

// kind codes
export const K_SEABED = 0, K_BEACH = 1, K_GRASS = 2, K_ROCK = 3, K_ROAD = 4, K_CHANNEL = 5;

function terrainAt(x, z) {
  const hm = headMask(x);
  const s = shoreZ(x) - z;                 // inland distance (negative = offshore)
  let e, kind, sand;
  if (s < 0) {
    const d = -s;
    e = -Math.min(20, d * 0.16 * (1 + 1.6 * hm));
    // submerged shoal off the western beach (focuses the wave by refraction)
    e += 8.5 * Math.exp(-((x + 130) ** 2 + (z - (baseShore(x) + 70)) ** 2) / (34 * 34));
    // submarine canyon (defocuses)
    e -= 6 * Math.exp(-((x - 35) ** 2) / (18 * 18)) * smoothstep(12, 60, d);
    e += (fbm(x * 0.03, z * 0.03) - 0.5) * 1.4 * smoothstep(6, 30, d);
    if (d > 14) e = Math.min(e, -1.6);
    e = Math.max(e, -24);
    kind = K_SEABED;
    sand = d < 70 ? 0.4 + 2.2 * (1 - d / 70) : 0.4;
  } else {
    const dune = 1.35 * Math.exp(-((s - 24) ** 2) / 28) * (0.55 + 0.7 * fbm(x * 0.03, 3.1)) * (1 - hm);
    if (s < 32) e = s * 0.075 + dune;
    else e = 2.4 + (s - 32) * 0.045 + (fbm(x * 0.012 + 3, z * 0.012) - 0.5) * 2.2 * smoothstep(40, 80, s);
    kind = s < 33 ? K_BEACH : K_GRASS;
    sand = s < 33 ? 3.0 : 0.6;
    // western hills / inland backdrop hill
    const west = Math.max(0, -x - 182) * 0.32 * smoothstep(0, 30, s);
    e += west;
    if (west > 1.5) { kind = K_GRASS; sand = 0.6; }
    e += Math.max(0, -z - 168) * 0.22;
    // headland plateau
    if (hm > 0) {
      e += hm * (13 * smoothstep(0, 16, s) + 5 * fbm(x * 0.04, z * 0.04));
      if (hm > 0.55 && s > 2) { kind = K_ROCK; sand = 0; }
    }
    // park depression
    e -= 1.9 * Math.exp(-((x - POND.x) ** 2 + (z - POND.z) ** 2) / (POND.r * POND.r));
  }
  // drainage channel (creek) that cuts through the town down to the sea
  if (s > -10 && hm < 0.2) {
    const dist = Math.abs(x - riverX(z));
    const ch = smoothstep(13, 4.5, dist);
    if (ch > 0) {
      const rb = -1.5 + Math.max(0, s) * 0.034;
      e = e * (1 - ch) + Math.min(e, rb) * ch;
      if (ch > 0.5 && s > 6) { kind = K_CHANNEL; sand = 1.0; }
    }
  }
  return { e, kind, sand };
}

// ---------------------------------------------------------------- defences
export const STRUCTURE_TYPES = {
  seawall: {
    name: 'Seawall', length: 96, width: 4, crest: 9.5, drag: 0, minGround: -9,
    desc: 'Tall vertical concrete wall. Blocks and reflects water; flow is diverted around its ends.',
  },
  breakwater: {
    name: 'Breakwater', crestL: 56, crestW: 4, crest: 1.6, slope: 1.2, drag: 1.4,
    desc: 'Low, heavy rubble mound offshore. Absorbs wave energy but lets water pass over it.',
  },
  segmented: {
    name: 'Segmented Breakwater', crestL: 12, pitch: 26, segments: 4, crestW: 4, crest: 2.6, slope: 1.5, drag: 1.4,
    desc: 'Detached offshore blocks with gaps. Water jets through the gaps; calm zones form behind blocks.',
  },
  embankment: {
    name: 'Sloped Embankment', crestL: 60, crestW: 6, crest: 6.0, slope: 0.45, drag: 0.35, minGround: -8,
    desc: 'Wide armoured dike with gentle slopes. Dissipates energy and can be overtopped.',
  },
};
for (const T of Object.values(STRUCTURE_TYPES)) {
  if (T.slope) {
    T.ext = Math.min(34, (T.crest + 25) / T.slope);
    const span = T.segments ? (T.segments - 1) * T.pitch + T.crestL : T.crestL;
    T.span = span;
    T.length = span + 2 * Math.min(T.ext, T.crest / T.slope + 4);
    T.width = T.crestW + 2 * Math.min(T.ext, T.crest / T.slope + 4);
    T.boundX = span / 2 + T.ext; T.boundZ = T.crestW / 2 + T.ext;
  } else {
    T.boundX = T.length / 2 + 1; T.boundZ = T.width / 2 + 1;
  }
}

// Top elevation of a structure at local coords (lx along its axis, lz across). NONE if outside.
export function structureProfile(type, lx, lz, margin = 0) {
  const T = STRUCTURE_TYPES[type];
  if (type === 'seawall') {
    if (Math.abs(lx) <= T.length / 2 + margin && Math.abs(lz) <= T.width / 2 + margin) return T.crest;
    return NONE;
  }
  let x = lx;
  if (T.segments) {
    let k = Math.round(lx / T.pitch + (T.segments - 1) / 2);
    k = clamp(k, 0, T.segments - 1);
    x = lx - (k - (T.segments - 1) / 2) * T.pitch;
  }
  const a = Math.max(0, Math.abs(lz) - T.crestW / 2 - margin);
  const b = Math.max(0, Math.abs(x) - T.crestL / 2 - margin);
  const d = Math.max(a, b);
  if (d > T.ext) return NONE;
  return T.crest - T.slope * d;
}

// ---------------------------------------------------------------- intensity
export const PRESETS = {
  moderate: { label: 'Moderate', A: 2.4, rise: 4, plateau: 1.5, fall: 6, trough: 0.3 },
  severe: { label: 'Severe', A: 4.2, rise: 4, plateau: 3, fall: 7, trough: 0.3 },
  extreme: { label: 'Extreme', A: 6.0, rise: 4, plateau: 5, fall: 8, trough: 0.35 },
};
const TROUGH_T = 3.5;
const OBLIQUE = Math.sin(7 * Math.PI / 180);

function waveShape(p, t) {
  if (t < 0) return 0;
  if (t < TROUGH_T) return -p.trough * p.A * Math.sin(Math.PI * t / TROUGH_T);
  t -= TROUGH_T;
  if (t < p.rise) return p.A * 0.5 * (1 - Math.cos(Math.PI * t / p.rise));
  t -= p.rise;
  if (t < p.plateau) return p.A * (1 + 0.04 * Math.sin(t * 2.1));
  t -= p.plateau;
  if (t < p.fall) return p.A * 0.5 * (1 + Math.cos(Math.PI * t / p.fall));
  return 0;
}
export function waveDuration(p) { return TROUGH_T + p.rise + p.plateau + p.fall + 5; }

// ---------------------------------------------------------------- town layout
const BUILDING_TYPES = {
  house: { resist: 22, w: [9, 12], d: [9, 12], h: [5.5, 7.5], roof: 'gable' },
  shop: { resist: 34, w: [12, 16], d: [10, 14], h: [6.5, 9], roof: 'flat' },
  apartment: { resist: 80, w: [14, 18], d: [14, 20], h: [13, 19], roof: 'flat' },
  hotel: { resist: 150, w: [18, 24], d: [16, 22], h: [24, 32], roof: 'flat' },
};
export const ROADS_S = [40, 114, 178];
export const CROSS_X = [-160, -30, 70];

function generateLayout() {
  const rnd = mulberry32(1337);
  const R = (a, b) => a + (b - a) * rnd();
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const buildings = [];
  const rows = [
    { s0: 47, s1: 73, types: ['house', 'house', 'house', 'shop', 'hotel'] },
    { s0: 81, s1: 107, types: ['house', 'house', 'shop', 'apartment'] },
    { s0: 121, s1: 147, types: ['apartment', 'shop', 'house', 'apartment'] },
    { s0: 152, s1: 172, types: ['house', 'shop', 'house'] },
    { s0: 185, s1: 206, types: ['house', 'house', 'shop'] },
  ];
  let hotels = 0;
  for (const row of rows) {
    let x = -226 + R(0, 8);
    while (x < 120) {
      let type = pick(row.types);
      if (type === 'hotel' && hotels >= 2) type = 'shop';
      const T = BUILDING_TYPES[type];
      const w = R(T.w[0], T.w[1]);
      const d = Math.min(R(T.d[0], T.d[1]), row.s1 - row.s0);
      const x0 = x, x1 = x + w;
      const xc = (x0 + x1) / 2;
      x = x1 + R(7, 15);
      if (x1 > 118) break;
      if (rnd() < 0.18) continue;
      if (CROSS_X.some((cx) => x1 > cx - 7 && x0 < cx + 7)) continue;
      const sMid = row.s0 + (row.s1 - row.s0) / 2 + R(-2, 2);
      const zc = baseShore(xc) - sMid;
      const z0 = zc - d / 2, z1 = zc + d / 2;
      if (z0 < Z0 + 8) continue;
      if (Math.abs(riverX(zc) - x0) < 18 || Math.abs(riverX(zc) - x1) < 18 || (x0 < riverX(zc) && x1 > riverX(zc))) continue;
      const pdx = Math.max(x0 - POND.x, 0, POND.x - x1), pdz = Math.max(z0 - POND.z, 0, POND.z - z1);
      if (Math.hypot(pdx, pdz) < POND.r + 4) continue;
      if (type === 'hotel') hotels++;
      buildings.push({
        type, x0, x1, z0, z1, height: R(T.h[0], T.h[1]), resist: T.resist * R(0.85, 1.2),
        roof: T.roof, hue: rnd(), seed: Math.floor(rnd() * 1e6),
      });
    }
  }
  // lighthouse on the headland
  buildings.push({ type: 'lighthouse', x0: 176, x1: 184, z0: 93, z1: 101, height: 22, resist: 2000, roof: 'lighthouse', hue: 0, seed: 7 });
  return buildings;
}

function roadPolylines() {
  const lines = [];
  for (const s of ROADS_S) {
    const pts = [];
    for (let x = X0 + 2; x <= 128; x += 4) pts.push([x, baseShore(x) - s]);
    lines.push(pts);
  }
  for (const cx of CROSS_X) {
    const pts = [];
    for (let z = baseShore(cx) - 40; z >= Z0 + 2; z -= 4) pts.push([cx, z]);
    lines.push(pts);
  }
  return lines;
}

// ---------------------------------------------------------------- simulation
export class FloodSim {
  constructor() {
    const N = NX * NZ;
    this.N = N;
    this.terrain0 = new Float64Array(N);
    this.terrain = new Float64Array(N);
    this.rock = new Float64Array(N);
    this.sand0 = new Float64Array(N);
    this.sand = new Float64Array(N);
    this.kind = new Uint8Array(N);
    this.erK = new Float64Array(N);
    this.ucrit = new Float64Array(N);
    this.n2 = new Float64Array(N);
    this.landMask = new Uint8Array(N);
    this.rubble = new Float64Array(N);
    this.rubbleDrag = new Float64Array(N);
    this.structTop = new Float64Array(N).fill(NONE);
    this.structDrag = new Float64Array(N);
    this.structId = new Int16Array(N).fill(-1);
    this.bldTop = new Float64Array(N).fill(NONE);
    this.bldId = new Int16Array(N).fill(-1);
    this.bed = new Float64Array(N);
    this.h = new Float64Array(N);
    this.eta = new Float64Array(N);
    this.u = new Float64Array((NX + 1) * NZ);
    this.v = new Float64Array(NX * (NZ + 1));
    this.u2 = new Float64Array((NX + 1) * NZ);
    this.v2 = new Float64Array(NX * (NZ + 1));
    this.qx = new Float64Array((NX + 1) * NZ);
    this.qz = new Float64Array(NX * (NZ + 1));
    this.scale = new Float64Array(N);
    this.conc = new Float64Array(N);
    this.fdrag = new Float64Array(N);
    this.cu = new Float64Array(N);
    this.cv = new Float64Array(N);
    this.speed = new Float64Array(N);
    this.sed = new Float64Array(N);
    this.sed2 = new Float64Array(N);
    this.foam = new Float64Array(N);
    this.foam2 = new Float64Array(N);
    this.wet = new Float64Array(N);
    this.maxDepth = new Float64Array(N);
    this.terrainDirty = true;

    this.structures = [];
    this.nextStructId = 1;
    this.sprayEvents = [];
    this.events = [];      // building collapses etc. consumed by renderer

    this._buildTerrain();
    this._buildTown();
    this.reset();
  }

  idx(i, j) { return j * NX + i; }
  worldToCell(x, z) {
    const i = Math.floor((x - X0) / DX), j = Math.floor((z - Z0) / DX);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return -1;
    return j * NX + i;
  }

  _buildTerrain() {
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        const t = terrainAt(cellX(i), cellZ(j));
        this.terrain0[c] = t.e;
        this.kind[c] = t.kind;
        this.sand0[c] = t.sand;
      }
    }
    // roads: flatten a little, non-erodible
    this.roads = roadPolylines();
    for (const pts of this.roads) {
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const i0 = Math.floor((Math.min(ax, bx) - 5 - X0) / DX), i1 = Math.ceil((Math.max(ax, bx) + 5 - X0) / DX);
        const j0 = Math.floor((Math.min(az, bz) - 5 - Z0) / DX), j1 = Math.ceil((Math.max(az, bz) + 5 - Z0) / DX);
        for (let j = Math.max(0, j0); j <= Math.min(NZ - 1, j1); j++) {
          for (let i = Math.max(0, i0); i <= Math.min(NX - 1, i1); i++) {
            const px = cellX(i), pz = cellZ(j);
            const dx = bx - ax, dz = bz - az;
            const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
            const dd = Math.hypot(px - ax - t * dx, pz - az - t * dz);
            const c = j * NX + i;
            if (dd < 3.6 && this.kind[c] !== K_CHANNEL && this.terrain0[c] > 0.5) { this.kind[c] = K_ROAD; this.sand0[c] = 0; }
          }
        }
      }
    }
    // pre-relax over-steepened sand so the initial state is at rest
    for (let it = 0; it < 40; it++) {
      for (let j = 0; j < NZ - 1; j++) {
        for (let i = 0; i < NX - 1; i++) {
          const c = j * NX + i;
          for (let q = 0; q < 2; q++) {
            const n = q === 0 ? c + 1 : c + NX;
            const d = this.terrain0[c] - this.terrain0[n];
            const hi = d > 0 ? c : n, lo = d > 0 ? n : c, ad = Math.abs(d);
            if (ad > 1.0 && this.sand0[hi] > 0) {
              const m = Math.min((ad - 1.0) * 0.4, this.sand0[hi]);
              this.sand0[hi] -= m; this.terrain0[hi] -= m;
            }
          }
        }
      }
    }
    for (let c = 0; c < this.N; c++) {
      const k = this.kind[c];
      this.rock[c] = this.terrain0[c] - this.sand0[c];
      this.landMask[c] = this.terrain0[c] > 0.3 ? 1 : 0;
      this.erK[c] = [0.6, 1.0, 0.32, 0, 0, 0.75][k];
      this.ucrit[c] = [1.3, 1.2, 2.3, 99, 99, 1.4][k];
      const n = [0.022, 0.025, 0.05, 0.04, 0.03, 0.03][k];
      this.n2[c] = n * n;
    }
  }

  _buildTown() {
    const layout = generateLayout();
    this.buildings = layout.map((b, id) => {
      const cells = [];
      let gmin = 1e9, gmax = -1e9;
      for (let j = 0; j < NZ; j++) {
        const z = cellZ(j);
        if (z < b.z0 || z > b.z1) continue;
        for (let i = 0; i < NX; i++) {
          const x = cellX(i);
          if (x < b.x0 || x > b.x1) continue;
          const c = j * NX + i;
          cells.push(c);
          gmin = Math.min(gmin, this.terrain0[c]);
          gmax = Math.max(gmax, this.terrain0[c]);
        }
      }
      // ring of cells just outside the footprint (where loads are sampled)
      const set = new Set(cells);
      const ring = new Set();
      for (const c of cells) {
        const i = c % NX, j = (c / NX) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) continue;
          const cc = jj * NX + ii;
          if (!set.has(cc)) ring.add(cc);
        }
      }
      for (const c of cells) this.sand0[c] = Math.min(this.sand0[c], 0.0);
      for (const c of cells) this.rock[c] = this.terrain0[c];
      return {
        ...b, id,
        cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, w: b.x1 - b.x0, d: b.z1 - b.z0,
        baseY: gmin, groundY: gmax, topY: gmax + b.height,
        cells: Int32Array.from(cells), ring: Int32Array.from(ring),
        health: 1, state: 'intact', load: 0, maxLoad: 0, flowX: 0, flowZ: 1, destroyedAt: -1,
      };
    });

    // decorative-but-simulated props (knocked down by flow)
    const rnd = mulberry32(99);
    const props = [];
    const free = (x, z, clear) => {
      const c = this.worldToCell(x, z);
      if (c < 0) return false;
      for (const b of this.buildings) if (x > b.x0 - clear && x < b.x1 + clear && z > b.z0 - clear && z < b.z1 + clear) return false;
      const i = c % NX, j = (c / NX) | 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) return false;
        const k = this.kind[jj * NX + ii];
        if (k === K_ROAD || k === K_CHANNEL) return false;
      }
      return true;
    };
    let tries = 0;
    while (props.filter((p) => p.type === 'tree').length < 190 && tries++ < 6000) {
      const x = X0 + 6 + rnd() * (NX * DX - 12), z = Z0 + 6 + rnd() * 230;
      const c = this.worldToCell(x, z);
      if (c < 0 || this.kind[c] !== K_GRASS || headMask(x) > 0.7) continue;
      if (!free(x, z, 3)) continue;
      props.push({ type: 'tree', x, z, scale: 0.8 + rnd() * 0.6, thr: 14, seed: rnd() });
    }
    for (let x = -226; x < 110; x += 15 + rnd() * 6) {
      const z = baseShore(x) - 34 + rnd() * 2;
      if (Math.abs(x - riverX(z)) < 16 || !free(x, z, 2)) continue;
      props.push({ type: 'palm', x, z, scale: 0.9 + rnd() * 0.35, thr: 20, seed: rnd() });
    }
    for (let k = 0; k < 30; k++) {
      const x = -220 + rnd() * 330;
      const z = shoreZ(x) - (7 + rnd() * 12);
      if (Math.abs(x - riverX(z)) < 16) continue;
      props.push({ type: 'umbrella', x, z, scale: 1, thr: 1.2, seed: rnd() });
    }
    this.props = props.map((p, id) => ({ ...p, id, cell: this.worldToCell(p.x, p.z), fallen: 0, fallDir: 0 }));

    // cars and boats become debris when water floats them
    this.vehicles = [];
    for (let k = 0; k < 22; k++) {
      const onCross = rnd() < 0.3;
      let x, z, yaw;
      if (onCross) {
        const cx = CROSS_X[Math.floor(rnd() * CROSS_X.length)];
        x = cx + (rnd() < 0.5 ? -2 : 2); z = baseShore(cx) - 48 - rnd() * 150; yaw = Math.PI / 2;
      } else {
        const s = ROADS_S[Math.floor(rnd() * ROADS_S.length)];
        x = -225 + rnd() * 340; z = baseShore(x) - s + (rnd() < 0.5 ? -2 : 2);
        const dzdx = 60 * x / (240 * 240);
        yaw = -Math.atan(dzdx);
      }
      const c = this.worldToCell(x, z);
      if (c < 0 || this.kind[c] !== K_ROAD) continue;
      this.vehicles.push({ kind: 'car', x, z, yaw, color: Math.floor(rnd() * 6) });
    }
    for (let k = 0; k < 7; k++) {
      const x = -200 + k * 45 + rnd() * 15;
      const z = shoreZ(x) + 22 + rnd() * 35;
      this.vehicles.push({ kind: 'boat', x, z, yaw: rnd() * Math.PI * 2, color: k % 4 });
    }
  }

  // ------------------------------------------------------------ structures
  structureCells(type, x, z, angle, margin = 0.7) {
    const T = STRUCTURE_TYPES[type];
    const R = Math.hypot(T.boundX, T.boundZ) + 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const out = [];
    const i0 = Math.floor((x - R - X0) / DX), i1 = Math.ceil((x + R - X0) / DX);
    const j0 = Math.floor((z - R - Z0) / DX), j1 = Math.ceil((z + R - Z0) / DX);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = cellX(i) - x, pz = cellZ(j) - z;
        const lx = px * ca + pz * sa;       // along length
        const lz = -px * sa + pz * ca;      // across
        const top = structureProfile(type, lx, lz, margin);
        if (top === NONE) continue;
        const inside = i >= 0 && j >= 0 && i < NX && j < NZ;
        out.push({ c: inside ? j * NX + i : -1, top });
      }
    }
    return out;
  }

  validateStructure(type, x, z, angle, ignoreId = -1) {
    const T = STRUCTURE_TYPES[type];
    const cells = this.structureCells(type, x, z, angle);
    if (!cells.length) return { ok: false, reason: 'Out of bounds' };
    let gmin = 1e9, gmax = -1e9, active = 0;
    for (const { c, top } of cells) {
      if (c < 0) {
        if (top > -8) return { ok: false, reason: 'Outside the model area' };
        continue;
      }
      if (top <= this.terrain0[c]) continue;
      const i = c % NX, j = (c / NX) | 0;
      if (i < 2 || j < 2 || i > NX - 3 || j > NZ - 4) return { ok: false, reason: 'Too close to the edge' };
      active++;
      if (this.bldId[c] >= 0) return { ok: false, reason: 'Overlaps a building' };
      gmin = Math.min(gmin, this.terrain0[c]);
      gmax = Math.max(gmax, this.terrain0[c]);
    }
    const cc = this.worldToCell(x, z);
    const g = cc >= 0 ? this.terrain0[cc] : 0;
    if (type === 'breakwater' || type === 'segmented') {
      if (g > 0.3) return { ok: false, reason: 'Breakwaters must be placed in the sea' };
      if (g < -16) return { ok: false, reason: 'Water too deep here' };
    } else {
      if (active < 4 || gmax > T.crest - 1.2) return { ok: false, reason: 'Ground is already higher than the crest' };
      if (gmin < T.minGround) return { ok: false, reason: 'Water too deep here' };
    }
    return { ok: true, reason: '' };
  }

  addStructure(type, x, z, angle) {
    const s = { id: this.nextStructId++, type, x, z, angle };
    this.structures.push(s);
    this.rasterizeStructures();
    return s;
  }
  updateStructure(id, x, z, angle) {
    const s = this.structures.find((q) => q.id === id);
    if (!s) return;
    s.x = x; s.z = z; s.angle = angle;
    this.rasterizeStructures();
  }
  removeStructure(id) {
    this.structures = this.structures.filter((s) => s.id !== id);
    this.rasterizeStructures();
  }
  clearStructures() {
    this.structures = [];
    this.rasterizeStructures();
  }
  rasterizeStructures() {
    this.structTop.fill(NONE);
    this.structDrag.fill(0);
    this.structId.fill(-1);
    for (const s of this.structures) {
      const T = STRUCTURE_TYPES[s.type];
      for (const { c, top } of this.structureCells(s.type, s.x, s.z, s.angle)) {
        if (c < 0 || this.bldId[c] >= 0) continue;
        if (top > this.structTop[c]) { this.structTop[c] = top; this.structId[c] = s.id; }
        if (top > this.terrain0[c] - 0.5) this.structDrag[c] = Math.max(this.structDrag[c], T.drag);
      }
    }
    this._rebuildBed();
    this._rebuildDrag();
    if (this.phase === 'idle') this._restWater();
    this.terrainDirty = true;
  }

  // ------------------------------------------------------------ reset
  reset() {
    this.terrain.set(this.terrain0);
    this.sand.set(this.sand0);
    this.rubble.fill(0);
    this.rubbleDrag.fill(0);
    this.bldTop.fill(NONE);
    this.bldId.fill(-1);
    for (const b of this.buildings) {
      b.health = 1; b.state = 'intact'; b.load = 0; b.maxLoad = 0; b.destroyedAt = -1; b.flowX = 0; b.flowZ = 1;
      for (const c of b.cells) { this.bldTop[c] = b.topY; this.bldId[c] = b.id; }
    }
    for (const p of this.props) { p.fallen = 0; p.fallDir = 0; }
    this.phase = 'idle';
    this.time = 0;
    this.preset = null;
    this.u.fill(0); this.v.fill(0); this.cu.fill(0); this.cv.fill(0); this.speed.fill(0);
    this.sed.fill(0); this.foam.fill(0); this.maxDepth.fill(0);
    this._rebuildBed();
    this._rebuildDrag();
    this._restWater();
    for (let c = 0; c < this.N; c++) this.wet[c] = this.h[c] > 0.01 ? 1 : 0;
    this._initDebris();
    this.sprayEvents.length = 0;
    this.events.length = 0;
    this.metrics = {
      maxFloodDepth: 0, floodedArea: 0, floodedPct: 0, erosion: 0, deposition: 0, maxScour: 0,
      damaged: 0, destroyed: 0, total: this.buildings.filter((b) => b.type !== 'lighthouse').length,
      peakWave: 0, inundation: 0, landWater: 0, peakLandWater: 0, arrived: false, arrivalTime: -1, maxSpeed: 0,
    };
    this.landCellCount = 0;
    for (let c = 0; c < this.N; c++) if (this.landMask[c] && this.bldId[c] < 0) this.landCellCount++;
    this.terrainDirty = true;
    this.stepCount = 0;
  }

  _rebuildBed() {
    const { bed, terrain, rubble, structTop, bldTop, eta, h } = this;
    for (let c = 0; c < this.N; c++) {
      let b = terrain[c] + rubble[c];
      if (structTop[c] > b) b = structTop[c];
      if (bldTop[c] > b) b = bldTop[c];
      bed[c] = b;
      eta[c] = b + h[c];
    }
  }
  _rebuildDrag() {
    for (let c = 0; c < this.N; c++) this.fdrag[c] = this.structDrag[c] + this.rubbleDrag[c];
  }
  _restWater() {
    for (let c = 0; c < this.N; c++) {
      this.h[c] = Math.max(0, SEA_LEVEL - this.bed[c]);
      this.eta[c] = this.bed[c] + this.h[c];
    }
    this.u.fill(0); this.v.fill(0);
  }

  launch(presetKey) {
    if (this.phase !== 'idle') return false;
    this.preset = PRESETS[presetKey];
    this.presetKey = presetKey;
    this.phase = 'running';
    this.time = 0;
    return true;
  }

  forcing(x, t) {
    if (!this.preset) return 0;
    const delay = (x - X0) * OBLIQUE / 14;
    const mod = 1 + 0.1 * Math.sin(x / 55 + 1.0);
    return waveShape(this.preset, t - delay) * mod;
  }

  // ------------------------------------------------------------ stepping
  advance(dtTotal, maxSteps = 12) {
    if (this.phase === 'idle') { this._updateDebris(dtTotal); return 0; }
    let remaining = dtTotal, steps = 0;
    while (remaining > 1e-5 && steps < maxSteps) {
      const dt = Math.min(remaining, this.maxStableDt());
      this.step(dt);
      remaining -= dt;
      steps++;
    }
    this._updateDebris(dtTotal - remaining);
    return steps;
  }

  maxStableDt() {
    // wave celerity + advective speed (tracked during the last flux pass)
    const m = Math.max(this._maxSignal || 0, Math.sqrt(G * 24));
    return Math.min(0.07, 0.62 * DX / m);
  }

  step(dt) {
    this.time += dt;
    this.stepCount++;
    this._advectVelocity(dt);
    this._updateVelocity(dt);
    this._boundary(dt);
    this._fluxes(dt);
    this._cellsAndErosion(dt);
    this._foamAcc = (this._foamAcc || 0) + dt;
    if (this.stepCount % 2 === 0) { this._foam(this._foamAcc); this._foamAcc = 0; }
    this._buildingsAndProps(dt);
    if (this.stepCount % 3 === 0) this._metrics();
  }

  _advectVelocity(dt) {
    const { u, v, u2, v2, h } = this;
    const k = dt / DX;
    const W = NX + 1;
    u2.set(u);
    for (let j = 0; j < NZ; j++) {
      const j1 = j * NX, j2 = (j + 1) * NX;
      for (let i = 1; i < NX; i++) {
        const c = j1 + i;
        if (h[c] < EPS && h[c - 1] < EPS) continue;
        const idx = j * W + i;
        const uu = u[idx];
        const vv = 0.25 * (v[j1 + i - 1] + v[j1 + i] + v[j2 + i - 1] + v[j2 + i]);
        if (uu < 1e-4 && uu > -1e-4 && vv < 1e-4 && vv > -1e-4) continue;
        let x = i - uu * k, y = j - vv * k;
        if (x < 0) x = 0; else if (x > NX) x = NX;
        if (y < 0) y = 0; else if (y > NZ - 1) y = NZ - 1;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 < NX ? x0 + 1 : x0, y1 = y0 < NZ - 1 ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        const r0 = y0 * W, r1 = y1 * W;
        const a = u[r0 + x0], b = u[r0 + x1], cc = u[r1 + x0], d = u[r1 + x1];
        u2[idx] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
      }
    }
    v2.set(v);
    for (let j = 1; j < NZ; j++) {
      const r0 = (j - 1) * W, r1 = j * W;
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        if (h[idx] < EPS && h[idx - NX] < EPS) continue;
        const vv = v[idx];
        const uu = 0.25 * (u[r0 + i] + u[r0 + i + 1] + u[r1 + i] + u[r1 + i + 1]);
        if (uu < 1e-4 && uu > -1e-4 && vv < 1e-4 && vv > -1e-4) continue;
        let x = i - uu * k, y = j - vv * k;
        if (x < 0) x = 0; else if (x > NX - 1) x = NX - 1;
        if (y < 0) y = 0; else if (y > NZ) y = NZ;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 < NX - 1 ? x0 + 1 : x0, y1 = y0 < NZ ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        const s0 = y0 * NX, s1 = y1 * NX;
        const a = v[s0 + x0], b = v[s0 + x1], cc = v[s1 + x0], d = v[s1 + x1];
        v2[idx] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
      }
    }
    this.u = u2; this.u2 = u;
    this.v = v2; this.v2 = v;
  }

  _updateVelocity(dt) {
    const { u, v, h, bed, eta, n2, fdrag } = this;
    const W = NX + 1;
    const gk = G * dt / DX;
    const FT = FR_TAB;
    for (let j = 0; j < NZ; j++) {
      u[j * W] = 0; u[j * W + NX] = 0;
      for (let i = 1; i < NX; i++) {
        const cL = j * NX + i - 1, cR = cL + 1, k = j * W + i;
        if (h[cL] < EPS && h[cR] < EPS) { u[k] = 0; continue; }
        const eL = eta[cL], eR = eta[cR];
        const bL = bed[cL], bR = bed[cR];
        const bmax = bL > bR ? bL : bR;
        let uu = u[k] - gk * (eR - eL);
        const hf = (uu > 0 ? eL : eR) - bmax;
        if (hf <= EPS) { u[k] = 0; continue; }
        const au = uu < 0 ? -uu : uu;
        let ti = (hf * 100) | 0; if (ti > 1023) ti = 1023;
        const fr = FT[ti] * 0.5 * (n2[cL] + n2[cR]) * au + 0.5 * (fdrag[cL] + fdrag[cR]) * au / (hf < 0.5 ? 0.5 : hf);
        uu /= 1 + dt * fr;
        u[k] = uu > VMAX ? VMAX : uu < -VMAX ? -VMAX : uu;
      }
    }
    for (let i = 0; i < NX; i++) v[i] = 0;
    for (let j = 1; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const cT = j * NX + i, cB = cT - NX;
        if (h[cB] < EPS && h[cT] < EPS) { v[cT] = 0; continue; }
        const eB = eta[cB], eT = eta[cT];
        const bB = bed[cB], bT = bed[cT];
        const bmax = bB > bT ? bB : bT;
        let vv = v[cT] - gk * (eT - eB);
        const hf = (vv > 0 ? eB : eT) - bmax;
        if (hf <= EPS) { v[cT] = 0; continue; }
        const av = vv < 0 ? -vv : vv;
        let ti = (hf * 100) | 0; if (ti > 1023) ti = 1023;
        const fr = FT[ti] * 0.5 * (n2[cB] + n2[cT]) * av + 0.5 * (fdrag[cB] + fdrag[cT]) * av / (hf < 0.5 ? 0.5 : hf);
        vv /= 1 + dt * fr;
        v[cT] = vv > VMAX ? VMAX : vv < -VMAX ? -VMAX : vv;
      }
    }
  }

  _boundary() {
    // Offshore edge (j = NZ): Flather radiation condition carrying the incoming wave.
    const { v, h, bed, eta } = this;
    const j = NZ - 1;
    for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      const k = NZ * NX + i;
      if (h[c] < 0.3) { v[k] = 0; continue; }
      const H = Math.max(1, SEA_LEVEL - bed[c]);
      const etaIn = this.phase === 'running' ? this.forcing(cellX(i), this.time) : 0;
      const w = Math.sqrt(G / H) * (2 * etaIn - (eta[c] - SEA_LEVEL));
      v[k] = -clamp(w, -VMAX, VMAX);
    }
  }

  _fluxes(dt) {
    const { u, v, qx, qz, h, eta, bed, scale, sed, conc } = this;
    const W = NX + 1;
    const k = dt / DX;
    // A: raw upwind fluxes (right + top face of each cell)
    for (let j = 0; j < NZ; j++) { qx[j * W] = 0; qx[j * W + NX] = 0; }
    for (let i = 0; i < NX; i++) qz[i] = 0;
    for (let j = 0; j < NZ; j++) {
      const top = j < NZ - 1;
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        if (i < NX - 1) {
          const idx = j * W + i + 1, uu = u[idx];
          if (uu === 0) qx[idx] = 0;
          else {
            const cR = c + 1;
            const bmax = bed[c] > bed[cR] ? bed[c] : bed[cR];
            const hf = (uu > 0 ? eta[c] : eta[cR]) - bmax;
            qx[idx] = hf > 0 ? uu * hf : 0;
          }
        }
        if (top) {
          const idx = c + NX, vv = v[idx];
          if (vv === 0) qz[idx] = 0;
          else {
            const cT = c + NX;
            const bmax = bed[c] > bed[cT] ? bed[c] : bed[cT];
            const hf = (vv > 0 ? eta[c] : eta[cT]) - bmax;
            qz[idx] = hf > 0 ? vv * hf : 0;
          }
        }
      }
    }
    for (let i = 0; i < NX; i++) {
      const c = (NZ - 1) * NX + i, idx = NZ * NX + i;
      qz[idx] = v[idx] * (h[c] > 0 ? h[c] : 0);
    }
    // B: positivity limiter + sediment concentration
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        const a = qx[j * W + i], b = qx[j * W + i + 1], d = qz[c], e = qz[c + NX];
        const out = ((b > 0 ? b : 0) + (a < 0 ? -a : 0) + (e > 0 ? e : 0) + (d < 0 ? -d : 0)) * k;
        const hh = h[c];
        scale[c] = out > hh ? hh / out : 1;
        conc[c] = sed[c] > 0 && hh > 1e-3 ? (sed[c] < hh ? sed[c] / hh : 1) : 0;
      }
    }
    // C: apply limiter to fluxes (scaled by donor cell)
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        if (i < NX - 1) {
          const idx = j * W + i + 1, q = qx[idx];
          if (q > 0) qx[idx] = q * scale[c]; else if (q < 0) qx[idx] = q * scale[c + 1];
        }
        const idx = c + NX, q = qz[idx];
        if (j < NZ - 1) { if (q > 0) qz[idx] = q * scale[c]; else if (q < 0) qz[idx] = q * scale[c + NX]; }
        else if (q > 0) qz[idx] = q * scale[c];
      }
    }
    // D: update depth, suspended sediment, free surface; track max signal speed
    let maxSig = 0;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        const qL = qx[j * W + i], qR = qx[j * W + i + 1], qB = qz[c], qT = qz[c + NX];
        let hn = h[c] - k * (qR - qL + qT - qB);
        if (hn < 0) hn = 0;
        const cL = qL > 0 ? (i > 0 ? conc[c - 1] : 0) : conc[c];
        const cR = qR > 0 ? conc[c] : (i < NX - 1 ? conc[c + 1] : 0);
        const cB = qB > 0 ? (j > 0 ? conc[c - NX] : 0) : conc[c];
        const cT = qT > 0 ? conc[c] : (j < NZ - 1 ? conc[c + NX] : 0);
        const ds = k * (qR * cR - qL * cL + qT * cT - qB * cB);
        if (ds !== 0) { const s = sed[c] - ds; sed[c] = s > 0 ? s : 0; }
        h[c] = hn;
        eta[c] = bed[c] + hn;
        if (hn > 0.05) {
          // gravity-wave celerity dominates the explicit pressure update; advection is
          // semi-Lagrangian and |u| <= VMAX keeps the advective Courant number below 0.6
          const uu = u[j * W + i + 1], vv = v[c + NX];
          const sig = 3.132 * Math.sqrt(hn) + 0.3 * ((uu < 0 ? -uu : uu) + (vv < 0 ? -vv : vv));
          if (sig > maxSig) maxSig = sig;
        }
      }
    }
    this._maxSignal = maxSig;
  }

  _cellsAndErosion(dt) {
    const { u, v, cu, cv, speed, h, sand, rock, terrain, erK, ucrit, sed, structTop, bldTop, rubble, bed, eta, landMask } = this;
    const W = NX + 1;
    const KE = 0.0012, WS = 0.035, UD2 = 2.2 * 2.2;
    const infil = this.metrics.arrived ? 0.0035 * dt : 0;
    let ms = 0;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        let hh = h[c];
        if (hh < 0.02) {
          cu[c] = 0; cv[c] = 0; speed[c] = 0;
          if (sed[c] > 0) {
            if (bldTop[c] === NONE) sand[c] += sed[c];
            sed[c] = 0;
            terrain[c] = rock[c] + sand[c];
            let b = terrain[c] + rubble[c];
            if (structTop[c] > b) b = structTop[c];
            if (bldTop[c] > b) b = bldTop[c];
            bed[c] = b; eta[c] = b + hh;
          }
          continue;
        }
        const a = 0.5 * (u[j * W + i] + u[j * W + i + 1]);
        const bb = 0.5 * (v[c] + v[c + NX]);
        cu[c] = a; cv[c] = bb;
        const sp2 = a * a + bb * bb;
        const sp = Math.sqrt(sp2);
        speed[c] = sp;
        if (landMask[c]) {
          if (sp > ms) ms = sp;
          if (infil) { hh = hh > infil ? hh - infil : 0; h[c] = hh; eta[c] = bed[c] + hh; }
        }
        if (structTop[c] > terrain[c] || bldTop[c] !== NONE) continue;
        const uc = ucrit[c];
        let changed = false;
        if (sp > uc && erK[c] > 0 && sand[c] > 0) {
          let e = dt * KE * erK[c] * (sp2 - uc * uc);
          if (e > 0.05 * hh) e = 0.05 * hh;
          if (e > sand[c]) e = sand[c];
          sand[c] -= e; sed[c] += e; changed = true;
        }
        if (sed[c] > 0 && sp2 < UD2) {
          const dep = sed[c] * Math.min(1, dt * WS * (1 - sp2 / UD2) / (hh < 0.3 ? 0.3 : hh));
          sed[c] -= dep; sand[c] += dep; changed = true;
        }
        if (changed) {
          terrain[c] = rock[c] + sand[c];
          let b = terrain[c] + rubble[c];
          if (structTop[c] > b) b = structTop[c];
          bed[c] = b; eta[c] = b + hh;
        }
      }
    }
    this.metrics.maxSpeed = Math.max(this.metrics.maxSpeed * 0.999, ms);
    // slope relaxation (avalanching of over-steepened, undercut sand)
    if (this.stepCount % 4 === 0) {
      const lim = 1.1;
      let any = false;
      for (let j = 0; j < NZ - 1; j++) {
        for (let i = 0; i < NX - 1; i++) {
          const c = j * NX + i;
          for (let q = 0; q < 2; q++) {
            const n = q === 0 ? c + 1 : c + NX;
            if (h[c] < 0.02 && h[n] < 0.02) continue;
            const d = terrain[c] - terrain[n];
            if (d > lim) {
              if (sand[c] > 0 && bldTop[n] === NONE && structTop[n] < terrain[n]) {
                const m = Math.min((d - lim) * 0.3, sand[c]);
                sand[c] -= m; sand[n] += m; any = true;
                terrain[c] = rock[c] + sand[c]; terrain[n] = rock[n] + sand[n];
              }
            } else if (d < -lim) {
              if (sand[n] > 0 && bldTop[c] === NONE && structTop[c] < terrain[c]) {
                const m = Math.min((-d - lim) * 0.3, sand[n]);
                sand[n] -= m; sand[c] += m; any = true;
                terrain[c] = rock[c] + sand[c]; terrain[n] = rock[n] + sand[n];
              }
            }
          }
        }
      }
      if (any) this._rebuildBed();
    }
    this.terrainDirty = true;
  }

  _foam(dt) {
    const { foam, foam2, h, eta, bed, speed, cu, cv } = this;
    const decay = Math.exp(-dt * 0.7);
    const spray = this.sprayEvents;
    const rate = dt * 30;
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const c = j * NX + i;
        const hh = h[c];
        if (hh < 0.02) { foam2[c] = 0; continue; }
        const sp = speed[c];
        let gx = 0, gz = 0;
        if (h[c + 1] > 0.3 && h[c - 1] > 0.3) gx = (eta[c + 1] - eta[c - 1]) * 0.25;
        if (h[c + NX] > 0.3 && h[c - NX] > 0.3) gz = (eta[c + NX] - eta[c - NX]) * 0.25;
        const steep = Math.sqrt(gx * gx + gz * gz);
        const deep = hh < 0.6 ? hh / 0.6 : 1;
        let src = 0;
        if (steep > 0.09) src = (steep - 0.09) * 5 * (sp < 1.5 ? sp / 1.5 : 1) * deep;
        if (sp > 4.5) src += (sp - 4.5) * 0.05 * deep;
        const e = eta[c] + 0.3;
        let impact = 0;
        if (bed[c + 1] > e && cu[c] > impact) impact = cu[c];
        if (bed[c - 1] > e && -cu[c] > impact) impact = -cu[c];
        if (bed[c + NX] > e && cv[c] > impact) impact = cv[c];
        if (bed[c - NX] > e && -cv[c] > impact) impact = -cv[c];
        if (impact > 1.5) {
          src += (impact - 1.5) * 0.5 * deep;
          if (impact > 3 && spray.length < 3000 && Math.random() < 0.05 * impact * rate) {
            spray.push(cellX(i), eta[c], cellZ(j), impact, -cu[c] * 0.3, -cv[c] * 0.3);
          }
        }
        if (steep > 0.22 && sp > 3 && spray.length < 3000 && Math.random() < 0.03 * rate) {
          spray.push(cellX(i), eta[c], cellZ(j), sp * 0.6, cu[c] * 0.5, cv[c] * 0.5);
        }
        let x = i - cu[c] * dt / DX, y = j - cv[c] * dt / DX;
        if (x < 0) x = 0; else if (x > NX - 1.001) x = NX - 1.001;
        if (y < 0) y = 0; else if (y > NZ - 1.001) y = NZ - 1.001;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const b0 = y0 * NX + x0;
        const f = (foam[b0] * (1 - fx) + foam[b0 + 1] * fx) * (1 - fy) + (foam[b0 + NX] * (1 - fx) + foam[b0 + NX + 1] * fx) * fy;
        const nf = f * decay + src * dt * 2.5;
        foam2[c] = nf > 1 ? 1 : nf;
      }
    }
    this.foam = foam2; this.foam2 = foam;
  }

  _buildingsAndProps(dt) {
    const { h, speed, cu, cv } = this;
    for (const b of this.buildings) {
      if (b.state === 'destroyed') continue;
      let M = 0, fx = 0, fz = 0;
      for (let k = 0; k < b.ring.length; k++) {
        const c = b.ring[k];
        const hh = h[c];
        if (hh < 0.05) continue;
        const sp = speed[c];
        const m = hh * sp * sp + 0.3 * G * hh * hh;
        if (m > M) { M = m; fx = cu[c]; fz = cv[c]; }
      }
      b.load = M;
      if (M > b.maxLoad) b.maxLoad = M;
      if (M > 0.05) { const l = Math.hypot(fx, fz); if (l > 0.2) { b.flowX = fx / l; b.flowZ = fz / l; } }
      const r = M / b.resist;
      // impact: loads above the structural resistance break the building quickly
      if (r > 1) b.health -= dt * Math.min(3, 0.25 * Math.pow(r - 1, 1.5));
      // exposure: sustained moderate loads (standing / slow water) degrade it gradually
      if (r > 0.3) b.health -= dt * 0.03 * Math.min(r, 1.5);
      if (b.health <= 0) this._destroyBuilding(b);
      else if (b.health < 0.93) b.state = 'damaged';
    }
    for (const p of this.props) {
      if (p.fallen || p.cell < 0) continue;
      const hh = h[p.cell];
      if (hh < 0.2) continue;
      const sp = speed[p.cell];
      if (hh * sp * sp + 0.3 * G * hh * hh * 0.2 > p.thr) {
        p.fallen = 1;
        p.fallDir = Math.atan2(cv[p.cell], cu[p.cell]);
      }
    }
  }

  _destroyBuilding(b) {
    b.health = 0;
    b.state = 'destroyed';
    b.destroyedAt = this.time;
    for (const c of b.cells) {
      this.bldTop[c] = NONE;
      this.bldId[c] = -1;
      this.rubble[c] = 0.6 + 0.4 * Math.random();
      this.rubbleDrag[c] = 0.8;
    }
    this._rebuildBed();
    this._rebuildDrag();
    this.events.push({ type: 'collapse', building: b });
    // spawn floating / tumbling debris chunks
    const n = Math.min(14, 4 + Math.round(b.w * b.d / 25));
    for (let k = 0; k < n; k++) {
      const d = this._allocDebris('chunk');
      if (!d) break;
      d.x = b.x0 + Math.random() * b.w; d.z = b.z0 + Math.random() * b.d;
      d.y = b.groundY + Math.random() * Math.min(b.height, 12);
      d.vx = b.flowX * 2 + (Math.random() - 0.5) * 3; d.vz = b.flowZ * 2 + (Math.random() - 0.5) * 3; d.vy = Math.random() * 2;
      d.len = 1.2 + Math.random() * 2.6; d.wid = 0.4 + Math.random() * 1.2; d.hgt = 0.25 + Math.random() * 0.6;
      d.draft = d.hgt * 0.4; d.floaty = Math.random() < 0.7;
      d.yaw = Math.random() * 6.28; d.wyaw = (Math.random() - 0.5) * 2; d.tilt = Math.random() * 0.8;
      d.color = b.id; d.building = b.id;
    }
  }

  // ------------------------------------------------------------ debris
  _initDebris() {
    const MAX = 260;
    if (!this.debris) {
      this.debris = [];
      for (let k = 0; k < MAX; k++) this.debris.push({ active: false, kind: 'chunk', id: k });
    }
    for (const d of this.debris) { d.active = false; d.kind = 'chunk'; }
    this.vehicleDebris = [];
    for (let k = 0; k < this.vehicles.length; k++) {
      const vdef = this.vehicles[k];
      const d = this.debris[k];
      d.active = true; d.kind = vdef.kind; d.vehicle = k;
      d.x = vdef.x; d.z = vdef.z; d.vx = 0; d.vz = 0; d.vy = 0;
      d.yaw = vdef.yaw; d.wyaw = 0; d.tilt = 0;
      if (vdef.kind === 'car') { d.len = 4.2; d.wid = 1.9; d.hgt = 1.5; d.draft = 0.55; d.floaty = true; }
      else { d.len = 7; d.wid = 2.6; d.hgt = 1.6; d.draft = 0.5; d.floaty = true; }
      const c = this.worldToCell(d.x, d.z);
      d.y = vdef.kind === 'boat' ? 0 : this.terrain0[c] + d.hgt / 2;
      d.color = vdef.color;
    }
  }
  _allocDebris(kind) {
    for (let k = this.vehicles.length; k < this.debris.length; k++) {
      const d = this.debris[k];
      if (!d.active) { d.active = true; d.kind = kind; return d; }
    }
    return null;
  }

  sample(arr, x, z) {
    let gx = (x - X0) / DX - 0.5, gz = (z - Z0) / DX - 0.5;
    gx = clamp(gx, 0, NX - 1.001); gz = clamp(gz, 0, NZ - 1.001);
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j;
    const c = j * NX + i;
    return (arr[c] * (1 - fx) + arr[c + 1] * fx) * (1 - fz) + (arr[c + NX] * (1 - fx) + arr[c + NX + 1] * fx) * fz;
  }

  _updateDebris(dt) {
    if (dt <= 0) return;
    const t = this.time;
    for (const d of this.debris) {
      if (!d.active) continue;
      const c = this.worldToCell(d.x, d.z);
      if (c < 0) { d.active = false; continue; }
      const hh = this.h[c];
      const ground = this.terrain[c] + this.rubble[c];
      const surf = ground + hh;
      const floating = d.floaty && hh > d.draft;
      if (floating) {
        const wu = this.sample(this.cu, d.x, d.z), wv = this.sample(this.cv, d.x, d.z);
        const a = Math.min(1, dt * (d.kind === 'boat' ? 1.2 : 2.2));
        d.vx += (wu - d.vx) * a; d.vz += (wv - d.vz) * a;
        const ty = surf - d.draft + d.hgt / 2 + Math.sin(t * 2 + d.id) * 0.06;
        d.y += (ty - d.y) * Math.min(1, dt * 5);
        d.vy = 0;
        d.wyaw += ((wu * 0.13 - wv * 0.07) * 0.2 - d.wyaw) * Math.min(1, dt);
        if (d.kind !== 'boat') d.tilt += (Math.min(0.5, Math.hypot(wu, wv) * 0.05) - d.tilt) * dt;
      } else {
        const gy = ground + d.hgt / 2;
        if (d.y > gy + 0.05) { d.vy -= 9.81 * dt; d.y += d.vy * dt; if (d.y < gy) { d.y = gy; d.vy = 0; } }
        else { d.y = gy; d.vy = 0; }
        const fr = Math.exp(-dt * (hh > 0.1 ? 1.5 : 5));
        // partially submerged heavy chunks get dragged a little
        if (hh > 0.15) {
          const wu = this.cu[c], wv = this.cv[c];
          const a = Math.min(1, dt * 0.6 * Math.min(1, hh / (d.draft + 0.01)));
          d.vx += (wu - d.vx) * a; d.vz += (wv - d.vz) * a;
        }
        d.vx *= fr; d.vz *= fr; d.wyaw *= fr;
      }
      const nx = d.x + d.vx * dt, nz = d.z + d.vz * dt;
      const nc = this.worldToCell(nx, nz);
      if (nc < 0) { d.vx = -d.vx * 0.3; d.vz = -d.vz * 0.3; continue; }
      const top = Math.max(this.bldTop[nc], this.structTop[nc]);
      if (top > d.y - d.hgt * 0.3 && top > this.terrain[nc] + 0.3) {
        const sp = Math.hypot(d.vx, d.vz);
        const bid = this.bldId[nc];
        if (bid >= 0 && sp > 1.5) {
          const b = this.buildings[bid];
          b.health -= 0.012 * sp * (d.kind === 'boat' ? 3 : d.kind === 'car' ? 2 : 1);
          if (b.health < 0.93 && b.state === 'intact') b.state = 'damaged';
          if (b.health <= 0 && b.state !== 'destroyed') this._destroyBuilding(b);
        }
        d.vx = -d.vx * 0.25; d.vz = -d.vz * 0.25;
      } else {
        d.x = nx; d.z = nz;
      }
      d.yaw += d.wyaw * dt;
    }
  }

  // ------------------------------------------------------------ metrics
  _metrics() {
    const m = this.metrics;
    const { h, landMask, maxDepth, bldId, eta } = this;
    let maxD = m.maxFloodDepth, flooded = 0, landWater = 0;
    for (let c = 0; c < this.N; c++) {
      if (!landMask[c]) continue;
      const hh = h[c];
      if (hh > maxDepth[c]) maxDepth[c] = hh;
      if (bldId[c] >= 0) continue;
      if (hh > maxD) maxD = hh;
      if (maxDepth[c] > 0.2) flooded++;
      landWater += hh;
    }
    m.maxFloodDepth = maxD;
    m.floodedArea = flooded * DX * DX;
    m.floodedPct = 100 * flooded / this.landCellCount;
    m.landWater = landWater * DX * DX;
    if (m.landWater > (m.peakLandWater || 0)) m.peakLandWater = m.landWater;
    if (!m.arrived && flooded > 40) { m.arrived = true; m.arrivalTime = this.time; }
    // peak wave height in the sea near the coast
    if (this.stepCount % 4 === 0) {
      let pk = m.peakWave;
      for (let c = 0; c < this.N; c++) if (this.terrain0[c] < -0.5 && h[c] > 0.3 && eta[c] > pk) pk = eta[c];
      m.peakWave = pk;
      // erosion volumes and inland reach
      let er = 0, dep = 0, sc = 0;
      for (let c = 0; c < this.N; c++) {
        const d = this.sand[c] - this.sand0[c];
        if (this.terrain0[c] > -4) {
          if (d < 0) { er -= d; if (-d > sc) sc = -d; } else dep += d;
        }
      }
      m.erosion = er * DX * DX; m.deposition = dep * DX * DX; m.maxScour = sc;
      let reach = 0;
      for (let i = 0; i < NX; i++) {
        const x = cellX(i);
        for (let j = 0; j < NZ; j++) {
          const c = j * NX + i;
          if (landMask[c] && maxDepth[c] > 0.2) { const s = shoreZ(x) - cellZ(j); if (s > reach) reach = s; break; }
        }
      }
      m.inundation = reach;
    }
    let dmg = 0, des = 0;
    for (const b of this.buildings) {
      if (b.type === 'lighthouse') continue;
      if (b.state === 'destroyed') des++; else if (b.state === 'damaged') dmg++;
    }
    m.damaged = dmg; m.destroyed = des;
  }

  // front position for camera follow
  waveFront() {
    let best = 1e9, sx = 0, n = 0;
    const thr = this.preset ? this.preset.A * 0.35 : 1;
    for (let j = 0; j < NZ; j += 2) {
      for (let i = 0; i < NX; i += 2) {
        const c = j * NX + i;
        const z = cellZ(j);
        const active = this.landMask[c] ? (this.h[c] > 0.15 && this.speed[c] > 1.2) : (this.eta[c] > thr && this.h[c] > 0.3);
        if (active) {
          if (z < best - 4) { best = z; sx = cellX(i); n = 1; }
          else if (z < best + 4) { sx += cellX(i); n++; }
        }
      }
    }
    if (!n) return null;
    return { x: sx / n, z: best };
  }

  status() {
    if (this.phase === 'idle') return 'Ready';
    const m = this.metrics;
    const p = this.preset;
    if (!m.arrived) return this.time < 6 ? 'Sea drawing back — wave approaching' : 'Wave approaching the coast';
    const peak = m.peakLandWater || 0;
    if (m.landWater > 0.85 * peak || this.time < m.arrivalTime + p.rise + 4) return 'Impact — inundation in progress';
    if (m.landWater > 0.3 * peak && this.time < m.arrivalTime + 70) return 'Water receding';
    return 'Aftermath — inspect the damage';
  }
}
