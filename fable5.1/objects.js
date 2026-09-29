/* ------------------------------------------------------------------
 * Objects that live on the grid: user-placed defenses, buildings with
 * structural health, floating debris, flow arrows and spray particles.
 * ------------------------------------------------------------------ */
'use strict';

const STRUCTURE_TYPES = {
  seawall:    { name: 'Seawall',               length: 64, width: 4,  crest: 7.0, drag: 0.0,  color: 0xb9bec4, segments: 1 },
  breakwater: { name: 'Breakwater',            length: 56, width: 12, crest: 2.0, drag: 0.22, color: 0x76695a, segments: 1 },
  segmented:  { name: 'Segmented Breakwater',  length: 78, width: 10, crest: 2.0, drag: 0.22, color: 0x76695a, segments: 5, gap: 6 },
  embankment: { name: 'Sloped Embankment',     length: 64, width: 26, crest: 4.0, drag: 0.03, color: 0x7d8f4c, segments: 1 },
};

/* ----------------------------- Structures ----------------------------- */
class StructureManager {
  constructor(scene, sim) {
    this.scene = scene; this.sim = sim; this.list = []; this.nextId = 1;
    this.group = new THREE.Group(); this.group.name = 'structures'; scene.add(this.group);
  }

  /* Build the display mesh for a structure type at a given world position/rotation. */
  makeMesh(type, x, z, rot, ghost) {
    const T = STRUCTURE_TYPES[type];
    const g = new THREE.Group();
    const base = this.groundUnder(x, z, rot, T);
    const mat = ghost
      ? new THREE.MeshStandardMaterial({ color: 0x56d68a, emissive: 0x56d68a, emissiveIntensity: 0.35, transparent: true, opacity: 0.62, depthWrite: false, roughness: 0.6 })
      : new THREE.MeshStandardMaterial({ color: T.color, roughness: type === 'seawall' ? 0.55 : 0.95, metalness: 0 });
    const bottom = base - 1.0;
    if (type === 'embankment') {
      const hgt = T.crest - bottom;
      const shape = new THREE.Shape();
      const hw = T.width / 2, top = T.width * 0.12;
      shape.moveTo(-hw, 0); shape.lineTo(hw, 0); shape.lineTo(top, hgt); shape.lineTo(-top, hgt); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: T.length, bevelEnabled: false });
      geo.rotateY(Math.PI / 2); geo.translate(-T.length / 2, 0, 0);
      const m = new THREE.Mesh(geo, mat); m.position.y = bottom; m.castShadow = !ghost; m.receiveShadow = true; g.add(m);
      // armour stripe on the seaward toe
      if (!ghost) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(T.length, 0.5, hw * 0.35), new THREE.MeshStandardMaterial({ color: 0x6d6a60, roughness: 1 }));
        stripe.position.set(0, bottom + hgt * 0.22, -hw * 0.62); stripe.rotation.x = Math.atan2(hgt, hw); g.add(stripe);
      }
    } else if (type === 'segmented') {
      const seg = (T.length - T.gap * (T.segments - 1)) / T.segments;
      for (let s = 0; s < T.segments; s++) {
        const cx = -T.length / 2 + seg / 2 + s * (seg + T.gap);
        const hgt = T.crest - bottom;
        const m = new THREE.Mesh(new THREE.BoxGeometry(seg, hgt, T.width), mat);
        m.position.set(cx, bottom + hgt / 2, 0); m.castShadow = !ghost; m.receiveShadow = true; g.add(m);
      }
    } else {
      const hgt = T.crest - bottom;
      const m = new THREE.Mesh(new THREE.BoxGeometry(T.length, hgt, T.width), mat);
      m.position.y = bottom + hgt / 2; m.castShadow = !ghost; m.receiveShadow = true; g.add(m);
      if (type === 'seawall' && !ghost) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(T.length + 0.6, 0.6, T.width + 0.8), new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.5 }));
        cap.position.y = T.crest + 0.3; cap.castShadow = true; g.add(cap);
      }
      if (type === 'breakwater' && !ghost) {
        const rk = new THREE.Mesh(new THREE.BoxGeometry(T.length * 0.98, 0.9, T.width * 0.7), new THREE.MeshStandardMaterial({ color: 0x8a7d6e, roughness: 1 }));
        rk.position.y = T.crest + 0.45; rk.castShadow = true; g.add(rk);
      }
    }
    if (ghost) {
      // bright outline so the preview reads at any zoom level
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
      const meshes = [];
      g.traverse(o => { if (o.isMesh) meshes.push(o); });
      for (const m of meshes) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat);
        edges.position.copy(m.position); edges.rotation.copy(m.rotation); edges.renderOrder = 20; edges.userData.outline = true;
        g.add(edges);
      }
    }
    g.position.set(x, 0, z); g.rotation.y = rot;
    g.userData.base = base;
    return g;
  }

  /* Lowest terrain elevation under the footprint (so meshes never float). */
  groundUnder(x, z, rot, T) {
    const c = Math.cos(rot), s = Math.sin(rot);
    let mn = Infinity;
    for (let a = -0.5; a <= 0.5; a += 0.1) for (let b = -0.5; b <= 0.5; b += 0.25) {
      const lx = a * T.length, lz = b * T.width;
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      const e = this.sim.bed[clampInt(cellJ(wz), 0, GRID_M - 1) * GRID_N + clampInt(cellI(wx), 0, GRID_N - 1)];
      if (e < mn) mn = e;
    }
    return mn === Infinity ? 0 : mn;
  }

  add(type, x, z, rot) {
    const mesh = this.makeMesh(type, x, z, rot, false);
    const st = { id: this.nextId++, type, x, z, rot, mesh };
    mesh.traverse(o => { o.userData.structure = st; });
    this.group.add(mesh);
    this.list.push(st);
    return st;
  }

  remove(st) {
    const i = this.list.indexOf(st);
    if (i >= 0) this.list.splice(i, 1);
    this.group.remove(st.mesh);
    disposeObject(st.mesh);
  }

  rotate(st, delta) {
    st.rot += delta;
    this.group.remove(st.mesh); disposeObject(st.mesh);
    st.mesh = this.makeMesh(st.type, st.x, st.z, st.rot, false);
    st.mesh.traverse(o => { o.userData.structure = st; });
    this.group.add(st.mesh);
  }

  clear() { while (this.list.length) this.remove(this.list[0]); }

  setHighlight(st, on) {
    if (!st) return;
    st.mesh.traverse(o => { if (o.isMesh) { o.material.emissive = new THREE.Color(on ? 0xff9a2a : 0x000000); o.material.emissiveIntensity = on ? 0.55 : 0; } });
  }

  /* Write structure elevations and drag into the simulation grid. */
  rasterize(crest, drag) {
    const sim = this.sim;
    for (const st of this.list) {
      const T = STRUCTURE_TYPES[st.type];
      const c = Math.cos(st.rot), s = Math.sin(st.rot);
      const R = Math.hypot(T.length, T.width) * 0.5 + CELL;
      const i0 = clampInt(cellI(st.x - R), 0, GRID_N - 1), i1 = clampInt(cellI(st.x + R), 0, GRID_N - 1);
      const j0 = clampInt(cellJ(st.z - R), 0, GRID_M - 1), j1 = clampInt(cellJ(st.z + R), 0, GRID_M - 1);
      const seg = T.segments > 1 ? (T.length - T.gap * (T.segments - 1)) / T.segments : T.length;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = worldX(i) - st.x, dz = worldZ(j) - st.z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) > T.length / 2 || Math.abs(lz) > T.width / 2) continue;
        if (T.segments > 1) {
          const u = (lx + T.length / 2) % (seg + T.gap);
          if (u > seg) continue;
        }
        const k = j * GRID_N + i;
        let el;
        if (st.type === 'embankment') {
          const hw = T.width / 2, top = T.width * 0.12, a = Math.abs(lz);
          const base = sim.bed[k];
          el = a <= top ? T.crest : T.crest - (T.crest - base) * (a - top) / (hw - top);
        } else el = T.crest;
        if (el > crest[k]) crest[k] = el;
        drag[k] = Math.max(drag[k], T.drag);
      }
    }
  }

  /* Does a candidate footprint overlap any building lot? */
  overlapsBuildings(type, x, z, rot, buildings) {
    const T = STRUCTURE_TYPES[type];
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const b of buildings.list) {
      for (const [px, pz] of [[b.x - b.w / 2, b.z - b.d / 2], [b.x + b.w / 2, b.z - b.d / 2], [b.x - b.w / 2, b.z + b.d / 2], [b.x + b.w / 2, b.z + b.d / 2], [b.x, b.z]]) {
        const dx = px - x, dz = pz - z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < T.length / 2 + 2 && Math.abs(lz) < T.width / 2 + 2) return true;
      }
    }
    return false;
  }
}

