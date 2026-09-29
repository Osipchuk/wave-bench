// Water surface rendered directly from the simulation state.
// Per-cell state is uploaded as float textures; the vertex shader displaces a grid
// to the simulated free surface and derives normals from it. Small flow-advected
// ripples and foam are layered on top in the fragment shader (driven by the
// simulated velocity and foam fields, so they never contradict the physics).
import * as THREE from 'three';
import { NX, NZ, DX, cellX, cellZ } from '../sim.js';

const vert = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;   // x: surface y, y: depth, z: foam, w: mud
uniform sampler2D uVel;     // x: u, y: v, z: speed
uniform float uDX;
in vec2 aCell;
in float aSide;             // skirt: 1 = top edge, 0 = bottom edge, -1 = surface vertex
out vec3 vWorld;
out vec3 vNormal;
out float vDepth;
out float vFoam;
out float vMud;
out vec2 vVel;
out float vSpeed;
out float vSkirt;
out float vAnom;

float surf(ivec2 c, float fallback, ivec2 sz) {
  c = clamp(c, ivec2(0), sz - 1);
  vec4 s = texelFetch(uState, c, 0);
  return s.y > 0.02 ? s.x : fallback;
}

void main() {
  ivec2 sz = textureSize(uState, 0);
  ivec2 c = ivec2(aCell);
  vec4 s = texelFetch(uState, c, 0);
  vec4 vel = texelFetch(uVel, c, 0);
  float y = s.x;
  float yL = surf(c + ivec2(-1, 0), y, sz);
  float yR = surf(c + ivec2(1, 0), y, sz);
  float yD = surf(c + ivec2(0, -1), y, sz);
  float yU = surf(c + ivec2(0, 1), y, sz);
  vec3 n = normalize(vec3((yL - yR) / (2.0 * uDX), 1.0, (yD - yU) / (2.0 * uDX)));
  vSkirt = 0.0;
  vec3 p = vec3(position.x, y, position.z);
  if (aSide > -0.5) {
    vSkirt = 1.0;
    p.y = aSide > 0.5 ? y : y - s.y;
    n = normalize(position * vec3(1.0, 0.0, 1.0));
  }
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = n;
  vDepth = s.y;
  vFoam = s.z;
  vMud = s.w;
  vVel = vel.xy;
  vSpeed = vel.z;
  vAnom = vel.w;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const frag = /* glsl */`
precision highp float;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
in vec3 vWorld;
in vec3 vNormal;
in float vDepth;
in float vFoam;
in float vMud;
in vec2 vVel;
in float vSpeed;
in float vSkirt;
in float vAnom;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 4; k++) { s += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
// analytic ripple gradient (sum of directional waves)
vec2 ripples(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(0.3, 1.0)), d2 = normalize(vec2(-0.8, 0.6)), d3 = normalize(vec2(0.9, 0.2)), d4 = normalize(vec2(-0.2, -1.0));
  g += d1 * cos(dot(d1, p) * 1.3 + t * 1.7) * 1.3;
  g += d2 * cos(dot(d2, p) * 2.1 + t * 2.3) * 0.9;
  g += d3 * cos(dot(d3, p) * 3.4 + t * 2.9) * 0.6;
  g += d4 * cos(dot(d4, p) * 5.3 + t * 3.7) * 0.35;
  return g;
}

void main() {
  if (vDepth < 0.025) discard;
  vec3 V = normalize(cameraPosition - vWorld);

  if (vSkirt > 0.5) {
    // cross-section of the water column at the model edge
    vec3 deep = vec3(0.02, 0.16, 0.26);
    vec3 col = mix(vec3(0.12, 0.45, 0.55), deep, 0.6);
    col = mix(col, vec3(0.32, 0.26, 0.16), clamp(vMud, 0.0, 0.8));
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dot(vWorld - cameraPosition, vWorld - cameraPosition));
    fragColor = vec4(mix(col, uFogColor, fogF), 0.78);
    return;
  }

  // flow-advected detail: two phases blended to avoid stretching
  vec2 flow = clamp(vVel, vec2(-8.0), vec2(8.0));
  float ph0 = fract(uTime * 0.35), ph1 = fract(uTime * 0.35 + 0.5);
  float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
  vec2 p = vWorld.xz * 0.55;
  vec2 g0 = ripples(p - flow * ph0 * 0.9, uTime);
  vec2 g1 = ripples(p - flow * ph1 * 0.9 + vec2(3.1, 1.7), uTime);
  vec2 grad = mix(g1, g0, w0);
  float turb = 0.05 + min(vSpeed, 9.0) * 0.035;
  vec3 N = normalize(vNormal + vec3(grad.x, 0.0, grad.y) * turb);

  float NdV = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  float ry = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(ry, 0.6));
  float sd = max(dot(R, uSunDir), 0.0);
  vec3 spec = uSunColor * (pow(sd, 700.0) * 9.0 + pow(sd, 90.0) * 0.35);

  float d = vDepth;
  vec3 shallow = vec3(0.16, 0.58, 0.60);
  vec3 mid = vec3(0.05, 0.33, 0.45);
  vec3 deep = vec3(0.015, 0.11, 0.22);
  vec3 body = mix(shallow, mid, smoothstep(0.0, 3.0, d));
  body = mix(body, deep, smoothstep(3.0, 16.0, d));
  // make the long wave readable: raised water is lighter/greener, drawn-down water darker
  float crest = smoothstep(0.3, 5.0, vAnom);
  float trough = smoothstep(-0.1, -1.5, vAnom);
  body = mix(body, vec3(0.20, 0.62, 0.64), crest * 0.6);
  body *= 1.0 - trough * 0.3;
  vec3 mud = vec3(0.40, 0.31, 0.19);
  body = mix(body, mud, clamp(vMud, 0.0, 0.88));
  float diff = 0.55 + 0.45 * max(dot(N, uSunDir), 0.0);
  body *= diff;

  vec3 col = mix(body, sky, fres * 0.85) + spec;

  // foam: simulated foam field modulated by advected noise
  float fp0 = fbm((vWorld.xz - flow * ph0 * 1.6) * 0.7);
  float fp1 = fbm((vWorld.xz - flow * ph1 * 1.6) * 0.7 + 4.0);
  float fp = mix(fp1, fp0, w0);
  float foamAmt = clamp(vFoam * 1.3, 0.0, 1.0);
  float shoreFoam = (1.0 - smoothstep(0.04, 0.22, d)) * smoothstep(1.0, 3.0, vSpeed) * 0.45;
  foamAmt = max(foamAmt, shoreFoam);
  // streaky, broken foam: only the upper part of the noise shows
  float foam = smoothstep(0.08, 0.3, fp - (1.0 - foamAmt) * 0.55 - 0.2) * foamAmt;
  foam = clamp(foam + smoothstep(0.7, 1.0, foamAmt) * 0.35, 0.0, 1.0);
  col = mix(col, vec3(0.93, 0.95, 0.96) * (0.75 + 0.25 * diff), foam);

  float alpha = clamp(0.38 + d * 0.22, 0.0, 0.93);
  alpha = max(alpha, fres);
  alpha = max(alpha, foam);
  alpha = max(alpha, clamp(vMud, 0.0, 1.0) * 0.9);
  alpha *= smoothstep(0.025, 0.12, d);

  float dist2 = dot(vWorld - cameraPosition, vWorld - cameraPosition);
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist2);
  col = mix(col, uFogColor, fogF);
  fragColor = vec4(col, alpha);
}
`;

export class WaterView {
  constructor(layout, sky) {
    this.layout = layout;
    const N = NX * NZ;
    this.stateData = new Float32Array(N * 4);
    this.velData = new Float32Array(N * 4);
    this.stateTex = new THREE.DataTexture(this.stateData, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.velTex = new THREE.DataTexture(this.velData, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    for (const t of [this.stateTex, this.velTex]) {
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    }
    this.uniforms = {
      uState: { value: this.stateTex },
      uVel: { value: this.velTex },
      uDX: { value: DX },
      uTime: { value: 0 },
      uSunDir: { value: sky.sunDir.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
      uZenith: { value: sky.zenith.clone() },
      uHorizon: { value: sky.horizon.clone() },
      uFogColor: { value: sky.fog.clone() },
      uFogDensity: { value: sky.fogDensity },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms,
      transparent: true, depthWrite: true,
    });

    // surface grid
    const pos = new Float32Array(N * 3), cell = new Float32Array(N * 2), side = new Float32Array(N).fill(-1);
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      pos[c * 3] = cellX(i); pos[c * 3 + 2] = cellZ(j);
      cell[c * 2] = i; cell[c * 2 + 1] = j;
    }
    const index = [];
    for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;

    // edge skirt (water column cross-section) along the three open sides + inland edge
    const loop = [];
    for (let i = 0; i < NX; i++) loop.push([i, 0]);
    for (let j = 1; j < NZ; j++) loop.push([NX - 1, j]);
    for (let i = NX - 2; i >= 0; i--) loop.push([i, NZ - 1]);
    for (let j = NZ - 2; j >= 0; j--) loop.push([0, j]);
    const sp = new Float32Array(loop.length * 2 * 3), sc = new Float32Array(loop.length * 2 * 2), ss = new Float32Array(loop.length * 2);
    loop.forEach(([i, j], k) => {
      for (let t = 0; t < 2; t++) {
        const o = k * 2 + t;
        // push slightly outward so it sits on the skirt face
        const ox = i === 0 ? -0.08 : i === NX - 1 ? 0.08 : 0, oz = j === 0 ? -0.08 : j === NZ - 1 ? 0.08 : 0;
        sp[o * 3] = cellX(i) + ox; sp[o * 3 + 1] = 0; sp[o * 3 + 2] = cellZ(j) + oz;
        sc[o * 2] = i; sc[o * 2 + 1] = j;
        ss[o] = t;
      }
    });
    const sidx = [];
    for (let k = 0; k < loop.length - 1; k++) {
      const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
      sidx.push(a, b, c, c, b, d);
    }
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sgeo.setAttribute('aCell', new THREE.BufferAttribute(sc, 2));
    sgeo.setAttribute('aSide', new THREE.BufferAttribute(ss, 1));
    sgeo.setIndex(sidx);
    const smat = this.material.clone();
    smat.uniforms = this.uniforms;
    smat.side = THREE.DoubleSide;
    this.skirt = new THREE.Mesh(sgeo, smat);
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 1;

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.skirt);
  }

  // snapshot fields (Float32Array per cell): h, eta, foam, sed, cu, cv
  update(s, terrainHeights) {
    const st = this.stateData, vd = this.velData;
    const { h, eta, foam, sed, cu, cv } = s;
    const land = this.layout.landMask;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i, o = c * 4;
        const hh = h[c];
        let y;
        if (hh > 0.02) {
          y = eta[c];
        } else {
          // dry cell: continue the neighbouring water level (hidden under terrain/buildings)
          let sum = 0, n = 0;
          if (i > 0 && h[c - 1] > 0.02) { sum += eta[c - 1]; n++; }
          if (i < NX - 1 && h[c + 1] > 0.02) { sum += eta[c + 1]; n++; }
          if (j > 0 && h[c - NX] > 0.02) { sum += eta[c - NX]; n++; }
          if (j < NZ - 1 && h[c + NX] > 0.02) { sum += eta[c + NX]; n++; }
          y = n ? sum / n : terrainHeights[c] - 1.0;
        }
        st[o] = y;
        st[o + 1] = hh;
        st[o + 2] = foam[c];
        const conc = hh > 0.05 ? sed[c] / hh : 0;
        st[o + 3] = Math.min(1, conc * 28 + (land[c] ? 0.42 : 0));
        vd[o] = cu[c]; vd[o + 1] = cv[c];
        vd[o + 2] = Math.sqrt(cu[c] * cu[c] + cv[c] * cv[c]);
        vd[o + 3] = land[c] || hh < 0.02 ? 0 : eta[c];
      }
    }
    this.stateTex.needsUpdate = true;
    this.velTex.needsUpdate = true;
  }

  tick(t) { this.uniforms.uTime.value = t; }
}
