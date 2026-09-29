import { Sim, SIM_DT } from './src/sim.js';
import * as W from './src/world.js';
const key=process.argv[2]||'severe';
const sim=new Sim(); sim.setStructures([]); sim.reset(); sim.launch(key);
for(let k=0;k<60*30;k++){ sim.step(SIM_DT); if(k%3==0) sim.update(3*SIM_DT); }
const vals=[]; for(let c=0;c<sim.d.length;c++) if(sim.land[c]&&!sim.solid[c]&&sim.peak[c]>0.15) vals.push(sim.peak[c]);
vals.sort((a,b)=>a-b); const p=q=>vals[Math.floor(q*(vals.length-1))].toFixed(2);
console.log(key,'flooded cells',vals.length,'p50',p(.5),'p90',p(.9),'p99',p(.99),'max',p(1));
// per-row (s) average peak depth at column x=0
const rows=[]; const ic=W.idxOfX(0); for(let j=0;j<W.NY;j+=3){ const c=j*W.NX+ic; rows.push(W.cellZ(j).toFixed(0)+':'+sim.peak[c].toFixed(1)); } console.log(rows.join(' '));
const b=sim.bld.map(b=>b.spec.name.slice(0,8)+' pk'+b.peakDepth.toFixed(1)+' sp'+b.peakSpeed.toFixed(1)+' L'+b.peakLoad.toFixed(1)+'/'+b.cap+' I'+(b.dmgInt||0).toFixed(1)+' hp'+b.hp.toFixed(0)); console.log(b.join(' | '));
