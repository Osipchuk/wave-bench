// Headless acceptance checks (Tests 1-5): runs the solver without rendering and
// reports global metrics plus local flooding in the zone directly behind x in [-52, 12].
import { FloodSim, baseShore, shoreZ, NX, NZ, cellX, cellZ } from '../js/sim.js';

const sim = new FloodSim();
function zoneStats() {
  // town blocks directly behind the test wall: x in [-68, 28], 40..120 m inland
  let sum = 0, n = 0, wet = 0;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = cellX(i), z = cellZ(j), s = shoreZ(x) - z;
    if (x < -68 || x > 28 || s < 40 || s > 120) continue;
    const c = j * NX + i;
    if (!sim.landMask[c] || sim.bldId[c] >= 0) continue;
    n++; sum += sim.maxDepth[c];
    if (sim.maxDepth[c] > 0.2) wet++;
  }
  return { townBehindMeanMaxDepth: +(sum / n).toFixed(2), townBehindFloodedPct: Math.round(100 * wet / n) };
}
const only = process.argv[2];
function run(label, preset, setup, T = 80) {
  if (only && !label.startsWith(only)) return;
  sim.clearStructures();
  sim.reset();
  if (setup) setup(sim);
  sim.launch(preset);
  let asym = null;
  while (sim.time < T) {
    sim.advance(0.07, 1);
    if (asym === null && sim.time > 32) {
      // mean along-shore velocity just behind the wall zone (flow redirection)
      let su = 0, n = 0;
      for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
        const x = cellX(i), z = cellZ(j), s = shoreZ(x) - z;
        if (x < -80 || x > 40 || s < -30 || s > 10) continue;
        const c = j * NX + i; if (sim.h[c] > 0.2) { su += sim.cu[c]; n++; }
      }
      asym = +(su / Math.max(1, n)).toFixed(2);
    }
  }
  const m = sim.metrics;
  const out = { label, preset, floodedHa: +(m.floodedArea / 1e4).toFixed(2), maxDepth: +m.maxFloodDepth.toFixed(1),
    erosion: Math.round(m.erosion), damaged: m.damaged, destroyed: m.destroyed, meanAlongshoreU: asym, ...zoneStats() };
  console.log(JSON.stringify(out));
  return out;
}
const wall = (s) => s.addStructure('seawall', -20, baseShore(-20) + 3, 0);
run('T1 no defenses', 'severe');
run('T2 seawall parallel', 'severe', wall);
run('T3 seawall diagonal +35deg', 'severe', (s) => s.addStructure('seawall', -20, baseShore(-20) + 3, 35 * Math.PI / 180));
run('T3 seawall diagonal -35deg', 'severe', (s) => s.addStructure('seawall', -20, baseShore(-20) + 3, -35 * Math.PI / 180));
run('T4 segmented breakwater', 'severe', (s) => s.addStructure('segmented', -20, baseShore(-20) + 42, 0));
run('T5 extreme, no defenses', 'extreme');
run('T5 extreme vs seawall', 'extreme', wall);
