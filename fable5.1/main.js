/* ------------------------------------------------------------------
 * Application: renderer, camera, placement, UI, simulation loop, metrics.
 * ------------------------------------------------------------------ */
'use strict';

const WAVE_PRESETS = {
  moderate: { label: 'Moderate', amp: 2.0, period: 10 },
  severe:   { label: 'Severe',   amp: 3.0, period: 12 },
  extreme:  { label: 'Extreme',  amp: 4.8, period: 15 },
};
const SIM_DT = 0.03;

/* ------------------------- Orbit camera controls ------------------------- */
class OrbitCamera {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.target = new THREE.Vector3(0, 2, 20);
    this.theta = Math.PI + 0.62; this.phi = 0.98; this.dist = 340;
    this.minDist = 40; this.maxDist = 620;
    this.followTarget = null;
    this.update();
  }
  orbit(dx, dy) { this.theta -= dx * 0.005; this.phi = Math.max(0.12, Math.min(1.45, this.phi - dy * 0.005)); }
  pan(dx, dy) {
    const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    right.crossVectors(fwd, up).normalize();
    const k = this.dist * 0.0016;
    this.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
    this.target.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.target.x));
    this.target.z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.target.z));
  }
  zoom(delta) { this.dist = Math.max(this.minDist, Math.min(this.maxDist, this.dist * Math.exp(delta * 0.0012))); }
  update(dt) {
    if (this.followTarget && dt) {
      const k = Math.min(1, dt * 1.6);
      this.target.x += (this.followTarget.x - this.target.x) * k;
      this.target.z += (this.followTarget.z - this.target.z) * k;
    }
    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    this.camera.position.set(
      this.target.x + this.dist * sp * Math.sin(this.theta),
      this.target.y + this.dist * cp,
      this.target.z + this.dist * sp * Math.cos(this.theta));
    this.camera.lookAt(this.target);
  }
}

