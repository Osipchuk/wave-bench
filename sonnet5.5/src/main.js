import * as THREE from 'three';
import * as W from './world.js';
import { NX, NY, DX } from './world.js';
import { Sim, SIM_DT } from './sim.js';
import { createStage, TerrainView, WaterView } from './scene.js';
import { BuildingView } from './buildings.js';
import { makeStructMesh, setGhost, setSelColor, disposeGroup, checkPlacement } from './structures.js';
import { Particles, Debris, FlowArrows, emitSpray, emitDust } from './fx.js';
import { Props } from './props.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ setup
const stageEl = $('#stage');
const stage = createStage(stageEl);
const { renderer, scene, camera, controls, sun } = stage;
const sim = new Sim();
const terrain = new TerrainView(sim, scene);
const water = new WaterView(sim, scene, stage);
const buildings = sim.bld.map((b) => new BuildingView(sim, b, scene));
const props = new Props(scene, sim);
const particles = new Particles(scene, 3200);
const debris = new Debris(scene, 170);
const arrows = new FlowArrows(scene, sim);
const buildingMeshes = [];
for (const bv of buildings) bv.group.traverse((o) => { if (o.isMesh && o.userData.buildingId !== undefined) buildingMeshes.push(o); });

const HOME_POS = new THREE.Vector3(-36, 40, -86), HOME_TARGET = new THREE.Vector3(0, 0, 8);
const state = { tool: 'select', intensity: 'severe', speed: 1, paused: false, follow: false, showFlow: false, selected: -1, ghostRot: 0, hover: null };
const structs = [];        // placed defenses  { id, type, x, z, rot, ref, mesh }
let nextId = 1;
let ghost = null;          // { type, group }
let acc = 0;
const history = [];
let lastRun = null, baselineRun = null, recorded = false;

function resize() {
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  particles.setViewport(renderer.domElement.height, camera.fov);
}
new ResizeObserver(resize).observe(stageEl);
resize();

// ------------------------------------------------------------------ helpers
function sampleGrid(arr, x, z) {
  const fx = (x - W.XMIN) / DX - 0.5, fz = (z - W.ZMIN) / DX - 0.5;
  const i0 = Math.max(0, Math.min(NX - 2, Math.floor(fx))), j0 = Math.max(0, Math.min(NY - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i0)), tz = Math.max(0, Math.min(1, fz - j0));
  const c = j0 * NX + i0;
  return (arr[c] * (1 - tx) + arr[c + 1] * tx) * (1 - tz) + (arr[c + NX] * (1 - tx) + arr[c + NX + 1] * tx) * tz;
}
const groundFn = (x, z) => sampleGrid(sim.ground0, x, z);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function pickGround(e) {
  setNDC(e);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  const inside = (x, z) => x > W.XMIN + 0.3 && x < W.XMAX - 0.3 && z > W.ZMIN + 0.3 && z < W.ZMAX - 0.3;
  let prev = null, hit = null;
  for (let t = 2; t < 520; t += 0.5) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (!inside(x, z)) { prev = null; continue; }
    if (y <= sampleGrid(sim.bT, x, z)) { hit = { a: prev ?? t - 0.5, b: t }; break; }
    prev = t;
  }
  if (!hit) return null;
  let a = hit.a, b = hit.b;
  for (let k = 0; k < 10; k++) {
    const m = (a + b) / 2, x = o.x + d.x * m, y = o.y + d.y * m, z = o.z + d.z * m;
    if (y <= sampleGrid(sim.bT, x, z)) b = m; else a = m;
  }
  const t = (a + b) / 2;
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}
const deg = (r) => ((Math.round((r * 180) / Math.PI) % 360) + 360) % 360;
const fmt = (v, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

let toastTimer = 0;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'on ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2600);
}
const isLocked = () => sim.phase !== 'idle';

// ------------------------------------------------------------------ defenses
function poseOf(type, x, z, rot) { const p = { type, x, z, rot }; p.ref = W.computeRef(p, groundFn); return p; }
function tagStruct(mesh, id) { mesh.traverse((o) => { o.userData.structId = id; }); }

