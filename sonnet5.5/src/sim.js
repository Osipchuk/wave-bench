// Real-time shallow-water solver on a staggered (C-grid) height field.
//
// State per cell:  d  = water depth above the (effective) bed
// State per face:  qx, qy = discharge per unit width (momentum-carrying, inertial)
//
// Face update (inertial shallow-water form with implicit Manning friction):
//   q' = ( q - g * hf * dt * dEta/dx ) / ( 1 + g*dt*n^2*|q| / hf^(7/3) )
// where hf is the flow depth over the sill between the two cells, so barriers,
// walls, gaps and overtopping emerge directly from the bed geometry.
// Mass is conserved by limiting outflow to the water available in each cell.
import * as W from './world.js';
import { NX, NY, DX, G } from './world.js';

const N = NX * NY;
const NEG = -100;
const HMIN = 1e-3;
const VMAX = 8;
const SPONGE_ROWS = 7;
export const SIM_DT = 1 / 60;
const INV_DX = 1 / DX;
const DMG_RATE = 30;
const INFIL = 0.018;
const CBT = new Float32Array(4096); for (let i = 0; i < 4096; i++) CBT[i] = Math.cbrt((i + 0.5) / 128);
const cb = (h) => (h < 0.03 || h > 31.9 ? Math.cbrt(h) : CBT[(h * 128) | 0]); // ground drainage (m/s) on land

export class Sim {
  constructor() {
    const f = () => new Float32Array(N);
    this.ground0 = f(); this.bT = f(); this.bS = f(); this.bB = f(); this.Bh = f();
    this.mann0 = f(); this.mann = f(); this.erod0 = f(); this.erod = f();
    this.d = f(); this.qx = f(); this.qy = f(); this.K = f();
    this.uc = f(); this.vc = f(); this.spd = f(); this.foam = f(); this.tmp = f();
    this.wet = f(); this.peak = f();
    this.land = new Uint8Array(N); this.nearSolid = new Uint8Array(N); this.solid = new Uint8Array(N); this.flooded = new Uint8Array(N);
    this.sponge = f();
    this.structs = [];
    this.events = [];
    this.buildStatic();
    this.reset();
  }

