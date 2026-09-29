// Procedural canvas textures (facades, concrete, road markings).
import * as THREE from 'three';
import { mulberry32 } from '../sim.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function finish(c, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

// A facade tile represents `tileW` metres wide x 3 m (one storey).
function facade(style, broken, seed) {
  const [c, g] = canvas(256, 128);
  const rnd = mulberry32(seed);
  g.fillStyle = '#f2efe8';
  g.fillRect(0, 0, 256, 128);
  // subtle plaster noise
  for (let k = 0; k < 900; k++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.035})`;
    g.fillRect(rnd() * 256, rnd() * 128, 2 + rnd() * 3, 2 + rnd() * 3);
  }
  const drawWindow = (x, y, w, h) => {
    const isBroken = broken && rnd() < 0.55;
    g.fillStyle = '#d9d4ca';
    g.fillRect(x - 4, y - 4, w + 8, h + 8);
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    if (isBroken) {
      grd.addColorStop(0, '#15171a'); grd.addColorStop(1, '#262626');
    } else {
      grd.addColorStop(0, '#6f8fa6'); grd.addColorStop(0.5, '#34506a'); grd.addColorStop(1, '#223648');
    }
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    if (isBroken) {
      g.strokeStyle = 'rgba(200,210,220,0.5)'; g.lineWidth = 1.5;
      g.beginPath();
      const cx = x + rnd() * w, cy = y + rnd() * h;
      for (let s = 0; s < 5; s++) { g.moveTo(cx, cy); g.lineTo(x + rnd() * w, y + rnd() * h); }
      g.stroke();
    } else {
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(x, y + h * 0.6); g.lineTo(x + w * 0.5, y); g.lineTo(x + w * 0.75, y); g.lineTo(x, y + h); g.fill();
      g.strokeStyle = '#e8e4dc'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.stroke();
    }
  };
  if (style === 'house') {
    drawWindow(40, 34, 52, 58);
    drawWindow(164, 34, 52, 58);
  } else if (style === 'shop') {
    drawWindow(24, 30, 92, 70);
    drawWindow(140, 30, 92, 70);
  } else if (style === 'apartment') {
    for (let k = 0; k < 3; k++) drawWindow(18 + k * 82, 32, 56, 56);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 118, 256, 10);
  } else if (style === 'hotel') {
    g.fillStyle = '#e9edf0'; g.fillRect(0, 0, 256, 128);
    const grd = g.createLinearGradient(0, 20, 0, 108);
    grd.addColorStop(0, broken ? '#1b1d20' : '#7da3bf'); grd.addColorStop(1, broken ? '#2a2a2a' : '#2b4d69');
    g.fillStyle = grd; g.fillRect(0, 22, 256, 84);
    g.fillStyle = '#f7f7f5'; g.fillRect(0, 100, 256, 14);          // balcony slab
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2;
    for (let x = 0; x < 256; x += 32) { g.beginPath(); g.moveTo(x, 22); g.lineTo(x, 106); g.stroke(); }
    if (broken) {
      g.strokeStyle = 'rgba(200,210,220,0.45)';
      for (let s = 0; s < 14; s++) { g.beginPath(); const x = rnd() * 256; g.moveTo(x, 22 + rnd() * 80); g.lineTo(x + (rnd() - 0.5) * 60, 22 + rnd() * 80); g.stroke(); }
    }
  }
  if (broken) {
    // mud / water stain
    const grd = g.createLinearGradient(0, 128, 0, 0);
    grd.addColorStop(0, 'rgba(70,55,35,0.55)'); grd.addColorStop(1, 'rgba(70,55,35,0.15)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 128);
  }
  return finish(c);
}

let cache = null;
export function getTextures() {
  if (cache) return cache;
  cache = {};
  for (const style of ['house', 'shop', 'apartment', 'hotel']) {
    cache[style] = facade(style, false, 11);
    cache[style + '_broken'] = facade(style, true, 23);
  }
  // concrete for seawalls
  {
    const [c, g] = canvas(256, 256);
    const rnd = mulberry32(5);
    g.fillStyle = '#a9a8a2'; g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 3000; k++) {
      const v = 120 + rnd() * 80;
      g.fillStyle = `rgba(${v},${v},${v - 5},0.18)`;
      g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    g.strokeStyle = 'rgba(60,60,60,0.35)'; g.lineWidth = 2;
    for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
    for (let y = 0; y <= 256; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    cache.concrete = finish(c);
  }
  // road with dashed centre line (u across road, v along)
  {
    const [c, g] = canvas(64, 256);
    g.fillStyle = '#3a3c40'; g.fillRect(0, 0, 64, 256);
    const rnd = mulberry32(8);
    for (let k = 0; k < 600; k++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`; g.fillRect(rnd() * 64, rnd() * 256, 1, 1); }
    g.fillStyle = '#d8d2bd'; g.fillRect(3, 0, 2, 256); g.fillRect(59, 0, 2, 256);
    g.fillStyle = '#e8c65a'; g.fillRect(31, 0, 2, 150);
    cache.road = finish(c);
  }
  return cache;
}

// Rescale BoxGeometry UVs so textures tile in metres (facade tile = tileW x 3 m).
export function boxWithMetricUV(w, h, d, tileW = 8, tileH = 3) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = dims[f];
    for (let k = 0; k < 4; k++) {
      const idx = f * 4 + k;
      uv.setXY(idx, uv.getX(idx) * fw / tileW, uv.getY(idx) * fh / tileH);
    }
  }
  return geo;
}