/* ------------------------------- App ------------------------------- */
class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.sRGBEncoding !== undefined) this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 1, 2500);
    this.controls = new OrbitCamera(this.camera, this.canvas);

    this.sim = new ShallowWaterSim(GRID_N, GRID_M, CELL);
    window.BUILDING_LOTS = generateBuildingLots();
    this.world = new World(this.scene, this.sim);
    this.buildings = new BuildingManager(this.scene, this.sim, window.BUILDING_LOTS);
    this.structures = new StructureManager(this.scene, this.sim);
    this.debris = new DebrisManager(this.scene, this.sim);
    this.flow = new FlowField(this.scene, this.sim, 4);
    this.spray = new SprayParticles(this.scene, this.sim);

    // invisible plane at sea level for placement raycasts
    this.placePlane = new THREE.Mesh(new THREE.PlaneGeometry(GRID_N * CELL, GRID_M * CELL), new THREE.MeshBasicMaterial({ visible: false }));
    this.placePlane.rotation.x = -Math.PI / 2; this.placePlane.position.y = 1.5;
    this.scene.add(this.placePlane);
    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    // state
    this.tool = null; this.ghost = null; this.ghostRot = 0; this.ghostValid = false; this.ghostPos = null;
    this.selected = null;
    this.intensity = 'severe'; this.speed = 1;
    this.state = 'ready';   // ready | running | paused
    this.accum = 0; this.wallTime = 0; this.launchedLabel = null; this.launchTime = 0; this._reported = false;
    this.metrics = this.freshMetrics();
    this.peakH = new Float32Array(this.sim.size);
    this.followEnabled = false;
    this.crestPos = new THREE.Vector3(0, 0, -120);

    this.rebuildObstacles();
    this.sim.resetWater();
    this.world.updateTerrain(true); this.world.updateWater(0);
    this.bindUI();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.lastT = performance.now();
    requestAnimationFrame(t => this.loop(t));
    document.getElementById('loading').classList.add('hide');
  }

  freshMetrics() { return { peakDepth: 0, nowDepth: 0, peakArea: 0, nowArea: 0 }; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /* ------------------------ obstacle grid ------------------------ */
  rebuildObstacles() {
    const sim = this.sim;
    sim.crest.fill(SIM_NONE); sim.drag.fill(0);
    this.structures.rasterize(sim.crest, sim.drag);
    this.buildings.rasterize(sim.crest);
    sim.updateBottom();
    // water that now sits inside a new solid is removed; new gaps offshore fill to sea level while calm
    if (this.state === 'ready') {
      for (let k = 0; k < sim.size; k++) sim.h[k] = Math.max(0, sim.seaLevel - sim.b[k]);
    } else {
      for (let k = 0; k < sim.size; k++) if (sim.crest[k] > sim.bed[k]) sim.h[k] = Math.max(0, sim.h[k] + sim.bed[k] - sim.crest[k]);
    }
  }

  /* ------------------------ UI ------------------------ */
  bindUI() {
    const $ = id => document.getElementById(id);
    document.querySelectorAll('.tool').forEach(btn => btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      this.setTool(this.tool === t ? null : t);
    }));
    $('btn-rot-l').addEventListener('click', () => this.rotateSelected(Math.PI / 12));
    $('btn-rot-r').addEventListener('click', () => this.rotateSelected(-Math.PI / 12));
    $('btn-delete').addEventListener('click', () => this.deleteSelected());
    document.querySelectorAll('#intensity button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#intensity button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); this.intensity = b.dataset.int;
      this.status(`Wave intensity set to ${WAVE_PRESETS[this.intensity].label}.`);
    }));
    document.querySelectorAll('#speed button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#speed button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); this.speed = parseFloat(b.dataset.speed);
    }));
    $('btn-launch').addEventListener('click', () => this.launchWave());
    $('btn-pause').addEventListener('click', () => this.togglePause());
    $('btn-reset').addEventListener('click', () => this.resetSimulation());
    $('btn-clear').addEventListener('click', () => this.clearDefenses());
    $('chk-flow').addEventListener('change', e => { this.flow.visible = e.target.checked; });
    $('chk-follow').addEventListener('change', e => { this.followEnabled = e.target.checked; this.controls.followTarget = this.followEnabled && this.state !== 'ready' ? this.crestPos : null; });
    $('btn-onboard').addEventListener('click', () => $('onboard').classList.add('hide'));
    // prevent UI interaction from reaching the canvas
    for (const id of ['panel', 'metrics', 'status']) {
      const el = $(id);
      el.addEventListener('pointerdown', e => e.stopPropagation());
      el.addEventListener('wheel', e => e.stopPropagation());
    }
    this.el = {
      state: $('m-state'), time: $('m-time'), wave: $('m-wave'), depth: $('m-depth'), depthNow: $('m-depth-now'),
      area: $('m-area'), areaNow: $('m-area-now'), erosion: $('m-erosion'), erosionMax: $('m-erosion-max'),
      damaged: $('m-damaged'), destroyed: $('m-destroyed'), health: $('m-health'), healthTxt: $('m-health-txt'),
      pause: $('btn-pause'), status: $('status-text'), sel: $('selection'), selName: $('sel-name'), hint: $('build-hint'),
    };
    this.updateMetricsUI();
  }

  status(msg, flash) {
    this.el.status.textContent = msg;
    const s = document.getElementById('status');
    s.classList.toggle('flash', !!flash);
  }

  setState(s) {
    this.state = s;
    const b = this.el.state;
    b.className = 'badge ' + (s === 'ready' ? 'ready' : s === 'running' ? 'running' : 'paused');
    b.textContent = s === 'ready' ? 'Ready' : s === 'running' ? 'Running' : 'Paused';
    this.el.pause.textContent = s === 'paused' ? 'Resume' : 'Pause';
    this.el.pause.classList.toggle('paused', s === 'paused');
    this.controls.followTarget = this.followEnabled && s !== 'ready' ? this.crestPos : null;
  }

  /* ------------------------ tools & placement ------------------------ */
  setTool(t) {
    this.tool = t;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    this.select(null);
    if (this.ghost) { this.scene.remove(this.ghost); disposeObject(this.ghost); this.ghost = null; }
    this.canvas.style.cursor = t ? 'crosshair' : 'default';
    if (t) this.status(`Placing ${STRUCTURE_TYPES[t].name}: click in the scene to place, R to rotate, Esc to cancel.`);
    else this.status('Select a defense to build, or launch the wave.');
  }

  updateGhost() {
    if (!this.tool || !this.ghostPos) return;
    const { x, z } = this.ghostPos;
    const inside = Math.abs(x) < WORLD_HALF - 6 && Math.abs(z) < WORLD_HALF - 6;
    const valid = inside && !this.structures.overlapsBuildings(this.tool, x, z, this.ghostRot, this.buildings);
    const T = STRUCTURE_TYPES[this.tool];
    const ground = this.structures.groundUnder(x, z, this.ghostRot, T);
    if (!this.ghost || this.ghost.userData.type !== this.tool || this.ghost.userData.rot !== this.ghostRot || Math.abs(ground - this.ghost.userData.base) > 0.75) {
      if (this.ghost) { this.scene.remove(this.ghost); disposeObject(this.ghost); }
      this.ghost = this.structures.makeMesh(this.tool, x, z, this.ghostRot, true);
      this.ghost.userData.type = this.tool; this.ghost.userData.rot = this.ghostRot;
      this.scene.add(this.ghost);
    }
    this.ghost.position.set(x, 0, z);
    this.ghostValid = valid;
    this.ghost.traverse(o => { if (o.isMesh) { o.material.color.setHex(valid ? 0x56d68a : 0xff5f5f); o.material.emissive.setHex(valid ? 0x56d68a : 0xff5f5f); } else if (o.userData.outline) o.material.color.setHex(valid ? 0xffffff : 0xff8080); });
  }

  place() {
    if (!this.tool || !this.ghostPos || !this.ghostValid) { if (this.tool && !this.ghostValid) this.status('Cannot place here: keep structures away from buildings and the map edge.'); return; }
    const st = this.structures.add(this.tool, this.ghostPos.x, this.ghostPos.z, this.ghostRot);
    this.rebuildObstacles();
    this.status(`${STRUCTURE_TYPES[st.type].name} placed. Place another, or press Esc to finish.`);
  }

  select(st) {
    if (this.selected) this.structures.setHighlight(this.selected, false);
    this.selected = st;
    if (st) { this.structures.setHighlight(st, true); this.el.sel.classList.remove('hidden'); this.el.selName.textContent = STRUCTURE_TYPES[st.type].name; this.el.hint.style.display = 'none'; }
    else { this.el.sel.classList.add('hidden'); this.el.hint.style.display = ''; }
  }

  rotateSelected(d) {
    if (this.tool) { this.ghostRot += d; this.updateGhost(); return; }
    if (!this.selected) return;
    this.structures.rotate(this.selected, d);
    this.structures.setHighlight(this.selected, true);
    this.rebuildObstacles();
  }

  deleteSelected() {
    if (!this.selected) return;
    const name = STRUCTURE_TYPES[this.selected.type].name;
    this.structures.remove(this.selected);
    this.select(null);
    this.rebuildObstacles();
    this.status(`${name} removed.`);
  }

  clearDefenses() {
    this.select(null);
    this.structures.clear();
    this.rebuildObstacles();
    this.status('All defenses cleared.');
  }

  /* ------------------------ input ------------------------ */
  bindInput() {
    const c = this.canvas;
    let down = null, moved = false, button = 0;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY }; moved = false; button = e.button; c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      this.mouseNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!moved && Math.hypot(dx, dy) > 4) moved = true;
        if (moved) {
          if (button === 0 && !e.shiftKey) this.controls.orbit(e.movementX, e.movementY);
          else this.controls.pan(e.movementX, e.movementY);
        }
      }
      if (this.tool) { this.updateGhostPos(); this.updateGhost(); }
    });
    c.addEventListener('pointerup', e => {
      if (down && !moved && e.button === 0) this.click();
      down = null;
    });
    c.addEventListener('pointerleave', () => { down = null; });
    c.addEventListener('wheel', e => { e.preventDefault(); this.controls.zoom(e.deltaY); }, { passive: false });
    window.addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') { if (this.tool) this.setTool(null); else this.select(null); }
      else if (k === 'r' || k === 'e') this.rotateSelected(-Math.PI / 12);
      else if (k === 'q') this.rotateSelected(Math.PI / 12);
      else if (k === 'delete' || k === 'backspace') this.deleteSelected();
      else if (k === ' ') { e.preventDefault(); if (this.state === 'ready') this.launchWave(); else this.togglePause(); }
      else if (k === '1') this.setTool('seawall'); else if (k === '2') this.setTool('breakwater');
      else if (k === '3') this.setTool('segmented'); else if (k === '4') this.setTool('embankment');
    });
  }

  updateGhostPos() {
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hit = this.raycaster.intersectObject(this.placePlane, false);
    if (hit.length) { const p = hit[0].point; this.ghostPos = { x: Math.round(p.x / CELL) * CELL, z: Math.round(p.z / CELL) * CELL }; }
  }

  click() {
    if (this.tool) { this.updateGhostPos(); this.updateGhost(); this.place(); return; }
    this.camera.updateMatrixWorld();
    this.structures.group.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this.structures.group.children, true);
    const st = hits.length ? hits[0].object.userData.structure : null;
    this.select(st || null);
    if (st) this.status(`${STRUCTURE_TYPES[st.type].name} selected. Rotate with Q / E or delete it.`);
  }

  /* ------------------------ simulation control ------------------------ */
  launchWave() {
    const p = WAVE_PRESETS[this.intensity];
    this.sim.launchWave(p.amp, p.period, worldX);
    this.launchedLabel = p.label; this.launchTime = this.sim.time; this._reported = false;
    this.el.wave.textContent = p.label;
    if (this.state !== 'paused') this.setState('running');
    this.status(`${p.label} wave launched: ${p.amp.toFixed(1)} m crest travelling toward the coast.`, true);
    this.crestPos.set(0, 0, -150);
  }

  togglePause() {
    if (this.state === 'ready') { this.status('Launch a wave first.'); return; }
    this.setState(this.state === 'paused' ? 'running' : 'paused');
    this.status(this.state === 'paused' ? 'Simulation paused.' : 'Simulation resumed.');
  }

  resetSimulation() {
    this.sim.resetWater();
    this.buildings.reset();
    this.rebuildObstacles();
    this.sim.resetWater();
    this.debris.clear();
    this.spray.clear();
    this.world.resetTrees();
    this.metrics = this.freshMetrics(); this.peakH.fill(0);
    this.launchedLabel = null; this.el.wave.textContent = '—';
    this.accum = 0; this._reported = false; this.launchTime = 0;
    this.setState('ready');
    this.world.updateTerrain(true);
    this.world.updateWater(0);
    this.flow.update();
    this.updateMetricsUI();
    this.status('Simulation reset. Defenses kept. Adjust the layout or launch again.');
  }

  /* ------------------------ metrics ------------------------ */
  computeMetrics() {
    const sim = this.sim, land = this.world.landMask, h = sim.h, crest = sim.crest, N = GRID_N, M = GRID_M;
    let maxD = 0, area = 0, maxLandSpeed = 0;
    let cx = 0, cz = 0, cw = 0;
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (land[k] && crest[k] <= SIM_NONE + 1) {
        const d = h[k];
        if (d > 0.1) { area++; if (d > maxD) maxD = d; if (sim.speed[k] > maxLandSpeed) maxLandSpeed = sim.speed[k]; if (d > this.peakH[k]) this.peakH[k] = d; }
      }
      // crest tracking for follow camera: weight surface elevation above sea level
      const eta = sim.b[k] + h[k];
      if (h[k] > 0.3 && eta > 0.6) { const w = (eta - 0.6) * (eta - 0.6); cx += worldX(i) * w; cz += worldZ(j) * w; cw += w; }
    }
    const m = this.metrics;
    m.nowDepth = maxD; m.nowArea = area * CELL * CELL; m.landSpeed = maxLandSpeed;
    if (maxD > m.peakDepth) m.peakDepth = maxD;
    if (m.nowArea > m.peakArea) m.peakArea = m.nowArea;
    if (cw > 0) { this.crestPos.x += (cx / cw - this.crestPos.x) * 0.2; this.crestPos.z += (cz / cw - this.crestPos.z) * 0.2; }
  }

  updateMetricsUI() {
    const m = this.metrics, sim = this.sim, e = this.el;
    e.time.textContent = sim.time.toFixed(1) + ' s';
    e.depth.textContent = m.peakDepth.toFixed(2) + ' m';
    e.depthNow.textContent = 'now ' + m.nowDepth.toFixed(2) + ' m';
    e.area.textContent = fmtArea(m.peakArea);
    e.areaNow.textContent = 'now ' + fmtArea(m.nowArea);
    e.erosion.textContent = Math.round(sim.erodedVolume).toLocaleString('en-US') + ' m³';
    e.erosionMax.textContent = 'max cut ' + sim.maxCut.toFixed(2) + ' m';
    const c = this.buildings.counts();
    e.damaged.textContent = `${c.damaged} / ${c.total}`;
    e.destroyed.textContent = `${c.destroyed} / ${c.total}`;
    const integ = this.buildings.integrity();
    e.health.style.width = (integ * 100).toFixed(1) + '%';
    e.healthTxt.textContent = Math.round(integ * 100) + '%';
  }

  /* ------------------------ main loop ------------------------ */
  loop(t) {
    requestAnimationFrame(tt => this.loop(tt));
    let dt = (t - this.lastT) / 1000; this.lastT = t;
    if (dt > 0.1) dt = 0.1;
    this.wallTime += dt;
    const sim = this.sim;
    let simAdvanced = 0;
    if (this.state === 'running') {
      this.accum += dt * this.speed;
      let steps = 0;
      while (this.accum >= SIM_DT && steps < 8) {
        sim.step(SIM_DT); this.accum -= SIM_DT; steps++;
      }
      if (steps === 8) this.accum = 0;   // never let the sim clock run away on slow machines
      simAdvanced = steps * SIM_DT;
      if (simAdvanced > 0) {
        this.buildings.update(simAdvanced, this.debris);
        this.rebuildIfDestroyedChanged();
        this.debris.update(simAdvanced);
        this.world.updateTrees(false);
        this.computeMetrics();
        this.checkSettled();
      }
    }
    this.spray.update(simAdvanced, this.state === 'running' && simAdvanced > 0);
    this.world.frame++;
    if (this.world.frame % 2 === 0) this.world.updateTerrain(false);
    this.world.updateWater(this.wallTime);
    this.world.updateBuoys(this.wallTime);
    this.flow.update();
    if (this.world.frame % 6 === 0) this.updateMetricsUI();
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /* Advance the simulation synchronously without rendering (used for automated checks). */
  simulate(seconds) {
    const sim = this.sim;
    if (this.state === 'ready') this.setState('running');
    let t = 0;
    while (t < seconds) {
      sim.step(SIM_DT); t += SIM_DT;
      this.buildings.update(SIM_DT, this.debris);
      this.rebuildIfDestroyedChanged();
      this.debris.update(SIM_DT);
      this.world.updateTrees(false);
      this.computeMetrics();
      this.checkSettled();
    }
    this.world.updateTerrain(true); this.world.updateWater(this.wallTime); this.flow.update(); this.updateMetricsUI();
  }

  rebuildIfDestroyedChanged() {
    const c = this.buildings.counts().destroyed;
    if (c !== this._lastDestroyed) { this._lastDestroyed = c; this.rebuildObstacles(); }
  }

  /* When the water has calmed after a wave, report the outcome. */
  checkSettled() {
    if (this._reported || !this.launchedLabel || this.sim.time - this.launchTime < 40 || this.sim.waveActive) return;
    const m = this.metrics;
    if (m.nowArea < Math.max(80, 0.15 * m.peakArea) && m.landSpeed < 0.6) {
      this._reported = true;
      const c = this.buildings.counts();
      const verdict = c.destroyed === 0 && c.damaged === 0 ? 'The town survived untouched.' : c.destroyed === 0 ? 'The town survived with damage.' : c.destroyed >= c.total / 2 ? 'The town was devastated.' : 'The town took heavy losses.';
      this.status(`Water has receded. ${verdict} ${c.destroyed} destroyed, ${c.damaged} damaged, peak flood ${m.peakDepth.toFixed(1)} m, ${Math.round(this.sim.erodedVolume)} m³ of beach eroded.`);
      this.el.state.className = 'badge done'; this.el.state.textContent = 'Complete';
    }
  }
}

function fmtArea(a) {
  if (a >= 10000) return (a / 10000).toFixed(2) + ' ha';
  return Math.round(a).toLocaleString('en-US') + ' m²';
}

window.addEventListener('DOMContentLoaded', () => {
  try { window.app = new App(); }
  catch (err) { document.getElementById('loading').innerHTML = '<div style="color:#ff5f5f;max-width:420px;text-align:center">Failed to start: ' + err.message + '</div>'; console.error(err); }
});
