// Effects driven by the simulation: spray/dust particles, floating debris, flow arrows.
import * as THREE from 'three';
import * as W from './world.js';
import { NX, NY, DX } from './world.js';

// ---------------------------------------------------------------- particles (spray & dust)
export class Particles {
  constructor(scene, max = 3000) {
    this.max = max; this.head = 0; this.count = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max); this.grow = new Float32Array(max); this.size0 = new Float32Array(max);
    this.col0 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 500 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = aSize * uScale / max(0.1, -mv.z); }`,
      fragmentShader: `varying vec4 vC;
        void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p)*2.0; float a = (1.0 - smoothstep(0.35, 1.0, r)) * vC.a; if (a < 0.01) discard;
          gl_FragColor = vec4(vC.rgb, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 5;
    scene.add(this.points);
    this.life.fill(0);
  }
  emit(x, y, z, vx, vy, vz, life, size, r, g, b, a = 0.9, drag = 0.4, grow = 0) {
    const k = this.head; this.head = (this.head + 1) % this.max;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.life[k] = life; this.maxLife[k] = life; this.size0[k] = size; this.size[k] = size;
    this.col[k * 4] = r; this.col[k * 4 + 1] = g; this.col[k * 4 + 2] = b; this.col[k * 4 + 3] = a; this.col0[k] = a;
    this.drag[k] = drag; this.grow[k] = grow;
  }
  update(dt) {
    if (dt <= 0) return;
    const { pos, vel, col, life, maxLife, drag, size, size0, grow, col0 } = this;
    for (let k = 0; k < this.max; k++) {
      if (life[k] <= 0) { col[k * 4 + 3] = 0; continue; }
      life[k] -= dt;
      const f = Math.max(0, life[k] / maxLife[k]);
      const dr = Math.exp(-drag[k] * dt);
      vel[k * 3] *= dr; vel[k * 3 + 2] *= dr; vel[k * 3 + 1] = (vel[k * 3 + 1] - 6.5 * dt * (grow[k] > 0 ? 0.05 : 1)) * (grow[k] > 0 ? dr : 1);
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      col[k * 4 + 3] = col0[k] * Math.min(1, f * 2.2) * (grow[k] > 0 ? f : 1);
      size[k] = size0[k] * (1 + grow[k] * (1 - f));
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
  clear() { this.life.fill(0); this.col.fill(0); this.geo.attributes.aColor.needsUpdate = true; }
  setViewport(h, fov) { this.mat.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360)); }
}

// spray + dust emitters driven by simulation state
export function emitSpray(sim, parts, dtSim, budget = 40) {
  if (dtSim <= 0) return;
  const { d, spd, foam, uc, vc, Bh, solid } = sim;
  let n = 0;
  const tries = 500;
  for (let t = 0; t < tries && n < budget; t++) {
    const c = (Math.random() * NX * NY) | 0;
    const f = foam[c], s = spd[c];
    if (f < 0.55 || s < 2.6 || d[c] < 0.15) continue;
    const i = c % NX, j = (c / NX) | 0;
    const near = (i > 0 && solid[c - 1]) || (i < NX - 1 && solid[c + 1]) || (j > 0 && solid[c - NX]) || (j < NY - 1 && solid[c + NX]);
    if (!near && Math.random() > 0.3 + f * 0.25) continue;
    const x = W.cellX(i) + (Math.random() - 0.5) * DX, z = W.cellZ(j) + (Math.random() - 0.5) * DX;
    const y = Bh[c] + d[c];
    const up = 2 + Math.random() * (near ? 6 : 3.5) * Math.min(1.6, s * 0.3);
    parts.emit(x, y + 0.1, z, uc[c] * 0.5 + (Math.random() - 0.5) * 1.6, up, vc[c] * 0.5 + (Math.random() - 0.5) * 1.6, 0.9 + Math.random() * 0.8, 0.28 + Math.random() * 0.34, 0.92, 0.96, 1.0, 0.75, 0.5, 0.2);
    n++;
  }
}
export function emitDust(parts, x, y, z, w, d, h, n = 34) {
  for (let k = 0; k < n; k++) {
    const g = 0.55 + Math.random() * 0.15;
    parts.emit(x + (Math.random() - 0.5) * w, y + Math.random() * h * 0.6, z + (Math.random() - 0.5) * d,
      (Math.random() - 0.5) * 3.2, 1 + Math.random() * 2.4, (Math.random() - 0.5) * 3.2, 1.6 + Math.random() * 1.4, 1.1 + Math.random() * 1.2, g, g * 0.94, g * 0.86, 0.55, 1.2, 1.6);
  }
}

