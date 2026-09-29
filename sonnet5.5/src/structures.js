// Meshes, placement validation and ghost previews for the coastal defenses.
import * as THREE from 'three';
import * as W from './world.js';

const hash3 = (x, y, z) => {
  let h = (Math.imul(Math.round(x * 37), 73856093) ^ Math.imul(Math.round(y * 37), 19349663) ^ Math.imul(Math.round(z * 37), 83492791)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

let concreteTex = null;
function getConcreteTex() {
  if (concreteTex) return concreteTex;
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#c9cbcd'; g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${90 + Math.random() * 60},${90 + Math.random() * 60},${95 + Math.random() * 60},0.08)`; g.fillRect(Math.random() * 256, Math.random() * 128, 2 + Math.random() * 6, 2 + Math.random() * 4); }
  g.strokeStyle = 'rgba(70,74,80,0.55)'; g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 126);
  g.beginPath(); g.moveTo(0, 64); g.lineTo(256, 64); g.stroke();
  concreteTex = new THREE.CanvasTexture(cv);
  concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;
  concreteTex.colorSpace = THREE.SRGBColorSpace;
  concreteTex.anisotropy = 4;
  return concreteTex;
}

function moundGeometry(len, wid, crest, slope, seed) {
  const H = crest + 10;
  const geo = new THREE.BoxGeometry(len, H, wid, Math.max(2, Math.round(len / 1.5)), 9, Math.max(2, Math.round(wid / 1.5)));
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let k = 0; k < p.count; k++) {
    let x = p.getX(k), y = p.getY(k) + crest - H / 2, z = p.getZ(k);
    const drop = crest - y;
    const ex = drop * slope;
    x *= 1 + ex / (len / 2); z *= 1 + ex / (wid / 2);
    const h1 = hash3(x + seed, y, z), h2 = hash3(z, x - seed, y + 3), h3 = hash3(y, z + seed, x);
    const amp = drop < 0.05 ? 0.28 : 0.2;
    x += (h1 - 0.5) * amp; z += (h2 - 0.5) * amp; y += (h3 - 0.5) * amp * 1.2;
    p.setXYZ(k, x, y, z);
    const shade = 0.5 + h1 * 0.22 - Math.max(0, drop - 1.5) * 0.02;
    const warm = h2 * 0.06;
    col[k * 3] = shade + warm; col[k * 3 + 1] = shade + warm * 0.6; col[k * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function embankmentGeometry(def) {
  const H = def.crest, c = def.crestW / 2, w0 = -(c + H * def.seaSlope), w1 = c + H * def.landSlope;
  const shape = new THREE.Shape();
  shape.moveTo(w0, 0); shape.lineTo(-c, H); shape.lineTo(c, H); shape.lineTo(w1, 0); shape.lineTo(w1, -12); shape.lineTo(w0, -12); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: def.len, bevelEnabled: false, steps: 1 });
  const p = g.attributes.position, n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  for (let k = 0; k < p.count; k++) {
    const xs = p.getX(k), ys = p.getY(k), zs = p.getZ(k);
    const nx = n.getX(k), ny = n.getY(k), nz = n.getZ(k);
    p.setXYZ(k, def.len / 2 - zs, ys, xs);
    n.setXYZ(k, -nz, ny, nx);
    let r, gg, b;
    const jitter = hash3(xs * 3, ys * 3, zs * 3);
    if (ys > 0.02 && xs < -c - 0.05) { const s = 0.5 + jitter * 0.14; r = s + 0.03; gg = s; b = s - 0.03; } // riprap face
    else if (ys > 0.02) { r = 0.27 + jitter * 0.05; gg = 0.44 + jitter * 0.08; b = 0.19; }                  // grass crest and back
    else { r = 0.36; gg = 0.29; b = 0.22; }
    col[k * 3] = r; col[k * 3 + 1] = gg; col[k * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.attributes.position.needsUpdate = true;
  return g;
}

// Group in local space: x = along the structure, z = across (-z faces the sea), y = 0 at the reference height.
export function makeStructMesh(type) {
  const def = W.STRUCTS[type];
  const grp = new THREE.Group();
  grp.userData.type = type;
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  if (type === 'seawall') {
    const tex = getConcreteTex().clone(); tex.needsUpdate = true; tex.repeat.set(def.len / 6, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.85 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(def.len, def.crest + 10, def.thick), mat);
    body.position.y = def.crest - (def.crest + 10) / 2;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(def.len + 0.3, 0.4, def.thick + 0.55), new THREE.MeshStandardMaterial({ color: 0xdfe1e3, roughness: 0.8 }));
    cap.position.y = def.crest - 0.05;
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(def.len, 0.7, 0.3), new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.8 }));
    parapet.position.set(0, def.crest + 0.4, -def.thick / 2 - 0.1);
    grp.add(body, cap, parapet);
    for (const m of grp.children) { m.castShadow = true; m.receiveShadow = true; }
  } else if (type === 'breakwater') {
    const m = new THREE.Mesh(moundGeometry(def.len, def.wid, def.crest, def.slope, 11), rockMat);
    m.castShadow = true; m.receiveShadow = true; grp.add(m);
  } else if (type === 'segmented') {
    const per = def.blen + def.gap, a0 = -W.structLength(def) / 2 + def.blen / 2;
    for (let k = 0; k < def.blocks; k++) {
      const m = new THREE.Mesh(moundGeometry(def.blen, def.wid, def.crest, def.slope, 17 + k * 5), rockMat);
      m.position.x = a0 + k * per; m.castShadow = true; m.receiveShadow = true; grp.add(m);
    }
  } else if (type === 'embankment') {
    const m = new THREE.Mesh(embankmentGeometry(def), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    m.castShadow = true; m.receiveShadow = true; grp.add(m);
  }
  // selection outline + heading arrow (hidden until needed)
  const r = W.structRect(def);
  const y = def.crest + 0.55;
  const pts = [new THREE.Vector3(r.a0, y, r.w0), new THREE.Vector3(r.a1, y, r.w0), new THREE.Vector3(r.a1, y, r.w1), new THREE.Vector3(r.a0, y, r.w1)];
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.95 }));
  line.renderOrder = 10;
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(-0.9, 0); arrowShape.lineTo(-0.9, 1.8); arrowShape.lineTo(-1.8, 1.8); arrowShape.lineTo(0, 3.6); arrowShape.lineTo(1.8, 1.8); arrowShape.lineTo(0.9, 1.8); arrowShape.lineTo(0.9, 0); arrowShape.closePath();
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  arrow.position.set(0, y, r.w0 - 0.4);
  arrow.renderOrder = 10;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(r.a1 - r.a0, r.w1 - r.w0).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.2, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  plane.position.set((r.a0 + r.a1) / 2, y - 0.05, (r.w0 + r.w1) / 2); plane.renderOrder = 9;
  const sel = new THREE.Group(); sel.add(plane, line, arrow); sel.visible = false; sel.name = 'selection';
  grp.add(sel);
  grp.userData.sel = sel; grp.userData.arrowMat = arrow.material; grp.userData.lineMat = line.material; grp.userData.planeMat = plane.material;
  return grp;
}

