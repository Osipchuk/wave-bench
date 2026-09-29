// Headless acceptance runs of the solver (no rendering).
import { FloodSim, baseShore } from '../js/sim.js';

const sim = new FloodSim();
const args = process.argv.slice(2);
const presets = args.length ? args : ['moderate', 'severe', 'extreme'];

function run(label, preset, setup) {
  sim.clearStructures();
  sim.reset();
  if (setup) setup(sim);
  sim.launch(preset);
  const t0 = performance.now();
  let steps = 0, lastLog = 0;
  const out = [];
  let bad = false;
  while (sim.time < 100) {
    steps += sim.advance(0.07, 1);
    if (sim.time - lastLog >= 15) {
      lastLog = sim.time;
      const m = sim.metrics;
      out.push(`t=${sim.time.toFixed(0)} flood=${(m.floodedArea/1e4).toFixed(2)}ha(${m.floodedPct.toFixed(0)}%) maxD=${m.maxFloodDepth.toFixed(2)} peak=${m.peakWave.toFixed(2)} reach=${m.inundation.toFixed(0)} ero=${m.erosion.toFixed(0)} scour=${m.maxScour.toFixed(2)} dmg=${m.damaged} des=${m.destroyed} landW=${m.landWater.toFixed(0)} vmax=${m.maxSpeed.toFixed(1)}`);
    }
    if (steps % 50 === 0) for (let c = 0; c < sim.N; c++) if (!Number.isFinite(sim.h[c])) { bad = true; break; }
    if (bad) break;
  }
  const ms = performance.now() - t0;
  console.log(`\n== ${label} [${preset}] steps=${steps} ms/step=${(ms/steps).toFixed(2)} ${bad ? 'NaN!!' : ''}`);
  console.log(out.join('\n'));
  return sim.metrics;
}

for (const p of presets) {
  run('No defences', p);
  run('Seawall x3 on beach', p, (s) => {
    for (const x of [-120, -60, 0, 60]) s.addStructure('seawall', x, baseShore(x) + 2, Math.atan(60 * x / (240 * 240)));
  });
  run('Single seawall (center)', p, (s) => {
    s.addStructure('seawall', -20, baseShore(-20) + 3, 0);
  });
  run('Single seawall (diagonal)', p, (s) => {
    s.addStructure('seawall', -20, baseShore(-20) + 3, 0.6);
  });
  run('Embankment x3', p, (s) => {
    for (const x of [-100, -30, 40]) s.addStructure('embankment', x, baseShore(x) - 2, Math.atan(60 * x / (240 * 240)));
  });
  run('Breakwater x3', p, (s) => {
    for (const x of [-150, -60, 30]) s.addStructure('breakwater', x, baseShore(x) + 40, 0);
  });
  run('Segmented breakwaters x3', p, (s) => {
    for (const x of [-150, -60, 30]) s.addStructure('segmented', x, baseShore(x) + 45, 0);
  });
}
