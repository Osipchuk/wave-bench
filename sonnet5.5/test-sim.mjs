import { Sim, SIM_DT } from './src/sim.js';
import * as W from './src/world.js';
const sim = new Sim();
function mk(type,x,z,rot=0){ const p={type,x,z,rot}; p.ref=W.computeRef(p); return p; }
function run(name, key, structs, T=40, log=false){
  sim.setStructures(structs); sim.reset(); sim.launch(key);
  const t0=Date.now(); let acc=0, frames=0;
  while(sim.t<T){ for(let k=0;k<2;k++) sim.step(SIM_DT); sim.update(2*SIM_DT); frames++;
    if(log && frames%60==0) console.log(sim.t.toFixed(1), sim.status, 'front',sim.frontZ.toFixed(1),'maxD',sim.maxDepth.toFixed(2),'landWet',sim.landWet, 'maxSpd',sim.landMaxSpeed.toFixed(1));
    if(!isFinite(sim.d[1000])) {console.log('NaN!');break;} }
  const m=sim.metrics(); const ms=(Date.now()-t0);
  let mass=0, mx=0; for(let c=0;c<sim.d.length;c++){ mass+=sim.d[c]; if(sim.d[c]>mx) mx=sim.d[c]; }
  console.log(name.padEnd(26), key.padEnd(9), `depth ${m.maxDepth.toFixed(2)} area ${m.floodedArea.toFixed(0)} (${m.floodedPct.toFixed(1)}%) eros ${m.erosion.toFixed(1)} scour ${m.maxScour.toFixed(2)} dam ${m.damaged} des ${m.destroyed}  phase ${sim.phase} maxd ${mx.toFixed(1)}  ${ms}ms`);
}
const args=process.argv.slice(2);
if(args[0]==='log'){ run('none',args[1]||'severe',[],60,true); process.exit(0); }
for (const k of ['moderate','severe','extreme']) run('none',k,[]);
for (const k of ['moderate','severe','extreme']) run('seawall s~5',k,[mk('seawall',0,W.coastZ(0)+5,0)]);
run('seawall diagonal','severe',[mk('seawall',0,W.coastZ(0)+5,0.6)]);
run('segmented offshore','severe',[mk('segmented',0,-6,0)]);
run('breakwater offshore','severe',[mk('breakwater',0,-6,0)]);
run('embankment','severe',[mk('embankment',0,W.coastZ(0)+3,0)]);
run('seawall extreme+bw','extreme',[mk('seawall',0,W.coastZ(0)+5,0),mk('breakwater',0,-6,0)]);
