// Buildings, roads, vegetation, vehicles and debris.
import * as THREE from 'three';
import { mulberry32, baseShore, NX, cellX, cellZ, DX, X0, Z0 } from '../sim.js';
import { getTextures, boxWithMetricUV } from './textures.js';

const HOUSE_COLORS = [0xf3d9b1, 0xe9c4a2, 0xcfe0e8, 0xf0e6c8, 0xe7b8a4, 0xd9e4c8, 0xf4f1ea, 0xc8d6e6];
const SHOP_COLORS = [0xf5efe2, 0xe3d6c0, 0xd6dde3, 0xf2d7b6];
const APT_COLORS = [0xd9d6cf, 0xc9c4ba, 0xe5e1d8, 0xbfc7cc, 0xd8cbb8];
const ROOF_COLORS = [0xa4513a, 0x8c3f2e, 0x6d5a4c, 0x7b8a8f, 0xb86b45];
const CAR_COLORS = [0xd83a3a, 0x2f6fd6, 0xf2f2f2, 0x2b2b2b, 0xf0c33c, 0x3d9a64];
const BOAT_COLORS = [0xffffff, 0xe8f0f5, 0xf5e9d0, 0xd8e8f0];

function gableRoof(w, d, rise) {
  // ridge along the longer side
  const alongX = w >= d;
  const L = alongX ? w : d, S = alongX ? d : w;
  const o = 0.5; // overhang
  const hl = L / 2 + o, hs = S / 2 + o;
  const v = [
    -hl, 0, -hs, hl, 0, -hs, hl, rise, 0, -hl, rise, 0,   // slope 1
    -hl, 0, hs, -hl, rise, 0, hl, rise, 0, hl, 0, hs,     // slope 2
    -hl, 0, -hs, -hl, rise, 0, -hl, 0, hs,               // gable 1
    hl, 0, -hs, hl, 0, hs, hl, rise, 0,                  // gable 2
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(idx);
  const ng = geo.toNonIndexed();
  ng.computeVertexNormals();
  if (!alongX) ng.rotateY(Math.PI / 2);
  return ng;
}

export class TownView {
  constructor(layout, terrainView) {
    this.layout = layout;
    this.terrainView = terrainView;
    this.group = new THREE.Group();
    this.tex = getTextures();
    this.buildingViews = [];
    this._buildRoads();
    this._buildBuildings();
    this._buildProps();
    this._buildVehicles();
    this._buildChunks();
    this._buildPier();
  }

  // ------------------------------------------------------------------ roads
  _buildRoads() {
    const L = this.layout, tv = this.terrainView;
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.road, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const hAt = (x, z) => {
      // sample across the road width: roads never sink into the ground
      return Math.max(tv.heightAt(x, z), tv.heightAt(x + 2, z), tv.heightAt(x - 2, z), tv.heightAt(x, z + 2), tv.heightAt(x, z - 2));
    };
    for (const line of L.roads) {
      // resample densely
      const pts = [];
      for (let k = 0; k < line.length - 1; k++) {
        const [ax, az] = line[k], [bx, bz] = line[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let s = 0; s < n; s++) pts.push([ax + (bx - ax) * s / n, az + (bz - az) * s / n]);
      }
      pts.push(line[line.length - 1]);
      const ys = pts.map(([x, z]) => hAt(x, z));
      // bridge over dips (channel): take max of min of neighbours within 12 m
      const yb = ys.map((y, k) => {
        let lm = -1e9, rm = -1e9;
        for (let q = 1; q <= 7; q++) { if (k - q >= 0) lm = Math.max(lm, ys[k - q]); if (k + q < ys.length) rm = Math.max(rm, ys[k + q]); }
        return Math.max(y, Math.min(lm, rm) - 0.3);
      });
      const pos = [], uv = [], idx = [];
      let dist = 0;
      for (let k = 0; k < pts.length; k++) {
        const [x, z] = pts[k];
        const [px, pz] = pts[Math.max(0, k - 1)], [nx, nz] = pts[Math.min(pts.length - 1, k + 1)];
        let tx = nx - px, tz = nz - pz;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const ox = -tz * 3.5, oz = tx * 3.5;
        if (k > 0) dist += Math.hypot(x - pts[k - 1][0], z - pts[k - 1][1]);
        const y = yb[k] + 0.12;
        pos.push(x + ox, y, z + oz, x - ox, y, z - oz);
        uv.push(0, dist / 12, 1, dist / 12);
        if (k < pts.length - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      // ensure normals point up
      const n = geo.attributes.normal;
      for (let q = 0; q < n.count; q++) if (n.getY(q) < 0) n.setXYZ(q, -n.getX(q), -n.getY(q), -n.getZ(q));
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.material.side = THREE.DoubleSide;
      this.group.add(m);
      // bridge piers where road is well above ground
      for (let k = 0; k < pts.length; k += 3) {
        const gap = yb[k] - tv.heightAt(pts[k][0], pts[k][1]);
        if (gap > 1.2) {
          const pier = new THREE.Mesh(new THREE.BoxGeometry(1.2, gap + 2, 6), new THREE.MeshStandardMaterial({ color: 0x9d9a92, roughness: 0.9 }));
          pier.position.set(pts[k][0], yb[k] - gap / 2 - 0.6, pts[k][1]);
          pier.castShadow = true;
          this.group.add(pier);
        }
      }
    }
  }

  // --------------------------------------------------------------- buildings
  _buildBuildings() {
    const L = this.layout;
    const T = this.tex;
    this.rubbleMat = new THREE.MeshStandardMaterial({ color: 0x8f8778, roughness: 1, flatShading: true });
    for (const b of L.buildings) {
      const rnd = mulberry32(b.seed + 17);
      const g = new THREE.Group();
      const baseY = b.baseY - 1.2;
      const hTot = b.topY - baseY;
      let wallColor, style = b.type;
      if (b.type === 'house') wallColor = HOUSE_COLORS[Math.floor(b.hue * HOUSE_COLORS.length)];
      else if (b.type === 'shop') wallColor = SHOP_COLORS[Math.floor(b.hue * SHOP_COLORS.length)];
      else if (b.type === 'apartment') wallColor = APT_COLORS[Math.floor(b.hue * APT_COLORS.length)];
      else if (b.type === 'hotel') wallColor = 0xf1f3f4;
      else wallColor = 0xf5f5f0;
      let body;
      const mats = [];
      if (b.type === 'lighthouse') {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, hTot, 20), new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.6 }));
        tower.position.y = hTot / 2;
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.75, 3.05, 3.2, 20), new THREE.MeshStandardMaterial({ color: 0xc8322d, roughness: 0.6 }));
        stripe.position.y = hTot * 0.62;
        const stripe2 = stripe.clone(); stripe2.position.y = hTot * 0.32; stripe2.scale.set(1.12, 1, 1.12);
        const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.6, 16), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd36b, emissiveIntensity: 1.2 }));
        lantern.position.y = hTot + 1.3;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(2.4, 2.4, 16), new THREE.MeshStandardMaterial({ color: 0xc8322d }));
        cap.position.y = hTot + 3.8;
        for (const m of [tower, stripe, stripe2, lantern, cap]) { m.castShadow = true; g.add(m); }
        body = tower;
      } else {
        const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, map: T[style], roughness: 0.85 });
        const roofMat = new THREE.MeshStandardMaterial({ color: b.roof === 'gable' ? 0x7d7d7d : 0x8e9092, roughness: 0.9 });
        const tileW = style === 'house' ? 8 : style === 'shop' ? 10 : style === 'apartment' ? 9 : 8;
        body = new THREE.Mesh(boxWithMetricUV(b.w, hTot, b.d, tileW, 3), [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]);
        body.position.y = hTot / 2;
        body.castShadow = true; body.receiveShadow = true;
        g.add(body);
        mats.push(wallMat);
        if (b.roof === 'gable') {
          const roofColor = ROOF_COLORS[Math.floor(rnd() * ROOF_COLORS.length)];
          const roof = new THREE.Mesh(gableRoof(b.w, b.d, Math.min(b.w, b.d) * 0.38), new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.8, flatShading: true }));
          roof.position.y = hTot;
          roof.castShadow = true;
          g.add(roof);
        } else {
          // parapet + rooftop box
          const para = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.3, 0.8, b.d + 0.3), new THREE.MeshStandardMaterial({ color: 0xd0cec8, roughness: 0.9 }));
          para.position.y = hTot + 0.1;
          g.add(para);
          const inner = new THREE.Mesh(new THREE.BoxGeometry(b.w - 0.6, 0.9, b.d - 0.6), roofMat);
          inner.position.y = hTot + 0.2;
          g.add(inner);
          const n = b.type === 'shop' ? 1 : 2;
          for (let k = 0; k < n; k++) {
            const bw = 2 + rnd() * 3, bd = 2 + rnd() * 3, bh = 1.5 + rnd() * 1.5;
            const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshStandardMaterial({ color: 0xa7aaad, roughness: 0.7 }));
            box.position.set((rnd() - 0.5) * (b.w - bw - 2), hTot + bh / 2, (rnd() - 0.5) * (b.d - bd - 2));
            box.castShadow = true;
            g.add(box);
          }
          if (b.type === 'shop') {
            // awning facing the sea (+z)
            const aw = new THREE.Mesh(new THREE.BoxGeometry(b.w * 0.85, 0.2, 2.2), new THREE.MeshStandardMaterial({ color: [0xd2493b, 0x2f7fb5, 0x3e9b6a][Math.floor(rnd() * 3)] }));
            aw.position.set(0, (b.groundY - baseY) + 3.2, b.d / 2 + 1.1);
            aw.rotation.x = 0.25;
            aw.castShadow = true;
            g.add(aw);
          }
        }
      }
      g.position.set(b.cx, baseY, b.cz);
      this.group.add(g);

      // rubble pile (shown once destroyed)
      const rubble = new THREE.Group();
      const rmat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 1, flatShading: true });
      rmat.color.multiplyScalar(0.75);
      const pieces = 7 + Math.floor(b.w * b.d / 40);
      for (let k = 0; k < pieces; k++) {
        const s = 1.2 + rnd() * 2.8;
        const geo = new THREE.DodecahedronGeometry(s, 0);
        const m = new THREE.Mesh(geo, rnd() < 0.5 ? rmat : this.rubbleMat);
        m.position.set((rnd() - 0.5) * b.w * 0.9, s * 0.35, (rnd() - 0.5) * b.d * 0.9);
        m.scale.set(1, 0.45 + rnd() * 0.4, 1);
        m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
        m.castShadow = true; m.receiveShadow = true;
        rubble.add(m);
      }
      // a few standing wall stumps
      for (let k = 0; k < 3; k++) {
        const stub = new THREE.Mesh(new THREE.BoxGeometry(b.w * (0.2 + rnd() * 0.3), 1 + rnd() * 2.5, 0.5), rmat);
        stub.position.set((rnd() - 0.5) * b.w * 0.6, 1, (rnd() < 0.5 ? -1 : 1) * b.d * 0.42);
        stub.rotation.set(0, rnd() < 0.5 ? 0 : Math.PI / 2, (rnd() - 0.5) * 0.4);
        stub.castShadow = true;
        rubble.add(stub);
      }
      rubble.position.set(b.cx, b.groundY - 0.3, b.cz);
      rubble.visible = false;
      this.group.add(rubble);

      this.buildingViews.push({
        b, group: g, body, mats, style, wallColor: new THREE.Color(wallColor), rubble,
        state: 0, health: 1, collapseT: -1, tiltAxis: new THREE.Vector3(1, 0, 0), baseY,
        seedTilt: (rnd() - 0.5),
      });
    }
  }

  // ------------------------------------------------------------------ props
  _buildProps() {
    const L = this.layout;
    const trees = L.props.filter((p) => p.type === 'tree');
    const palms = L.props.filter((p) => p.type === 'palm');
    const umbrellas = L.props.filter((p) => p.type === 'umbrella');
    const mk = (geo, mat, n) => { const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = true; m.receiveShadow = true; this.group.add(m); return m; };
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 3, 6); trunkGeo.translate(0, 1.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.4, 0); crownGeo.translate(0, 4.6, 0);
    const palmTrunk = new THREE.CylinderGeometry(0.18, 0.3, 7, 6); palmTrunk.translate(0, 3.5, 0);
    const frond = new THREE.ConeGeometry(3.2, 1.4, 7, 1, true); frond.translate(0, 7.1, 0);
    const pole = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 4); pole.translate(0, 1.2, 0);
    const canopy = new THREE.ConeGeometry(1.4, 0.6, 8); canopy.translate(0, 2.4, 0);
    this.propSets = [
      { list: trees, meshes: [mk(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2f }), trees.length), mk(crownGeo, new THREE.MeshStandardMaterial({ color: 0x3f7a35, flatShading: true, roughness: 0.9 }), trees.length)] },
      { list: palms, meshes: [mk(palmTrunk, new THREE.MeshStandardMaterial({ color: 0x8a6d4b }), palms.length), mk(frond, new THREE.MeshStandardMaterial({ color: 0x4f8f3a, flatShading: true, side: THREE.DoubleSide }), palms.length)] },
      { list: umbrellas, meshes: [mk(pole, new THREE.MeshStandardMaterial({ color: 0xdddddd }), umbrellas.length), mk(canopy, new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }), umbrellas.length)] },
    ];
    const ucols = [0xe84a3c, 0xf5c542, 0x3b8fd9, 0xffffff, 0x41b36a];
    umbrellas.forEach((p, k) => this.propSets[2].meshes[1].setColorAt(k, new THREE.Color(ucols[k % ucols.length])));
    trees.forEach((p, k) => this.propSets[0].meshes[1].setColorAt(k, new THREE.Color().setHSL(0.26 + p.seed * 0.08, 0.45, 0.28 + p.seed * 0.1)));
    this.propFallen = new Float32Array(L.props.length);
    this.propFallT = new Float32Array(L.props.length);
    this.propDir = new Float32Array(L.props.length);
    this._updateProps(true);
  }

  _updateProps(force) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const axis = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const qy = new THREE.Quaternion();
    for (const set of this.propSets) {
      let changed = force;
      set.list.forEach((pr, k) => {
        const f = this.propFallT[pr.id];
        if (!force && !(f > 0 && f < 1.01)) return;
        changed = true;
        const ang = Math.min(1, f) * (pr.type === 'umbrella' ? 1.5 : 1.35);
        const dir = this.propDir[pr.id];
        axis.set(Math.sin(dir), 0, -Math.cos(dir));    // perpendicular to flow → falls along flow
        q.setFromAxisAngle(axis, ang);
        qy.setFromAxisAngle(up, pr.seed * 6.28);
        q.multiply(qy);
        s.setScalar(pr.scale);
        p.set(pr.x, this.terrainView.heightAt(pr.x, pr.z) - 0.2, pr.z);
        m4.compose(p, q, s);
        for (const mesh of set.meshes) mesh.setMatrixAt(k, m4);
      });
      if (changed) for (const mesh of set.meshes) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    }
  }

  // --------------------------------------------------------------- vehicles
  _buildVehicles() {
    this.vehicleMeshes = [];
    const L = this.layout;
    for (const v of L.vehicles) {
      const g = new THREE.Group();
      if (v.kind === 'car') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.8, 1.9), new THREE.MeshStandardMaterial({ color: CAR_COLORS[v.color], roughness: 0.35, metalness: 0.4 }));
        body.position.y = -0.25;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.65, 1.7), new THREE.MeshStandardMaterial({ color: 0x2a3440, roughness: 0.2, metalness: 0.5 }));
        cab.position.set(-0.2, 0.45, 0);
        g.add(body, cab);
      } else {
        const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 2.6), new THREE.MeshStandardMaterial({ color: BOAT_COLORS[v.color], roughness: 0.5 }));
        const bow = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.4, 4), hull.material);
        bow.rotation.z = -Math.PI / 2; bow.rotation.x = Math.PI / 4; bow.position.set(4.6, 0, 0); bow.scale.set(1, 1, 0.75);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(7.05, 0.25, 2.65), new THREE.MeshStandardMaterial({ color: [0x1f5fa8, 0xc0392b, 0x16a085, 0x2c3e50][v.color] }));
        stripe.position.y = 0.2;
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 1.9), new THREE.MeshStandardMaterial({ color: 0xf4f4f4 }));
        cabin.position.set(-0.8, 1.1, 0);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
        mast.position.set(0.8, 3.2, 0);
        g.add(hull, bow, stripe, cabin, mast);
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      this.group.add(g);
      this.vehicleMeshes.push(g);
    }
  }

  _buildChunks() {
    const MAX = 260;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.chunks = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), MAX);
    this.chunks.castShadow = true;
    this.chunks.count = 0;
    this.chunks.frustumCulled = false;
    this.group.add(this.chunks);
    const c = new THREE.Color();
    for (let k = 0; k < MAX; k++) this.chunks.setColorAt(k, c.set(0x8b7355));
  }

  _buildPier() {
    const x0 = 8, zs = baseShore(x0) - 4, len = 58;
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 0.9 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, len), mat);
    deck.position.set(x0, 2.6, zs + len / 2);
    deck.castShadow = true; deck.receiveShadow = true;
    this.group.add(deck);
    for (let z = zs + 4; z < zs + len; z += 6) {
      for (const dx of [-1.7, 1.7]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 14), mat);
        post.position.set(x0 + dx, 2.4 - 7, z);
        post.castShadow = true;
        this.group.add(post);
      }
    }
    this.pier = deck;
  }

  // ------------------------------------------------------------------ update
  reset() {
    for (const v of this.buildingViews) {
      v.state = 0; v.health = 1; v.collapseT = -1;
      v.group.visible = true;
      v.group.position.y = v.baseY;
      v.group.rotation.set(0, 0, 0);
      v.group.scale.set(1, 1, 1);
      v.rubble.visible = false;
      for (const m of v.mats) { m.map = this.tex[v.style]; m.color.copy(v.wallColor); m.needsUpdate = true; }
    }
    this.propFallen.fill(0);
    this.propFallT.fill(0);
    this._updateProps(true);
    this.chunks.count = 0;
  }

  applyState(s, dt) {
    const L = this.layout;
    // buildings
    const bld = s.bld;
    for (let k = 0; k < this.buildingViews.length; k++) {
      const v = this.buildingViews[k];
      const health = bld[k * 4], state = bld[k * 4 + 1];
      const fx = bld[k * 4 + 2], fz = bld[k * 4 + 3];
      v.health = health;
      if (state >= 1 && v.state === 0) {
        v.state = 1;
        for (const m of v.mats) { m.map = this.tex[v.style + '_broken']; m.needsUpdate = true; }
      }
      if (v.state >= 1 && v.state < 2 && v.b.type !== 'lighthouse') {
        const dmg = 1 - health;
        v.tiltAxis.set(fz, 0, -fx).normalize();
        const tilt = Math.min(0.07, dmg * 0.08) * (0.6 + Math.abs(v.seedTilt));
        v.group.setRotationFromAxisAngle(v.tiltAxis.lengthSq() > 0 ? v.tiltAxis : new THREE.Vector3(1, 0, 0), tilt);
        for (const m of v.mats) m.color.copy(v.wallColor).multiplyScalar(1 - dmg * 0.35);
      }
      if (state === 2 && v.state < 2) {
        v.state = 2;
        v.collapseT = 0;
        v.tiltAxis.set(fz, 0, -fx);
        if (v.tiltAxis.lengthSq() < 1e-4) v.tiltAxis.set(1, 0, 0);
        v.tiltAxis.normalize();
        v.rubble.visible = true;
        v.rubble.scale.set(1, 0.01, 1);
      }
      if (v.collapseT >= 0 && v.collapseT < 1) {
        v.collapseT = Math.min(1, v.collapseT + dt / 1.8);
        const t = v.collapseT, e = t * t;
        v.group.setRotationFromAxisAngle(v.tiltAxis, e * 0.55);
        v.group.scale.set(1, Math.max(0.05, 1 - e * 0.95), 1);
        v.group.position.y = v.baseY - e * 2;
        v.rubble.scale.set(1, Math.min(1, t * 1.3), 1);
        if (t >= 1) v.group.visible = false;
      }
    }
    // props
    let propChange = false;
    for (let k = 0; k < L.props.length; k++) {
      if (s.props[k * 2] > 0 && this.propFallen[k] === 0) {
        this.propFallen[k] = 1; this.propDir[k] = s.props[k * 2 + 1]; this.propFallT[k] = 0.001; propChange = true;
      }
      if (this.propFallT[k] > 0 && this.propFallT[k] < 1) { this.propFallT[k] = Math.min(1, this.propFallT[k] + dt * 1.2); propChange = true; }
    }
    if (propChange) this._updateProps(false);
  }

  applyDebris(debris, stride) {
    const nVeh = this.vehicleMeshes.length;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    const n0 = debris.length / stride;
    for (let k = 0; k < n0; k++) {
      const o = k * stride;
      if (k < nVeh) {
        const g = this.vehicleMeshes[k];
        g.visible = debris[o] > 0;
        if (!g.visible) continue;
        g.position.set(debris[o + 2], debris[o + 3], debris[o + 4]);
        g.rotation.set(0, -debris[o + 5], debris[o + 6] * 0.6);
        continue;
      }
      if (!debris[o]) continue;
      p.set(debris[o + 2], debris[o + 3], debris[o + 4]);
      e.set(debris[o + 6], -debris[o + 5], debris[o + 6] * 0.5);
      q.setFromEuler(e);
      sc.set(debris[o + 7], debris[o + 9], debris[o + 8]);
      m4.compose(p, q, sc);
      this.chunks.setMatrixAt(n, m4);
      const bv = this.buildingViews[debris[o + 11] | 0];
      col.copy(bv ? bv.wallColor : col.set(0x8b7355));
      if ((k & 3) === 0) col.set(0x7a5c3e); // timber
      this.chunks.setColorAt(n, col.multiplyScalar(0.8));
      n++;
    }
    this.chunks.count = n;
    this.chunks.instanceMatrix.needsUpdate = true;
    if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;
  }
}
