// Environmental details: trees (can be uprooted by strong flow), lamps, umbrellas, rocks, boats.
import * as THREE from 'three';
import * as W from './world.js';
import { NX, DX } from './world.js';

export class Props {
  constructor(scene, sim) {
    this.sim = sim;
    this.trees = [];
    const rnd = W.rand01(20240611);
    const okSpot = (x, z, pad) => {
      for (const b of W.BUILDINGS) if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return false;
      return true;
    };
    // --- trees
    for (let tries = 0; tries < 2600 && this.trees.length < 300; tries++) {
      const x = W.XMIN + 2 + rnd() * (W.XMAX - W.XMIN - 4), z = W.ZMIN + 40 + rnd() * (W.ZMAX - W.ZMIN - 42);
      const g = W.groundAt(x, z), s = z - W.coastZ(x);
      if (g < 0.75 || s < 7.2) continue;
      if (W.roadMask(x, z) > 0.05) continue;
      if (!okSpot(x, z, 1.6)) continue;
      const riv = Math.exp(-Math.pow((x - 24 - 3 * Math.sin(s * 0.12)) / 3.2, 2)) * W.smooth(3, 9, s);
      if (riv > 0.3) continue;
      // density: forest on the hills, sparse in town, palms near the shore
      const dens = s > 30 ? 0.95 : s > 24 ? 0.25 : s < 11 ? 0.32 : 0.12 + 0.2 * (Math.abs(x + 22) < 9 && s > 26 ? 3 : 0);
      if (rnd() > dens) continue;
      const kind = s < 11.5 ? 'palm' : s > 27 ? (rnd() < 0.6 ? 'pine' : 'round') : 'round';
      const sc = 0.8 + rnd() * 0.7;
      this.trees.push({ x, z, y: g, kind, sc, alive: true, rot: rnd() * 6.28, id: this.trees.length });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.19, 1, 6).translate(0, 0.5, 0);
    const roundGeo = new THREE.IcosahedronGeometry(1, 1).translate(0, 0, 0);
    const pineGeo = new THREE.ConeGeometry(1, 2.4, 7).translate(0, 1.2, 0);
    const palmGeo = new THREE.ConeGeometry(1.5, 0.5, 7).translate(0, 0.1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4c32, roughness: 1 });
    const mk = (geo, color) => { const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true }), this.trees.length); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; return m; };
    this.trunkM = new THREE.InstancedMesh(trunkGeo, trunkMat, this.trees.length);
    this.trunkM.castShadow = true; this.trunkM.frustumCulled = false;
    this.roundM = mk(roundGeo, 0x4f8a3a); this.pineM = mk(pineGeo, 0x2f5f3a); this.palmM = mk(palmGeo, 0x5ea043);
    const col = new THREE.Color();
    this.trees.forEach((t, k) => {
      this.roundM.setColorAt(k, col.setHSL(0.27 + (rnd() - 0.5) * 0.05, 0.42, 0.3 + rnd() * 0.08));
      this.pineM.setColorAt(k, col.setHSL(0.36 + (rnd() - 0.5) * 0.04, 0.4, 0.2 + rnd() * 0.06));
      this.palmM.setColorAt(k, col.setHSL(0.25, 0.5, 0.33 + rnd() * 0.06));
    });
    this.writeTrees();
    scene.add(this.trunkM, this.roundM, this.pineM, this.palmM);

    // --- lamp posts along the coast road
    const lampPos = [];
    for (let x = -46; x <= 46; x += 8) lampPos.push([x, W.coastZ(x) + W.COAST_ROAD_S - 1.55]);
    const poleM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 6).translate(0, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0x2f353c, roughness: 0.6 }), lampPos.length);
    const bulbM = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff2c4, emissive: 0xffd77a, emissiveIntensity: 0.7 }), lampPos.length);
    const m4 = new THREE.Matrix4();
    lampPos.forEach(([x, z], k) => { const y = W.groundAt(x, z); m4.makeTranslation(x, y, z); poleM.setMatrixAt(k, m4); m4.makeTranslation(x, y + 2.7, z); bulbM.setMatrixAt(k, m4); });
    poleM.castShadow = true; scene.add(poleM, bulbM);

    // --- beach umbrellas
    const umb = new THREE.Group();
    const colors = [0xe4572e, 0xf4d35e, 0x2e86ab, 0xf1f1f1, 0xe4572e, 0x2e86ab, 0xf4d35e];
    [-38, -30, -12, -4, 8, 16, 34].forEach((x, k) => {
      const z = W.coastZ(x) + 3.6 + (k % 3) * 0.6;
      const y = W.groundAt(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.7, 5), new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
      pole.position.set(x, y + 0.85, z);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.45, 8), new THREE.MeshStandardMaterial({ color: colors[k], roughness: 0.8 }));
      top.position.set(x, y + 1.85, z);
      const towel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.55), new THREE.MeshStandardMaterial({ color: colors[(k + 2) % colors.length] }));
      towel.position.set(x + 0.4, y + 0.04, z - 0.9); towel.rotation.y = 0.4;
      [pole, top, towel].forEach((m) => { m.castShadow = true; umb.add(m); });
    });
    scene.add(umb);

    // --- rocks along the shore
    const rockCount = 46;
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x8a867d, roughness: 1, flatShading: true }), rockCount);
    for (let k = 0; k < rockCount; k++) {
      const flank = rnd() < 0.5;
      const x = flank ? (rnd() < 0.5 ? -1 : 1) * (40 + rnd() * 8.5) : W.XMIN + 3 + rnd() * (W.XMAX - W.XMIN - 6);
      const z = W.coastZ(x) + (flank ? -3 + rnd() * 10 : -1.5 + rnd() * 3);
      const sc = 0.25 + rnd() * 0.75;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      m4.compose(new THREE.Vector3(x, W.groundAt(x, z) + sc * 0.3, z), q, new THREE.Vector3(sc * 1.3, sc * 0.8, sc));
      rocks.setMatrixAt(k, m4);
    }
    rocks.castShadow = true; rocks.receiveShadow = true; scene.add(rocks);

    // --- beached rowboats
    const boats = new THREE.Group();
    [[-24, 0.3, 0x2e6f95], [26.5, 0.9, 0xc0392b], [12, -0.5, 0xe9b44c]].forEach(([x, rot, color]) => {
      const z = W.coastZ(x) + 5.2, y = W.groundAt(x, z);
      const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 2.2, 4, 10).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
      hull.scale.set(1, 0.55, 1);
      hull.position.set(x, y + 0.22, z); hull.rotation.y = rot;
      hull.castShadow = true; boats.add(hull);
    });
    scene.add(boats);
  }

  writeTrees() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.trees.forEach((t, k) => {
      if (!t.alive) { this.trunkM.setMatrixAt(k, zero); this.roundM.setMatrixAt(k, zero); this.pineM.setMatrixAt(k, zero); this.palmM.setMatrixAt(k, zero); return; }
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      const h = t.kind === 'palm' ? 3.4 : t.kind === 'pine' ? 1.6 : 1.5;
      p.set(t.x, t.y - 0.1, t.z); s.set(t.sc, h * t.sc, t.sc);
      m.compose(p, q, s); this.trunkM.setMatrixAt(k, m);
      this.roundM.setMatrixAt(k, zero); this.pineM.setMatrixAt(k, zero); this.palmM.setMatrixAt(k, zero);
      if (t.kind === 'round') { p.set(t.x, t.y + 1.5 * t.sc + 0.9 * t.sc, t.z); s.set(1.15 * t.sc, 1.0 * t.sc, 1.15 * t.sc); m.compose(p, q, s); this.roundM.setMatrixAt(k, m); }
      else if (t.kind === 'pine') { p.set(t.x, t.y + 1.2 * t.sc, t.z); s.set(1.0 * t.sc, 1.35 * t.sc, 1.0 * t.sc); m.compose(p, q, s); this.pineM.setMatrixAt(k, m); }
      else { p.set(t.x, t.y + 3.3 * t.sc, t.z); s.set(1.1 * t.sc, 1.4 * t.sc, 1.1 * t.sc); m.compose(p, q, s); this.palmM.setMatrixAt(k, m); }
    });
    for (const im of [this.trunkM, this.roundM, this.pineM, this.palmM]) im.instanceMatrix.needsUpdate = true;
  }

  // uproot trees exposed to strong flow; returns positions of uprooted trees (for log debris)
  update() {
    const sim = this.sim, out = [];
    let changed = false;
    for (const t of this.trees) {
      if (!t.alive) continue;
      const i = Math.floor((t.x - W.XMIN) / DX), j = Math.floor((t.z - W.ZMIN) / DX);
      const c = j * NX + i, d = sim.d[c];
      if (d > 0.5 && d * sim.spd[c] * sim.spd[c] > 3.2 + (t.kind === 'pine' ? 1.5 : 0)) { t.alive = false; changed = true; out.push(t); }
    }
    if (changed) this.writeTrees();
    return out;
  }
  reset() { let ch = false; for (const t of this.trees) if (!t.alive) { t.alive = true; ch = true; } if (ch) this.writeTrees(); }
}