export function setSelColor(grp, hex) {
  const u = grp.userData;
  u.arrowMat.color.setHex(hex); u.lineMat.color.setHex(hex); u.planeMat.color.setHex(hex);
}

export function setGhost(grp, valid) {
  const col = valid ? 0x4ade80 : 0xf87171;
  grp.traverse((o) => {
    if (o.isMesh && o.parent !== grp.userData.sel) {
      if (!o.userData.ghosted) { o.userData.ghosted = true; o.material = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.72, depthWrite: false, emissive: col, emissiveIntensity: 0.45, roughness: 0.6 }); o.renderOrder = 6; o.castShadow = false; o.receiveShadow = false; }
      else { o.material.color.setHex(col); o.material.emissive.setHex(col); }
    }
  });
  setSelColor(grp, col);
  grp.userData.sel.visible = true;
}

export function disposeGroup(grp) {
  grp.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { if (m.map && m.map !== concreteTex) m.map.dispose(); m.dispose(); }); }
  });
}

// ---------------------------------------------------------------- placement rules
function rectSamples(def, step = 1) {
  const r = W.structRect(def), out = [];
  for (let a = r.a0; a <= r.a1 + 1e-6; a += step) for (let w = r.w0; w <= r.w1 + 1e-6; w += step) out.push([a, w]);
  for (const [a, w] of [[r.a0, r.w0], [r.a1, r.w0], [r.a1, r.w1], [r.a0, r.w1]]) out.push([a, w]);
  return out;
}
const inRect = (r, a, w, m) => a >= r.a0 - m && a <= r.a1 + m && w >= r.w0 - m && w <= r.w1 + m;

export function checkPlacement(p, others, ignoreIdx = -1) {
  if (others.length - (ignoreIdx >= 0 ? 1 : 0) >= W.MAX_STRUCTS) return { ok: false, reason: `Limit of ${W.MAX_STRUCTS} defenses reached` };
  const def = W.STRUCTS[p.type];
  const pts = rectSamples(def, 1);
  for (const [a, w] of pts) {
    const [x, z] = W.toWorld(p, a, w);
    if (x < W.XMIN + 3 || x > W.XMAX - 3 || z < W.ZMIN + 8 || z > W.ZMAX - 3) return { ok: false, reason: 'Outside the buildable area' };
    for (const b of W.BUILDINGS) {
      if (Math.abs(x - b.x) < b.w / 2 + 0.7 && Math.abs(z - b.z) < b.d / 2 + 0.7) return { ok: false, reason: `Too close to ${b.name}` };
    }
  }
  for (let k = 0; k < others.length; k++) {
    if (k === ignoreIdx) continue;
    const o = others[k], odef = W.STRUCTS[o.type], orect = W.structRect(odef);
    for (const [a, w] of pts) { const [x, z] = W.toWorld(p, a, w); const [la, lw] = W.toLocal(o, x, z); if (inRect(orect, la, lw, 0.6)) return { ok: false, reason: 'Overlaps another defense' }; }
    const r = W.structRect(def);
    for (const [a, w] of rectSamples(odef, 1)) { const [x, z] = W.toWorld(o, a, w); const [la, lw] = W.toLocal(p, x, z); if (inRect(r, la, lw, 0.6)) return { ok: false, reason: 'Overlaps another defense' }; }
  }
  return { ok: true, reason: '' };
}