function addStruct(pose) {
  const mesh = makeStructMesh(pose.type);
  mesh.position.set(pose.x, pose.ref, pose.z); mesh.rotation.y = -pose.rot;
  scene.add(mesh);
  const s = { id: nextId++, ...pose, mesh };
  tagStruct(mesh, s.id);
  structs.push(s);
  return s;
}
function removeStruct(id) {
  const k = structs.findIndex((s) => s.id === id);
  if (k < 0) return;
  scene.remove(structs[k].mesh); disposeGroup(structs[k].mesh);
  structs.splice(k, 1);
  if (state.selected === id) state.selected = -1;
}
const selStruct = () => structs.find((s) => s.id === state.selected) || null;

function refreshSelection() {
  for (const s of structs) {
    const on = s.id === state.selected;
    s.mesh.userData.sel.visible = on;
    if (on) setSelColor(s.mesh, 0x38bdf8);
    s.mesh.traverse((o) => { if (o.isMesh && o.material && o.material.emissive && o.parent !== s.mesh.userData.sel) { o.material.emissive.setHex(on ? 0x0b3d5c : 0x000000); o.material.emissiveIntensity = on ? 1 : 0; } });
  }
  updateInspector();
}
function selectStruct(id) { state.selected = id; refreshSelection(); }

function setTool(tool) {
  if (tool !== 'select' && isLocked()) { toast('Reset the simulation to edit defenses', 'bad'); return; }
  state.tool = tool;
  if (ghost) { scene.remove(ghost.group); disposeGroup(ghost.group); ghost = null; }
  if (tool !== 'select') {
    ghost = { type: tool, group: makeStructMesh(tool), pose: null, valid: false };
    ghost.group.visible = false; ghost.group.userData.sel.visible = true;
    setGhost(ghost.group, true);
    scene.add(ghost.group);
    state.selected = -1; refreshSelection();
  }
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  updateToolHint(); updateInspector();
}
function updateToolHint(msg, cls = '') {
  const h = $('#toolHint'); h.className = 'hint ' + cls;
  if (msg) { h.textContent = msg; return; }
  const t = state.tool;
  h.textContent = t === 'select' ? 'Click a defense to select it. Drag it to move it. Drag empty space to orbit.'
    : `${W.STRUCTS[t].blurb} Click to place, R to rotate, Esc to stop.`;
}
function updateInspector() {
  const el = $('#inspector'); const s = selStruct();
  document.body.classList.toggle('locked', isLocked());
  $('#left').classList.toggle('locked', isLocked());
  $$('.tool').forEach((b) => (b.disabled = isLocked() && b.dataset.tool !== 'select'));
  $('#clearDef').disabled = isLocked() || structs.length === 0;
  const rotTarget = s ? s.rot : state.tool !== 'select' ? state.ghostRot : null;
  if (!s && state.tool === 'select') {
    el.innerHTML = `<div class="sub" style="margin:0">${structs.length ? `${structs.length} defense${structs.length > 1 ? 's' : ''} placed. Select one to rotate, move or delete it.` : 'No defenses yet. Pick a tool above to start building.'}</div>`;
    return;
  }
  const def = W.STRUCTS[s ? s.type : state.tool];
  const heading = deg(rotTarget);
  el.innerHTML = `
    <div class="name">${def.name}<i>${s ? 'Selected' : 'Placing'}</i></div>
    <div class="sub">${s ? `Crest ${fmt(s.ref + def.crest, 1)} m above sea level` : 'Preview follows the cursor. Green = valid.'}</div>
    <div class="hrow"><label for="heading">Heading</label><input type="range" id="heading" min="0" max="355" step="5" value="${heading - (heading % 5)}"><output id="headingOut">${heading}°</output></div>
    <div class="btnrow"><button class="btn" id="rotL" title="Rotate 15° counter-clockwise (Shift+R)">⟲ 15°</button><button class="btn" id="rotR" title="Rotate 15° clockwise (R)">⟳ 15°</button>
    ${s ? '<button class="btn danger" id="delSel" title="Delete the selected defense (Del)">Delete</button>' : ''}</div>
    <div class="sub" style="margin-top:6px">The arrow marks the sea-facing side.</div>`;
  const dis = isLocked() && !!s;
  $('#heading').disabled = dis; $('#rotL').disabled = dis; $('#rotR').disabled = dis; if ($('#delSel')) $('#delSel').disabled = dis;
  $('#heading').oninput = (e) => applyHeading((+e.target.value * Math.PI) / 180);
  $('#rotL').onclick = () => rotateBy(-Math.PI / 12);
  $('#rotR').onclick = () => rotateBy(Math.PI / 12);
  if ($('#delSel')) $('#delSel').onclick = deleteSelected;
}
function applyHeading(rot) {
  const s = selStruct();
  if (s) {
    if (isLocked()) return;
    const np = poseOf(s.type, s.x, s.z, rot);
    const chk = checkPlacement(np, structs, structs.indexOf(s));
    if (!chk.ok) { updateToolHint(chk.reason, 'bad'); setSelColor(s.mesh, 0xf87171); return; }
    s.rot = rot; s.ref = np.ref; s.mesh.rotation.y = -rot; s.mesh.position.y = s.ref;
    refreshSelectionColorOnly();
  } else if (state.tool !== 'select') { state.ghostRot = rot; if (ghost && ghost.pose) updateGhost(ghost.pose.x, ghost.pose.z); }
  const out = $('#headingOut'); if (out) out.textContent = deg(rot) + '°';
}
function refreshSelectionColorOnly() { const s = selStruct(); if (s) setSelColor(s.mesh, 0x38bdf8); updateToolHint(); }
function rotateBy(dr) {
  const s = selStruct();
  applyHeading(((s ? s.rot : state.ghostRot) + dr + Math.PI * 2) % (Math.PI * 2));
  updateInspector();
}
function deleteSelected() {
  const s = selStruct(); if (!s || isLocked()) return;
  removeStruct(s.id); refreshSelection(); updateInspector(); toast('Defense removed');
}
function clearDefenses() {
  if (isLocked() || !structs.length) return;
  while (structs.length) removeStruct(structs[0].id);
  state.selected = -1; refreshSelection(); updateInspector(); toast('All defenses cleared');
}