function disposeObject(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose(); }
  });
}

/* ----------------------------- Buildings ----------------------------- */
const BUILDING_PALETTE = [0xe8d9c0, 0xd9a78b, 0xc9d4de, 0xf1e4a8, 0xd6b7c8, 0xb8cfc2, 0xf0c9a1, 0xe0e0e0];

function generateBuildingLots() {
  const rnd = mulberry32(1234);
  const lots = [];
  const rows = [{ z: 35, w0: 8, w1: 15, hmin: 4, hmax: 8 }, { z: 56, w0: 9, w1: 16, hmin: 5, hmax: 12 }, { z: 72, w0: 9, w1: 18, hmin: 5, hmax: 14 },
                { z: 88, w0: 8, w1: 16, hmin: 6, hmax: 18 }, { z: 112, w0: 9, w1: 17, hmin: 5, hmax: 12 }, { z: 128, w0: 8, w1: 14, hmin: 4, hmax: 9 }];
  for (const r of rows) {
    for (let x = -124; x <= 100; x += 22 + rnd() * 10) {
      if (x > 78 && r.z > 58) continue;         // hill
      const w = r.w0 + rnd() * (r.w1 - r.w0), d = 8 + rnd() * 7;
      const cx = x + rnd() * 4 - 2, cz = r.z + rnd() * 5 - 2.5;
      // keep off roads
      let bad = false;
      for (const [px, pz] of [[cx - w / 2 - 1, cz - d / 2 - 1], [cx + w / 2 + 1, cz - d / 2 - 1], [cx - w / 2 - 1, cz + d / 2 + 1], [cx + w / 2 + 1, cz + d / 2 + 1]]) if (isRoad(px, pz)) bad = true;
      if (bad) continue;
      if (baseTerrain(cx, cz) < 2.4) continue;
      let hgt = r.hmin + rnd() * (r.hmax - r.hmin);
      if (rnd() < 0.12) hgt += 8;
      lots.push({ x: cx, z: cz, w, d, h: hgt, color: BUILDING_PALETTE[Math.floor(rnd() * BUILDING_PALETTE.length)] });
    }
  }
  return lots;
}

