/* ------------------------------------------------------------------
 * Shallow-water height-field solver (CPU, staggered grid, explicit).
 *
 *  h[k]   water depth at cell centre (m)
 *  u[k]   x-velocity on the face between cell (i, j) and (i+1, j)
 *  v[k]   z-velocity on the face between cell (i, j) and (i, j+1)
 *  bed[k] erodible terrain elevation (m, sea level = 0)
 *  crest[k] absolute elevation of a solid structure/building, or NONE
 *  drag[k] extra quadratic drag (porous breakwaters, rough embankments)
 *
 *  Effective bottom b = max(bed, crest).  Free surface eta = b + h.
 *  Momentum: du/dt = -u·∇u - g ∂eta/∂x - friction
 *  Mass:     dh/dt = -∇·(h_upwind · u)     with outflow limiting so h ≥ 0.
 * ------------------------------------------------------------------ */
'use strict';

const SIM_NONE = -1e9;

class ShallowWaterSim {
  constructor(N, M, dx) {
    this.N = N; this.M = M; this.dx = dx; this.size = N * M;
    const S = this.size;
    this.g = 9.81;
    this.seaLevel = 0;
    this.bed = new Float32Array(S);
    this.bed0 = new Float32Array(S);
    this.crest = new Float32Array(S).fill(SIM_NONE);
    this.drag = new Float32Array(S);
    this.erod = new Float32Array(S);
    this.h = new Float32Array(S);
    this.u = new Float32Array(S);
    this.v = new Float32Array(S);
    this.un = new Float32Array(S);
    this.vn = new Float32Array(S);
    this.fx = new Float32Array(S);
    this.fz = new Float32Array(S);
    this.scale = new Float32Array(S);
    this.wet = new Float32Array(S);
    this.foam = new Float32Array(S);
    this.speed = new Float32Array(S);   // cell-centre speed magnitude (diagnostic)
    this.b = new Float32Array(S);       // effective bottom cache
    this.time = 0;
    this.erodedVolume = 0;
    this.maxCut = 0;
    this.spongeRows = 7;
    this.cfBase = 0.0035;      // base bottom friction
    this.eps = 1e-3;
    this.maxSpeed = 22;
    this.critSpeed2 = 3.2 * 3.2;
    this.erosionRate = 0.0014;
    this.seepage = 0.02;        // m/s of water lost to infiltration on land
    this.maxErosionDepth = 3.0;
  }

  idx(i, j) { return j * this.N + i; }

  /* Restore calm sea. Terrain returns to the original profile. */
  resetWater() {
    const S = this.size;
    this.bed.set(this.bed0);
    this.updateBottom();
    for (let k = 0; k < S; k++) {
      this.h[k] = Math.max(0, this.seaLevel - this.b[k]);
      this.u[k] = 0; this.v[k] = 0; this.wet[k] = 0; this.foam[k] = 0; this.speed[k] = 0;
    }
    this.time = 0;
    this.erodedVolume = 0;
    this.maxCut = 0;
    this.waveActive = false; this.waveA = 0;
  }

  updateBottom() {
    const b = this.b, bed = this.bed, crest = this.crest;
    for (let k = 0; k < this.size; k++) b[k] = bed[k] > crest[k] ? bed[k] : crest[k];
  }

