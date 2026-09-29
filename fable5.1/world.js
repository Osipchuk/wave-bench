/* ------------------------------------------------------------------
 * World: grid layout, terrain generation, scene lighting, terrain and
 * water meshes, and static decoration (pier, lighthouse, trees).
 * ------------------------------------------------------------------ */
'use strict';

const GRID_N = 160, GRID_M = 160, CELL = 2.0;
const WORLD_HALF = GRID_N * CELL * 0.5;
function worldX(i) { return (i - (GRID_N - 1) * 0.5) * CELL; }
function worldZ(j) { return (j - (GRID_M - 1) * 0.5) * CELL; }
function cellI(x) { return Math.round(x / CELL + (GRID_N - 1) * 0.5); }
function cellJ(z) { return Math.round(z / CELL + (GRID_M - 1) * 0.5); }
function clampInt(a, lo, hi) { return a < lo ? lo : a > hi ? hi : a; }

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss2(dx, dz, sx, sz) { return Math.exp(-(dx * dx / (2 * sx * sx) + dz * dz / (2 * sz * sz))); }
function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/* Shoreline offset: makes the coast gently curved so wave fronts refract. */
function shoreOffset(x) { return 6 * Math.sin(x / 60) + 2.5 * Math.sin(x / 25 + 1); }

/* Base terrain elevation (m above sea level). */
function baseTerrain(x, z) {
  const zz = z - shoreOffset(x);
  let e;
  if (zz < -40) e = -3 + (zz + 40) * (11 / 120);
  else if (zz < 0) e = -3 + (zz + 40) * (3 / 40);
  else if (zz < 24) e = zz * (2.6 / 24);
  else e = 2.6 + (zz - 24) * 0.03;
  const off = smooth01(-zz / 10);                    // 1 offshore, 0 on land
  e += off * (2.2 * gauss2(x - 60, z + 75, 26, 32) - 2.2 * gauss2(x + 78, z + 60, 18, 45));
  const land = smooth01((zz - 20) / 10);
  e += land * 15 * gauss2(x - 118, z - 118, 42, 42);   // coastal hill (lighthouse)
  e -= land * 1.7 * gauss2(x + 45, z - 64, 38, 24);    // low-lying district
  e += land * 3.0 * gauss2(x + 120, z - 140, 40, 35);  // gentle rise at back-left
  const nz = 0.32 * Math.sin(x / 13) * Math.cos(z / 17) + 0.18 * Math.sin(x / 7 + z / 11) + 0.12 * Math.cos(x / 4.3 - z / 5.1);
  e += nz * (0.25 + 0.75 * land);
  return Math.max(-14.5, e);
}

/* Road mask in world coords. */
function isRoad(x, z) {
  if (Math.abs(z - 44) < 3.4 && x > -134 && x < 92) return true;
  if (Math.abs(z - 100) < 3.0 && x > -134 && x < 60) return true;
  if (Math.abs(z - 26) < 2.2 && x > -120 && x < 90) return true;   // seaside promenade
  for (const rx of [-82, -22, 40]) if (Math.abs(x - rx) < 2.8 && z > 24 && z < 142) return true;
  if (Math.abs(x - 92) < 2.8 && z > 40 && z < 100) return true;
  return false;
}

class World {
  constructor(scene, sim) {
    this.scene = scene; this.sim = sim;
    this.landMask = new Uint8Array(sim.size);   // 1 = dry land at rest (for flood metrics)
    this.roadMask = new Uint8Array(sim.size);
    this.baseColor = new Float32Array(sim.size * 3);
    this.buildTerrainData();
    this.buildLights();
    this.buildTerrainMesh();
    this.buildWaterMesh();
    this.buildDecor();
    this.frame = 0;
  }