class BuildingManager {
  constructor(scene, sim, lots) {
    this.scene = scene; this.sim = sim; this.list = [];
    this.group = new THREE.Group(); this.group.name = 'buildings'; scene.add(this.group);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x6b5a4e, roughness: 0.95 });
    for (const l of lots) {
      const cells = [], ring = [];
      const i0 = cellI(l.x - l.w / 2), i1 = cellI(l.x + l.w / 2), j0 = cellJ(l.z - l.d / 2), j1 = cellJ(l.z + l.d / 2);
      let minBed = Infinity;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * GRID_N + i; cells.push(k);
        if (sim.bed0[k] < minBed) minBed = sim.bed0[k];
      }
      for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) {
        if (i >= i0 && i <= i1 && j >= j0 && j <= j1) continue;
        if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_M) continue;
        ring.push(j * GRID_N + i);
      }
      const mat = new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.85 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(l.w, l.h, l.d), mat);
      body.castShadow = true; body.receiveShadow = true;
      body.position.y = l.h / 2;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(l.w + 0.6, 0.5, l.d + 0.6), roofMat);
      roof.position.y = l.h + 0.25; roof.castShadow = true;
      const g = new THREE.Group(); g.add(body); g.add(roof);
      g.position.set(l.x, minBed - 0.3, l.z);
      this.group.add(g);
      const area = l.w * l.d;
      const b = {
        ...l, cells, ring, minBed, group: g, body, roof, mat, baseColor: new THREE.Color(l.color),
        health: 100, state: 'intact', collapse: 0,
        // bigger footprints and taller (reinforced) buildings resist more
        resist: 6000 + area * 70 + l.h * 700,
        volume: l.w * l.d * l.h,
      };
      this.list.push(b);
    }
  }

  rasterize(crest) {
    for (const b of this.list) {
      if (b.state === 'destroyed') continue;
      const top = b.minBed + b.h;
      for (const k of b.cells) if (top > crest[k]) crest[k] = top;
    }
  }

  reset() {
    for (const b of this.list) {
      b.health = 100; b.state = 'intact'; b.collapse = 0;
      b.group.visible = true; b.group.scale.set(1, 1, 1); b.group.rotation.set(0, 0, 0);
      b.group.position.y = b.minBed - 0.3;
      b.mat.color.copy(b.baseColor); b.body.material = b.mat;
    }
  }

  /* Apply hydrodynamic loading from the surrounding cells. Returns list of newly destroyed buildings. */
  update(dt, debris) {
    const sim = this.sim, h = sim.h, sp = sim.speed;
    const destroyed = [];
    for (const b of this.list) {
      if (b.state === 'destroyed') {
        if (b.collapse < 1) {
          b.collapse = Math.min(1, b.collapse + dt * 1.6);
          const c = b.collapse, e = 1 - (1 - c) * (1 - c);
          b.group.scale.y = 1 - 0.9 * e;
          b.group.rotation.z = b.tiltDir * 0.25 * e; b.group.rotation.x = b.tiltDir2 * 0.18 * e;
          b.group.position.y = b.minBed - 0.3 - 0.6 * e;
        }
        continue;
      }
      let force = 0;
      for (const k of b.ring) {
        const hk = h[k];
        if (hk < 0.05) continue;
        const s = sp[k];
        const f = 0.5 * 1000 * 9.81 * hk * hk + 1000 * hk * s * s;   // hydrostatic + dynamic (N per m of wall)
        if (f > force) force = f;
      }
      if (force > b.resist) {
        b.health -= (force - b.resist) / 10000 * 5.0 * dt;
        if (b.health <= 0) {
          b.health = 0; b.state = 'destroyed'; b.tiltDir = Math.random() < 0.5 ? -1 : 1; b.tiltDir2 = Math.random() - 0.5;
          b.body.material = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 1 });
          if (b._tmpMat) b._tmpMat.dispose();
          b._tmpMat = b.body.material;
          destroyed.push(b);
          if (debris) debris.spawnFromBuilding(b);
        } else if (b.health < 75 && b.state === 'intact') {
          b.state = 'damaged';
        }
      }
      if (b.state !== 'destroyed') {
        // visual: darken + slight lean with damage
        const d = 1 - b.health / 100;
        b.mat.color.copy(b.baseColor).multiplyScalar(1 - 0.45 * d);
        b.group.rotation.z = d * 0.08 * (b.x > 0 ? 1 : -1);
        b.group.position.y = b.minBed - 0.3 - d * 0.5;
      }
    }
    return destroyed;
  }

  counts() {
    let dmg = 0, des = 0;
    for (const b of this.list) { if (b.state === 'destroyed') des++; else if (b.state === 'damaged') dmg++; }
    return { damaged: dmg, destroyed: des, total: this.list.length };
  }

  integrity() {
    let tot = 0, cur = 0;
    for (const b of this.list) { tot += b.volume; cur += b.volume * b.health / 100; }
    return tot ? cur / tot : 1;
  }
}