  /* Start the offshore wave maker: the open boundary is driven with a
   * positive half-sine surface elevation of amplitude A over duration T,
   * i.e. a long wave with the matching shoreward velocity. */
  launchWave(A, T, worldX) {
    this.waveA = A; this.waveT = T; this.waveT0 = this.time; this.waveActive = true;
    if (!this.lateral) {
      this.lateral = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) { const x = worldX(i); this.lateral[i] = 1 + 0.08 * Math.sin(x / 23 + 0.7) + 0.05 * Math.sin(x / 9.3 + 2.1); }
    }
  }

  step(dt) {
    const N = this.N, M = this.M, S = this.size, dx = this.dx, g = this.g, eps = this.eps;
    const h = this.h, u = this.u, v = this.v, un = this.un, vn = this.vn, b = this.b;
    const drag = this.drag, fx = this.fx, fz = this.fz, sc = this.scale;
    const cfBase = this.cfBase, maxSpeed = this.maxSpeed;
    const gdt = g * dt / dx;

    this.updateBottom();

    /* ---------- momentum: x faces ---------- */
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N - 1; i++) {
        const k = j * N + i, kr = k + 1;
        const hl = h[k], hr = h[kr];
        if (hl <= eps && hr <= eps) { un[k] = 0; continue; }
        const bl = b[k], br = b[kr];
        const etal = bl + hl, etar = br + hr;
        // dry cell whose ground is higher than the neighbour's surface acts as a wall
        if (hl <= eps && bl >= etar) { un[k] = 0; continue; }
        if (hr <= eps && br >= etal) { un[k] = 0; continue; }
        let uc = u[k];
        // self advection (upwind)
        let adv = 0;
        if (uc > 0) { if (i > 0) adv += uc * (uc - u[k - 1]); }
        else if (i < N - 2) adv += uc * (u[k + 1] - uc);
        // cross advection by v (average of the four surrounding v faces)
        let va = 0, cnt = 0;
        if (j < M - 1) { va += v[k] + v[kr]; cnt += 2; }
        if (j > 0) { va += v[k - N] + v[kr - N]; cnt += 2; }
        if (cnt) va /= cnt;
        if (va > 0) { if (j > 0) adv += va * (uc - u[k - N]); }
        else if (j < M - 1) adv += va * (u[k + N] - uc);
        uc -= dt * adv / dx;
        // pressure gradient
        uc -= gdt * (etar - etal);
        // friction
        const hf = Math.max(0.5 * (hl + hr), 0.05);
        const cd = cfBase + 0.5 * (drag[k] + drag[kr]);
        uc /= 1 + dt * cd * Math.abs(uc) / hf;
        if (uc > maxSpeed) uc = maxSpeed; else if (uc < -maxSpeed) uc = -maxSpeed;
        un[k] = uc;
      }
      un[j * N + N - 1] = 0;
    }

    /* ---------- momentum: z faces ---------- */
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, kd = k + N;
        const hl = h[k], hr = h[kd];
        if (hl <= eps && hr <= eps) { vn[k] = 0; continue; }
        const bl = b[k], br = b[kd];
        const etal = bl + hl, etar = br + hr;
        if (hl <= eps && bl >= etar) { vn[k] = 0; continue; }
        if (hr <= eps && br >= etal) { vn[k] = 0; continue; }
        let vc = v[k];
        let adv = 0;
        if (vc > 0) { if (j > 0) adv += vc * (vc - v[k - N]); }
        else if (j < M - 2) adv += vc * (v[k + N] - vc);
        let ua = 0, cnt = 0;
        if (i < N - 1) { ua += u[k] + u[kd]; cnt += 2; }
        if (i > 0) { ua += u[k - 1] + u[kd - 1]; cnt += 2; }
        if (cnt) ua /= cnt;
        if (ua > 0) { if (i > 0) adv += ua * (vc - v[k - 1]); }
        else if (i < N - 1) adv += ua * (v[k + 1] - vc);
        vc -= dt * adv / dx;
        vc -= gdt * (etar - etal);
        const hf = Math.max(0.5 * (hl + hr), 0.05);
        const cd = cfBase + 0.5 * (drag[k] + drag[kd]);
        vc /= 1 + dt * cd * Math.abs(vc) / hf;
        if (vc > maxSpeed) vc = maxSpeed; else if (vc < -maxSpeed) vc = -maxSpeed;
        vn[k] = vc;
      }
    }
    for (let i = 0; i < N; i++) vn[(M - 1) * N + i] = 0;
    this.u = un; this.un = u;
    this.v = vn; this.vn = v;
    const U = this.u, V = this.v;

    /* ---------- fluxes (upwind depth) ---------- */
    for (let k = 0; k < S; k++) {
      const uu = U[k];
      fx[k] = uu > 0 ? uu * h[k] : uu * ((k + 1) % N === 0 ? 0 : h[k + 1]);
      const vv = V[k];
      fz[k] = vv > 0 ? vv * h[k] : (k + N < S ? vv * h[k + N] : 0);
    }
    /* outflow limiter: a cell cannot lose more water than it holds */
    const r = dt / dx;
    for (let k = 0; k < S; k++) {
      let out = 0;
      if (fx[k] > 0) out += fx[k];
      if (fz[k] > 0) out += fz[k];
      if (k % N !== 0 && fx[k - 1] < 0) out -= fx[k - 1];
      if (k >= N && fz[k - N] < 0) out -= fz[k - N];
      out *= r;
      sc[k] = out > h[k] && out > 0 ? h[k] / out : 1;
    }
    for (let k = 0; k < S; k++) {
      // scale each face flux by the factor of the cell it drains
      const f = fx[k];
      if (f > 0) fx[k] = f * sc[k]; else if (f < 0 && (k + 1) % N !== 0) fx[k] = f * sc[k + 1];
      const q = fz[k];
      if (q > 0) fz[k] = q * sc[k]; else if (q < 0 && k + N < S) fz[k] = q * sc[k + N];
    }
    /* ---------- continuity ---------- */
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let div = fx[k] + fz[k];
        if (i > 0) div -= fx[k - 1];
        if (j > 0) div -= fz[k - N];
        let hn = h[k] - r * div;
        if (hn < 0) hn = 0;
        h[k] = hn;
      }
    }

    /* ---------- offshore sponge (open boundary) ---------- */
    const sp = this.spongeRows, sea = this.seaLevel;
    let etaW = 0;
    if (this.waveActive) {
      const tw = this.time - this.waveT0;
      if (tw >= this.waveT) this.waveActive = false;
      else etaW = this.waveA * Math.sin(Math.PI * tw / this.waveT);
    }
    const lat = this.lateral;
    for (let j = 0; j < sp; j++) {
      const w = (1 - j / sp);
      const relax = j < 2 ? 1 : Math.min(1, dt * 3.0 * w * w);
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const eta = etaW * (lat ? lat[i] : 1);
        const d = sea - b[k];
        const target = Math.max(0, d + eta);
        const vT = d > 0.5 ? eta * Math.sqrt(g / d) : 0;
        h[k] += (target - h[k]) * relax;
        U[k] *= 1 - relax; V[k] += (vT - V[k]) * relax;
      }
    }

    /* ---------- diagnostics, erosion, wetness, foam ---------- */
    const bed = this.bed, bed0 = this.bed0, crest = this.crest, erod = this.erod;
    const wet = this.wet, foam = this.foam, speed = this.speed;
    const foamDecay = Math.max(0, 1 - 1.4 * dt), wetDecay = Math.max(0, 1 - 0.02 * dt);
    const cellArea = dx * dx, erosionRate = this.erosionRate, crit2 = this.critSpeed2, maxCutDepth = this.maxErosionDepth;
    let eroded = 0, maxCut = this.maxCut;
    const seep = this.seepage * dt;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let hk = h[k];
        if (hk <= eps) { speed[k] = 0; wet[k] *= wetDecay; foam[k] *= foamDecay; continue; }
        if (bed0[k] > 0.35) { hk = Math.max(0, hk - seep); h[k] = hk; }
        let uc = 0, vc = 0;
        if (hk > eps) {
          uc = 0.5 * (U[k] + (i > 0 ? U[k - 1] : 0));
          vc = 0.5 * (V[k] + (j > 0 ? V[k - N] : 0));
        }
        const s2 = uc * uc + vc * vc;
        const s = Math.sqrt(s2);
        speed[k] = s;
        // wetness memory
        if (hk > 0.03) wet[k] = 1; else wet[k] *= wetDecay;
        // foam: breaking / fast shallow flow / convergence / obstacles
        let gen = 0;
        if (hk > 0.02) {
          const shallow = Math.max(0, 1 - hk / 6);
          gen += Math.max(0, s - 2.5) * 0.35 * (0.4 + shallow);
          if (i > 0 && i < N - 1 && j > 0 && j < M - 1) {
            const divg = (U[k] - U[k - 1] + V[k] - V[k - N]) / dx;
            if (divg < -0.35) gen += (-divg - 0.35) * 0.8;
            // adjacent to a structure or wall
            if (s > 1.2 && (crest[k + 1] > b[k] + 0.5 || crest[k - 1] > b[k] + 0.5 || crest[k + N] > b[k] + 0.5 || crest[k - N] > b[k] + 0.5)) gen += 0.6 + s * 0.15;
          }
        }
        const f = foam[k] * foamDecay;
        foam[k] = gen > f ? Math.min(1, f + Math.min(1, gen) * dt * 6) : f;
        // erosion of unprotected sediment
        const er = erod[k];
        if (er > 0 && crest[k] <= SIM_NONE + 1 && hk > 0.05 && s2 > crit2) {
          let cut = er * erosionRate * (s2 - crit2) * dt;
          // thin sheets carry less sediment than deep fast flow
          cut *= Math.min(1, 0.35 + hk * 0.45);
          const floor = bed0[k] - maxCutDepth;
          let nb = bed[k] - cut;
          if (nb < floor) { cut = Math.max(0, bed[k] - floor); nb = floor; }
          if (cut > 0) {
            bed[k] = nb;
            b[k] = nb > crest[k] ? nb : crest[k];
            h[k] += cut;                    // surface stays put as the bed drops
            eroded += cut * cellArea;
            const c = bed0[k] - nb;
            if (c > maxCut) maxCut = c;
          }
        }
      }
    }
    this.erodedVolume += eroded;
    this.maxCut = maxCut;
    this.time += dt;
  }

  /* Sample surface elevation and velocity at an arbitrary world position (bilinear-ish, nearest cell). */
  sampleCell(i, j) {
    i = i < 0 ? 0 : i >= this.N ? this.N - 1 : i;
    j = j < 0 ? 0 : j >= this.M ? this.M - 1 : j;
    const k = j * this.N + i;
    const uc = 0.5 * (this.u[k] + (i > 0 ? this.u[k - 1] : 0));
    const vc = 0.5 * (this.v[k] + (j > 0 ? this.v[k - this.N] : 0));
    return { k, h: this.h[k], b: this.b[k], u: uc, v: vc };
  }
}
