// Coastal Flood Lab — application shell: scene, camera, interaction, UI.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { FloodSim, STRUCTURE_TYPES, PRESETS, NX, NZ, cellX, cellZ, baseShore } from './sim.js';
import { SimClient } from './sim-client.js';
import { DEBRIS_STRIDE } from './sim-host.js';
import { TerrainView } from './visuals/terrain.js';
import { WaterView } from './visuals/water.js';
import { TownView } from './visuals/town.js';
import { DefenseView } from './visuals/defenses.js';
import { SprayView, FlowView } from './visuals/effects.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ renderer
const container = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // refreshed on demand (see frame())
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = {
  sunDir: new THREE.Vector3(-0.45, 0.62, 0.64).normalize(),
  zenith: new THREE.Color(0x2f6fb0),
  horizon: new THREE.Color(0xcfe2ef),
  fog: new THREE.Color(0xb9d2e3),
  fogDensity: 0.00115,
};
scene.fog = new THREE.FogExp2(sky.fog, sky.fogDensity);
scene.background = sky.fog.clone();

// sky dome
{
  const geo = new THREE.SphereGeometry(2400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uZenith: { value: sky.zenith }, uHorizon: { value: sky.horizon }, uSun: { value: sky.sunDir } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; varying vec3 vDir;
      void main(){ float y = max(vDir.y, 0.0); vec3 c = mix(uHorizon, uZenith, pow(y, 0.55));
        float s = max(dot(vDir, uSun), 0.0); c += vec3(1.0,0.9,0.7) * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
        if (vDir.y < 0.0) c = mix(uHorizon, vec3(0.55,0.65,0.72), min(1.0, -vDir.y * 4.0));
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -10;
  scene.add(dome);
}

// lights
const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
sun.position.copy(sky.sunDir).multiplyScalar(500);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 50, far: 1300 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.8;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x6b5a45, 0.95));