  buildStatic() {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i, x = W.cellX(i), z = W.cellZ(j), s = z - W.coastZ(x);
        const g = W.groundAt(x, z);
        this.ground0[c] = g;
        this.land[c] = g > 0.5 ? 1 : 0;
        const road = W.roadMask(x, z);
        let n;
        if (g < 0) n = 0.022;
        else if (s < 10) n = 0.032;
        else if (s < 28) n = 0.05;
        else n = 0.07;
        if (road > 0.5) n = 0.022;
        this.mann0[c] = n;
        // erodibility: sand beach fully erodible, lawns/roads much less, rock patches not at all
        let e;
        if (s < -12) e = 0;
        else if (s < -2) e = 0.55 * W.smooth(-12, -2, s) ;
        else if (s < 10) e = 0.55 + 0.45 * W.smooth(-2, 3, s);
        else e = 1 - 0.65 * W.smooth(10, 16, s);
        e *= 1 - 0.55 * W.smooth(16, 30, s);
        if (road > 0.5) e *= 0.5;
        const rock = W.smooth(0.63, 0.7, W.fbm(x * 0.07 + 10, z * 0.07 - 4)) * W.smooth(-6, 2, s);
        const flank = W.smooth(41, 47, Math.abs(x)) * W.smooth(-6, 4, s) * (s < 12 ? 1 : 0);
        e *= 1 - Math.max(rock, flank * 0.9);
        this.erod0[c] = e;
        // absorbing layer at the offshore boundary
        this.sponge[c] = j < SPONGE_ROWS ? Math.pow((SPONGE_ROWS - j) / SPONGE_ROWS, 1.5) : 0;
      }
    }
    // building footprints
    this.bld = W.BUILDINGS.map((spec, id) => {
      const cells = [], ringSet = new Set(), inSet = new Set();
      let gmax = -1e9;
      const i0 = W.idxOfX(spec.x - spec.w / 2), i1 = W.idxOfX(spec.x + spec.w / 2);
      const j0 = W.idxOfZ(spec.z - spec.d / 2), j1 = W.idxOfZ(spec.z + spec.d / 2);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = W.cellX(i), cz = W.cellZ(j);
        if (Math.abs(cx - spec.x) <= spec.w / 2 && Math.abs(cz - spec.z) <= spec.d / 2) {
          const c = j * NX + i; cells.push(c); inSet.add(c); gmax = Math.max(gmax, this.ground0[c]);
        }
      }
      for (const c of cells) {
        const i = c % NX, j = (c / NX) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
          const n = nj * NX + ni; if (!inSet.has(n)) ringSet.add(n);
        }
      }
      return { id, spec, cells, ring: [...ringSet], gmax, top: gmax + spec.h, cap: W.KINDS[spec.kind].cap, hp: 100, state: 0, peakDepth: 0, peakSpeed: 0, load: 0 };
    });
    this.landCount = 0;
  }

  setStructures(list) { this.structs = list.map((s) => ({ ...s })); }

  rasterStructs() {
    for (const p of this.structs) {
      const def = W.STRUCTS[p.type];
      const r = W.structReach(def);
      const rad = Math.hypot(Math.max(Math.abs(r.a0), Math.abs(r.a1)), Math.max(Math.abs(r.w0), Math.abs(r.w1)));
      const i0 = Math.max(0, W.idxOfX(p.x - rad)), i1 = Math.min(NX - 1, W.idxOfX(p.x + rad));
      const j0 = Math.max(0, W.idxOfZ(p.z - rad)), j1 = Math.min(NY - 1, W.idxOfZ(p.z + rad));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * NX + i;
        const [a, w] = W.toLocal(p, W.cellX(i), W.cellZ(j));
        const t = W.structTop(def, a, w);
        if (t === -Infinity) continue;
        const top = p.ref + t;
        if (top > this.bT[c] + 0.02) {
          if (top > this.bS[c]) this.bS[c] = top;
          if (def.mann > this.mann[c]) this.mann[c] = def.mann;
          this.erod[c] = 0;
        }
      }
    }
  }

  reset() {
    const { bT, bS, bB, Bh, d } = this;
    bT.set(this.ground0); bS.fill(NEG); bB.fill(NEG);
    this.mann.set(this.mann0); this.erod.set(this.erod0);
    this.rasterStructs();
    for (const b of this.bld) {
      b.hp = 100; b.state = 0; b.peakDepth = 0; b.peakSpeed = 0; b.load = 0; b.peakLoad = 0; b.dmgInt = 0;
      for (const c of b.cells) { bB[c] = b.top; this.erod[c] = 0; }
    }
    for (let c = 0; c < N; c++) {
      const h = Math.max(bT[c], bS[c], bB[c]);
      Bh[c] = h;
      this.solid[c] = h > bT[c] + 0.05 ? 1 : 0;
      d[c] = h < 0 ? -h : 0;
    }
    this.qx.fill(0); this.qy.fill(0); this.K.fill(1);
    this.uc.fill(0); this.vc.fill(0); this.spd.fill(0);
    this.foam.fill(0); this.wet.fill(0); this.peak.fill(0); this.flooded.fill(0);
    let lc = 0; for (let c = 0; c < N; c++) if (this.land[c] && !this.solid[c]) lc++;
    this.nearSolid.fill(0);
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) { const c = j * NX + i; if (this.solid[c + 1] || this.solid[c - 1] || this.solid[c + NX] || this.solid[c - NX]) this.nearSolid[c] = 1; }
    this.landCount = lc;
    this.phase = 'idle'; this.t = 0; this.intensity = null;
    this.maxDepth = 0; this.floodedCount = 0; this.erodedVol = 0; this.maxScour = 0;
    this.landWet = 0; this.peakLandWet = 0; this.landMaxSpeed = 0; this.calmT = 0;
    this.frontZ = W.ZMIN; this.maxEta = 0; this.status = 'Calm';
    this.terrainDirty = true; this.events.length = 0; this.stepCount = 0;
  }

  launch(key) {
    const w = W.WAVES[key];
    this.phase = 'running'; this.intensity = key; this.t = 0;
    const { d, qy } = this;
    for (let j = 0; j < NY - 1; j++) {
      const z = W.cellZ(j);
      for (let i = 0; i < NX; i++) {
        const x = W.cellX(i);
        const z0 = -27 + 1.2 * Math.sin(x * 0.07 + 0.4);
        const mod = 1 + 0.1 * Math.sin(x * 0.11 + 1.3) + 0.06 * Math.sin(x * 0.27 + 0.2);
        const q = (z - z0) / w.L;
        if (q > 3 || q < -3) continue;
        const c = j * NX + i;
        const eta = w.A * mod * Math.exp(-q * q);
        const h0 = d[c], h1 = h0 + eta;
        d[c] = h1;
        qy[c] = h1 * 2 * (Math.sqrt(G * h1) - Math.sqrt(G * Math.max(h0, 0.01)));
      }
    }
  }

  // ------------------------------------------------------------ solver step
  step(dt) {
    const { Bh, d, qx, qy, mann, K, sponge } = this;
    const g = G * dt;
    const damp = dt;
    // 1. discharge update on faces
    for (let j = 0; j < NY; j++) {
      const row = j * NX;
      for (let i = 0; i < NX; i++) {
        const a = row + i;
        if (i < NX - 1) {
          const b = a + 1;
          const ba = Bh[a], bb = Bh[b];
          const sa = ba + d[a], sb = bb + d[b];
          const hf = (sa > sb ? sa : sb) - (ba > bb ? ba : bb);
          if (hf <= HMIN) qx[a] = 0;
          else {
            const q = qx[a];
            const n = 0.5 * (mann[a] + mann[b]);
            const den = 1 + g * n * n * Math.abs(q) / (hf * hf * cb(hf));
            let qn = (q - g * hf * (sb - sa) * INV_DX) / den;
            const lim = hf * VMAX;
            qx[a] = qn > lim ? lim : qn < -lim ? -lim : qn;
          }
        }
        if (j < NY - 1) {
          const b = a + NX;
          const ba = Bh[a], bb = Bh[b];
          const sa = ba + d[a], sb = bb + d[b];
          const hf = (sa > sb ? sa : sb) - (ba > bb ? ba : bb);
          if (hf <= HMIN) qy[a] = 0;
          else {
            const q = qy[a];
            const n = 0.5 * (mann[a] + mann[b]);
            const den = 1 + g * n * n * Math.abs(q) / (hf * hf * cb(hf));
            let qn = (q - g * hf * (sb - sa) * INV_DX) / den;
            const lim = hf * VMAX;
            qy[a] = qn > lim ? lim : qn < -lim ? -lim : qn;
          }
        }
        if (j < SPONGE_ROWS) { const sp = 1 - Math.min(0.95, sponge[a] * 5 * damp); qx[a] *= sp; qy[a] *= sp; }
      }
    }
    // 2. limit outflow to available water
    const k = dt * INV_DX;
    for (let j = 0; j < NY; j++) {
      const row = j * NX;
      for (let i = 0; i < NX; i++) {
        const c = row + i;
        const dd0 = d[c];
        if (dd0 === 0) { K[c] = 1; continue; }
        let out = 0;
        if (i < NX - 1) { const q = qx[c]; if (q > 0) out += q; }
        if (i > 0) { const q = qx[c - 1]; if (q < 0) out -= q; }
        if (j < NY - 1) { const q = qy[c]; if (q > 0) out += q; }
        if (j > 0) { const q = qy[c - NX]; if (q < 0) out -= q; }
        const vol = out * k;
        K[c] = vol > dd0 ? dd0 / vol : 1;
      }
    }
    // 3. scale fluxes (consistently for both neighbouring cells) and update depths (continuity)
    const land = this.land;
    for (let j = 0; j < NY; j++) {
      const row = j * NX;
      for (let i = 0; i < NX; i++) {
        const c = row + i;
        let dd = d[c];
        let net = 0;
        if (i > 0) net += qx[c - 1];
        if (j > 0) net += qy[c - NX];
        if (i < NX - 1) { const q = qx[c]; if (q !== 0) { const qs = q > 0 ? q * K[c] : q * K[c + 1]; qx[c] = qs; net -= qs; } }
        if (j < NY - 1) { const q = qy[c]; if (q !== 0) { const qs = q > 0 ? q * K[c] : q * K[c + NX]; qy[c] = qs; net -= qs; } }
        dd += k * net;
        if (land[c] && dd > 0) dd = dd > INFIL * dt ? dd - INFIL * dt : 0;
        if (j < SPONGE_ROWS) { const tgt = Bh[c] < 0 ? -Bh[c] : 0; dd += (tgt - dd) * Math.min(1, sponge[c] * 2.5 * dt); }
        d[c] = dd < 1e-5 ? 0 : dd;
      }
    }
    this.t += dt; this.stepCount++;
  }

  // ------------------------------------------------- per-frame derived fields
  updateFields(dt) {
    const { d, qx, qy, uc, vc, spd, Bh, foam, tmp, wet, peak, land, solid, flooded } = this;
    let landWet = 0, landMax = 0, maxDepth = this.maxDepth, newFlooded = 0;
    // velocities
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i, dd = d[c];
      if (dd > 0.02) {
        const ql = i > 0 ? qx[c - 1] : 0, qr = i < NX - 1 ? qx[c] : 0;
        const qd = j > 0 ? qy[c - NX] : 0, qu = j < NY - 1 ? qy[c] : 0;
        const de = dd < 0.08 ? 0.08 : dd;
        let u = 0.5 * (ql + qr) / de, v = 0.5 * (qd + qu) / de;
        const s2 = u * u + v * v;
        if (s2 > VMAX * VMAX) { const f = VMAX / Math.sqrt(s2); u *= f; v *= f; }
        uc[c] = u; vc[c] = v; spd[c] = Math.sqrt(u * u + v * v);
      } else { uc[c] = 0; vc[c] = 0; spd[c] = 0; }
    }
    // foam: generated at steep, fast fronts and against obstacles; advected with the flow
    const decay = Math.exp(-dt * 0.8), fast = Math.exp(-dt * 3);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i, dd = d[c];
      if (dd < 0.03) { tmp[c] = foam[c] > 0.001 ? foam[c] * fast * 0.9 : 0; continue; }
      const s = spd[c];
      if (s < 0.1 && foam[c] < 0.002) { tmp[c] = 0; continue; }
      // semi-Lagrangian advection
      let fx = i - uc[c] * dt * INV_DX, fy = j - vc[c] * dt * INV_DX;
      fx = fx < 0 ? 0 : fx > NX - 1.001 ? NX - 1.001 : fx; fy = fy < 0 ? 0 : fy > NY - 1.001 ? NY - 1.001 : fy;
      const i0 = fx | 0, j0 = fy | 0, tx = fx - i0, ty = fy - j0, c0 = j0 * NX + i0;
      let fo = (foam[c0] * (1 - tx) + foam[c0 + 1] * tx) * (1 - ty) + (foam[c0 + NX] * (1 - tx) + foam[c0 + NX + 1] * tx) * ty;
      fo *= dd < 0.12 ? fast : decay;
      let gen = 0;
      if (i > 0 && j > 0 && i < NX - 1 && j < NY - 1 && s > 0.3) {
        const H = Bh[c] + dd;
        const hE = d[c + 1] > 0.02 ? Bh[c + 1] + d[c + 1] : H, hW = d[c - 1] > 0.02 ? Bh[c - 1] + d[c - 1] : H;
        const hN = d[c + NX] > 0.02 ? Bh[c + NX] + d[c + NX] : H, hS = d[c - NX] > 0.02 ? Bh[c - NX] + d[c - NX] : H;
        const gx = (hE - hW) * 0.5 * INV_DX, gz = (hN - hS) * 0.5 * INV_DX;
        const grad = Math.sqrt(gx * gx + gz * gz);
        gen += Math.min(1, Math.max(0, (grad - 0.22) * 2.0)) * Math.min(1, s * 0.4) * 0.8;
        const fr = s / Math.sqrt(G * dd);
        gen += Math.min(1, Math.max(0, (fr - 0.85) * 1.4)) * 0.55 * W.smooth(0.3, 1.2, dd);
        if (solid[c + 1] || solid[c - 1] || solid[c + NX] || solid[c - NX]) gen += Math.min(1, Math.max(0, (s - 1.2) * 0.35)) * 0.9;
      }
      fo += gen * dt * 3.2;
      tmp[c] = fo > 1 ? 1 : fo;
    }
    foam.set(tmp);
    // wetness, peak depth, land stats
    const wdecay = Math.exp(-dt / 50);
    for (let c = 0; c < N; c++) {
      const dd = d[c];
      wet[c] = dd > 0.03 ? 1 : wet[c] * wdecay;
      if (land[c] && !solid[c]) {
        if (dd > peak[c]) peak[c] = dd;
        if (dd > 0.1) { landWet++; if (spd[c] > landMax) landMax = spd[c]; }
        if (peak[c] > 0.15 && !flooded[c]) { flooded[c] = 1; newFlooded++; }
        if (dd > maxDepth && !this.nearSolid[c]) maxDepth = dd;
      }
    }
    this.maxDepth = maxDepth; this.floodedCount += newFlooded;
    this.landWet = landWet; this.landMaxSpeed = landMax;
    if (landWet > this.peakLandWet) this.peakLandWet = landWet;
    // wave front position (row with the largest momentum flux) for the follow-camera
    let best = 0, bj = -1, maxEta = 0;
    for (let j = 10; j < NY - 2; j++) {
      let m = 0;
      for (let i = 4; i < NX - 4; i += 2) { const c = j * NX + i; if (d[c] > 0.15) { const e = spd[c] * spd[c] * d[c]; m += e; const eta = Bh[c] + d[c]; if (eta > maxEta && Bh[c] < 0.3) maxEta = eta; } }
      if (m > best) { best = m; bj = j; }
    }
    if (bj >= 0 && best > 20) this.frontZ += (W.cellZ(bj) - this.frontZ) * 0.15;
    this.maxEta = maxEta;
  }

  updateErosion(dt) {
    const { d, spd, uc, vc, erod, bT, bS, bB, Bh, ground0, solid } = this;
    const TAU = 3.2, KE = 0.013, MAXCUT = 1.1;
    let dirty = false;
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const c = j * NX + i;
      const e = erod[c];
      if (e <= 0 || d[c] < 0.05 || solid[c]) continue;
      const s = spd[c], ex = s * s - TAU;
      if (ex <= 0) continue;
      const cut0 = ground0[c] - bT[c];
      let dz = KE * ex * e * Math.min(1, d[c] / 0.35) * dt;
      dz = Math.min(dz, MAXCUT - cut0);
      if (dz <= 0) continue;
      bT[c] -= dz; this.erodedVol += dz * DX * DX;
      const cut = cut0 + dz; if (cut > this.maxScour) this.maxScour = cut;
      Bh[c] = Math.max(bT[c], bS[c], bB[c]);
      // deposit part of the sediment slightly downstream, where the flow is weaker
      const ni = i + Math.round(uc[c] / s), nj = j + Math.round(vc[c] / s);
      const n = nj * NX + ni;
      if (n !== c && erod[n] > 0 && !solid[n] && spd[n] < s * 0.85 && bT[n] < ground0[n] + 0.45) {
        bT[n] += dz * 0.4; Bh[n] = Math.max(bT[n], bS[n], bB[n]);
      }
      dirty = true;
    }
    if (dirty) this.terrainDirty = true;
  }

  updateBuildings(dt) {
    const { d, spd } = this;
    for (const b of this.bld) {
      if (b.state === 2) continue;
      let mMax = 0, mSum = 0, hMax = 0, sMax = 0;
      const ring = b.ring;
      for (let k = 0; k < ring.length; k++) {
        const c = ring[k], dd = d[c];
        if (dd < 0.05) continue;
        const s = spd[c], m = dd * s * s;
        mSum += m; if (m > mMax) mMax = m; if (dd > hMax) hMax = dd; if (s > sMax) sMax = s;
      }
      if (hMax > b.peakDepth) b.peakDepth = hMax;
      if (sMax > b.peakSpeed) b.peakSpeed = sMax;
      const load = 0.35 * mMax + 0.35 * (mSum / ring.length) * 4 + 0.22 * G * hMax * hMax;
      b.load = load; if (load > b.peakLoad) b.peakLoad = load;
      const excess = load - b.cap;
      if (excess > 0) {
        b.hp -= excess * DMG_RATE * dt; b.dmgInt = (b.dmgInt || 0) + excess * dt;
        if (b.hp < 62 && b.state === 0) { b.state = 1; this.events.push({ type: 'damaged', id: b.id }); }
        if (b.hp <= 0) this.destroy(b);
      }
    }
  }

  destroy(b) {
    b.hp = 0; b.state = 2;
    for (const c of b.cells) {
      this.bB[c] = this.bT[c] + 0.3;
      this.Bh[c] = Math.max(this.bT[c], this.bS[c], this.bB[c]);
      this.solid[c] = this.Bh[c] > this.bT[c] + 0.05 ? 1 : 0;
    }
    this.events.push({ type: 'destroyed', id: b.id });
  }

  update(dt) { // once per rendered frame, dt = simulated seconds advanced this frame
    if (dt <= 0) return;
    this.updateFields(dt);
    if (this.phase !== 'idle') {
      this.updateErosion(dt);
      this.updateBuildings(dt);
      // status / completion
      if (this.phase === 'running') {
        const quiet = this.landMaxSpeed < 0.5 || (this.peakLandWet > 0 && this.landWet < this.peakLandWet * 0.06);
        if (quiet && this.t > 20) this.calmT += dt; else this.calmT = 0;
        if (this.t > 20 && this.calmT > 2.5) this.phase = 'complete';
        else if (this.t > 90) this.phase = 'complete';
      }
      if (this.phase === 'complete') this.status = 'Complete';
      else if (this.peakLandWet === 0) this.status = this.frontZ > W.ZMIN + 20 && this.t > 1 ? 'Wave reaching shore' : 'Wave approaching';
      else if (this.landWet < this.peakLandWet * 0.85 && this.t > 12) this.status = 'Receding';
      else this.status = 'Inundation';
    }
  }

  counts() {
    let dam = 0, des = 0;
    for (const b of this.bld) { if (b.state === 1) dam++; else if (b.state === 2) des++; }
    return { damaged: dam, destroyed: des, total: this.bld.length };
  }
  metrics() {
    return {
      maxDepth: this.maxDepth,
      floodedArea: this.floodedCount * DX * DX,
      floodedPct: (100 * this.floodedCount) / Math.max(1, this.landCount),
      erosion: this.erodedVol,
      maxScour: this.maxScour,
      ...this.counts(),
    };
  }
}
