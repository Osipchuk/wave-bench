// Renderer, lights, sky, terrain and water views.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as W from './world.js';
import { NX, NY, DX } from './world.js';

const N = NX * NY;

export function createStage(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xa9c6dc);
  scene.fog = new THREE.FogExp2(fogColor, 0.0032);

  const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.5, 900);
  camera.position.set(-36, 40, -86);

  // lights
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x7b7060, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.1);
  sun.position.set(-70, 62, 22);
  sun.target.position.set(0, 0, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(3072, 3072);
  const sc = sun.shadow.camera;
  sc.left = -80; sc.right = 80; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 260;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xb8d4ff, 0.7);
  fill.position.set(30, 30, -80);
  scene.add(fill);

  // sky dome
  const sunDir = sun.position.clone().sub(sun.target.position).normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: sunDir } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 uSun;
        vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
        void main(){
          float h = clamp(vD.y, -0.2, 1.0);
          vec3 hor = srgb(vec3(0.72,0.84,0.93)), top = srgb(vec3(0.20,0.42,0.78)), low = srgb(vec3(0.55,0.68,0.78));
          vec3 c = mix(hor, top, pow(clamp(h,0.0,1.0), 0.55));
          c = mix(c, low, smoothstep(0.0,-0.2,h));
          float s = max(dot(normalize(vD), uSun), 0.0);
          c += srgb(vec3(1.0,0.9,0.7)) * (pow(s, 600.0)*4.0 + pow(s, 12.0)*0.16);
          gl_FragColor = vec4(c,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
  );
  scene.add(sky);

  // display platform under the diorama
  const plat = new THREE.Mesh(
    new THREE.BoxGeometry(W.XMAX - W.XMIN + 8, 1.4, W.ZMAX - W.ZMIN + 8),
    new THREE.MeshStandardMaterial({ color: 0x1b232d, roughness: 0.55, metalness: 0.2 })
  );
  plat.position.set(0, -10.3, (W.ZMIN + W.ZMAX) / 2);
  plat.receiveShadow = true;
  scene.add(plat);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(700, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x27303a, roughness: 0.95 })
  );
  ground.position.y = -11.2;
  ground.receiveShadow = true;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 14;
  controls.maxDistance = 230;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.screenSpacePanning = false;
  controls.target.set(0, 0, 8);
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.9;
  controls.update();

  return { renderer, scene, camera, controls, sun, sunDir, fogColor };
}

// ---------------------------------------------------------------- terrain
const C = (r, g, b) => [r, g, b];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const srgb2lin = (c) => c.map((v) => Math.pow(v, 2.2));

export class TerrainView {
  constructor(sim, scene) {
    this.sim = sim;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 3);
    this.nor = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    this.base = new Float32Array(N * 3);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      this.pos[c * 3] = W.cellX(i); this.pos[c * 3 + 2] = W.cellZ(j);
    }
    const idx = new Uint32Array((NX - 1) * (NY - 1) * 6);
    let k = 0;
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = geo;
    this.computeBase();
    this.updateGeometry();
    this.updateColors();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWP;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