function updateGhost(x, z) {
  if (!ghost) return;
  const pose = poseOf(ghost.type, x, z, state.ghostRot);
  const chk = checkPlacement(pose, structs);
  ghost.pose = pose; ghost.valid = chk.ok;
  ghost.group.visible = true;
  ghost.group.position.set(x, pose.ref, z); ghost.group.rotation.y = -pose.rot;
  setGhost(ghost.group, chk.ok);
  updateToolHint(chk.ok ? undefined : chk.reason, chk.ok ? '' : 'bad');
}
function placeAtGhost() {
  if (!ghost || !ghost.pose) return;
  if (isLocked()) { toast('Reset the simulation to edit defenses', 'bad'); return; }
  if (!ghost.valid) { const c = checkPlacement(ghost.pose, structs); toast(c.reason || 'Cannot place here', 'bad'); return; }
  addStruct(ghost.pose);
  updateInspector();
  dismissIntro();
}

// ------------------------------------------------------------------ pointer interaction
const stageParent = renderer.domElement.parentElement;
let down = null, drag = null;
const pickStruct = (e) => {
  setNDC(e);
  const meshes = []; for (const s of structs) s.mesh.traverse((o) => { if (o.isMesh && o.userData.structId) meshes.push(o); });
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? hit.object.userData.structId : null;
};
stageParent.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target !== renderer.domElement) return;
  down = { x: e.clientX, y: e.clientY, moved: false, t: performance.now() };
  if (state.tool === 'select') {
    const id = pickStruct(e);
    if (id !== null) {
      selectStruct(id);
      const s = selStruct(), g = pickGround(e);
      if (s && g && !isLocked()) {
        drag = { id, ox: s.x - g.x, oz: s.z - g.z, moved: false };
        controls.enabled = false;
        renderer.domElement.setPointerCapture(e.pointerId);
      }
      down.onStruct = true;
    }
  }
}, true);
window.addEventListener('pointermove', (e) => {
  if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
  if (drag) {
    const s = structs.find((q) => q.id === drag.id); const g = pickGround(e);
    if (s && g) {
      const nx = g.x + drag.ox, nz = g.z + drag.oz;
      const np = poseOf(s.type, nx, nz, s.rot);
      const chk = checkPlacement(np, structs, structs.indexOf(s));
      if (chk.ok) { s.x = nx; s.z = nz; s.ref = np.ref; s.mesh.position.set(nx, np.ref, nz); refreshSelectionColorOnly(); drag.moved = true; }
      else { setSelColor(s.mesh, 0xf87171); updateToolHint(chk.reason, 'bad'); }
    }
    return;
  }
  if (e.target !== renderer.domElement) { if (ghost) ghost.group.visible = false; hideTip(); return; }
  if (ghost && !isLocked() && (e.buttons === 0 || e.buttons === undefined)) {
    const g = pickGround(e);
    if (g) updateGhost(g.x, g.z); else ghost.group.visible = false;
  }
  if (e.buttons === 0) updateHover(e);
});
window.addEventListener('pointerup', (e) => {
  if (drag) { drag = null; controls.enabled = true; updateInspector(); down = null; return; }
  if (!down) return;
  const wasClick = !down.moved && e.button === 0 && e.target === renderer.domElement;
  const onStruct = down.onStruct;
  down = null;
  if (!wasClick) return;
  if (state.tool === 'select') { if (!onStruct) { if (state.selected !== -1) selectStruct(-1); } }
  else placeAtGhost();
});
window.addEventListener('pointercancel', () => { if (drag) { drag = null; controls.enabled = true; } down = null; });
renderer.domElement.addEventListener('pointerleave', () => { if (ghost && !drag) ghost.group.visible = false; hideTip(); });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// building hover tooltip
let hoverT = 0;
const tip = $('#tip');
function hideTip() { tip.style.display = 'none'; }
function updateHover(e) {
  const now = performance.now(); if (now - hoverT < 60) return; hoverT = now;
  if (drag) return;
  setNDC(e);
  const hit = raycaster.intersectObjects(buildingMeshes, false)[0];
  if (!hit || !hit.object.visible) { hideTip(); return; }
  const id = hit.object.userData.buildingId, b = sim.bld[id];
  const st = ['Intact', 'Damaged', 'Destroyed'][b.state], cls = ['i', 'd', 'x'][b.state];
  tip.innerHTML = `<b>${b.spec.name}</b><span>${b.spec.kind[0].toUpperCase() + b.spec.kind.slice(1)}</span><br><span class="st ${cls}">${st}</span> <span>· integrity ${Math.max(0, Math.round(b.hp))}%</span><br><span>Peak depth ${fmt(b.peakDepth, 1)} m · peak flow ${fmt(b.peakSpeed, 1)} m/s</span>`;
  tip.style.display = 'block';
  tip.style.left = Math.min(window.innerWidth - 230, e.clientX + 16) + 'px'; tip.style.top = Math.min(window.innerHeight - 90, e.clientY + 14) + 'px';
}

