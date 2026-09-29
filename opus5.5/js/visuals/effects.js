// Spray particles and flow-velocity arrows.
import * as THREE from 'three';
import { NX, NZ, cellX, cellZ } from '../sim.js';

export class SprayView {
  constructor(max = 5000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.tint = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 950 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute float aTint;
        uniform float uScale;
        varying float vAlpha; varying float vTint;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / -mv.z;
          vAlpha = aAlpha; vTint = aTint;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha; varying float vTint;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = smoothstep(0.25, 0.0, r) * vAlpha;
          vec3 c = mix(vec3(0.95, 0.97, 1.0), vec3(0.55, 0.47, 0.36), vTint);
          gl_FragColor = vec4(c, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.renderOrder = 6;
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  emit(x, y, z, vx, vy, vz, size, life, tint) {
    const k = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.life[k] = life; this.size[k] = size; this.tint[k] = tint;
  }

  // events: flat [x, y, z, strength, dx, dz] * n
  addEvents(ev) {
    for (let o = 0; o + 5 < ev.length; o += 6) {
      const x = ev[o], y = ev[o + 1], z = ev[o + 2], s = ev[o + 3], dx = ev[o + 4], dz = ev[o + 5];
      const n = Math.min(10, 2 + Math.floor(s * 1.2));
      for (let q = 0; q < n; q++) {
        this.emit(x + (Math.random() - 0.5) * 2, y + 0.2, z + (Math.random() - 0.5) * 2,
          dx + (Math.random() - 0.5) * s * 0.8, s * (0.6 + Math.random() * 0.9), dz + (Math.random() - 0.5) * s * 0.8,
          0.6 + Math.random() * 1.2, 0.8 + Math.random() * 0.9, 0);
      }
    }
  }

  burst(x, y, z, r, count, tint) {
    for (let q = 0; q < count; q++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * r;
      this.emit(x + Math.cos(a) * rr, y + Math.random() * 3, z + Math.sin(a) * rr,
        Math.cos(a) * 2, 2 + Math.random() * 5, Math.sin(a) * 2, 1.5 + Math.random() * 2.5, 1.2 + Math.random() * 1.5, tint);
    }
  }

  update(dt) {
    const { pos, vel, life, alpha, size } = this;
    for (let k = 0; k < this.max; k++) {
      if (life[k] <= 0) { alpha[k] = 0; continue; }
      life[k] -= dt;
      vel[k * 3 + 1] -= 9.81 * dt * 0.7;
      const drag = Math.exp(-dt * 0.8);
      vel[k * 3] *= drag; vel[k * 3 + 2] *= drag;
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      alpha[k] = Math.min(1, life[k] * 1.5) * 0.75;
      size[k] += dt * 0.8;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aTint.needsUpdate = true;
  }

  clear() { this.life.fill(0); this.alpha.fill(0); this.geo.attributes.aAlpha.needsUpdate = true; }
}

const STEP = 4;
export class FlowView {
  constructor() {
    this.cols = Math.floor(NX / STEP);
    this.rows = Math.floor(NZ / STEP);
    const n = this.cols * this.rows;
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.12); shape.lineTo(0.62, -0.12); shape.lineTo(0.62, -0.32); shape.lineTo(1, 0);
    shape.lineTo(0.62, 0.32); shape.lineTo(0.62, 0.12); shape.lineTo(0, 0.12); shape.lineTo(0, -0.12);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);  // lie flat, pointing +x
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.92, depthWrite: false }), n);
    this.mesh.renderOrder = 7;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.m4 = new THREE.Matrix4();
    this.col = new THREE.Color();
    for (let k = 0; k < n; k++) this.mesh.setColorAt(k, this.col.set(0xffffff));
  }

  static speedColor(sp, c) {
    // blue → cyan → yellow → red
    const t = Math.min(1, sp / 9);
    if (t < 0.33) c.setRGB(0.15, 0.45 + t * 1.5, 1.0);
    else if (t < 0.66) { const u = (t - 0.33) / 0.33; c.setRGB(0.15 + u * 0.85, 0.95, 1.0 - u * 0.8); }
    else { const u = (t - 0.66) / 0.34; c.setRGB(1.0, 0.95 - u * 0.75, 0.2 - u * 0.1); }
    return c;
  }

  update(s) {
    if (!this.mesh.visible) return;
    const { h, eta, cu, cv } = s;
    const m = this.m4, col = this.col;
    let n = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let q = 0; q < this.cols; q++) {
        const i = q * STEP + (STEP >> 1), j = r * STEP + (STEP >> 1);
        const c = j * NX + i;
        const hh = h[c];
        const u = cu[c], v = cv[c];
        const sp = Math.sqrt(u * u + v * v);
        if (hh < 0.08 || sp < 0.15) continue;
        const len = Math.min(7.5, 1.6 + sp * 0.9);
        const a = Math.atan2(v, u);
        const ca = Math.cos(a), sa = Math.sin(a);
        const w = len * 0.9;
        // rotation about y by -a (three's y rotation maps +x to (cos, 0, -sin))
        m.set(
          ca * len, 0, -sa * w, cellX(i) - ca * len * 0.5,
          0, 1, 0, eta[c] + 0.35,
          sa * len, 0, ca * w, cellZ(j) - sa * len * 0.5,
          0, 0, 0, 1,
        );
        this.mesh.setMatrixAt(n, m);
        this.mesh.setColorAt(n, FlowView.speedColor(sp, col));
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