  buildTerrainData() {
    const sim = this.sim, N = GRID_N, M = GRID_M;
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, x = worldX(i), z = worldZ(j);
      const e = baseTerrain(x, z);
      sim.bed0[k] = e; sim.bed[k] = e;
      const zz = z - shoreOffset(x);
      // erodibility: sandy beach and near-shore sand bars, weak inland soil, none on rock/hill
      let er = 0;
      if (zz > -34 && zz < 30) er = 1;
      else if (zz >= 30) er = 0.18 * smooth01((110 - zz) / 30);
      else er = smooth01((zz + 60) / 26) * 0.25;
      if (e > 9) er *= smooth01((13 - e) / 4);
      sim.erod[k] = er;
      this.landMask[k] = e > 2.3 ? 1 : 0;   // inland ground behind the beach crest
      this.roadMask[k] = isRoad(x, z) && e > 1.0 ? 1 : 0;
    }
    // static base colours
    const rnd = mulberry32(7);
    const c = this.baseColor;
    for (let k = 0; k < sim.size; k++) {
      const e = sim.bed0[k];
      const er = sim.erod[k];
      let r, g, b;
      if (e < -0.4) {
        const t = smooth01((-e - 0.4) / 12);
        r = 0.62 + (0.16 - 0.62) * t; g = 0.58 + (0.28 - 0.58) * t; b = 0.44 + (0.34 - 0.44) * t;
      } else if (er > 0.6 && e < 3.2) {
        r = 0.88; g = 0.80; b = 0.60;
        const t = smooth01((e - 2.2) / 1.2);       // dune grass creeping in
        r += (0.55 - r) * t * 0.5; g += (0.62 - g) * t * 0.5; b += (0.32 - b) * t * 0.5;
      } else {
        const t = smooth01((e - 3) / 9);
        r = 0.36 + (0.50 - 0.36) * t; g = 0.55 + (0.50 - 0.55) * t; b = 0.24 + (0.30 - 0.24) * t;
        if (e > 12) { const s = smooth01((e - 12) / 4); r += (0.55 - r) * s; g += (0.53 - g) * s; b += (0.5 - b) * s; }
      }
      if (this.roadMask[k]) { r = 0.30; g = 0.31; b = 0.33; }
      const n = 0.94 + rnd() * 0.12;
      c[k * 3] = r * n; c[k * 3 + 1] = g * n; c[k * 3 + 2] = b * n;
    }
  }

  buildLights() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x9fc8e6);
    scene.fog = new THREE.Fog(0x9fc8e6, 380, 900);
    const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5f6b4a, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.35);
    sun.position.set(-160, 220, -120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -200; sc.right = 200; sc.top = 200; sc.bottom = -200; sc.near = 50; sc.far = 700;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.5;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
    this.sunDir = sun.position.clone().normalize();
    const amb = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(amb);
  }

  makeGridGeometry() {
    const N = GRID_N, M = GRID_M;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * M * 3);
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i; pos[k * 3] = worldX(i); pos[k * 3 + 1] = 0; pos[k * 3 + 2] = worldZ(j);
    }
    const idx = new Uint32Array((N - 1) * (M - 1) * 6);
    let p = 0;
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  buildTerrainMesh() {
    const geo = this.makeGridGeometry();
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.sim.size * 3), 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = true;
    mesh.name = 'terrain';
    this.scene.add(mesh);
    this.terrain = mesh;
    // skirt so the edges of the world do not look paper thin
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(GRID_N * CELL, 30, GRID_M * CELL), new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 1 }));
    skirt.position.y = -15 - 14.5;
    this.scene.add(skirt);
    this.updateTerrain(true);
  }

  updateTerrain(force) {
    const sim = this.sim, geo = this.terrain.geometry;
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    const base = this.baseColor, bed = sim.bed, bed0 = sim.bed0, wet = sim.wet;
    for (let k = 0; k < sim.size; k++) {
      pos[k * 3 + 1] = bed[k];
      const cut = bed0[k] - bed[k];
      let r = base[k * 3], g = base[k * 3 + 1], b = base[k * 3 + 2];
      if (cut > 0.05) {
        const t = Math.min(1, cut / 1.6);
        r += (0.52 - r) * t; g += (0.42 - g) * t; b += (0.30 - b) * t;   // exposed darker wet sediment
      }
      const w = wet[k];
      if (w > 0.01) { const f = 1 - 0.38 * w; r *= f; g *= f; b *= f * 1.04; }
      col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    if (force || (this.frame % 8 === 0)) { geo.computeVertexNormals(); }
    if (!geo.boundingSphere) geo.computeBoundingSphere();
  }

  buildWaterMesh() {
    const geo = this.makeGridGeometry();
    const S = this.sim.size;
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(S * 3), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(S), 1));
    geo.setAttribute('aFoam', new THREE.BufferAttribute(new Float32Array(S), 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(new Float32Array(S), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: this.sunDir.clone() },
        uFogColor: { value: new THREE.Color(0x9fc8e6) },
        uFogNear: { value: 380 }, uFogFar: { value: 900 },
      },
      vertexShader: `
        attribute float aDepth; attribute float aFoam; attribute float aSpeed;
        varying vec3 vNormal; varying vec3 vWorld; varying float vDepth; varying float vFoam; varying float vSpeed;
        void main() {
          vNormal = normal; vDepth = aDepth; vFoam = aFoam; vSpeed = aSpeed;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uSun; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
        varying vec3 vNormal; varying vec3 vWorld; varying float vDepth; varying float vFoam; varying float vSpeed;
        void main() {
          float t = uTime;
          vec3 p = vWorld;
          // small animated ripples on top of the simulated slope
          float camDist = length(cameraPosition - p);
          float rip = (0.07 + 0.04 * min(vSpeed, 4.0)) * (1.0 - smoothstep(150.0, 600.0, camDist));
          vec3 n = vNormal + rip * vec3(
            sin(p.x * 0.38 + t * 1.6) + 0.6 * sin(p.z * 0.55 - t * 1.3 + p.x * 0.17),
            0.0,
            cos(p.x * 0.47 - t * 1.5 + p.z * 0.11) + 0.6 * sin(p.z * 0.31 + t * 1.9));
          n = normalize(n);
          vec3 viewDir = normalize(cameraPosition - p);
          float diff = max(dot(n, uSun), 0.0);
          vec3 hv = normalize(uSun + viewDir);
          float spec = pow(max(dot(n, hv), 0.0), 140.0) * 1.1;
          float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
          float dfac = 1.0 - exp(-vDepth * 0.22);
          vec3 shallow = vec3(0.30, 0.78, 0.76);
          vec3 deep = vec3(0.02, 0.19, 0.42);
          vec3 col = mix(shallow, deep, dfac);
          // turbid, energetic water looks greener/browner
          float turb = clamp(vSpeed * 0.12, 0.0, 0.55) * (1.0 - dfac * 0.5);
          col = mix(col, vec3(0.34, 0.50, 0.42), turb);
          col = col * (0.42 + 0.72 * diff);
          vec3 sky = vec3(0.66, 0.80, 0.94);
          col += fres * sky * 0.55 + spec * vec3(1.0, 0.97, 0.9);
          // foam
          float fm = clamp(vFoam, 0.0, 1.0);
          float fpat = 0.65 + 0.35 * sin(p.x * 2.3 + t * 3.0) * sin(p.z * 2.9 - t * 2.2);
          col = mix(col, vec3(0.96, 0.98, 1.0), fm * fpat * 0.92);
          float alpha = (0.58 + 0.38 * dfac) * smoothstep(0.0, 0.28, vDepth);
          alpha = min(0.95, alpha + fm * 0.35);
          float dist = length(cameraPosition - p);
          float fog = smoothstep(uFogNear, uFogFar, dist);
          col = mix(col, uFogColor, fog);
          gl_FragColor = vec4(col, alpha);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    mesh.name = 'water';
    this.scene.add(mesh);
    this.water = mesh;
    this.updateWater();
  }

  updateWater(time) {
    const sim = this.sim, geo = this.water.geometry, N = GRID_N, M = GRID_M;
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
    const dep = geo.attributes.aDepth.array, foam = geo.attributes.aFoam.array, spd = geo.attributes.aSpeed.array;
    const h = sim.h, b = sim.b, bed = sim.bed, fo = sim.foam, sp = sim.speed;
    // surface heights: dry cells sink a little under the *terrain* (not under
    // structure crests) so no water curtain climbs up walls and buildings
    for (let k = 0; k < sim.size; k++) {
      const hk = h[k];
      pos[k * 3 + 1] = hk > 0.012 ? b[k] + hk : bed[k] - 0.25;
      dep[k] = hk; foam[k] = fo[k]; spd[k] = sp[k];
    }
    // normals from the height field
    const inv = 1 / (2 * CELL);
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const yl = pos[(i > 0 ? k - 1 : k) * 3 + 1], yr = pos[(i < N - 1 ? k + 1 : k) * 3 + 1];
      const yd = pos[(j > 0 ? k - N : k) * 3 + 1], yu = pos[(j < M - 1 ? k + N : k) * 3 + 1];
      let nx = -(yr - yl) * inv, nz = -(yu - yd) * inv;
      // dry edges: flatten to avoid spiky normals along the tongue
      if (h[k] < 0.012) { nx *= 0.2; nz *= 0.2; }
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      nor[k * 3] = nx / len; nor[k * 3 + 1] = 1 / len; nor[k * 3 + 2] = nz / len;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.aDepth.needsUpdate = true;
    geo.attributes.aFoam.needsUpdate = true;
    geo.attributes.aSpeed.needsUpdate = true;
    if (time !== undefined) this.water.material.uniforms.uTime.value = time;
  }

  buildDecor() {
    const scene = this.scene, sim = this.sim;
    const group = new THREE.Group(); group.name = 'decor';
    // pier
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x8a6d4b, roughness: 0.9 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5c4630, roughness: 0.9 });
    const pierX = -48, z0 = 8, z1 = -52;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, z0 - z1), deckMat);
    deck.position.set(pierX, 3.0, (z0 + z1) / 2); deck.castShadow = true; deck.receiveShadow = true;
    group.add(deck);
    for (let z = z1 + 3; z <= z0; z += 6) for (const sx of [-2.2, 2.2]) {
      const bed = baseTerrain(pierX + sx, z);
      const hgt = 3.0 - bed;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, hgt, 6), postMat);
      post.position.set(pierX + sx, bed + hgt / 2, z); post.castShadow = true;
      group.add(post);
    }
    // lighthouse on the hill
    const lx = 118, lz = 118, lb = baseTerrain(lx, lz);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.0, 16, 14), new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.7 }));
    tower.position.set(lx, lb + 8, lz); tower.castShadow = true; group.add(tower);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 2.6, 14), new THREE.MeshStandardMaterial({ color: 0xc83b32, roughness: 0.6 }));
    cap.position.set(lx, lb + 17.3, lz); cap.castShadow = true; group.add(cap);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffc94a, emissiveIntensity: 0.8 }));
    lamp.position.set(lx, lb + 19.5, lz); group.add(lamp);
    // beach umbrellas & benches (scale cues)
    const umbMat = [0xe0554c, 0xf2c14e, 0x3fa7d6, 0xffffff];
    for (let n = 0; n < 7; n++) {
      const x = -110 + n * 30 + (n % 2) * 8, z = 14 + shoreOffset(x) + (n % 3) * 2.5;
      const bed = baseTerrain(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 5), postMat);
      pole.position.set(x, bed + 1.3, z); group.add(pole);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.7, 10), new THREE.MeshStandardMaterial({ color: umbMat[n % 4], roughness: 0.8 }));
      top.position.set(x, bed + 2.7, z); top.castShadow = true; group.add(top);
    }
    // buoys offshore
    for (let n = 0; n < 5; n++) {
      const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), new THREE.MeshStandardMaterial({ color: n % 2 ? 0xff7a2a : 0xf5f5f5, roughness: 0.5 }));
      buoy.position.set(-120 + n * 60, 0.4, -70 - (n % 2) * 20);
      buoy.userData.buoy = true;
      group.add(buoy);
    }
    this.buoys = group.children.filter(c => c.userData.buoy);
    scene.add(group);
    this.decor = group;

    // trees (instanced)
    const rnd = mulberry32(42);
    const trees = [];
    for (let n = 0; n < 900 && trees.length < 110; n++) {
      const x = -150 + rnd() * 300, z = 30 + rnd() * 125;
      const e = baseTerrain(x, z);
      if (e < 3.0 || e > 14) continue;
      if (isRoad(x, z)) continue;
      let near = false;
      for (const b of (window.BUILDING_LOTS || [])) if (Math.abs(x - b.x) < b.w / 2 + 3 && Math.abs(z - b.z) < b.d / 2 + 3) { near = true; break; }
      if (near) continue;
      trees.push({ x, z, e, s: 0.8 + rnd() * 0.7, alive: true });
    }
    this.trees = trees;
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.8, 5, 7), new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.9 }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.35, 1.6, 6), postMat, trees.length);
    crown.castShadow = true; trunk.castShadow = true;
    scene.add(crown); scene.add(trunk);
    this.treeCrown = crown; this.treeTrunk = trunk;
    this.updateTrees(true);
  }

  updateTrees(force) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let changed = force;
    for (let n = 0; n < this.trees.length; n++) {
      const t = this.trees[n];
      if (!force && t.alive) {
        const c = this.sim.sampleCell(cellI(t.x), cellJ(t.z));
        if (c.h > 1.2 && Math.sqrt(c.u * c.u + c.v * c.v) > 3.2) { t.alive = false; changed = true; }
        else continue;
      } else if (!force) continue;
      const sc = t.alive ? t.s : 0.0001;
      s.set(sc, sc, sc); q.identity();
      p.set(t.x, t.e + 1.6 * sc + 2.5 * sc, t.z); m.compose(p, q, s); this.treeCrown.setMatrixAt(n, m);
      p.set(t.x, t.e + 0.8 * sc, t.z); m.compose(p, q, s); this.treeTrunk.setMatrixAt(n, m);
    }
    if (changed) { this.treeCrown.instanceMatrix.needsUpdate = true; this.treeTrunk.instanceMatrix.needsUpdate = true; }
  }

  resetTrees() { for (const t of this.trees) t.alive = true; this.updateTrees(true); }

  updateBuoys(time) {
    for (const b of this.buoys) {
      const c = this.sim.sampleCell(cellI(b.position.x), cellJ(b.position.z));
      b.position.y = c.b + c.h + 0.25 + 0.15 * Math.sin(time * 1.7 + b.position.x);
    }
  }
}