// ------------------------------------------------------------------ simulation control
function pushStructsToSim() { sim.setStructures(structs.map((s) => ({ type: s.type, x: s.x, z: s.z, rot: s.rot, ref: s.ref }))); }

function resetWorld() {
  pushStructsToSim();
  sim.reset();
  baselineRun = history.length ? history[history.length - 1] : null;
  for (const b of buildings) b.resetVisual();
  props.reset(); debris.clear(); particles.clear();
  terrain.updateGeometry(); terrain.updateColors(); water.update(); arrows.update();
  state.paused = false; acc = 0; recorded = false;
  $('#pause').textContent = 'Pause';
  updateUI(true);
}
function launch() {
  if (sim.phase === 'running') return;
  resetWorld();
  sim.launch(state.intensity);
  if (state.tool !== 'select') setTool('select');
  dismissIntro();
  state.paused = false; $('#pause').textContent = 'Pause';
  if (structs.length) { state.selected = -1; refreshSelection(); }
  if (ghost) ghost.group.visible = false;
  updateUI(true); updateInspector();
}
function resetSim() {
  resetWorld();
  updateInspector();
  toast('Simulation reset - defenses kept');
}
function togglePause() {
  if (sim.phase === 'idle') return;
  state.paused = !state.paused; $('#pause').textContent = state.paused ? 'Resume' : 'Pause'; updateUI(true);
}

