// Terrain height-field mesh: deforms with erosion/deposition, darkens when wet,
// plus a cut-away "diorama" skirt showing the soil layers.
import * as THREE from 'three';
import { NX, NZ, DX, cellX, cellZ, fbm, K_SEABED, K_BEACH, K_GRASS, K_ROCK, K_ROAD, K_CHANNEL } from '../sim.js';

const BASE_Y = -30;

const C = {
  sand: new THREE.Color(0xe0cf9f),
  wetSand: new THREE.Color(0xa89468),
  seabed: new THREE.Color(0xb9a77c),
  grassA: new THREE.Color(0x6f9a45),
  grassB: new THREE.Color(0x4f7d33),
  rock: new THREE.Color(0x8b857c),
  road: new THREE.Color(0x55575b),
  channel: new THREE.Color(0x8a7a5a),
  subsoil: new THREE.Color(0x8a6a45),
  mud: new THREE.Color(0x6e5a3e),
};

export class TerrainView {
  constructor(layout) {
    this.layout = layout;
    const N = NX * NZ;
    this.N = N;
    this.base = new Float32Array(N * 3);
    this.wet = new Float32Array(N);
    this.heights = new Float32Array(layout.terrain0);
    this.sand = new Float32Array(layout.sand0);

    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const nor = new Float32Array(N * 3);
    const cell = new Float32Array(N * 2);
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const c = j * NX + i;
        // CPU positions stay at the pristine terrain (used for placement raycasts while idle);
        // the rendered surface is displaced on the GPU from the live height texture.
        pos[c * 3] = cellX(i); pos[c * 3 + 1] = layout.terrain0[c]; pos[c * 3 + 2] = cellZ(j);
        nor[c * 3 + 1] = 1;
        cell[c * 2] = i; cell[c * 2 + 1] = j;
        this._baseColor(c, i, j);
      }
    }
    col.set(this.base);
    const index = [];
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
    geo.setIndex(index);
    this.geo = geo;

    // live state texture: x height, y sand change, z wetness (land only), w kind
    this.texData = new Float32Array(N * 4);
    this.tex = new THREE.DataTexture(this.texData, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    const uniforms = { uTerr: { value: this.tex }, uDX: { value: DX } };
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform highp sampler2D uTerr;
          uniform float uDX;
          attribute vec2 aCell;
          varying float vDs;
          varying float vWet;
          varying float vKind;
          float tH(ivec2 c) { c = clamp(c, ivec2(0), textureSize(uTerr, 0) - 1); return texelFetch(uTerr, c, 0).x; }`)
        .replace('#include <beginnormal_vertex>', `
          ivec2 tc = ivec2(aCell);
          vec4 ts = texelFetch(uTerr, tc, 0);
          float hL = tH(tc + ivec2(-1, 0)), hR = tH(tc + ivec2(1, 0)), hD = tH(tc + ivec2(0, -1)), hU = tH(tc + ivec2(0, 1));
          vec3 objectNormal = normalize(vec3((hL - hR) / (2.0 * uDX), 1.0, (hD - hU) / (2.0 * uDX)));
          vDs = ts.y; vWet = ts.z; vKind = ts.w;`)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, ts.x, position.z);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vDs;
          varying float vWet;
          varying float vKind;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec3 c = diffuseColor.rgb;
            bool grass = abs(vKind - 2.0) < 0.5;
            bool sandy = vKind < 1.5;
            if (vDs < -0.04) c = mix(c, grass ? vec3(0.43, 0.35, 0.24) : vec3(0.54, 0.41, 0.27), min(1.0, -vDs / 1.2));
            else if (vDs > 0.04 && !sandy) c = mix(c, vec3(0.88, 0.81, 0.62), min(0.85, vDs / 0.35));
            c *= 1.0 - 0.42 * vWet;
            c.b *= 1.0 + 0.12 * vWet;
            diffuseColor.rgb = c;
          }`);
    };
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'terrain';
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this._buildSkirt();
    this.update(layout.terrain0, layout.sand0, null, 0);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
  }

  _baseColor(c, i, j) {
    const L = this.layout;
    const k = L.kind[c];
    const x = cellX(i), z = cellZ(j);
    const n = fbm(x * 0.05, z * 0.05);
    const col = new THREE.Color();
    const e = L.terrain0[c];
    switch (k) {
      case K_SEABED: {
        col.copy(C.seabed).multiplyScalar(0.62 + 0.38 * Math.exp(e / 9) + (n - 0.5) * 0.12);
        break;
      }
      case K_BEACH: col.copy(C.sand).multiplyScalar(0.93 + (n - 0.5) * 0.14); break;
      case K_GRASS: {
        col.copy(C.grassA).lerp(C.grassB, fbm(x * 0.02 + 7, z * 0.02) * 1.2 - 0.1);
        col.multiplyScalar(0.9 + (n - 0.5) * 0.25);
        // sandy transition behind the beach
        if (e < 3.2) col.lerp(C.sand, Math.max(0, Math.min(0.6, (3.2 - e) * 0.9)));
        break;
      }
      case K_ROCK: col.copy(C.rock).multiplyScalar(0.8 + n * 0.4); break;
      case K_ROAD: col.copy(C.road); break;
      case K_CHANNEL: col.copy(C.channel).multiplyScalar(0.85 + n * 0.3); break;
    }
    this.base[c * 3] = col.r; this.base[c * 3 + 1] = col.g; this.base[c * 3 + 2] = col.b;
  }

  _buildSkirt() {
    // perimeter loop of vertices, with horizontal strata rows
    const L = this.layout;
    const loop = [];
    for (let i = 0; i < NX; i++) loop.push([i, 0]);
    for (let j = 1; j < NZ; j++) loop.push([NX - 1, j]);
    for (let i = NX - 2; i >= 0; i--) loop.push([i, NZ - 1]);
    for (let j = NZ - 2; j >= 1; j--) loop.push([0, j]);
    loop.push([0, 0]);
    const levels = [0, -1.2, -3, -6, -10, -15, -21, BASE_Y];
    const rows = levels.length;
    const pos = new Float32Array(loop.length * rows * 3);
    const col = new Float32Array(loop.length * rows * 3);
    const strata = (y, top) => {
      const d = top - y;
      if (d < 0.8) return [0.42, 0.34, 0.22];
      if (y > -4) return [0.66, 0.56, 0.38];
      if (y > -9) return [0.55, 0.43, 0.3];
      if (y > -16) return [0.47, 0.4, 0.34];
      return [0.36, 0.34, 0.33];
    };
    this.skirtLoop = loop;
    for (let k = 0; k < loop.length; k++) {
      const [i, j] = loop[k];
      const top = L.terrain0[j * NX + i];
      for (let r = 0; r < rows; r++) {
        const y = r === 0 ? top : Math.min(top - 0.01 * r, levels[r]);
        const o = (k * rows + r) * 3;
        pos[o] = cellX(i); pos[o + 1] = y; pos[o + 2] = cellZ(j);
        const s = strata(y, top);
        const shade = 0.9 + 0.1 * Math.sin(k * 0.7);
        col[o] = s[0] * shade; col[o + 1] = s[1] * shade; col[o + 2] = s[2] * shade;
      }
    }
    const index = [];
    for (let k = 0; k < loop.length - 1; k++) {
      for (let r = 0; r < rows - 1; r++) {
        const a = k * rows + r, b = a + 1, c = (k + 1) * rows + r, d = c + 1;
        index.push(a, b, c, c, b, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    this.skirt = new THREE.Mesh(geo, mat);
    this.skirt.receiveShadow = true;
    this.group.add(this.skirt);
    // pedestal
    const W = NX * DX, D = NZ * DX;
    const ped = new THREE.Mesh(new THREE.BoxGeometry(W + 24, 4, D + 24),
      new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.6, metalness: 0.2 }));
    ped.position.set(0, BASE_Y - 2, 0);
    ped.receiveShadow = true;
    this.group.add(ped);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(W + 24.6, 0.35, D + 24.6),
      new THREE.MeshStandardMaterial({ color: 0x39c2d7, emissive: 0x0f5561, roughness: 0.4 }));
    rim.position.set(0, BASE_Y - 0.45, 0);
    this.group.add(rim);
  }

  // terrain/sand may be null (no change); h (depth) drives wetness.
  update(terrain, sand, h, dt) {
    if (terrain) this.heights.set(terrain);
    if (sand) this.sand.set(sand);
    const L = this.layout;
    const H = this.heights, S = this.sand, S0 = L.sand0, wet = this.wet, land = L.landMask, kind = L.kind;
    const td = this.texData;
    const decay = Math.exp(-dt / 70);
    for (let c = 0, o = 0; c < this.N; c++, o += 4) {
      if (h) wet[c] = h[c] > 0.03 ? 1 : wet[c] * decay;
      td[o] = H[c];
      td[o + 1] = S[c] - S0[c];
      td[o + 2] = land[c] ? wet[c] : 0;
      td[o + 3] = kind[c];
    }
    this.tex.needsUpdate = true;
  }

  resetWetness() {
    this.wet.fill(0);
  }

  heightAt(x, z) {
    let gx = (x - cellX(0)) / DX, gz = (z - cellZ(0)) / DX;
    gx = Math.max(0, Math.min(NX - 1.001, gx)); gz = Math.max(0, Math.min(NZ - 1.001, gz));
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j;
    const H = this.heights, c = j * NX + i;
    return (H[c] * (1 - fx) + H[c + 1] * fx) * (1 - fz) + (H[c + NX] * (1 - fx) + H[c + NX + 1] * fx) * fz;
  }
}