/* ------------------------------- Debris ------------------------------- */
const MAX_DEBRIS = 320;
class DebrisManager {
  constructor(scene, sim) {
    this.scene = scene; this.sim = sim;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9 }), MAX_DEBRIS);
    this.mesh.castShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
    this.clear();
  }

  clear() {
    this.items.length = 0;
    const m = this._m.identity().makeScale(0.0001, 0.0001, 0.0001);
    for (let n = 0; n < MAX_DEBRIS; n++) { this.mesh.setMatrixAt(n, m); this.mesh.setColorAt(n, new THREE.Color(0xffffff)); }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  spawnFromBuilding(b) {
    const n = 6 + Math.floor(Math.min(10, b.volume / 250));
    const col = new THREE.Color(b.color), grey = new THREE.Color(0x8d857a);
    for (let q = 0; q < n; q++) {
      if (this.items.length >= MAX_DEBRIS) this.items.shift();
      const sx = 0.8 + Math.random() * 2.4, sy = 0.5 + Math.random() * 1.4, sz = 0.8 + Math.random() * 2.2;
      this.items.push({
        x: b.x + (Math.random() - 0.5) * b.w, z: b.z + (Math.random() - 0.5) * b.d, y: b.minBed + 0.5 + Math.random() * 2,
        vx: (Math.random() - 0.5) * 2, vz: (Math.random() - 0.5) * 2, vy: 0, sx, sy, sz,
        rot: Math.random() * Math.PI * 2, rotV: 0, color: Math.random() < 0.5 ? col.clone() : grey.clone(),
      });
    }
  }

  update(dt) {
    const sim = this.sim, m = this._m, q = this._q, e = this._e, s = this._s, p = this._p;
    for (let n = 0; n < MAX_DEBRIS; n++) {
      const d = this.items[n];
      if (!d) { m.makeScale(0.0001, 0.0001, 0.0001); this.mesh.setMatrixAt(n, m); continue; }
      const c = sim.sampleCell(cellI(d.x), cellJ(d.z));
      const ground = c.b;
      const floatH = d.sy * 0.45;
      if (c.h > floatH * 0.8) {
        // carried by the flow
        const k = Math.min(1, dt * 3.0);
        d.vx += (c.u - d.vx) * k; d.vz += (c.v - d.vz) * k;
        const targetY = ground + Math.max(c.h - floatH * 0.5, floatH * 0.3);
        d.y += (targetY - d.y) * Math.min(1, dt * 6);
        d.rotV += (Math.hypot(c.u, c.v) * 0.25 - d.rotV) * dt * 2;
      } else {
        d.vx *= Math.max(0, 1 - dt * 4); d.vz *= Math.max(0, 1 - dt * 4);
        d.y += (ground + d.sy * 0.5 - d.y) * Math.min(1, dt * 6);
        d.rotV *= Math.max(0, 1 - dt * 3);
      }
      d.x += d.vx * dt; d.z += d.vz * dt; d.rot += d.rotV * dt;
      if (d.x < -WORLD_HALF + 2) { d.x = -WORLD_HALF + 2; d.vx = 0; } else if (d.x > WORLD_HALF - 2) { d.x = WORLD_HALF - 2; d.vx = 0; }
      if (d.z < -WORLD_HALF + 2) { d.z = -WORLD_HALF + 2; d.vz = 0; } else if (d.z > WORLD_HALF - 2) { d.z = WORLD_HALF - 2; d.vz = 0; }
      e.set(0, d.rot, 0); q.setFromEuler(e); s.set(d.sx, d.sy, d.sz); p.set(d.x, d.y, d.z);
      m.compose(p, q, s); this.mesh.setMatrixAt(n, m);
      this.mesh.setColorAt(n, d.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/* ----------------------------- Flow arrows ----------------------------- */
class FlowField {
  constructor(scene, sim, stride) {
    this.scene = scene; this.sim = sim; this.stride = stride;
    this.nx = Math.floor(GRID_N / stride); this.nz = Math.floor(GRID_M / stride);
    const count = this.nx * this.nz;
    // flat arrow pointing +x, length 1, in the XZ plane
    const geo = new THREE.BufferGeometry();
    const v = new Float32Array([
      -0.5, 0, -0.12,   0.15, 0, -0.12,   0.15, 0, 0.12,
      -0.5, 0, -0.12,   0.15, 0, 0.12,   -0.5, 0, 0.12,
       0.1, 0, -0.32,   0.5, 0, 0,        0.1, 0, 0.32,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.renderOrder = 8; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); this._c = new THREE.Color();
  }

  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }

  update() {
    if (!this.mesh.visible) return;
    const sim = this.sim, st = this.stride, m = this._m, q = this._q, e = this._e, s = this._s, p = this._p, c = this._c;
    let n = 0;
    for (let jj = 0; jj < this.nz; jj++) for (let ii = 0; ii < this.nx; ii++) {
      const i = ii * st + (st >> 1), j = jj * st + (st >> 1);
      const cell = sim.sampleCell(i, j);
      const spd = Math.hypot(cell.u, cell.v);
      if (cell.h < 0.06 || spd < 0.25) { m.makeScale(0.0001, 0.0001, 0.0001); this.mesh.setMatrixAt(n++, m); continue; }
      const len = Math.min(7, 1.2 + spd * 0.55);
      e.set(0, Math.atan2(-cell.v, cell.u), 0); q.setFromEuler(e);
      s.set(len, 1, Math.min(2.2, 1 + spd * 0.12)); p.set(worldX(i), cell.b + cell.h + 0.35, worldZ(j));
      m.compose(p, q, s); this.mesh.setMatrixAt(n, m);
      const t = Math.min(1, spd / 9);
      if (t < 0.5) c.setRGB(0.2 + t * 1.6, 0.9, 1 - t * 1.6); else c.setRGB(1, 0.9 - (t - 0.5) * 1.6, 0.1);
      this.mesh.setColorAt(n, c);
      n++;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/* ------------------------------- Spray -------------------------------- */
const MAX_SPRAY = 1800;
class SprayParticles {
  constructor(scene, sim) {
    this.scene = scene; this.sim = sim;
    this.pos = new Float32Array(MAX_SPRAY * 3);
    this.vel = new Float32Array(MAX_SPRAY * 3);
    this.life = new Float32Array(MAX_SPRAY);
    this.alpha = new Float32Array(MAX_SPRAY);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 260 } },
      vertexShader: `attribute float aAlpha; varying float vA; uniform float uSize;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize / max(1.0, -mv.z) * (0.6 + 0.4 * aAlpha); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard; float a = (1.0 - r * 4.0) * vA * 0.85; gl_FragColor = vec4(0.97, 0.99, 1.0, a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; this.points.renderOrder = 9;
    scene.add(this.points);
    this.next = 0;
    this.clear();
  }

  clear() {
    this.life.fill(0); this.alpha.fill(0);
    for (let n = 0; n < MAX_SPRAY; n++) this.pos[n * 3 + 1] = -100;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }

  emit(x, y, z, vx, vy, vz) {
    const n = this.next; this.next = (n + 1) % MAX_SPRAY;
    this.pos[n * 3] = x; this.pos[n * 3 + 1] = y; this.pos[n * 3 + 2] = z;
    this.vel[n * 3] = vx; this.vel[n * 3 + 1] = vy; this.vel[n * 3 + 2] = vz;
    this.life[n] = 0.7 + Math.random() * 0.6; this.alpha[n] = 1;
  }

  update(dt, active) {
    const sim = this.sim;
    if (active) {
      // sample random cells; emit where the flow is violent
      const tries = 220;
      for (let t = 0; t < tries; t++) {
        const k = (Math.random() * sim.size) | 0;
        const f = sim.foam[k], s = sim.speed[k], h = sim.h[k];
        if (h < 0.08 || s < 3.6 || f < 0.35) continue;
        const i = k % GRID_N, j = (k / GRID_N) | 0;
        const c = sim.sampleCell(i, j);
        const x = worldX(i) + (Math.random() - 0.5) * CELL, z = worldZ(j) + (Math.random() - 0.5) * CELL;
        const up = 2 + Math.random() * (2 + s * 0.6);
        this.emit(x, c.b + c.h + 0.3, z, c.u * 0.6 + (Math.random() - 0.5) * 3, up, c.v * 0.6 + (Math.random() - 0.5) * 3);
        if (s > 6 && Math.random() < 0.5) this.emit(x, c.b + c.h + 0.5, z, c.u * 0.4 + (Math.random() - 0.5) * 4, up * 1.3, c.v * 0.4 + (Math.random() - 0.5) * 4);
      }
    }
    const pos = this.pos, vel = this.vel, life = this.life, al = this.alpha;
    for (let n = 0; n < MAX_SPRAY; n++) {
      if (life[n] <= 0) continue;
      life[n] -= dt;
      if (life[n] <= 0) { al[n] = 0; pos[n * 3 + 1] = -100; continue; }
      vel[n * 3 + 1] -= 9.81 * dt;
      pos[n * 3] += vel[n * 3] * dt; pos[n * 3 + 1] += vel[n * 3 + 1] * dt; pos[n * 3 + 2] += vel[n * 3 + 2] * dt;
      al[n] = Math.min(1, life[n] * 1.5);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }
}
