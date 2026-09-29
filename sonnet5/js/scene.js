/* Three.js presentation layer: consumes Simulation state, never mutates it (except via explicit calls). */

const WATER_VERT = `
attribute float aDepth;
attribute float aSpeed;
attribute float aTurb;
varying float vDepth;
varying float vSpeed;
varying float vTurb;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vDepth = aDepth;
  vSpeed = aSpeed;
  vTurb = aTurb;
  vNormal = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WATER_FRAG = `
precision highp float;
varying float vDepth;
varying float vSpeed;
varying float vTurb;
varying vec3 vWorldPos;
varying vec3 vNormal;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSunDir;
uniform vec3 uFoamColor;

float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
  vec2 u=f*f*(3.0-2.0*f);
  return mix(a,b,u.x)+ (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}

void main() {
  float depthT = clamp(vDepth / 6.0, 0.0, 1.0);
  vec3 base = mix(uShallow, uDeep, depthT);

  vec3 n = normalize(vNormal + vec3(
    noise(vWorldPos.xz*0.6+uTime*0.3)-0.5,
    0.0,
    noise(vWorldPos.xz*0.6-uTime*0.25)-0.5) * 0.12);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 48.0);
  vec3 skyTint = vec3(0.72, 0.85, 0.92);

  float shoreFoam = smoothstep(0.55, 0.02, vDepth) * smoothstep(0.02, 0.12, vDepth);
  float speedFoam = smoothstep(2.0, 5.5, vSpeed);
  float turbFoam = smoothstep(0.15, 0.7, vTurb);
  float foamN = noise(vWorldPos.xz*1.3 + uTime*0.6);
  float foam = clamp((shoreFoam*1.2 + speedFoam*0.9 + turbFoam*0.8) * (0.5+0.5*foamN), 0.0, 1.0);

  vec3 color = mix(base, skyTint, fresnel*0.45);
  color += spec * 0.6;
  color = mix(color, uFoamColor, foam);

  float alpha = smoothstep(0.0, 0.10, vDepth) * 0.92 + 0.08;
  alpha = clamp(alpha, 0.0, 0.97);
  gl_FragColor = vec4(color, alpha);
}`;

class SceneManager {
  constructor(sim, container) {
    this.sim = sim;
    this.container = container;
    this.showFlow = false;
    this.selectedDefenseId = null;
    this.debris = [];
    this.followWave = false;
    this._buildingFlash = new Map();

    this._initThree();
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildWater();
    this._buildBuildings();
    this._buildFlowArrows();
    this._buildDebrisPool();
    this.ghost = null;
    this.defenseMeshes = new Map(); // id -> THREE.Group

    window.addEventListener('resize', () => this._onResize());
  }

  _initThree() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.5, 600);
    this.camera.position.set(6, 62, 92);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 220;
    this.controls.target.set(4, 2, 6);
    this.controls.update();

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  }

  setCameraDragEnabled(enabled) {
    this.controls.mouseButtons.LEFT = enabled ? THREE.MOUSE.ROTATE : null;
  }

  _buildSky() {
    const skyGeo = new THREE.SphereGeometry(400, 24, 16);
    const colors = [];
    const pos = skyGeo.attributes.position;
    const top = new THREE.Color(0x2f6fa8), horizon = new THREE.Color(0xcfeaf2);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 400;
      const t = THREE.MathUtils.clamp(y * 0.9 + 0.15, 0, 1);
      const c = horizon.clone().lerp(top, t);
      colors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xcfeaf2, 140, 380);
    this.scene.background = new THREE.Color(0xbfe3ef);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xddeeff, 0x3a4a35, 0.65);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d8, 1.15);
    sun.position.set(-60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun);
    this.sunDir = sun.position.clone().normalize();
    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.25));
  }

  // ---------- terrain ----------
  _buildTerrain() {
    const { NX, NZ } = GRID;
    const geo = new THREE.BufferGeometry();
    const count = NX * NZ;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const indices = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i;
        positions[n * 3] = simToWorldX(i);
        positions[n * 3 + 1] = this.sim.terrain[n];
        positions[n * 3 + 2] = simToWorldZ(j);
        normals[n * 3 + 1] = 1;
      }
    }
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    geo.setIndex(indices);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = false;
    this.scene.add(this.terrainMesh);

    this._terrainColors = colors;
    this._updateTerrainGeometry(true);

    // simple road strips through town for scale/detail
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x54525a, roughness: 1 });
    const roadGeo = new THREE.PlaneGeometry(1, 60);
    for (const rx of [4, 52, 96]) {
      const road = new THREE.Mesh(roadGeo, roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(simToWorldX(rx) , 3.35, simToWorldZ(74));
      road.receiveShadow = true;
      this.scene.add(road);
    }
    const crossRoad = new THREE.Mesh(new THREE.PlaneGeometry(120, 1), roadMat);
    crossRoad.rotation.x = -Math.PI / 2;
    crossRoad.position.set(0, 3.3, simToWorldZ(74));
    crossRoad.receiveShadow = true;
    this.scene.add(crossRoad);

    // small scale-reference props (lamp posts) along the beach
    this.props = new THREE.Group();
    const postGeo = new THREE.CylinderGeometry(0.15, 0.15, 3.2, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
    for (let px = 6; px < GRID.NX - 6; px += 14) {
      const post = new THREE.Mesh(postGeo, postMat);
      const gz = ZONE.beachEnd + 3;
      post.position.set(simToWorldX(px), this.sim.groundHeightAt(px, gz) + 1.6, simToWorldZ(gz));
      post.castShadow = true;
      this.props.add(post);
    }
    this.scene.add(this.props);
  }

  _sandColorAt(elev, wet) {
    if (elev < -0.3) return [0.08, 0.22, 0.32];
    if (elev < 0.15) return wet ? [0.62, 0.58, 0.42] : [0.82, 0.76, 0.55];
    if (elev < 2.6) return wet ? [0.70, 0.63, 0.42] : [0.87, 0.79, 0.56];
    const g = 0.30 + Math.min(1, (elev - 2.6) / 8) * 0.12;
    return [0.27, g + 0.15, 0.20];
  }

  _updateTerrainGeometry(force) {
    const { NX, NZ } = GRID;
    const pos = this.terrainMesh.geometry.attributes.position;
    const col = this.terrainMesh.geometry.attributes.color;
    const T = this.sim.terrain, W = this.sim.wetness;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i;
        pos.array[n * 3 + 1] = T[n];
        const c = this._sandColorAt(T[n], W[n] > 0.15);
        col.array[n * 3] = c[0]; col.array[n * 3 + 1] = c[1]; col.array[n * 3 + 2] = c[2];
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this._computeGridNormals(pos.array, this.terrainMesh.geometry.attributes.normal.array, NX, NZ);
    this.terrainMesh.geometry.attributes.normal.needsUpdate = true;
    if (force) this.terrainMesh.geometry.computeBoundingSphere();
  }

  _computeGridNormals(posArr, normArr, NX, NZ) {
    const dx = GRID.DX, dz = GRID.DZ;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i;
        const hL = posArr[(j * NX + Math.max(0, i - 1)) * 3 + 1];
        const hR = posArr[(j * NX + Math.min(NX - 1, i + 1)) * 3 + 1];
        const hD = posArr[(Math.max(0, j - 1) * NX + i) * 3 + 1];
        const hU = posArr[(Math.min(NZ - 1, j + 1) * NX + i) * 3 + 1];
        const nx = (hL - hR) / (2 * dx);
        const nz = (hD - hU) / (2 * dz);
        const len = Math.hypot(nx, 1, nz);
        normArr[n * 3] = nx / len; normArr[n * 3 + 1] = 1 / len; normArr[n * 3 + 2] = nz / len;
      }
    }
  }

  // ---------- water ----------
  _buildWater() {
    const { NX, NZ } = GRID;
    const geo = new THREE.BufferGeometry();
    const count = NX * NZ;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const aDepth = new Float32Array(count);
    const aSpeed = new Float32Array(count);
    const aTurb = new Float32Array(count);
    const indices = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i;
        positions[n * 3] = simToWorldX(i);
        positions[n * 3 + 1] = this.sim.h[n];
        positions[n * 3 + 2] = simToWorldZ(j);
        normals[n * 3 + 1] = 1;
      }
    }
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    geo.setIndex(indices);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
    geo.setAttribute('aTurb', new THREE.BufferAttribute(aTurb, 1));

    this.waterUniforms = {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(0x2fb4c6) },
      uDeep: { value: new THREE.Color(0x0a2c52) },
      uSunDir: { value: this.sunDir.clone() },
      uFoamColor: { value: new THREE.Color(0xf3fbff) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: this.waterUniforms,
      transparent: true,
      depthWrite: true,
    });
    this.waterMesh = new THREE.Mesh(geo, mat);
    this.waterMesh.castShadow = false;
    this.waterMesh.receiveShadow = false;
    this.scene.add(this.waterMesh);
  }

  _updateWaterGeometry(dt) {
    const { NX, NZ } = GRID;
    const geo = this.waterMesh.geometry;
    const pos = geo.attributes.position.array;
    const aDepth = geo.attributes.aDepth.array;
    const aSpeed = geo.attributes.aSpeed.array;
    const aTurb = geo.attributes.aTurb.array;
    const h = this.sim.h, T = this.sim.terrain, U = this.sim.u, V = this.sim.v, Turb = this.sim.turbulence;
    for (let n = 0; n < NX * NZ; n++) {
      const D = Math.max(h[n] - T[n], 0);
      pos[n * 3 + 1] = D > 0.001 ? h[n] : T[n] - 0.02;
      aDepth[n] = D;
      aSpeed[n] = Math.hypot(U[n], V[n]);
      aTurb[n] = Turb[n];
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aDepth.needsUpdate = true;
    geo.attributes.aSpeed.needsUpdate = true;
    geo.attributes.aTurb.needsUpdate = true;
    this._computeGridNormals(pos, geo.attributes.normal.array, NX, NZ);
    geo.attributes.normal.needsUpdate = true;
    this.waterUniforms.uTime.value += dt;
  }

  // ---------- buildings ----------
  _buildBuildings() {
    this.buildingGroup = new THREE.Group();
    this.scene.add(this.buildingGroup);
    for (const b of this.sim.buildings) {
      const group = new THREE.Group();
      const hue = 0.08 + b.colorSeed * 0.06;
      const bodyColor = new THREE.Color().setHSL(hue, 0.28, 0.62);
      const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a4a3a, roughness: 0.8 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), bodyMat);
      body.position.y = b.h / 2;
      body.castShadow = true; body.receiveShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(b.w, b.d) * 0.72, b.h * 0.42, 4), roofMat);
      roof.position.y = b.h + (b.h * 0.42) / 2 - 0.05;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(body, roof);
      const gy = this.sim.groundHeightAt(b.x, b.z);
      group.position.set(simToWorldX(b.x), gy, simToWorldZ(b.z));
      group.rotation.y = b.rotY;
      this.buildingGroup.add(group);
      b.mesh = { group, body, roof, bodyMat, roofMat, baseColor: bodyColor.clone() };
    }
  }

  _updateBuildings() {
    for (const b of this.sim.buildings) {
      const m = b.mesh;
      if (!m) continue;
      if (b.state === 'destroyed') {
        if (m.group.visible) {
          m.group.visible = false;
          this._spawnDebris(b);
        }
        continue;
      }
      m.group.visible = true;
      if (b.state === 'damaged') {
        const t = 1 - b.health / 100;
        m.bodyMat.color.copy(m.baseColor).lerp(new THREE.Color(0x3a352f), Math.min(0.6, t));
        m.group.rotation.z = Math.sin(b.id.length + b.health) * 0.03 * t;
      } else {
        m.bodyMat.color.copy(m.baseColor);
        m.group.rotation.z = 0;
      }
    }
  }

  _buildDebrisPool() {
    this.debrisGroup = new THREE.Group();
    this.scene.add(this.debrisGroup);
  }

  _spawnDebris(b) {
    const pieces = 5;
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a7f6a, roughness: 1 });
    for (let k = 0; k < pieces; k++) {
      const size = 0.6 + Math.random() * 1.1;
      const geo = new THREE.BoxGeometry(size, size * 0.6, size);
      const mesh = new THREE.Mesh(geo, mat);
      const gy = this.sim.groundHeightAt(b.x, b.z);
      mesh.position.set(simToWorldX(b.x) + (Math.random() - 0.5) * b.w, gy + 1.5 + Math.random(), simToWorldZ(b.z) + (Math.random() - 0.5) * b.d);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.debrisGroup.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      this.debris.push({
        mesh,
        simX: b.x + (Math.random() - 0.5) * 2,
        simZ: b.z + (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 2,
        vx: Math.cos(ang) * 1.5,
        vz: Math.sin(ang) * 1.5,
        settled: false,
      });
      if (this.debris.length > 90) {
        const old = this.debris.shift();
        this.debrisGroup.remove(old.mesh);
      }
    }
  }

  _updateDebris(dt) {
    for (const d of this.debris) {
      const groundY = this.sim.groundHeightAt(d.simX, d.simZ);
      if (!d.settled) {
        d.vy -= 9.8 * dt;
        d.simX += d.vx * dt;
        d.simZ += d.vz * dt;
        let y = d.mesh.position.y + d.vy * dt;
        if (y <= groundY + 0.3) { y = groundY + 0.3; d.settled = true; d.vy = 0; }
        d.mesh.position.set(simToWorldX(d.simX), y, simToWorldZ(d.simZ));
      } else {
        const flow = this.sim.sampleFlow(d.simX, d.simZ);
        if (flow.depth > 0.15) {
          d.simX += flow.u * dt * 0.5;
          d.simZ += flow.v * dt * 0.5;
          const gy = this.sim.groundHeightAt(d.simX, d.simZ);
          d.mesh.position.set(simToWorldX(d.simX), gy + 0.25, simToWorldZ(d.simZ));
        }
      }
    }
  }

  // ---------- defenses ----------
  _defenseGeometry(type) {
    const p = Simulation.defenseParams(type);
    const group = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.75 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d6a63, roughness: 0.95 });
    if (type === 'seawall') {
      const geo = new THREE.BoxGeometry(p.lengthU, p.peak, p.lengthV);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.y = p.peak / 2;
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    } else if (type === 'breakwater') {
      const geo = new THREE.BoxGeometry(p.lengthU, p.peak, p.lengthV);
      const mesh = new THREE.Mesh(geo, rockMat);
      mesh.position.y = p.peak / 2;
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    } else if (type === 'segmented') {
      const n = p.segments;
      const totalSpan = n * p.lengthU + (n - 1) * p.gap;
      const start = -totalSpan / 2 + p.lengthU / 2;
      for (let s = 0; s < n; s++) {
        const geo = new THREE.BoxGeometry(p.lengthU, p.peak, p.lengthV);
        const mesh = new THREE.Mesh(geo, rockMat);
        mesh.position.set(start + s * (p.lengthU + p.gap), p.peak / 2, 0);
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
      }
    } else if (type === 'embankment') {
      const shape = new THREE.Shape();
      const halfT = p.lengthV / 2;
      shape.moveTo(-halfT, 0);
      shape.lineTo(0, p.peak);
      shape.lineTo(halfT, 0);
      shape.lineTo(-halfT, 0);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: p.lengthU, bevelEnabled: false, steps: 1 });
      geo.rotateY(Math.PI / 2);
      geo.translate(0, 0, -p.lengthU / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a8f6f, roughness: 1 }));
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  createGhost(type) {
    this.removeGhost();
    const group = this._defenseGeometry(type);
    group.traverse(o => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.55;
        o.castShadow = false;
      }
    });
    group.userData.type = type;
    this.scene.add(group);
    this.ghost = group;
    return group;
  }

  setGhostValid(valid) {
    if (!this.ghost) return;
    const c = valid ? 0x5be07a : 0xe05b5b;
    this.ghost.traverse(o => { if (o.isMesh) o.material.color.setHex(c); });
  }

  removeGhost() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
  }

  placeGhostAt(simX, simZ, rot) {
    if (!this.ghost) return;
    const gy = this.sim.groundHeightAt(simX, simZ);
    this.ghost.position.set(simToWorldX(simX), gy, simToWorldZ(simZ));
    this.ghost.rotation.y = -rot;
  }

  addDefenseMesh(defense) {
    const group = this._defenseGeometry(defense.type);
    const gy = this.sim.groundHeightAt(defense.x, defense.z);
    group.position.set(simToWorldX(defense.x), gy, simToWorldZ(defense.z));
    group.rotation.y = -defense.rot;
    group.userData.defenseId = defense.id;
    this.scene.add(group);
    this.defenseMeshes.set(defense.id, group);
    return group;
  }

  removeDefenseMesh(id) {
    const g = this.defenseMeshes.get(id);
    if (g) { this.scene.remove(g); this.defenseMeshes.delete(id); }
    if (this.selectedDefenseId === id) this.setSelectedDefense(null);
  }

  clearAllDefenseMeshes() {
    for (const g of this.defenseMeshes.values()) this.scene.remove(g);
    this.defenseMeshes.clear();
    this.setSelectedDefense(null);
  }

  syncDefenseMeshTransform(defense) {
    const g = this.defenseMeshes.get(defense.id);
    if (g) g.rotation.y = -defense.rot;
  }

  setSelectedDefense(id) {
    if (this.selectedDefenseId && this.defenseMeshes.has(this.selectedDefenseId)) {
      this.defenseMeshes.get(this.selectedDefenseId).traverse(o => {
        if (o.isMesh) o.material.emissive && o.material.emissive.setHex(0x000000);
      });
    }
    this.selectedDefenseId = id;
    if (id && this.defenseMeshes.has(id)) {
      this.defenseMeshes.get(id).traverse(o => {
        if (o.isMesh) {
          if (!o.material.emissive) return;
          o.material.emissive.setHex(0x2255ff);
          o.material.emissiveIntensity = 0.35;
        }
      });
    }
  }

  // ---------- flow arrows ----------
  _buildFlowArrows() {
    this.flowStep = 5;
    const cols = Math.floor(GRID.NX / this.flowStep);
    const rows = Math.floor(GRID.NZ / this.flowStep);
    this.flowCount = cols * rows;
    this.flowCols = cols; this.flowRows = rows;
    const geo = new THREE.ConeGeometry(0.35, 1.4, 6);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x1fd0ff, transparent: true, opacity: 0.85 });
    this.flowMesh = new THREE.InstancedMesh(geo, mat, this.flowCount);
    this.flowMesh.visible = false;
    this.scene.add(this.flowMesh);
    this._dummy = new THREE.Object3D();
  }

  _updateFlowArrows() {
    if (!this.flowMesh.visible) return;
    const { NX } = GRID;
    let idx = 0;
    for (let r = 0; r < this.flowRows; r++) {
      for (let c = 0; c < this.flowCols; c++) {
        const i = c * this.flowStep + Math.floor(this.flowStep / 2);
        const j = r * this.flowStep + Math.floor(this.flowStep / 2);
        const n = j * NX + i;
        const D = Math.max(this.sim.h[n] - this.sim.terrain[n], 0);
        const speed = Math.hypot(this.sim.u[n], this.sim.v[n]);
        const scale = D > 0.06 ? Math.min(2.2, 0.5 + speed * 0.35) : 0.0001;
        const yaw = Math.atan2(this.sim.u[n], this.sim.v[n]);
        this._dummy.position.set(simToWorldX(i), Math.max(this.sim.h[n], this.sim.terrain[n]) + 0.6, simToWorldZ(j));
        this._dummy.rotation.set(0, yaw, 0);
        this._dummy.scale.set(scale, scale, scale);
        this._dummy.updateMatrix();
        this.flowMesh.setMatrixAt(idx, this._dummy.matrix);
        idx++;
      }
    }
    this.flowMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- raycast helpers ----------
  updateMouseNDC(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._ndc = this._ndc || new THREE.Vector2();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return this._ndc;
  }

  pickGround(clientX, clientY) {
    const ndc = this.updateMouseNDC(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const target = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, target);
    if (!hit) return null;
    return { x: worldToSimX(target.x), z: worldToSimZ(target.z) };
  }

  pickDefense(clientX, clientY) {
    const ndc = this.updateMouseNDC(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.defenseMeshes.values()];
    const hits = this.raycaster.intersectObjects(meshes, true);
    if (hits.length === 0) return null;
    let obj = hits[0].object;
    while (obj && !obj.userData.defenseId) obj = obj.parent;
    return obj ? obj.userData.defenseId : null;
  }

  // ---------- frame ----------
  render(dt) {
    this._updateTerrainGeometry(false);
    this._updateWaterGeometry(dt);
    this._updateBuildings();
    this._updateDebris(dt);
    this._updateFlowArrows();
    if (this.followWave) this._applyFollowCamera();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _applyFollowCamera() {
    // gently bias target toward the wave front's centroid without hijacking user control
    const { NX, NZ } = GRID;
    let sx = 0, sz = 0, sw = 0;
    for (let j = 10; j < NZ; j += 6) {
      for (let i = 10; i < NX - 10; i += 6) {
        const n = j * NX + i;
        const D = Math.max(this.sim.h[n] - this.sim.terrain[n], 0);
        const speed = Math.hypot(this.sim.u[n], this.sim.v[n]);
        const w = D * speed;
        if (w > 0.05) { sx += simToWorldX(i) * w; sz += simToWorldZ(j) * w; sw += w; }
      }
    }
    if (sw > 0.01) {
      const tx = sx / sw, tz = sz / sw;
      this.controls.target.lerp(new THREE.Vector3(tx, 2, tz), 0.02);
    }
  }

  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

function simToWorldX(i) { return i * GRID.DX - GRID.WIDTH / 2; }
function simToWorldZ(j) { return j * GRID.DZ - GRID.DEPTH / 2; }
function worldToSimX(x) { return (x + GRID.WIDTH / 2) / GRID.DX; }
function worldToSimZ(z) { return (z + GRID.DEPTH / 2) / GRID.DZ; }