// ---------------------------------------------------------------- debris
export class Debris {
  constructor(scene, max = 170) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9 }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.items = [];
    for (let k = 0; k < max; k++) this.items.push({ on: false, x: 0, z: 0, vx: 0, vz: 0, sx: 1, sy: 1, sz: 1, rx: 0, ry: 0, rz: 0, spin: 0, y: 0 });
    this.next = 0;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.p = new THREE.Vector3(); this.s = new THREE.Vector3();
    this.color = new THREE.Color();
    this.hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < max; k++) { this.mesh.setMatrixAt(k, this.hide); this.mesh.setColorAt(k, this.color.set(0xffffff)); }
    scene.add(this.mesh);
  }
  spawn(x, z, sx, sy, sz, hex, vx = 0, vz = 0) {
    const k = this.next; this.next = (this.next + 1) % this.max;
    Object.assign(this.items[k], { on: true, x, z, vx, vz, sx, sy, sz, rx: (Math.random() - 0.5) * 0.4, ry: Math.random() * 6.28, rz: (Math.random() - 0.5) * 0.4, spin: (Math.random() - 0.5) * 2, y: 0 });
    this.mesh.setColorAt(k, this.color.set(hex));
    this.mesh.instanceColor.needsUpdate = true;
  }
  spawnFromBuilding(spec, kind) {
    const n = Math.min(22, Math.round(9 + spec.w * spec.d * 0.35));
    const cols = [kind.color, kind.roof, 0x7a6a5a, kind.roof, 0xd6cfc0];
    for (let k = 0; k < n; k++) {
      const long = Math.random() < 0.3;
      this.spawn(spec.x + (Math.random() - 0.5) * spec.w * 0.9, spec.z + (Math.random() - 0.5) * spec.d * 0.9,
        long ? 1.6 + Math.random() * 1.6 : 0.5 + Math.random() * 0.9, 0.18 + Math.random() * 0.3, long ? 0.3 + Math.random() * 0.3 : 0.5 + Math.random() * 0.9,
        cols[(Math.random() * cols.length) | 0], (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
    }
  }
  clear() {
    for (let k = 0; k < this.max; k++) { this.items[k].on = false; this.mesh.setMatrixAt(k, this.hide); }
    this.mesh.instanceMatrix.needsUpdate = true; this.next = 0;
  }
  update(dt, sim) {
    if (dt <= 0) return;
    const { d, Bh, bT, uc, vc } = sim;
    for (let k = 0; k < this.max; k++) {
      const it = this.items[k];
      if (!it.on) continue;
      let i = Math.floor((it.x - W.XMIN) / DX), j = Math.floor((it.z - W.ZMIN) / DX);
      if (i < 1 || j < 1 || i > NX - 2 || j > NY - 2) { it.on = false; this.mesh.setMatrixAt(k, this.hide); continue; }
      const c = j * NX + i, dd = d[c];
      const surf = Bh[c] + dd;
      if (dd > 0.1) {
        const k1 = Math.min(1, dt * 2.4);
        it.vx += (uc[c] * 0.9 - it.vx) * k1; it.vz += (vc[c] * 0.9 - it.vz) * k1;
        it.rx += Math.sin(performance.now() * 0.002 + k) * 0.002; it.ry += it.spin * dt * (0.3 + Math.hypot(it.vx, it.vz) * 0.1);
        it.y += ((surf + it.sy * 0.3) - it.y) * Math.min(1, dt * 8);
      } else {
        const fr = Math.exp(-dt * 3.5); it.vx *= fr; it.vz *= fr;
        it.y += ((Bh[c] + it.sy * 0.5) - it.y) * Math.min(1, dt * 10);
      }
      // move with simple obstacle collision against buildings / defenses
      let nx = it.x + it.vx * dt, nz = it.z + it.vz * dt;
      const lim = Math.max(surf, Bh[c] + 0.4) + 0.05;
      const blocked = (px, pz) => { const ii = Math.floor((px - W.XMIN) / DX), jj = Math.floor((pz - W.ZMIN) / DX); if (ii < 1 || jj < 1 || ii > NX - 2 || jj > NY - 2) return true; return Bh[jj * NX + ii] > lim; };
      if (blocked(nx, it.z)) { it.vx *= -0.3; nx = it.x; }
      if (blocked(it.x, nz)) { it.vz *= -0.3; nz = it.z; }
      it.x = nx; it.z = nz;
      if (it.y === 0) it.y = surf;
      this.e.set(it.rx, it.ry, it.rz);
      this.q.setFromEuler(this.e);
      this.p.set(it.x, it.y, it.z); this.s.set(it.sx, it.sy, it.sz);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- flow arrows
const RAMP = [[0.0, [0.16, 0.36, 0.95]], [0.25, [0.1, 0.82, 0.95]], [0.5, [0.55, 0.95, 0.4]], [0.75, [1.0, 0.85, 0.25]], [1.0, [1.0, 0.28, 0.16]]];
export function rampColor(t, out) {
  t = Math.max(0, Math.min(1, t));
  for (let k = 1; k < RAMP.length; k++) if (t <= RAMP[k][0]) {
    const a = RAMP[k - 1], b = RAMP[k], f = (t - a[0]) / (b[0] - a[0]);
    out.setRGB(a[1][0] + (b[1][0] - a[1][0]) * f, a[1][1] + (b[1][1] - a[1][1]) * f, a[1][2] + (b[1][2] - a[1][2]) * f);
    return out;
  }
  return out.setRGB(1, 0.28, 0.16);
}
export const FLOW_MAX = 6;

export class FlowArrows {
  constructor(scene, sim) {
    this.stride = 3;
    this.nx = Math.floor(NX / this.stride); this.ny = Math.floor(NY / this.stride);
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.11); shape.lineTo(0.55, -0.11); shape.lineTo(0.55, -0.3); shape.lineTo(1.0, 0); shape.lineTo(0.55, 0.3); shape.lineTo(0.55, 0.11); shape.lineTo(0, 0.11); shape.closePath();
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(-0.5, 0, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, fog: false }), this.nx * this.ny);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 4; this.mesh.visible = false;
    this.o = new THREE.Object3D(); this.c = new THREE.Color();
    for (let k = 0; k < this.mesh.count; k++) this.mesh.setColorAt(k, this.c.set(0xffffff));
    scene.add(this.mesh);
    this.sim = sim;
  }
  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
  update() {
    if (!this.mesh.visible) return;
    const { d, spd, uc, vc, Bh } = this.sim, st = this.stride;
    let k = 0;
    for (let jj = 0; jj < this.ny; jj++) for (let ii = 0; ii < this.nx; ii++, k++) {
      const i = ii * st + 1, j = jj * st + 1;
      // average over the stride block to reduce flicker
      let du = 0, dv = 0, dd = 0, cnt = 0, hs = 0;
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) { const c = (j + b) * NX + i + a; if (d[c] > 0.08) { du += uc[c]; dv += vc[c]; dd += d[c]; hs += Bh[c]; cnt++; } }
      const o = this.o;
      if (cnt < 2) { o.position.set(0, -50, 0); o.scale.set(0, 0, 0); o.updateMatrix(); this.mesh.setMatrixAt(k, o.matrix); continue; }
      du /= cnt; dv /= cnt; dd /= cnt; hs /= cnt;
      const s = Math.hypot(du, dv);
      if (s < 0.35) { o.position.set(0, -50, 0); o.scale.set(0, 0, 0); o.updateMatrix(); this.mesh.setMatrixAt(k, o.matrix); continue; }
      o.position.set(W.cellX(i) + DX * 0.5, hs + dd + 0.22, W.cellZ(j) + DX * 0.5);
      o.rotation.set(0, Math.atan2(-dv, du), 0);
      const len = 0.9 + Math.min(1.9, s * 0.32);
      o.scale.set(len, 1, 0.75 + Math.min(0.8, s * 0.1));
      o.updateMatrix();
      this.mesh.setMatrixAt(k, o.matrix);
      this.mesh.setColorAt(k, rampColor(s / FLOW_MAX, this.c));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
