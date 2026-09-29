(function () {
  const container = document.getElementById('viewport');
  const sim = new Simulation();
  sim.running = true;
  const scene = new SceneManager(sim, container);

  // ---------------- state ----------------
  let tool = 'select';
  let ghostRot = 0;
  let selectedId = null;
  let dragStart = null;

  const els = {
    toolBtns: [...document.querySelectorAll('.toolBtn')],
    rotateLeft: document.getElementById('rotateLeft'),
    rotateRight: document.getElementById('rotateRight'),
    deleteSelected: document.getElementById('deleteSelected'),
    clearDefenses: document.getElementById('clearDefenses'),
    intensityBtns: [...document.querySelectorAll('#intensityGroup .pill')],
    launchWave: document.getElementById('launchWave'),
    pauseResume: document.getElementById('pauseResume'),
    resetSim: document.getElementById('resetSim'),
    speedBtns: [...document.querySelectorAll('#speedGroup .pill')],
    showFlow: document.getElementById('showFlow'),
    followWave: document.getElementById('followWave'),
    banner: document.getElementById('instructionBanner'),
    bannerClose: document.getElementById('bannerClose'),
    statusBar: document.getElementById('statusBar'),
    placeHint: document.getElementById('placeHint'),
    mFloodDepth: document.getElementById('mFloodDepth'),
    mFloodArea: document.getElementById('mFloodArea'),
    mErosion: document.getElementById('mErosion'),
    mDamaged: document.getElementById('mDamaged'),
    mDestroyed: document.getElementById('mDestroyed'),
  };

  let selectedIntensity = 'moderate';
  let statusTimer = null;

  function showStatus(msg) {
    els.statusBar.textContent = msg;
    els.statusBar.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => els.statusBar.classList.remove('visible'), 2600);
  }

  function dismissBanner() {
    els.banner.classList.add('hidden');
  }
  els.bannerClose.addEventListener('click', dismissBanner);

  // ---------------- tool selection ----------------
  function setTool(name) {
    tool = name;
    els.toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    scene.removeGhost();
    setSelected(null);
    if (name === 'select') {
      scene.setCameraDragEnabled(true);
      els.placeHint.textContent = 'Click a placed structure to select it. Use Rotate / Delete to edit.';
    } else {
      scene.setCameraDragEnabled(false);
      ghostRot = 0;
      scene.createGhost(name);
      els.placeHint.textContent = 'Click the terrain to place. Press Q/E or use the rotate buttons to orient it.';
    }
  }
  els.toolBtns.forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

  // ---------------- selection ----------------
  function setSelected(id) {
    selectedId = id;
    scene.setSelectedDefense(id);
    const enabled = !!id;
    els.rotateLeft.disabled = tool !== 'select' ? false : !enabled;
    els.rotateRight.disabled = tool !== 'select' ? false : !enabled;
    els.deleteSelected.disabled = tool !== 'select' ? true : !enabled;
  }
  setSelected(null);

  // ---------------- rotate / delete ----------------
  function rotateActive(dir) {
    const delta = dir * (Math.PI / 12);
    if (tool !== 'select') {
      ghostRot += delta;
    } else if (selectedId) {
      sim.rotateDefense(selectedId, delta);
      const def = sim.defenses.find(d => d.id === selectedId);
      if (def) scene.syncDefenseMeshTransform(def);
    }
  }
  els.rotateLeft.addEventListener('click', () => rotateActive(1));
  els.rotateRight.addEventListener('click', () => rotateActive(-1));
  els.deleteSelected.addEventListener('click', () => {
    if (selectedId) {
      sim.removeDefense(selectedId);
      scene.removeDefenseMesh(selectedId);
      setSelected(null);
      showStatus('Structure removed.');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT')) return;
    if (e.key === 'Escape') setTool('select');
    else if (e.key === 'q' || e.key === 'Q') rotateActive(1);
    else if (e.key === 'e' || e.key === 'E') rotateActive(-1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select' && selectedId) {
      sim.removeDefense(selectedId);
      scene.removeDefenseMesh(selectedId);
      setSelected(null);
    }
  });

  // ---------------- canvas pointer interaction ----------------
  const canvas = scene.renderer.domElement;

  canvas.addEventListener('pointerdown', (e) => {
    dragStart = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (tool !== 'select' && scene.ghost) {
      const p = scene.pickGround(e.clientX, e.clientY);
      if (p) {
        const margin = 6;
        const valid = p.x > margin && p.x < GRID.NX - margin && p.z > margin && p.z < GRID.NZ - margin;
        scene.placeGhostAt(
          Math.min(GRID.NX - margin, Math.max(margin, p.x)),
          Math.min(GRID.NZ - margin, Math.max(margin, p.z)),
          ghostRot
        );
        scene.setGhostValid(valid);
        scene._lastGhostValid = valid;
        scene._lastGhostPos = p;
      }
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!dragStart) return;
    const dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
    dragStart = null;
    if (dist > 6) return; // treat as camera drag, not a click

    if (tool === 'select') {
      const id = scene.pickDefense(e.clientX, e.clientY);
      setSelected(id);
      return;
    }

    // placement click
    const p = scene.pickGround(e.clientX, e.clientY);
    if (!p) return;
    const margin = 6;
    const x = Math.min(GRID.NX - margin, Math.max(margin, p.x));
    const z = Math.min(GRID.NZ - margin, Math.max(margin, p.z));
    if (x <= margin || x >= GRID.NX - margin || z <= margin || z >= GRID.NZ - margin) return;
    const defense = sim.addDefense(tool, x, z, ghostRot);
    scene.addDefenseMesh(defense);
    showStatus(capitalize(tool) + ' placed. Keep clicking to add more, or press Escape to stop.');
  });

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  els.clearDefenses.addEventListener('click', () => {
    sim.clearDefensesAndReset();
    scene.clearAllDefenseMeshes();
    clearDebrisVisuals();
    setTool('select');
    showStatus('All defenses cleared and simulation reset.');
  });

  function clearDebrisVisuals() {
    for (const d of scene.debris) scene.debrisGroup.remove(d.mesh);
    scene.debris.length = 0;
  }

  // ---------------- wave intensity ----------------
  els.intensityBtns.forEach(btn => btn.addEventListener('click', () => {
    selectedIntensity = btn.dataset.intensity;
    els.intensityBtns.forEach(b => b.classList.toggle('active', b === btn));
  }));

  els.launchWave.addEventListener('click', () => {
    dismissBanner();
    sim.running = true;
    els.pauseResume.textContent = 'Pause';
    sim.launchWave(selectedIntensity);
    showStatus(capitalize(selectedIntensity) + ' wave launched offshore.');
  });

  // ---------------- playback ----------------
  els.pauseResume.addEventListener('click', () => {
    sim.running = !sim.running;
    els.pauseResume.textContent = sim.running ? 'Pause' : 'Resume';
  });

  els.resetSim.addEventListener('click', () => {
    sim.resetAll();
    clearDebrisVisuals();
    for (const b of sim.buildings) {
      if (b.mesh) {
        b.mesh.group.visible = true;
        b.mesh.bodyMat.color.copy(b.mesh.baseColor);
        b.mesh.group.rotation.z = 0;
      }
    }
    sim.running = true;
    els.pauseResume.textContent = 'Pause';
    showStatus('Simulation reset. Defenses kept in place.');
  });

  els.speedBtns.forEach(btn => btn.addEventListener('click', () => {
    els.speedBtns.forEach(b => b.classList.toggle('active', b === btn));
    sim.setSpeed(parseFloat(btn.dataset.speed));
  }));

  els.showFlow.addEventListener('change', () => {
    scene.showFlow = els.showFlow.checked;
    scene.flowMesh.visible = els.showFlow.checked;
  });
  els.followWave.addEventListener('change', () => {
    scene.followWave = els.followWave.checked;
  });

  // ---------------- metrics ----------------
  function updateMetricsUI() {
    const m = sim.metrics;
    els.mFloodDepth.textContent = m.maxFloodDepth.toFixed(2) + ' m';
    els.mFloodArea.textContent = Math.round(m.floodedArea).toLocaleString() + ' m²';
    els.mErosion.textContent = Math.round(m.erosionPct) + '%';
    els.mDamaged.textContent = m.buildingsDamaged;
    els.mDestroyed.textContent = m.buildingsDestroyed;
  }

  // ---------------- main loop ----------------
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    sim.step(dt);
    scene.render(dt);
    updateMetricsUI();
  }
  animate();

  setTool('select');
})();