// ------------------------------------------------------------------ UI
function setIntensity(k) {
  state.intensity = k;
  $$('#intensity button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  const w = W.WAVES[k];
  $('#waveH').textContent = `Offshore height ${fmt(w.A * 2, 1)} m`;
  const lv = { moderate: 2, severe: 3, extreme: 5 }[k];
  $$('#waveMeter i').forEach((el, i) => el.classList.toggle('on', i < lv));
}
function setSpeed(v) { state.speed = v; $$('#speed button').forEach((b) => b.classList.toggle('on', +b.dataset.k === v)); }
function dismissIntro() { $('#intro').classList.add('hide'); }

const prevTxt = (k, cur, prev, unit, d = 1) => {
  if (!prev) return '';
  const diff = cur - prev[k];
  const pct = prev[k] > 0 ? Math.round((diff / prev[k]) * 100) : 0;
  const arrow = sim.phase === 'idle' || Math.abs(pct) < 1 ? '' : diff < 0 ? ` ▼${Math.abs(pct)}%` : ` ▲${pct}%`;
  return `Last run: ${fmt(prev[k], d)}${unit}${arrow}`;
};
function setSub(id, txt, cur, prev, k) {
  const el = $(id); el.textContent = txt;
  const live = prev && sim.phase !== 'idle';
  el.className = 's' + (live && cur < prev[k] - 1e-6 ? ' better' : live && cur > prev[k] + 1e-6 ? ' worse' : '');
}
let lastUIFrame = 0;
function updateUI(force = false) {
  const m = sim.metrics();
  $('#mDepth').textContent = fmt(m.maxDepth, 1);
  $('#mArea').textContent = Math.round(m.floodedArea).toLocaleString('en-US');
  $('#mEros').textContent = Math.round(m.erosion).toLocaleString('en-US');
  $('#mDam').textContent = m.damaged; $('#mDes').textContent = m.destroyed;
  $('#totDam').textContent = '/ ' + m.total; $('#totDes').textContent = '/ ' + m.total;
  $('#bDam').style.width = (100 * m.damaged) / m.total + '%'; $('#bDes').style.width = (100 * m.destroyed) / m.total + '%';
  const p = baselineRun;
    setSub('#sDepth', p ? prevTxt('maxDepth', m.maxDepth, p, ' m', 1) : 'Deepest open-ground flooding', m.maxDepth, p, 'maxDepth');
  setSub('#sArea', p ? `${fmt(m.floodedPct, 0)}% of land · ${prevTxt('floodedArea', m.floodedArea, p, '', 0).replace('Last run: ', 'last ')}` : `${fmt(m.floodedPct, 0)}% of dry land`, m.floodedArea, p, 'floodedArea');
  setSub('#sEros', p ? `max scour ${fmt(m.maxScour, 2)} m · ${prevTxt('erosion', m.erosion, p, '', 0).replace('Last run: ', 'last ')}` : `max scour ${fmt(m.maxScour, 2)} m`, m.erosion, p, 'erosion');
  setSub('#sDam', p ? `Last run: ${p.damaged}` : '', m.damaged, p, 'damaged');
  setSub('#sDes', p ? `Last run: ${p.destroyed}` : '', m.destroyed, p, 'destroyed');
  // status
  const pill = $('#statusPill'), ph = sim.phase;
  let txt = 'Ready', cls = '';
  if (ph === 'running') { txt = state.paused ? 'Paused' : sim.status; cls = sim.status === 'Inundation' ? 'hit' : 'run'; }
  else if (ph === 'complete') { txt = 'Complete'; cls = 'done'; }
  pill.textContent = txt; pill.className = 'pill ' + cls;
  $('#hudStatus').textContent = ph === 'idle' ? 'Calm sea - build your defenses' : state.paused ? 'Paused - ' + sim.status : sim.status;
  $('#hudDot').className = 'dot ' + (ph === 'running' ? 'run' : ph === 'complete' ? 'done' : '');
  $('#hudTime').textContent = `t = ${sim.t.toFixed(1)} s`;
  const busy = ph === 'running';
  const L = $('#launch'); L.disabled = busy;
  $('#launchLabel').textContent = busy ? 'Wave in progress...' : ph === 'complete' ? 'Launch Wave Again' : 'Launch Wave';
  $('#pause').disabled = ph === 'idle';
  $('#reset').disabled = false;
}
function recordRun() {
  const m = sim.metrics();
  const run = { ...m, key: sim.intensity, defenses: structs.length, n: history.length + 1 };
  history.push(run);
  const el = $('#history'); el.classList.add('has');
  const rows = history.slice(-5).reverse().map((r) => `<div class="h"><span><b>#${r.n}</b> ${W.WAVES[r.key].name} · ${r.defenses} defense${r.defenses === 1 ? '' : 's'}</span><span>${fmt(r.floodedPct, 0)}% flooded · ${r.destroyed} lost</span></div>`).join('');
  el.innerHTML = `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:3px">Run history</div>${rows}`;
  lastRun = run;
  toast(`Run complete: ${fmt(m.floodedPct, 0)}% of land flooded, ${m.destroyed} destroyed, ${m.damaged} damaged`, 'good');
}

// wiring
$$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('#intensity button').forEach((b) => b.addEventListener('click', () => setIntensity(b.dataset.k)));
$$('#speed button').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.k)));
$('#launch').addEventListener('click', launch);
$('#pause').addEventListener('click', togglePause);
$('#reset').addEventListener('click', resetSim);
$('#clearDef').addEventListener('click', clearDefenses);
$('#showFlow').addEventListener('change', (e) => { state.showFlow = e.target.checked; arrows.visible = state.showFlow; $('#legend').classList.toggle('on', state.showFlow); arrows.update(); });
$('#followWave').addEventListener('change', (e) => { state.follow = e.target.checked; toast(state.follow ? 'Follow Wave on - the camera tracks the wave front' : 'Follow Wave off'); });
$('#introBtn').addEventListener('click', dismissIntro);
$('#viewbtn').addEventListener('click', () => { flyTo = { pos: HOME_POS.clone(), tgt: HOME_TARGET.clone(), t: 0 }; });
let flyTo = null;
let escArm = 0;
window.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { rotateBy(e.shiftKey ? -Math.PI / 12 : Math.PI / 12); e.preventDefault(); }
  else if (k === 'delete' || k === 'backspace') { deleteSelected(); e.preventDefault(); }
  else if (k === 'escape') {
    if (state.tool !== 'select') setTool('select');
    else if (state.selected !== -1) selectStruct(-1);
    else if (performance.now() - escArm < 900) resetSim(); else escArm = performance.now();
  }
  else if (k === ' ' && e.target === document.body) { togglePause(); e.preventDefault(); }
  else if (k === 'l') launch();
  else if (k === 'f') { const c = $('#showFlow'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
  else if (['1', '2', '3', '4', '5'].includes(k)) setTool(['select', 'seawall', 'breakwater', 'segmented', 'embankment'][+k - 1]);
});