// camera
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 5000);
const HOME = { pos: new THREE.Vector3(-255, 205, 330), target: new THREE.Vector3(-15, -4, -15) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 86 * DEG;
controls.minDistance = 30;
controls.maxDistance = 1100;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.screenSpacePanning = false;
controls.update();

// ------------------------------------------------------------------ world
const layout = new FloodSim();          // static layout / validation (never stepped)
const client = new SimClient();
const terrain = new TerrainView(layout);
scene.add(terrain.group);
const water = new WaterView(layout, sky);
scene.add(water.group);
const town = new TownView(layout, terrain);
scene.add(town.group);
const defenseView = new DefenseView();
scene.add(defenseView.group);
const spray = new SprayView();
scene.add(spray.points);
const flow = new FlowView();
scene.add(flow.mesh);

const ZERO = new Float32Array(NX * NZ);
function showRestWater() {
  water.update({ h: layout.h, eta: layout.eta, foam: ZERO, sed: ZERO, cu: ZERO, cv: ZERO }, terrain.heights);
}
showRestWater();

// ------------------------------------------------------------------ app state
const app = {
  tool: 'select',
  ghostAngle: 0,
  selectedId: null,
  preset: 'severe',
  speed: 1,
  paused: false,
  showFlow: false,
  follow: false,
  phase: 'idle',
  gen: 0,
  snap: null,
  time: 0,
  status: 'Ready',
  metrics: null,
  runInfo: null,
  runLogged: false,
  experiments: [],
  pendingTerrain: null,
  lastTerrainApply: 0,
  lastWetApply: 0,
  shadowDirty: true,
};
const defenses = [];
let nextDefenseId = 1;

function syncDefenses() {
  app.shadowDirty = true;
  client.send({ type: 'structures', list: defenses.map((d) => ({ ...d })) });
  $('defCount').textContent = `${defenses.length} placed`;
}

// ------------------------------------------------------------------ toasts / tips
function toast(msg, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 450);
  while ($('toast').children.length > 3) $('toast').firstChild.remove();
}
const tip = $('cursorTip');
function showTip(x, y, text, ok) {
  tip.textContent = text;
  tip.classList.toggle('ok', !!ok);
  tip.classList.remove('hidden');
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hideTip() { tip.classList.add('hidden'); }

// ------------------------------------------------------------------ tools
const locked = () => app.phase !== 'idle';

function setTool(tool) {
  if (locked() && tool !== 'select') { toast('Reset the simulation to edit defenses', 'bad'); return; }
  app.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  if (tool !== 'select') { deselect(); }
  defenseView.hideGhost();
  hideTip();
  updateAngleLabel();
}

function updateAngleLabel() {
  const s = selected();
  const a = s ? s.angle : app.ghostAngle;
  const deg = Math.round(((a / DEG) % 360 + 360) % 360);
  $('angleLabel').textContent = `${deg}°`;
  if (s) $('selAngle').textContent = `${deg}°`;
}

function selected() { return defenses.find((d) => d.id === app.selectedId) || null; }

function select(id) {
  app.selectedId = id;
  const s = selected();
  if (!s) { deselect(); return; }
  defenseView.showSelection(s);
  $('selPanel').classList.remove('hidden');
  $('selName').textContent = STRUCTURE_TYPES[s.type].name;
  updateAngleLabel();
}
function deselect() {
  app.selectedId = null;
  defenseView.hideSelection();
  $('selPanel').classList.add('hidden');
  updateAngleLabel();
}

function rotate(deltaDeg) {
  const s = selected();
  if (s) {
    if (locked()) { toast('Reset the simulation to edit defenses', 'bad'); return; }
    const na = s.angle + deltaDeg * DEG;
    const v = layout.validateStructure(s.type, s.x, s.z, na);
    if (!v.ok) { toast(`Can't rotate: ${v.reason}`, 'bad'); return; }
    s.angle = na;
    defenseView.place(s);
    defenseView.showSelection(s);
    syncDefenses();
  } else {
    app.ghostAngle += deltaDeg * DEG;
    if (lastPointer && app.tool !== 'select') updateGhost(lastPointer.x, lastPointer.y);
  }
  updateAngleLabel();
}

function deleteSelected() {
  const s = selected();
  if (!s) return;
  if (locked()) { toast('Reset the simulation to edit defenses', 'bad'); return; }
  defenses.splice(defenses.indexOf(s), 1);
  defenseView.remove(s.id);
  deselect();
  syncDefenses();
  toast(`${STRUCTURE_TYPES[s.type].name} removed`);
}

function clearDefenses() {
  if (locked()) { toast('Reset the simulation first, then clear defenses', 'bad'); return; }
  if (!defenses.length) { toast('No defenses to clear'); return; }
  defenses.length = 0;
  defenseView.clear();
  deselect();
  syncDefenses();
  toast('All defenses cleared');
}

// ------------------------------------------------------------------ picking
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let lastPointer = null;
function rayFrom(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function pickTerrain(x, y) {
  rayFrom(x, y);
  const hit = raycaster.intersectObject(terrain.mesh, false)[0];
  return hit ? hit.point : null;
}
function pickDefense(x, y) {
  rayFrom(x, y);
  const hit = raycaster.intersectObjects(defenseView.meshes(), false)[0];
  return hit ? hit.object.userData.structId : null;
}

function updateGhost(x, y) {
  if (app.tool === 'select' || locked()) { defenseView.hideGhost(); hideTip(); return; }
  const p = pickTerrain(x, y);
  if (!p) { defenseView.hideGhost(); hideTip(); return; }
  const v = layout.validateStructure(app.tool, p.x, p.z, app.ghostAngle);
  defenseView.showGhost(app.tool, p.x, p.z, app.ghostAngle, v.ok);
  app.ghost = { x: p.x, z: p.z, ok: v.ok, reason: v.reason };
  if (v.ok) showTip(x, y, `Click to place ${STRUCTURE_TYPES[app.tool].name}`, true);
  else showTip(x, y, v.reason, false);
}

const drag = { active: false, id: null, dx: 0, dz: 0, start: null, ok: true };
let down = null;
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
  if (e.button !== 0 || locked()) return;
  if (app.tool === 'select' && app.selectedId != null) {
    const id = pickDefense(e.clientX, e.clientY);
    if (id === app.selectedId) {
      const s = selected();
      const p = pickTerrain(e.clientX, e.clientY);
      if (p) {
        drag.active = true; drag.id = id; drag.dx = s.x - p.x; drag.dz = s.z - p.z;
        drag.start = { x: s.x, z: s.z }; drag.ok = true;
        controls.enabled = false;
        canvas.setPointerCapture(e.pointerId);
      }
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (drag.active) {
    const s = selected();
    const p = pickTerrain(e.clientX, e.clientY);
    if (s && p) {
      s.x = p.x + drag.dx; s.z = p.z + drag.dz;
      const v = layout.validateStructure(s.type, s.x, s.z, s.angle);
      drag.ok = v.ok;
      defenseView.place(s);
      defenseView.showSelection(s, v.ok);
      app.shadowDirty = true;
      if (!v.ok) showTip(e.clientX, e.clientY, v.reason, false); else hideTip();
    }
    return;
  }
  if (e.buttons & 1 && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { hideTip(); return; }
  updateGhost(e.clientX, e.clientY);
  if (app.tool === 'select' && !locked()) {
    canvas.style.cursor = pickDefense(e.clientX, e.clientY) != null ? (app.selectedId != null ? 'move' : 'pointer') : '';
  } else canvas.style.cursor = app.tool !== 'select' && !locked() ? 'crosshair' : '';
});
canvas.addEventListener('pointerleave', () => { if (!drag.active) { defenseView.hideGhost(); hideTip(); } });
canvas.addEventListener('pointerup', (e) => {
  if (drag.active) {
    drag.active = false;
    controls.enabled = true;
    const s = selected();
    if (s) {
      if (!drag.ok) { s.x = drag.start.x; s.z = drag.start.z; defenseView.place(s); toast('Invalid position — move cancelled', 'bad'); }
      else if (s.x !== drag.start.x || s.z !== drag.start.z) syncDefenses();
      defenseView.showSelection(s);
    }
    hideTip();
    down = null;
    return;
  }
  if (!down || e.button !== 0) { down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return;   // it was an orbit drag, not a click
  if (locked()) {
    if (app.tool !== 'select') toast('Reset the simulation to edit defenses', 'bad');
    return;
  }
  if (app.tool === 'select') {
    const id = pickDefense(e.clientX, e.clientY);
    if (id != null) select(id); else deselect();
    return;
  }
  const p = pickTerrain(e.clientX, e.clientY);
  if (!p) return;
  const v = layout.validateStructure(app.tool, p.x, p.z, app.ghostAngle);
  if (!v.ok) { toast(`Can't place here: ${v.reason}`, 'bad'); return; }
  const s = { id: nextDefenseId++, type: app.tool, x: p.x, z: p.z, angle: app.ghostAngle };
  defenses.push(s);
  defenseView.add(s);
  syncDefenses();
  toast(`${STRUCTURE_TYPES[s.type].name} placed`, 'good', 1600);
  if (!defenses.slice(0, -1).length) setTimeout(() => toast('Tip: press Esc to select, move or delete it'), 900);
});

// Shift + wheel rotates the ghost / selection instead of zooming
container.addEventListener('wheel', (e) => {
  if (!e.shiftKey) return;
  if (app.tool === 'select' && app.selectedId == null) return;
  e.preventDefault();
  e.stopPropagation();
  const d = (e.deltaY || e.deltaX) > 0 ? 15 : -15;
  rotate(d);
}, { capture: true, passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (!$('onboard').classList.contains('hidden')) { if (k === 'enter' || k === 'escape' || k === ' ') { e.preventDefault(); closeOnboarding(); } return; }
  if (k === 'q') rotate(-15);
  else if (k === 'e') rotate(15);
  else if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 'escape') { setTool('select'); deselect(); }
  else if (k === '1') setTool('seawall');
  else if (k === '2') setTool('breakwater');
  else if (k === '3') setTool('segmented');
  else if (k === '4') setTool('embankment');
  else if (k === ' ') { e.preventDefault(); launch(); }
  else if (k === 'p') togglePause();
  else if (k === 'r') resetSim();
  else if (k === 'f') toggleFlow();
  else if (k === 'h') homeCamera();
});

// ------------------------------------------------------------------ simulation control
function describeDefenses() {
  if (!defenses.length) return 'No defenses';
  const counts = {};
  for (const d of defenses) counts[d.type] = (counts[d.type] || 0) + 1;
  const short = { seawall: 'Seawall', breakwater: 'Breakwater', segmented: 'Segmented', embankment: 'Embankment' };
  return Object.entries(counts).map(([t, n]) => `${n}× ${short[t]}`).join(', ');
}

function launch() {
  if (app.phase !== 'idle') {
    // re-run the same experiment from a clean state
    resetSim(true);
  }
  deselect();
  setTool('select');
  defenseView.hideGhost();
  client.send({ type: 'launch', preset: app.preset });
  if (app.paused) togglePause();
  app.phase = 'running';
  app.runLogged = false;
  app.runInfo = { preset: app.preset, defenses: describeDefenses(), nDef: defenses.length };
  $('runTag').textContent = `${PRESETS[app.preset].label} · ${app.runInfo.defenses}`;
  updateControls();
  toast(`${PRESETS[app.preset].label} wave launched`, '', 1800);
}

function resetSim(silent = false) {
  logExperiment();
  app.gen++;
  client.send({ type: 'reset', gen: app.gen });
  app.phase = 'idle';
  app.time = 0;
  app.snap = null;
  app.metrics = null;
  app.pendingTerrain = null;
  town.reset();
  spray.clear();
  app.shadowDirty = true;
  terrain.resetWetness();
  terrain.update(layout.terrain0, layout.sand0, null, 0);
  showRestWater();
  flow.mesh.count = 0;
  renderMetrics(null);
  $('runTag').textContent = 'No run yet';
  $('clock').textContent = '00:00';
  setStatus('Ready — build your defenses', 'idle');
  updateControls();
  if (!silent) toast('Simulation reset — defenses kept', 'good', 1800);
}

function togglePause() {
  app.paused = !app.paused;
  client.send({ type: 'pause', paused: app.paused });
  updateControls();
}

function toggleFlow() {
  app.showFlow = !app.showFlow;
  flow.mesh.visible = app.showFlow;
  if (app.showFlow && app.snap) flow.update(app.snap);
  $('btnFlow').classList.toggle('on', app.showFlow);
  $('legend').classList.toggle('hidden', !app.showFlow);
}

function homeCamera() {
  camAnim = { t: 0, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: HOME.pos.clone(), toT: HOME.target.clone() };
  if (app.follow) toggleFollow();
}
let camAnim = null;

function toggleFollow() {
  app.follow = !app.follow;
  $('btnFollow').classList.toggle('on', app.follow);
  if (app.follow && app.phase === 'idle') toast('Follow Wave activates when the wave is launched');
}

function updateControls() {
  const idle = app.phase === 'idle';
  $('launchText').textContent = idle ? 'Launch Wave' : 'Run Again';
  $('btnLaunch').classList.toggle('rerun', !idle);
  $('btnLaunch').title = idle ? 'Launch the wave (Space)' : 'Reset the town and launch the same wave again (Space)';
  const pb = $('btnPause');
  pb.querySelector('use').setAttribute('href', app.paused ? '#i-play' : '#i-pause');
  pb.querySelector('span').textContent = app.paused ? 'Resume' : 'Pause';
  pb.classList.toggle('on', app.paused);
  document.querySelectorAll('.tool').forEach((b) => { b.disabled = !idle && b.dataset.tool !== 'select'; });
  $('lockNote').classList.toggle('hidden', idle);
  $('btnClear').disabled = !idle;
  $('rotateRow').classList.toggle('hidden', !idle);
}

function setStatus(text, cls) {
  $('statusText').textContent = text;
  $('statusDot').className = `dot ${cls}`;
}

// ------------------------------------------------------------------ metrics & log
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function renderMetrics(m) {
  const total = layout.buildings.filter((b) => b.type !== 'lighthouse').length;
  if (!m) m = { maxFloodDepth: 0, floodedArea: 0, floodedPct: 0, erosion: 0, maxScour: 0, damaged: 0, destroyed: 0, peakWave: 0, inundation: 0 };
  setNum('mDepth', fmt(m.maxFloodDepth, 1));
  setNum('mArea', fmt(m.floodedArea / 10000, 2));
  $('mAreaBar').style.width = `${Math.min(100, m.floodedPct)}%`;
  $('mAreaSub').textContent = `${fmt(m.floodedPct, 0)}% of land · ${fmt(m.floodedArea)} m²`;
  setNum('mErosion', fmt(m.erosion));
  $('mErosionSub').textContent = `max scour ${fmt(m.maxScour, 1)} m · deposited ${fmt(m.deposition || 0)} m³`;
  setNum('mDamaged', fmt(m.damaged));
  $('mTotal').textContent = `/ ${total}`;
  setNum('mDestroyed', fmt(m.destroyed));
  setNum('mPeak', fmt(m.peakWave, 1));
  setNum('mReach', fmt(m.inundation));
}
function setNum(id, text) {
  const el = $(id);
  if (el.textContent !== text) {
    if (el.dataset.v && parseFloat(text.replace(/,/g, '')) > parseFloat(el.dataset.v)) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    el.textContent = text;
    el.dataset.v = text.replace(/,/g, '');
  }
}

function logExperiment() {
  if (app.runLogged || !app.runInfo || !app.metrics || app.time < 20) return;
  app.runLogged = true;
  const m = app.metrics;
  const e = {
    n: app.experiments.length + 1, preset: app.runInfo.preset, defenses: app.runInfo.defenses,
    area: m.floodedArea, pct: m.floodedPct, depth: m.maxFloodDepth, erosion: m.erosion, damaged: m.damaged, destroyed: m.destroyed,
  };
  // compare with the previous run at the same intensity
  const prev = [...app.experiments].reverse().find((x) => x.preset === e.preset);
  app.experiments.push(e);
  renderLog();
  if (prev) {
    const dA = prev.area > 0 ? Math.round((e.area - prev.area) / prev.area * 100) : 0;
    const dD = e.destroyed - prev.destroyed;
    toast(`Run #${e.n} vs #${prev.n}: flooded area ${dA >= 0 ? '+' : ''}${dA}%, destroyed ${dD >= 0 ? '+' : ''}${dD}`, dA <= 0 && dD <= 0 ? 'good' : 'bad', 5000);
  }
}
function renderLog() {
  const el = $('log');
  if (!app.experiments.length) { el.innerHTML = '<div class="log-empty">Runs appear here so you can compare layouts.</div>'; return; }
  const best = {};
  for (const e of app.experiments) if (!best[e.preset] || e.area < best[e.preset].area) best[e.preset] = e;
  el.innerHTML = app.experiments.slice(-6).reverse().map((e) => `
    <div class="log-item ${best[e.preset] === e && app.experiments.filter((x) => x.preset === e.preset).length > 1 ? 'best' : ''}">
      <div class="lh"><b>#${e.n} · ${e.defenses}</b><span class="tag ${e.preset}">${PRESETS[e.preset].label}</span></div>
      <div class="ld"><span>Flooded <em>${fmt(e.area / 10000, 2)} ha</em></span><span>Depth <em>${fmt(e.depth, 1)} m</em></span>
      <span>Damaged <em>${e.damaged}</em></span><span>Destroyed <em>${e.destroyed}</em></span><span>Erosion <em>${fmt(e.erosion)} m³</em></span></div>
    </div>`).join('');
}

// ------------------------------------------------------------------ snapshots
const tmpFront = { x: 0, z: 0 };
function waveFront(s) {
  const { h, eta, cu, cv } = s;
  const land = layout.landMask;
  const thr = PRESETS[app.runInfo ? app.runInfo.preset : 'severe'].A * 0.35;
  let best = 1e9, sx = 0, n = 0;
  for (let j = 0; j < NZ; j += 2) {
    for (let i = 0; i < NX; i += 2) {
      const c = j * NX + i;
      const active = land[c] ? (h[c] > 0.15 && (cu[c] * cu[c] + cv[c] * cv[c]) > 1.4) : (eta[c] > thr && h[c] > 0.3);
      if (!active) continue;
      const z = cellZ(j);
      if (z < best - 6) { best = z; sx = cellX(i); n = 1; } else if (z < best + 6) { sx += cellX(i); n++; }
    }
  }
  if (!n) return null;
  tmpFront.x = sx / n; tmpFront.z = best;
  return tmpFront;
}

function applySnapshot(s, dt, now) {
  app.snap = s;
  app.time = s.time;
  app.metrics = s.metrics;
  if (s.phase !== app.phase && s.phase === 'running') app.phase = 'running';
  water.update(s, terrain.heights);
  if (s.terrain) app.pendingTerrain = { terrain: s.terrain, sand: s.sand };
  if (app.pendingTerrain && now - app.lastTerrainApply > 140) {
    terrain.update(app.pendingTerrain.terrain, app.pendingTerrain.sand, s.h, (now - app.lastTerrainApply) / 1000 * app.speed);
    app.pendingTerrain = null;
    app.lastTerrainApply = now;
    app.lastWetApply = now;
  } else if (app.phase !== 'idle' && now - app.lastWetApply > 400) {
    terrain.update(null, null, s.h, (now - app.lastWetApply) / 1000 * app.speed);
    app.lastWetApply = now;
  }
  flow.update(s);
  town.applyDebris(s.debris, DEBRIS_STRIDE);
  if (s.spray && s.spray.length) spray.addEvents(s.spray);
  for (const ev of s.events) {
    if (ev.type === 'collapse') {
      const b = layout.buildings[ev.id];
      spray.burst(b.cx, b.groundY + 2, b.cz, Math.max(b.w, b.d) * 0.5, 60, 1);
    }
  }
  town.lastState = s;
}

let lastUi = 0;
function updateUi(now) {
  if (now - lastUi < 150) return;
  lastUi = now;
  const s = app.snap;
  if (s && app.phase !== 'idle') {
    const t = Math.max(0, s.time);
    $('clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const st = s.status;
    let cls = 'run';
    if (st.startsWith('Impact')) cls = 'impact';
    else if (st.startsWith('Water receding') || st.startsWith('Aftermath')) cls = 'after';
    setStatus(app.paused ? `Paused — ${st}` : st, app.paused ? 'paused' : cls);
    renderMetrics(s.metrics);
    if (st.startsWith('Aftermath') && !app.runLogged) {
      logExperiment();
      app.runLogged = true;
      toast('Run complete — inspect the damage, then Reset or Run Again', 'good', 4000);
    }
  }
  const mode = client.mode === 'worker' ? 'Solver: Web Worker' : client.mode === 'local' ? 'Solver: main thread' : 'Solver: starting';
  $('perf').textContent = `${mode} · ${fps.toFixed(0)} fps${s && app.phase !== 'idle' ? ` · ${Math.round(s.stepsPerSec || 0)} steps/s` : ''} · grid ${NX}×${NZ}`;
}

// ------------------------------------------------------------------ UI wiring
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('rotL').addEventListener('click', () => rotate(-15));
$('rotR').addEventListener('click', () => rotate(15));
$('selRotL').addEventListener('click', () => rotate(-15));
$('selRotR').addEventListener('click', () => rotate(15));
$('selDelete').addEventListener('click', deleteSelected);
$('btnClear').addEventListener('click', clearDefenses);
$('btnLaunch').addEventListener('click', launch);
$('btnPause').addEventListener('click', togglePause);
$('btnReset').addEventListener('click', () => resetSim());
$('btnFlow').addEventListener('click', toggleFlow);
$('btnFollow').addEventListener('click', toggleFollow);
$('btnHome').addEventListener('click', homeCamera);
$('btnHelp').addEventListener('click', () => $('onboard').classList.remove('hidden'));
$('btnStart').addEventListener('click', closeOnboarding);
function closeOnboarding() { $('onboard').classList.add('hidden'); }

function presetInfo(k) {
  const p = PRESETS[k];
  return `Offshore height ${p.A.toFixed(1)} m · crest lasts ${(p.rise + p.plateau + p.fall / 2).toFixed(0)} s`;
}
document.querySelectorAll('#intensity button').forEach((b) => b.addEventListener('click', () => {
  app.preset = b.dataset.preset;
  document.querySelectorAll('#intensity button').forEach((q) => q.classList.toggle('on', q === b));
  $('presetInfo').textContent = presetInfo(app.preset);
  if (app.phase !== 'idle') toast('New intensity applies to the next run (Run Again)');
}));
$('presetInfo').textContent = presetInfo(app.preset);
document.querySelectorAll('#speed button').forEach((b) => b.addEventListener('click', () => {
  app.speed = parseFloat(b.dataset.speed);
  document.querySelectorAll('#speed button').forEach((q) => q.classList.toggle('on', q === b));
  client.send({ type: 'speed', speed: app.speed });
}));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ main loop
let last = performance.now();
let fps = 60;
let frameNo = 0;
const followDelta = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  tick(now);
}
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

  const s = client.pull();
  if (s && s.type === 'state') {
    if (s.gen === app.gen) applySnapshot(s, dt, now);
  }
  if (town.lastState && town.lastState.gen === app.gen) town.applyState(town.lastState, app.paused ? 0 : dt);
  if (!app.paused) spray.update(dt * (app.phase === 'idle' ? 1 : app.speed));
  water.tick(now / 1000);
  defenseView.pulse(now / 1000);

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 1.2);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
    controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
    if (camAnim.t >= 1) camAnim = null;
  } else if (app.follow && app.phase !== 'idle' && app.snap && !/^(Water receding|Aftermath)/.test(app.snap.status) && now - (app.lastFollow || 0) > 100) {
    app.lastFollow = now;
    const f = waveFront(app.snap);
    if (f) {
      const tx = Math.max(-200, Math.min(200, f.x)), tz = Math.max(-170, Math.min(170, f.z + 15));
      followDelta.set((tx - controls.target.x) * 0.08, 0, (tz - controls.target.z) * 0.08);
      controls.target.add(followDelta);
      camera.position.add(followDelta);
    }
  }
  controls.update();
  frameNo++;
  renderer.shadowMap.needsUpdate = app.shadowDirty || (app.phase !== 'idle' ? frameNo % 2 === 0 : frameNo % 20 === 0);
  app.shadowDirty = false;
  renderer.render(scene, camera);
  updateUi(now);
}

updateControls();
renderMetrics(null);
syncDefenses();
$('loading').classList.add('hidden');
requestAnimationFrame(frame);

// expose for debugging / automated checks
window.__lab = { tick: (t) => tick(t ?? performance.now()), app, defenses, layout, client, scene, camera, controls, renderer, water, terrain, town, flow, spray, launch, resetSim, setTool, rotate, clearDefenses, select,
  place(type, x, z, angleDeg = 0) {
    const a = angleDeg * DEG;
    const v = layout.validateStructure(type, x, z, a);
    if (!v.ok) return v;
    const s = { id: nextDefenseId++, type, x, z, angle: a };
    defenses.push(s); defenseView.add(s); syncDefenses();
    return { ok: true, id: s.id };
  },
  baseShore,
};
