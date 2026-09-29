// Meshes for user-placed coastal defences, the placement ghost and selection markers.
// Mound geometry is generated from the same profile function the solver rasterises,
// so what you see is exactly what the water feels.
import * as THREE from 'three';
import { STRUCTURE_TYPES, structureProfile, fbm } from '../sim.js';
import { getTextures } from './textures.js';

const FLOOR = -26;
const geoCache = {};

function moundGeometry(type) {
  const T = STRUCTURE_TYPES[type];
  const hx = T.boundX, hz = T.boundZ;
  const step = type === 'embankment' ? 1.5 : 1.0;
  const nx = Math.ceil((2 * hx) / step) + 1, nz = Math.ceil((2 * hz) / step) + 1;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  for (let b = 0; b < nz; b++) {
    for (let a = 0; a < nx; a++) {
      const lx = -hx + a * step, lz = -hz + b * step;
      const top = structureProfile(type, lx, lz, 0);
      let y = top < -1e8 ? FLOOR : Math.max(FLOOR, top);
      const n = fbm(lx * 0.45 + 3, lz * 0.45);
      if (type !== 'embankment') y += (n - 0.5) * 0.9;           // rubble roughness
      const o = (b * nx + a) * 3;
      pos[o] = lx; pos[o + 1] = y; pos[o + 2] = lz;
      if (type === 'embankment') {
        const crestDist = Math.max(0, Math.abs(lz) - T.crestW / 2);
        if (crestDist < 0.3 && top > T.crest - 0.2) c.setRGB(0.62, 0.58, 0.5);            // crest path
        else if (lz > 0) c.setRGB(0.38 + n * 0.16, 0.36 + n * 0.14, 0.33 + n * 0.12);    // seaward armour stone
        else c.setRGB(0.36 + n * 0.1, 0.55 + n * 0.12, 0.27);                          // grassed landward slope
      } else {
        const g = 0.3 + n * 0.32;
        c.setRGB(g, g * 0.97, g * 0.92);
      }
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
    }
  }
  const idx = [];
  for (let b = 0; b < nz - 1; b++) for (let a = 0; a < nx - 1; a++) {
    const i0 = b * nx + a, i1 = i0 + 1, i2 = i0 + nx, i3 = i2 + 1;
    idx.push(i0, i2, i1, i1, i2, i3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

function seawallGeometry() {
  const T = STRUCTURE_TYPES.seawall;
  const h = T.crest - FLOOR;
  const g = new THREE.BoxGeometry(T.length, h, T.width);
  g.translate(0, FLOOR + h / 2, 0);
  const uv = g.attributes.uv;
  const dims = [[T.width, h], [T.width, h], [T.length, T.width], [T.length, T.width], [T.length, h], [T.length, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, uv.getX(i) * dims[f][0] / 8, uv.getY(i) * dims[f][1] / 8);
  }
  return g;
}

export function getStructureGeometry(type) {
  if (!geoCache[type]) geoCache[type] = type === 'seawall' ? seawallGeometry() : moundGeometry(type);
  return geoCache[type];
}

function outlineGeometry(type) {
  // crest outline(s) as line segments
  const T = STRUCTURE_TYPES[type];
  const pts = [];
  const rect = (cx, hl, hw, y) => {
    const c = [[cx - hl, -hw], [cx + hl, -hw], [cx + hl, hw], [cx - hl, hw]];
    for (let k = 0; k < 4; k++) { const a = c[k], b = c[(k + 1) % 4]; pts.push(a[0], y, a[1], b[0], y, b[1]); }
  };
  if (type === 'seawall') rect(0, T.length / 2 + 0.6, T.width / 2 + 0.6, T.crest + 0.3);
  else if (T.segments) {
    for (let k = 0; k < T.segments; k++) rect((k - (T.segments - 1) / 2) * T.pitch, T.crestL / 2 + 2, T.crestW / 2 + 2, T.crest + 0.6);
  } else rect(0, T.crestL / 2 + 2, T.crestW / 2 + 2, T.crest + 0.6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

export class DefenseView {
  constructor() {
    this.group = new THREE.Group();
    this.items = new Map();   // id -> mesh
    const tex = getTextures();
    this.mats = {
      seawall: new THREE.MeshStandardMaterial({ color: 0xc9c6bd, map: tex.concrete, roughness: 0.8 }),
      breakwater: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
      segmented: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
      embankment: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
    };
    this.ghostMatOk = new THREE.MeshStandardMaterial({ color: 0x3ee08f, transparent: true, opacity: 0.62, emissive: 0x23b36a, emissiveIntensity: 0.8, depthWrite: false });
    this.ghostMatBad = new THREE.MeshStandardMaterial({ color: 0xff5a5a, transparent: true, opacity: 0.62, emissive: 0xb02828, emissiveIntensity: 0.8, depthWrite: false });
    this.ghostLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9dffcf, depthTest: false, transparent: true }));
    this.ghostLine.renderOrder = 10;
    this.ghostLine.visible = false;
    this.ghost = null;
    this.ghostType = null;
    this.outlines = {};
    this.selectLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
    this.selectLine.renderOrder = 10;
    this.selectLine.visible = false;
    this.group.add(this.selectLine);
    this.group.add(this.ghostLine);

    // orientation arrow shown with ghost / selection
    const shape = new THREE.Shape();
    shape.moveTo(-0.6, 0); shape.lineTo(0.6, 0); shape.lineTo(0.6, 6); shape.lineTo(2, 6); shape.lineTo(0, 9); shape.lineTo(-2, 6); shape.lineTo(-0.6, 6); shape.lineTo(-0.6, 0);
    const ag = new THREE.ShapeGeometry(shape);
    ag.rotateX(Math.PI / 2);   // lies flat, points toward +z (seaward) in local space
    this.arrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
    this.arrow.renderOrder = 11;
    this.arrow.visible = false;
    this.group.add(this.arrow);
  }

  add(s) {
    const mesh = new THREE.Mesh(getStructureGeometry(s.type), this.mats[s.type]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.structId = s.id;
    this.items.set(s.id, mesh);
    this.group.add(mesh);
    this.place(s);
    return mesh;
  }
  place(s) {
    const m = this.items.get(s.id);
    if (!m) return;
    m.position.set(s.x, 0, s.z);
    m.rotation.set(0, -s.angle, 0);
  }
  remove(id) {
    const m = this.items.get(id);
    if (m) { this.group.remove(m); this.items.delete(id); }
  }
  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
    this.hideSelection();
  }
  meshes() { return [...this.items.values()]; }

  showGhost(type, x, z, angle, ok) {
    if (this.ghostType !== type) {
      if (this.ghost) this.group.remove(this.ghost);
      this.ghost = new THREE.Mesh(getStructureGeometry(type), this.ghostMatOk);
      this.ghost.renderOrder = 5;
      this.group.add(this.ghost);
      this.ghostType = type;
    }
    this.ghost.visible = true;
    this.ghost.material = ok ? this.ghostMatOk : this.ghostMatBad;
    if (!this.outlines[type]) this.outlines[type] = outlineGeometry(type);
    this.ghostLine.geometry = this.outlines[type];
    this.ghostLine.visible = true;
    this.ghostLine.material.color.set(ok ? 0x9dffcf : 0xff8080);
    this.ghostLine.position.set(x, 0.05, z);
    this.ghostLine.rotation.set(0, -angle, 0);
    this.ghost.position.set(x, 0.05, z);
    this.ghost.rotation.set(0, -angle, 0);
    this._arrowAt(type, x, z, angle, ok ? 0x9dffcf : 0xffb3b3);
  }
  hideGhost() {
    if (this.ghost) this.ghost.visible = false;
    this.ghostLine.visible = false;
    if (!this.selectLine.visible) this.arrow.visible = false;
  }

  _arrowAt(type, x, z, angle, color) {
    const T = STRUCTURE_TYPES[type];
    this.arrow.visible = true;
    this.arrow.material.color.set(color);
    this.arrow.position.set(x, T.crest + 1.2, z);
    this.arrow.rotation.set(0, -angle, 0);
    // offset to the seaward face
    const off = (T.crestW || T.width) / 2 + 1.5;
    this.arrow.position.x += -Math.sin(angle) * off;
    this.arrow.position.z += Math.cos(angle) * off;
  }

  showSelection(s, ok = true) {
    if (!this.outlines[s.type]) this.outlines[s.type] = outlineGeometry(s.type);
    this.selectLine.geometry = this.outlines[s.type];
    this.selectLine.visible = true;
    this.selectLine.position.set(s.x, 0, s.z);
    this.selectLine.rotation.set(0, -s.angle, 0);
    this.selectLine.material.color.set(ok ? 0xffd166 : 0xff5a5a);
    this._arrowAt(s.type, s.x, s.z, s.angle, 0xffd166);
  }
  hideSelection() {
    this.selectLine.visible = false;
    if (!this.ghost || !this.ghost.visible) this.arrow.visible = false;
  }
  pulse(t) {
    if (this.selectLine.visible) this.selectLine.material.opacity = 0.65 + 0.35 * Math.sin(t * 5);
  }
}