// ------------------------------------------------------------------ main loop
let last = performance.now(), frameNo = 0, ema = 0.016, qualityDropped = false;
const tmpV = new THREE.Vector3();
// advances simulation, effects and derived visuals by dtReal seconds of wall-clock time
function advance(dtReal, now) {
  frameNo++;

  let stepped = 0;
  if (sim.phase !== 'idle' && !state.paused) {
    acc += dtReal * state.speed;
    while (acc >= SIM_DT && stepped < 4) { sim.step(SIM_DT); acc -= SIM_DT; stepped++; }
    if (acc > SIM_DT * 3) acc = 0;
  }
  const dtSim = stepped * SIM_DT;
  if (stepped > 0) {
    sim.update(dtSim);
    water.update();
    if (state.showFlow) arrows.update();
    // events -> visuals
    for (const ev of sim.events) {
      const bv = buildings[ev.id], spec = bv.spec;
      if (ev.type === 'damaged') { bv.setState(1, true); emitDust(particles, spec.x, sim.bld[ev.id].gmax + spec.h * 0.6, spec.z, spec.w, spec.d, spec.h, 16); }
      else if (ev.type === 'destroyed') { bv.setState(2, true); emitDust(particles, spec.x, sim.bld[ev.id].gmax + 0.5, spec.z, spec.w, spec.d, spec.h, 60); debris.spawnFromBuilding(spec, W.KINDS[spec.kind]); }
    }
    sim.events.length = 0;
    emitSpray(sim, particles, dtSim, 26 * stepped);
    if (frameNo % 3 === 0) for (const t of props.update()) debris.spawn(t.x, t.z, 0.25, 0.25, 2.4 + t.sc, 0x6b4c32, 0, 0);
    if (frameNo % 6 === 0) terrain.updateColors();
    if (sim.terrainDirty && frameNo % 3 === 0) { terrain.updateGeometry(); sim.terrainDirty = false; }
    if (sim.phase === 'complete' && !recorded) { recorded = true; recordRun(); updateUI(true); }
  }
  particles.update(dtSim);
  debris.update(dtSim, sim);
  for (const b of buildings) b.update(dtSim);
  water.mat.uniforms.uTime.value = now / 1000;
  return dtReal;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.05, (now - last) / 1000); last = now;
  ema += (dtReal - ema) * 0.05;
  if (!qualityDropped && frameNo > 120 && ema > 0.034 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); qualityDropped = true; }
  advance(dtReal, now);
  // camera
  if (flyTo) {
    flyTo.t = Math.min(1, flyTo.t + dtReal / 1.1); const e = flyTo.t * flyTo.t * (3 - 2 * flyTo.t);
    if (!flyTo.a) { flyTo.a = camera.position.clone(); flyTo.b = controls.target.clone(); }
    camera.position.lerpVectors(flyTo.a, flyTo.pos, e); controls.target.lerpVectors(flyTo.b, flyTo.tgt, e);
    if (flyTo.t >= 1) flyTo = null;
  } else if (state.follow && sim.phase === 'running' && !state.paused) {
    const tz = Math.max(-22, Math.min(32, sim.frontZ)), dz = (tz - controls.target.z) * Math.min(1, dtReal * 1.6);
    const dx = (0 - controls.target.x) * Math.min(1, dtReal * 0.8);
    controls.target.x += dx; controls.target.z += dz; camera.position.x += dx; camera.position.z += dz;
  }
  controls.update();
  controls.target.x = Math.max(-65, Math.min(65, controls.target.x)); controls.target.z = Math.max(-45, Math.min(60, controls.target.z));
  controls.target.y = Math.max(-2, Math.min(8, controls.target.y));

  if (frameNo - lastUIFrame >= 6) { lastUIFrame = frameNo; updateUI(); }
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ init
setIntensity('severe'); setSpeed(1); setTool('select');
camera.position.copy(HOME_POS); controls.target.copy(HOME_TARGET); controls.update();
resetWorld();
updateInspector();
requestAnimationFrame(frame);
setTimeout(() => { if (!state.introDone) $('#intro').classList.add('hide'); }, 45000);

// small automation / debugging handle (also handy for scripted experiments from the console)
window.__lab = {
  sim, state, structs, camera, controls, scene,
  place: (type, x, z, rotDeg = 0) => { const p = poseOf(type, x, z, (rotDeg * Math.PI) / 180); const c = checkPlacement(p, structs); if (c.ok) addStruct(p); updateInspector(); return c; },
  launch, resetSim, clearDefenses, setIntensity, setSpeed, togglePause, setTool,
  // deterministic fast-forward for scripted experiments (advances simulated time without waiting for animation frames)
  fastForward(seconds) { const n = Math.round(seconds * 60); for (let k = 0; k < n; k++) advance(1 / 60, performance.now()); updateUI(); water.update(); terrain.updateGeometry(); terrain.updateColors(); renderer.render(scene, camera); return sim.t; },
};