float gn = vn(vWP.xz*3.1)*0.5 + vn(vWP.xz*9.7)*0.3 + vn(vWP.xz*23.0)*0.2;
diffuseColor.rgb *= 0.86 + 0.28*gn;`);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true; this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.buildSkirt(scene);
  }

  computeBase() {
    const sim = this.sim;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i, x = W.cellX(i), z = W.cellZ(j), g = sim.ground0[c], s = z - W.coastZ(x);
      const n = W.fbm(x * 0.35, z * 0.35), n2 = W.vnoise(x * 1.7, z * 1.7);
      let col;
      if (g < 0) {
        const t = W.smooth(-0.3, -4.5, g);
        col = lerp3(C(0.80, 0.72, 0.54), C(0.20, 0.30, 0.36), t);
        col = lerp3(col, C(0.7, 0.63, 0.47), (n - 0.5) * 0.4 + 0.1);
      } else {
        const sand = lerp3(C(0.86, 0.78, 0.60), C(0.80, 0.70, 0.52), n);
        const grass = lerp3(C(0.36, 0.53, 0.25), C(0.28, 0.44, 0.20), n2);
        const hill = lerp3(C(0.27, 0.42, 0.20), C(0.40, 0.44, 0.27), n);
        const rockC = lerp3(C(0.50, 0.47, 0.42), C(0.40, 0.38, 0.35), n2);
        const gt = W.smooth(7.5, 12.5, s + (n - 0.5) * 4);
        col = lerp3(sand, grass, gt);
        col = lerp3(col, hill, W.smooth(26, 36, s));
        col = lerp3(col, rockC, W.smooth(4.2, 7.0, g) * 0.9);
        // dry riverbed / gravel channel
        const riv = Math.exp(-Math.pow((x - 24 - 3 * Math.sin(s * 0.12)) / 3.2, 2)) * W.smooth(3, 9, s) * (1 - W.smooth(34, 44, s));
        col = lerp3(col, C(0.55, 0.50, 0.40), Math.min(1, riv * 1.2) * 0.85);
        // pond park
        const pd = Math.exp(-(Math.pow(x + 22, 2) + Math.pow(s - 33, 2)) / 25);
        col = lerp3(col, C(0.30, 0.38, 0.25), pd * 0.7);
        const road = W.roadMask(x, z);
        if (road > 0.02) col = lerp3(col, C(0.30, 0.31, 0.33), Math.min(1, road));
      }
      const b = srgb2lin(col);
      this.base[c * 3] = b[0]; this.base[c * 3 + 1] = b[1]; this.base[c * 3 + 2] = b[2];
    }
  }

  updateGeometry() {
    const { pos, nor } = this, bT = this.sim.bT;
    for (let c = 0; c < N; c++) pos[c * 3 + 1] = bT[c];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      const hl = bT[i > 0 ? c - 1 : c], hr = bT[i < NX - 1 ? c + 1 : c], hd = bT[j > 0 ? c - NX : c], hu = bT[j < NY - 1 ? c + NX : c];
      const nx = -(hr - hl) / (2 * DX), nz = -(hu - hd) / (2 * DX), il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nor[c * 3] = nx * il; nor[c * 3 + 1] = il; nor[c * 3 + 2] = nz * il;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  updateColors() {
    const { col, base } = this, sim = this.sim;
    const { wet, peak, bT, ground0, erod0 } = sim;
    for (let c = 0; c < N; c++) {
      let r = base[c * 3], g = base[c * 3 + 1], b = base[c * 3 + 2];
      const g0 = ground0[c];
      if (g0 > -0.6) {
        const w = wet[c] * (g0 > 0 ? 1 : 0.5);
        const k = 1 - 0.36 * w;
        r *= k; g *= k * 0.99; b *= k * 0.96;
        const pk = peak[c];
        if (pk > 0.1) { // silt deposited by floodwater
          const m = Math.min(0.42, pk * 0.16);
          r += (0.20 - r) * m * 0.7; g += (0.15 - g) * m * 0.6; b += (0.09 - b) * m * 0.5;
        }
        const cut = g0 - bT[c];
        if (cut > 0.02 && erod0[c] > 0) { // scoured beach: exposed darker, coarse sand
          const m = Math.min(0.8, cut * 2.2);
          r += (0.30 - r) * m; g += (0.22 - g) * m; b += (0.13 - b) * m;
        } else if (cut < -0.04) { // deposition: lighter
          const m = Math.min(0.5, -cut * 1.5);
          r += (0.75 - r) * m; g += (0.62 - g) * m; b += (0.42 - b) * m;
        }
      }
      col[c * 3] = r; col[c * 3 + 1] = g; col[c * 3 + 2] = b;
    }
    this.geo.attributes.color.needsUpdate = true;
  }

  buildSkirt(scene) {
    // vertical strata walls around the diorama, so the terrain reads as a cut-away block
    const rows = [null, -2.5, -5.5, -9.6];
    const cols = [[0.55, 0.42, 0.28], [0.50, 0.38, 0.26], [0.36, 0.30, 0.25], [0.24, 0.21, 0.20]].map(srgb2lin);
    const verts = [], colors = [], index = [];
    const sides = [];
    for (let i = 0; i < NX; i++) sides.push([i]);
    const edge = [];
    for (let i = 0; i < NX; i++) edge.push(0 * NX + i);                   // front (ocean)
    const right = []; for (let j = 0; j < NY; j++) right.push(j * NX + NX - 1);
    const back = []; for (let i = NX - 1; i >= 0; i--) back.push((NY - 1) * NX + i);
    const left = []; for (let j = NY - 1; j >= 0; j--) left.push(j * NX);
    const bT = this.sim.ground0;
    for (const loop of [edge, right, back, left]) {
      const base = verts.length / 3;
      for (const c of loop) {
        const top = bT[c], x = this.pos[c * 3], z = this.pos[c * 3 + 2];
        for (let r = 0; r < rows.length; r++) {
          const y = r === 0 ? top : Math.min(top, rows[r]);
          verts.push(x, y, z);
          const cc = cols[Math.min(r, cols.length - 1)]; colors.push(cc[0], cc[1], cc[2]);
        }
      }
      const R = rows.length;
      for (let k = 0; k < loop.length - 1; k++) for (let r = 0; r < R - 1; r++) {
        const a = base + k * R + r, b = base + (k + 1) * R + r, c = a + 1, d = b + 1;
        index.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    m.receiveShadow = true;
    scene.add(m);
    this.skirt = m;
  }
}

// ---------------------------------------------------------------- water
const WATER_VS = `
attribute vec4 aFlow; attribute float aLand;
varying vec3 vW; varying vec3 vN; varying vec4 vF; varying float vLand;
void main(){
  vW = position; vN = normal; vF = aFlow; vLand = aLand;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const WATER_FS = `
uniform float uTime; uniform vec3 uSun; uniform vec3 fogColor; uniform float fogDensity;
varying vec3 vW; varying vec3 vN; varying vec4 vF; varying float vLand;
vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ return vn(p)*0.5 + vn(p*2.03+3.1)*0.3 + vn(p*4.1-7.7)*0.2; }
vec3 skyCol(vec3 r){
  float h = clamp(r.y, 0.0, 1.0);
  vec3 c = mix(srgb(vec3(0.72,0.84,0.93)), srgb(vec3(0.20,0.42,0.78)), pow(h, 0.55));
  float s = max(dot(r, uSun), 0.0);
  return c + srgb(vec3(1.0,0.9,0.7)) * (pow(s, 600.0)*4.0 + pow(s, 12.0)*0.16);
}
void main(){
  float depth = vF.x;
  float a0 = smoothstep(0.004, 0.1, depth);
  if (a0 < 0.01) discard;
  vec2 vel = vF.yz; float speed = length(vel); float foam = vF.w;
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  vec2 p = vW.xz; float t = uTime;
  // decorative micro-ripples: kept small and damped where the simulation says the water is turbulent
  float amp = 0.035 + 0.05 * clamp(speed/3.0, 0.0, 1.0) + 0.05 * foam;
  vec2 q1 = p*0.9 + vec2(t*0.11, t*0.07), q2 = p*2.3 - vec2(t*0.13, -t*0.09);
  float e = 0.06;
  vec2 g1 = vec2(fbm(q1+vec2(e,0.0)) - fbm(q1-vec2(e,0.0)), fbm(q1+vec2(0.0,e)) - fbm(q1-vec2(0.0,e))) / (2.0*e);
  vec2 g2 = vec2(fbm(q2+vec2(e,0.0)) - fbm(q2-vec2(e,0.0)), fbm(q2+vec2(0.0,e)) - fbm(q2-vec2(0.0,e))) / (2.0*e);
  N = normalize(N + vec3(-(g1.x+g2.x*0.6), 0.0, -(g1.y+g2.y*0.6)) * amp * 3.0);
  float nv = max(dot(N, V), 0.0);
  float fr = 0.03 + 0.9 * pow(1.0 - nv, 4.5);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  vec3 refl = skyCol(R);
  float k = 1.0 - exp(-depth * 0.30);
  vec3 col = mix(srgb(vec3(0.16,0.62,0.66)), srgb(vec3(0.02,0.17,0.32)), k);
  // sediment-laden floodwater over land
  float mud = vLand * clamp(0.45 + speed*0.12, 0.0, 0.85);
  col = mix(col, srgb(vec3(0.44,0.36,0.24)), mud);
  vec3 c = mix(col, refl, fr);
  vec3 H = normalize(V + uSun);
  c += srgb(vec3(1.0,0.93,0.8)) * pow(max(dot(N, H), 0.0), 220.0) * 2.4;
  // foam
  float nz = fbm(p*2.4 + vec2(t*0.04, -t*0.03));
  float nz2 = vn(p*7.0 - t*0.05);
  float fa = smoothstep(0.42, 0.95, foam*1.15 + (nz-0.5)*0.85 + (nz2-0.5)*0.3);
  float edge = (1.0 - smoothstep(0.03, 0.22, depth)) * smoothstep(0.25, 0.7, nz + 0.15);
  fa = max(fa, edge * 0.6);
  c = mix(c, srgb(vec3(0.95,0.97,1.0)) * (0.85 + 0.2*nz2), fa * 0.92);
  float alpha = mix(0.50 + 0.46*k, 0.97, max(fa, mud));
  alpha = max(alpha, fr) * a0;
  float dist = length(cameraPosition - vW);
  float ff = 1.0 - exp(-pow(dist*fogDensity, 2.0));
  c = mix(c, fogColor, ff);
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class WaterView {
  constructor(sim, scene, stage) {
    this.sim = sim;
    this.pos = new Float32Array(N * 3);
    this.nor = new Float32Array(N * 3);
    this.flow = new Float32Array(N * 4);
    this.land = new Float32Array(N);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      this.pos[c * 3] = W.cellX(i); this.pos[c * 3 + 2] = W.cellZ(j);
      this.land[c] = sim.ground0[c] > 0.15 ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    const idx = new Uint32Array((NX - 1) * (NY - 1) * 6);
    let k = 0;
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(this.flow, 4));
    geo.setAttribute('aLand', new THREE.BufferAttribute(this.land, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uSun: { value: stage.sunDir },
        fogColor: { value: stage.fogColor.clone().convertSRGBToLinear() }, fogDensity: { value: 0.0032 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.buildSkirt(scene);
    this.update();
  }

  update() {
    const sim = this.sim, { d, Bh, bT, uc, vc, foam } = sim;
    const { pos, nor, flow } = this;
    for (let c = 0; c < N; c++) {
      const dd = d[c];
      const wet = dd > 0.002;
      pos[c * 3 + 1] = wet ? Bh[c] + dd : bT[c];
      flow[c * 4] = dd; flow[c * 4 + 1] = uc[c]; flow[c * 4 + 2] = vc[c]; flow[c * 4 + 3] = foam[c];
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      const yl = pos[(i > 0 ? c - 1 : c) * 3 + 1], yr = pos[(i < NX - 1 ? c + 1 : c) * 3 + 1];
      const yd = pos[(j > 0 ? c - NX : c) * 3 + 1], yu = pos[(j < NY - 1 ? c + NX : c) * 3 + 1];
      let nx = -(yr - yl) / (2 * DX), nz = -(yu - yd) / (2 * DX);
      nx = nx < -1.6 ? -1.6 : nx > 1.6 ? 1.6 : nx; nz = nz < -1.6 ? -1.6 : nz > 1.6 ? 1.6 : nz;
      const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nor[c * 3] = nx * il; nor[c * 3 + 1] = il; nor[c * 3 + 2] = nz * il;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.aFlow.needsUpdate = true;
    this.updateSkirt();
  }

  buildSkirt(scene) {
    // translucent water cross-sections on the three sea-facing sides
    const front = [], right = [], left = [];
    for (let i = 0; i < NX; i++) front.push(i);
    for (let j = 0; j < NY; j++) right.push(j * NX + NX - 1);
    for (let j = 0; j < NY; j++) left.push(j * NX);
    this.loops = [front, right, left];
    const total = front.length + right.length + left.length;
    this.sPos = new Float32Array(total * 2 * 3);
    this.sCol = new Float32Array(total * 2 * 4);
    const index = [];
    let base = 0;
    for (const loop of this.loops) {
      for (let k = 0; k < loop.length - 1; k++) {
        const a = base + k * 2, b = base + (k + 1) * 2;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
      base += loop.length * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.sCol, 4));
    geo.setIndex(index);
    this.sGeo = geo;
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    m.frustumCulled = false; m.renderOrder = 3;
    scene.add(m);
    this.sMesh = m;
  }

  updateSkirt() {
    const { d, Bh, bT } = this.sim;
    let v = 0, cc = 0;
    const top = srgb2lin([0.22, 0.70, 0.74]), bot = srgb2lin([0.02, 0.15, 0.28]);
    for (const loop of this.loops) {
      for (const c of loop) {
        const x = this.pos[c * 3], z = this.pos[c * 3 + 2];
        const dd = d[c];
        const has = dd > 0.01;
        const yT = has ? Bh[c] + dd : bT[c], yB = bT[c];
        this.sPos[v++] = x; this.sPos[v++] = yT; this.sPos[v++] = z;
        this.sPos[v++] = x; this.sPos[v++] = yB; this.sPos[v++] = z;
        const al = has ? 0.62 : 0;
        this.sCol[cc++] = top[0]; this.sCol[cc++] = top[1]; this.sCol[cc++] = top[2]; this.sCol[cc++] = al;
        this.sCol[cc++] = bot[0]; this.sCol[cc++] = bot[1]; this.sCol[cc++] = bot[2]; this.sCol[cc++] = al * 1.35 > 0.9 ? 0.9 : al * 1.35;
      }
    }
    this.sGeo.attributes.position.needsUpdate = true;
    this.sGeo.attributes.color.needsUpdate = true;
  }
}
