// Town buildings: procedural meshes with intact / damaged / destroyed states.
import * as THREE from 'three';
import * as W from './world.js';

let wallTex = null;
function getWallTex() {
  if (wallTex) return wallTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(120,120,120,${Math.random() * 0.07})`; g.fillRect(Math.random() * 128, Math.random() * 128, 6, 3); }
  g.fillStyle = '#e9eef2'; g.fillRect(30, 26, 68, 66);          // frame
  g.fillStyle = '#4b6072'; g.fillRect(34, 30, 60, 58);          // glass
  g.fillStyle = '#7f98ad'; g.fillRect(34, 30, 60, 14);
  g.fillStyle = '#e9eef2'; g.fillRect(62, 30, 4, 58); g.fillRect(34, 58, 60, 4);
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(28, 92, 72, 5);
  wallTex = new THREE.CanvasTexture(cv);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  wallTex.colorSpace = THREE.SRGBColorSpace;
  wallTex.anisotropy = 8;
  return wallTex;
}

function scaledBox(w, h, d, tile = 1.9, tileV = 1.6) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const sc = [[d / tile, h / tileV], [d / tile, h / tileV], [w / tile, d / tile], [w / tile, d / tile], [w / tile, h / tileV], [w / tile, h / tileV]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const idx = f * 4 + k;
    uv.setXY(idx, Math.max(1, Math.round(sc[f][0])) * uv.getX(idx), Math.max(1, Math.round(sc[f][1])) * uv.getY(idx));
  }
  return g;
}

function gableGeometry(w, d, rh) {
  const ridgeAlongX = w >= d;
  const B = (ridgeAlongX ? d : w) + 0.7, L = (ridgeAlongX ? w : d) + 0.7;
  const s = new THREE.Shape();
  s.moveTo(-B / 2, 0); s.lineTo(B / 2, 0); s.lineTo(0, rh); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: L, bevelEnabled: false });
  g.translate(0, 0, -L / 2);
  if (ridgeAlongX) g.rotateY(Math.PI / 2);
  return g;
}
function hipGeometry(w, d, rh) {
  const g = new THREE.ConeGeometry(1, rh, 4, 1).rotateY(Math.PI / 4);
  g.translate(0, rh / 2, 0);
  g.scale((w / 2 + 0.35) * Math.SQRT2, 1, (d / 2 + 0.35) * Math.SQRT2);
  return g;
}

const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts });
const shared = { box: new THREE.BoxGeometry(1, 1, 1) };
const rubbleMats = {};

export class BuildingView {
  constructor(sim, simB, parent) {
    this.simB = simB;
    const s = simB.spec, kind = W.KINDS[s.kind];
    this.spec = s;
    this.group = new THREE.Group();
    this.group.position.set(s.x, simB.gmax, s.z);
    this.pivot = new THREE.Group();
    this.group.add(this.pivot);
    this.parts = [];
    const tex = getWallTex();
    this.bodyMat = new THREE.MeshStandardMaterial({ map: tex, color: kind.color, roughness: 0.8 });
    this.roofMat = M(kind.roof, { roughness: 0.75 });
    this.trimMat = M(0xf1efe8);
    this.darkMat = M(0x3a3f47);
    const w = s.w, d = s.d, h = s.h;

    const add = (geo, mat, x, y, z, parent = this.pivot) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
      m.userData.buildingId = simB.id; parent.add(m); return m;
    };

    // body
    const bodyH = h + 0.8;
    this.body = add(scaledBox(w, bodyH, d), this.bodyMat, 0, (h - 0.8) / 2, 0);
    this.roofGroup = new THREE.Group(); this.roofGroup.position.y = h; this.pivot.add(this.roofGroup);
    const roofAdd = (geo, mat, x, y, z) => add(geo, mat, x, y, z, this.roofGroup);
    this.doorZ = -d / 2 - 0.03;
    const door = add(shared.box, this.darkMat, 0, 0.75 - 0.0, this.doorZ);
    door.scale.set(0.9, 1.5, 0.08); door.material = M(0x5b4636);

    switch (s.kind) {
      case 'house': {
        roofAdd(hipGeometry(w, d, 1.3), this.roofMat, 0, 0, 0);
        const ch = roofAdd(shared.box, M(0x8b8078), w * 0.22, 1.0, d * 0.1); ch.scale.set(0.45, 1.2, 0.45);
        break;
      }
      case 'shop': {
        roofAdd(shared.box, this.trimMat, 0, 0.12, 0).scale.set(w + 0.3, 0.25, d + 0.3);
        const aw = roofAdd(shared.box, this.roofMat, 0, -0.9, -d / 2 - 0.45); aw.scale.set(w * 0.85, 0.12, 0.95); aw.rotation.x = -0.28;
        const sign = roofAdd(shared.box, this.roofMat, 0, 0.55, -d / 2 + 0.1); sign.scale.set(w * 0.5, 0.55, 0.12);
        break;
      }
      case 'warehouse': {
        roofAdd(gableGeometry(w, d, 1.3), this.roofMat, 0, 0, 0);
        const gate = add(shared.box, M(0x59626b), 0, 1.05, this.doorZ - 0.02); gate.scale.set(Math.min(2.6, w * 0.4), 2.1, 0.1);
        break;
      }
      case 'inn': {
        roofAdd(hipGeometry(w, d, 1.7), this.roofMat, 0, 0, 0);
        const c1 = roofAdd(shared.box, M(0x8b8078), -w * 0.25, 1.2, 0); c1.scale.set(0.5, 1.6, 0.5);
        const c2 = roofAdd(shared.box, M(0x8b8078), w * 0.25, 1.2, 0); c2.scale.set(0.5, 1.6, 0.5);
        const bal = add(shared.box, M(0x6b4a34), 0, h * 0.55, -d / 2 - 0.4); bal.scale.set(w * 0.7, 0.16, 0.85);
        break;
      }
      case 'apartments': {
        roofAdd(shared.box, this.trimMat, 0, 0.12, 0).scale.set(w + 0.3, 0.25, d + 0.3);
        const tank = roofAdd(new THREE.CylinderGeometry(0.7, 0.7, 1.1, 12), M(0x7b838c), w * 0.2, 0.8, d * 0.15);
        const box = roofAdd(shared.box, this.roofMat, -w * 0.2, 0.6, -d * 0.1); box.scale.set(1.4, 0.9, 1.4);
        break;
      }
      case 'hall': {
        roofAdd(gableGeometry(w, d, 1.5), this.roofMat, 0, 0, 0);
        const tw = roofAdd(shared.box, this.bodyMat, 0, 1.9, 0); tw.scale.set(1.5, 2.6, 1.5);
        const sp = roofAdd(new THREE.ConeGeometry(1.15, 1.6, 4).rotateY(Math.PI / 4), this.roofMat, 0, 4.0, 0);
        for (let k = -1.5; k <= 1.5; k += 1) { const col = add(new THREE.CylinderGeometry(0.16, 0.16, h * 0.9, 8), this.trimMat, k * (w / 7), h * 0.45, -d / 2 - 0.5); }
        const porch = add(shared.box, this.trimMat, 0, h * 0.92, -d / 2 - 0.5); porch.scale.set(w * 0.6, 0.2, 1.2);
        break;
      }
      case 'school': {
        roofAdd(gableGeometry(w, d, 1.3), this.roofMat, 0, 0, 0);
        const pole = roofAdd(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), this.trimMat, w * 0.35, 1.2, -d * 0.2);
        const flag = roofAdd(shared.box, M(0xd94848), w * 0.35 + 0.35, 2.1, -d * 0.2); flag.scale.set(0.7, 0.4, 0.04);
        break;
      }
      case 'church': {
        roofAdd(gableGeometry(w, d, 1.9), this.roofMat, 0, 0, 0);
        const tw = add(shared.box, this.bodyMat, 0, h + 1.5, -d / 2 + 1.0); tw.scale.set(1.9, 3.6, 1.9);
        add(new THREE.ConeGeometry(1.5, 3.2, 4).rotateY(Math.PI / 4), this.roofMat, 0, h + 4.9, -d / 2 + 1.0);
        break;
      }
      case 'lighthouse': {
        this.body.visible = false; door.visible = false;
        const r = w / 2;
        this.lhBase = add(new THREE.CylinderGeometry(r * 0.66, r * 1.05, h + 0.8, 16), M(0xf4f4f2), 0, (h - 0.8) / 2, 0);
        this.parts.push(this.lhBase);
        for (let k = 0; k < 3; k++) {
          const y0 = 1.0 + k * (h / 3.2);
          const band = add(new THREE.CylinderGeometry(r * (1.0 - (y0 / h) * 0.34) + 0.02, r * (1.0 - ((y0 + h / 6.4) / h) * 0.34) + 0.02, h / 6.4, 16), M(0xc33b35), 0, y0 + h / 12.8, 0);
        }
        const gal = roofAdd(new THREE.CylinderGeometry(r * 0.95, r * 0.8, 0.25, 16), this.darkMat, 0, 0.1, 0);
        const lamp = roofAdd(new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.9, 12), M(0xffe9a8, { emissive: 0xffc45a, emissiveIntensity: 0.6 }), 0, 0.7, 0);
        roofAdd(new THREE.ConeGeometry(r * 0.66, 0.9, 12), this.roofMat, 0, 1.6, 0);
        break;
      }
    }
    this.pivot.traverse((o) => { if (o.isMesh) o.userData.buildingId = simB.id; });

    // damage details (hidden until damaged)
    this.damage = new THREE.Group(); this.damage.visible = false; this.pivot.add(this.damage);
    const hole = (x, y, z, sx, sy) => { const m = new THREE.Mesh(shared.box, M(0x1d1a18)); m.position.set(x, y, z); m.scale.set(sx, sy, 0.08); this.damage.add(m); };
    if (s.kind !== 'lighthouse') { hole(-w * 0.2, h * 0.55, -d / 2 - 0.05, 1.1, 0.9); hole(w * 0.25, h * 0.35, -d / 2 - 0.05, 0.8, 0.7); }
    else { hole(0, h * 0.5, -w * 0.3, 0.8, 1.0); }
    this.rubble = null;
    this.state = 0; this.anim = 0; this.animKind = null;
    parent.add(this.group);
    this.baseColor = new THREE.Color(kind.color);
  }

  makeRubble() {
    const s = this.spec, kind = W.KINDS[s.kind], rnd = W.rand01(this.simB.id * 97 + 1234);
    const g = new THREE.Group();
    const mats = [M(kind.color), M(kind.roof), M(0x6d635a), M(0x4a4038)];
    const n = Math.round(12 + s.w * s.d * 0.8);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(shared.box, mats[(rnd() * mats.length) | 0]);
      const sx = 0.4 + rnd() * 1.1, sy = 0.15 + rnd() * 0.4, sz = 0.4 + rnd() * 1.1;
      m.scale.set(sx, sy, sz);
      m.position.set((rnd() - 0.5) * s.w * 0.95, sy * 0.4 - 0.1 + rnd() * 0.15, (rnd() - 0.5) * s.d * 0.95);
      m.rotation.set((rnd() - 0.5) * 0.5, rnd() * 3.14, (rnd() - 0.5) * 0.5);
      m.castShadow = true; m.receiveShadow = true;
      m.userData.buildingId = this.simB.id;
      g.add(m);
    }
    this.group.add(g);
    return g;
  }

  setState(state, animate = true) {
    if (state === this.state) return;
    const prev = this.state; this.state = state;
    if (state === 1) {
      this.animKind = animate ? 'damage' : null; this.anim = 0;
      this.applyDamaged(animate ? 0 : 1);
    } else if (state === 2) {
      this.animKind = animate ? 'collapse' : null; this.anim = 0;
      if (!animate) this.finishCollapse();
    } else this.resetVisual();
  }

  applyDamaged(t) {
    this.damage.visible = true;
    const k = t;
    this.bodyMat.color.copy(this.baseColor).lerp(new THREE.Color(0x6a5a4a), 0.42 * k);
    this.pivot.rotation.z = 0.05 * k; this.pivot.rotation.x = -0.02 * k;
    this.roofGroup.rotation.z = -0.13 * k; this.roofGroup.position.y = this.spec.h - 0.18 * k;
    this.roofGroup.position.x = 0.25 * k;
  }

  finishCollapse() {
    this.pivot.visible = false;
    if (!this.rubble) this.rubble = this.makeRubble();
    this.rubble.visible = true;
  }

  update(dt) {
    if (!this.animKind) return;
    this.anim += dt;
    if (this.animKind === 'damage') {
      const t = Math.min(1, this.anim / 0.5);
      const bounce = 1 + Math.sin(t * Math.PI) * 0.25;
      this.applyDamaged(t * bounce > 1 ? 1 : t);
      if (t >= 1) this.animKind = null;
    } else if (this.animKind === 'collapse') {
      const T = 1.5, t = Math.min(1, this.anim / T), e = t * t * (3 - 2 * t);
      const h = this.spec.h;
      this.damage.visible = true;
      this.body.scale.y = 1 - e * 0.86; this.body.position.y = ((h - 0.8) / 2) * (1 - e * 0.86) - 0.05 * e;
      if (this.lhBase) this.lhBase.rotation.z = e * 0.9, this.lhBase.position.x = e * h * 0.25, this.lhBase.scale.y = 1 - e * 0.7;
      this.pivot.rotation.z = 0.05 + e * 0.12 * (this.simB.id % 2 ? 1 : -1);
      this.roofGroup.position.y = h * (1 - e) + 0.1; this.roofGroup.rotation.z = -0.13 - e * 0.7; this.roofGroup.position.x = 0.25 + e * 1.2;
      this.pivot.scale.setScalar(1 - e * 0.02);
      if (t >= 1) { this.animKind = null; this.finishCollapse(); }
    }
  }

  resetVisual() {
    this.state = 0; this.animKind = null; this.anim = 0;
    this.pivot.visible = true; this.pivot.rotation.set(0, 0, 0); this.pivot.scale.setScalar(1);
    this.body.scale.set(1, 1, 1); this.body.position.y = (this.spec.h - 0.8) / 2;
    if (this.lhBase) { this.lhBase.rotation.set(0, 0, 0); this.lhBase.position.set(0, (this.spec.h - 0.8) / 2, 0); this.lhBase.scale.set(1, 1, 1); }
    this.roofGroup.rotation.set(0, 0, 0); this.roofGroup.position.set(0, this.spec.h, 0);
    this.bodyMat.color.copy(this.baseColor);
    this.damage.visible = false;
    if (this.rubble) this.rubble.visible = false;
  }
}
