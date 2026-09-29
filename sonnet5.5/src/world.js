// Shared world definition: grid, terrain function, town layout, defense specs.
// Pure module (no DOM / three.js) so the solver can be tested headlessly in node.

export const NX = 160, NY = 140, DX = 0.625;
export const XMIN = -NX * DX / 2, ZMIN = -40;
export const XMAX = XMIN + NX * DX, ZMAX = ZMIN + NY * DX;
export const G = 5.2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, t) => { t = clamp((t - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const cellX = (i) => XMIN + (i + 0.5) * DX;
export const cellZ = (j) => ZMIN + (j + 0.5) * DX;
export const idxOfX = (x) => Math.floor((x - XMIN) / DX);
export const idxOfZ = (z) => Math.floor((z - ZMIN) / DX);

const hash = (ix, iz) => {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};
export function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
export const fbm = (x, z) => vnoise(x, z) * 0.55 + vnoise(x * 2.1 + 7.3, z * 2.1 - 3.1) * 0.3 + vnoise(x * 4.3 - 5.7, z * 4.3 + 11.9) * 0.15;
export function rand01(seed) { // tiny deterministic PRNG
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------------------------------------------------------- terrain
export const coastZ = (x) => 2.0 + 2.6 * Math.sin(x * 0.085 + 0.6) + 1.1 * Math.sin(x * 0.2 + 2.0);
const gauss = (dx, ds, ax, as) => Math.exp(-((dx * dx) / (ax * ax) + (ds * ds) / (as * as)));

function profile(s) {
  if (s < -26) return -7;
  if (s < -6) { const t = (s + 26) / 20; const sm = t * t * (3 - 2 * t); return -7 + 6.1 * (t * 0.7 + 0.3 * sm); }
  if (s < 0) return -0.9 + 0.9 * ((s + 6) / 6) * (0.85 + 0.15 * ((s + 6) / 6));
  if (s < 6) { const t = s / 6; return 0.95 * (0.7 * t + 0.3 * t * t * (3 - 2 * t)); }
  if (s < 9) return 0.95 + 0.30 * ((s - 6) / 3);
  if (s < 28) return 1.25 + 0.05 * (s - 9);
  const q = s - 28;
  return 2.2 + 0.015 * q * q;
}

export function groundAt(x, z) {
  const s = z - coastZ(x);
  let h = profile(s);
  // offshore shoal and trench -> refraction of the wave front
  h += 1.9 * gauss(x + 18, s + 14, 9, 6);
  h -= 1.5 * gauss(x - 26, s + 16, 6, 7);
  // river valley that funnels floodwater inland
  const riv = Math.exp(-Math.pow((x - 24 - 3 * Math.sin(s * 0.12)) / 3.2, 2));
  h -= 0.95 * riv * smooth(3, 9, s) * (1 - smooth(34, 44, s));
  // town pond
  h -= 0.85 * gauss(x + 22, s - 33, 5, 5);
  // dunes & roughness
  if (s > 0) h += (fbm(x * 0.12, z * 0.12) - 0.5) * 0.34 * smooth(2, 10, s) + (vnoise(x * 0.9, z * 0.9) - 0.5) * 0.05 * smooth(0, 6, s);
  else h += (fbm(x * 0.15 + 20, z * 0.15) - 0.5) * 0.14 * smooth(-30, -10, s);
  return h;
}

// ---------------------------------------------------------------- town layout
export const COAST_ROAD_S = 11.4, INLAND_ROAD_S = 22.3;
export const CROSS_STREETS = [-26, -11.8, 10, 38];
export function roadMask(x, z) {
  const s = z - coastZ(x);
  const e = (d, w) => 1 - smooth(w - 0.35, w + 0.35, d);
  let m = Math.max(e(Math.abs(s - COAST_ROAD_S), 1.15), e(Math.abs(s - INLAND_ROAD_S), 1.0));
  if (s > COAST_ROAD_S - 1 && s < 38) for (const cx of CROSS_STREETS) m = Math.max(m, e(Math.abs(x - cx), 1.0));
  return m;
}

// capacity: load a building can carry before it starts to fail (momentum-flux units)
export const KINDS = {
  house:      { cap: 2.2,  color: 0xe8d9b8, roof: 0xb5523b },
  shop:       { cap: 2.8,  color: 0xd9e4e8, roof: 0x3f7f9a },
  warehouse:  { cap: 3.4,  color: 0xc9c2b4, roof: 0x6f7780 },
  inn:        { cap: 4.0,  color: 0xf0e2c2, roof: 0x8a3f33 },
  apartments: { cap: 4.8,  color: 0xd8d2c8, roof: 0x59616b },
  hall:       { cap: 5.5,  color: 0xe9e4d8, roof: 0x4a6a55 },
  school:     { cap: 4.2,  color: 0xe6c99a, roof: 0x7d4a3a },
  church:     { cap: 5.2,  color: 0xeeeae0, roof: 0x5a5560 },
  lighthouse: { cap: 6.0,  color: 0xf2f2f0, roof: 0xb73a34 },
};
const B = (name, kind, x, s, w, d, h) => ({ name, kind, x, s, w, d, h, z: coastZ(x) + s });
export const BUILDINGS = [
  B('Beach Cafe', 'shop', -42, 14.6, 4.6, 3.6, 2.6),
  B('Seaside Cottage', 'house', -33, 14.6, 3.4, 3.4, 2.4),
  B('Fish Market', 'warehouse', -18, 14.8, 6.5, 4.0, 2.8),
  B('Harbor Inn', 'inn', -6, 15.0, 5.6, 4.2, 3.8),
  B('Surf Shop', 'shop', 4, 14.6, 4.0, 3.2, 2.4),
  B('Bay Cottage', 'house', 15, 14.6, 3.4, 3.4, 2.4),
  B('Boathouse', 'warehouse', 32, 14.6, 5.2, 3.6, 2.6),
  B('Dune Cottage', 'house', 44, 14.6, 3.4, 3.4, 2.4),
  B('Bakery', 'shop', -44, 18.8, 3.8, 3.2, 2.6),
  B('Old Townhouse', 'house', -35, 18.8, 4.2, 3.6, 3.6),
  B('Bookshop', 'shop', -19, 18.8, 4.4, 3.4, 3.0),
  B('Pharmacy', 'shop', -5, 18.8, 4.0, 3.4, 2.8),
  B('Corner House', 'house', 3, 18.8, 3.6, 3.6, 3.6),
  B('River Cottage', 'house', 16, 18.8, 3.4, 3.4, 2.4),
  B('Garden Cottage', 'house', 33, 18.8, 3.4, 3.4, 2.4),
  B('Hillside Cottage', 'house', 44, 18.8, 3.6, 3.6, 2.6),
  B('Town Hall', 'hall', -4, 27.5, 8.0, 5.2, 4.4),
  B('Primary School', 'school', -36, 27.5, 9.0, 5.0, 3.2),
  B('Apartments', 'apartments', 17, 27.5, 5.2, 5.2, 5.4),
  B('Chapel', 'church', 34, 27.5, 4.6, 7.4, 5.2),
  B('Hillside Flats', 'apartments', 46, 27.5, 4.6, 4.6, 5.0),
  B('Harbor Lighthouse', 'lighthouse', -46, 6.2, 2.6, 2.6, 8.5),
];

// ---------------------------------------------------------------- defenses
export const STRUCTS = {
  seawall: {
    key: 'seawall', name: 'Seawall', blurb: 'Tall vertical wall. Blocks and reflects.',
    len: 40, thick: 1.5, crest: 3.0, mann: 0.02,
  },
  breakwater: {
    key: 'breakwater', name: 'Breakwater', blurb: 'Low rubble mound. Absorbs wave energy.',
    len: 30, wid: 3.4, crest: 1.0, slope: 1.3, mann: 0.32,
  },
  segmented: {
    key: 'segmented', name: 'Segmented Breakwater', blurb: 'Rubble blocks with gaps between them.',
    blocks: 5, blen: 6.5, gap: 3.6, wid: 3.0, crest: 1.3, slope: 1.3, mann: 0.32,
  },
  embankment: {
    key: 'embankment', name: 'Sloped Embankment', blurb: 'Wide earth ramp. Dissipates and allows overtopping.',
    len: 36, crest: 2.4, seaSlope: 3, landSlope: 1.5, crestW: 2, mann: 0.12,
  },
};
export const MAX_STRUCTS = 24;

export function structLength(def) {
  return def.blocks ? def.blocks * def.blen + (def.blocks - 1) * def.gap : def.len;
}
// core rectangle in local coordinates (a along the structure, w across; -w = seaward)
export function structRect(def) {
  const L = structLength(def) / 2;
  if (def.key === 'seawall') return { a0: -L, a1: L, w0: -def.thick / 2 - 0.3, w1: def.thick / 2 + 0.3 };
  if (def.key === 'embankment') {
    const w0 = -(def.crestW / 2 + def.crest * def.seaSlope), w1 = def.crestW / 2 + def.crest * def.landSlope;
    return { a0: -L, a1: L, w0, w1 };
  }
  return { a0: -L - 1.5, a1: L + 1.5, w0: -def.wid / 2 - 1.5, w1: def.wid / 2 + 1.5 };
}
// Reach used for rasterisation (mounds extend down to the sea bed)
export function structReach(def) {
  const r = structRect(def);
  const m = def.slope ? def.slope * (def.crest + 9) : 1;
  return { a0: r.a0 - m, a1: r.a1 + m, w0: r.w0 - m, w1: r.w1 + m };
}
// Top surface height (above 'ref') at local (a, w); -Infinity if outside; also Manning n
export function structTop(def, a, w) {
  switch (def.key) {
    case 'seawall':
      return Math.abs(a) <= def.len / 2 && Math.abs(w) <= def.thick / 2 ? def.crest : -Infinity;
    case 'breakwater': {
      const da = Math.max(0, Math.abs(a) - def.len / 2), dw = Math.max(0, Math.abs(w) - def.wid / 2);
      return def.crest - Math.hypot(da, dw) / def.slope;
    }
    case 'segmented': {
      const per = def.blen + def.gap, a0 = -structLength(def) / 2 + def.blen / 2;
      const k = clamp(Math.round((a - a0) / per), 0, def.blocks - 1);
      const da = Math.max(0, Math.abs(a - (a0 + k * per)) - def.blen / 2), dw = Math.max(0, Math.abs(w) - def.wid / 2);
      return def.crest - Math.hypot(da, dw) / def.slope;
    }
    case 'embankment': {
      if (Math.abs(a) > def.len / 2) return -Infinity;
      const H = def.crest, c = def.crestW / 2;
      if (w < -c) { const w0 = -(c + H * def.seaSlope); return w < w0 ? -Infinity : H * (w - w0) / (H * def.seaSlope); }
      if (w <= c) return H;
      const w1 = c + H * def.landSlope; return w > w1 ? -Infinity : H * (w1 - w) / (H * def.landSlope);
    }
  }
  return -Infinity;
}

// local <-> world  (a-axis = (cos r, sin r) in x/z ; w-axis = (-sin r, cos r))
export function toLocal(p, x, z) {
  const dx = x - p.x, dz = z - p.z, c = Math.cos(p.rot), s = Math.sin(p.rot);
  return [dx * c + dz * s, -dx * s + dz * c];
}
export function toWorld(p, a, w) {
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  return [p.x + a * c - w * s, p.z + a * s + w * c];
}

export const WAVES = {
  moderate: { key: 'moderate', name: 'Moderate', A: 0.85, L: 4.4 },
  severe: { key: 'severe', name: 'Severe', A: 1.5, L: 5.0 },
  extreme: { key: 'extreme', name: 'Extreme', A: 2.5, L: 5.8 },
};

// Reference height for a structure: highest natural ground in its core footprint (never below sea level)
export function computeRef(p, groundFn = groundAt) {
  const def = STRUCTS[p.type], r = structRect(def);
  let m = 0;
  for (let a = r.a0; a <= r.a1 + 1e-6; a += 1) for (let w = r.w0; w <= r.w1 + 1e-6; w += 1) {
    const [x, z] = toWorld(p, a, w);
    m = Math.max(m, groundFn(x, z));
  }
  return m;
}
