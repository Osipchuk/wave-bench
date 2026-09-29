import { Sim, SIM_DT } from './src/sim.js';
import * as W from './src/world.js';
const sim=new Sim(); sim.setStructures([]); sim.reset(); sim.launch('severe');
const T=+process.argv[2]||3.6;
for(let k=0;k<T*60;k++){ sim.step(SIM_DT); if(k%3==0) sim.update(3*SIM_DT); }
const ic=W.idxOfX(0); let l1='',l2='';
for(let j=0;j<W.NY;j+=4){ const c=j*W.NX+ic; const eta=sim.Bh[c]+sim.d[c]; if(W.cellZ(j)>12) break; l1+=`${W.cellZ(j).toFixed(0)}:${eta.toFixed(2)} `; l2+=`${W.cellZ(j).toFixed(0)}:${sim.vc[c].toFixed(1)} `; }
console.log('eta',l1); console.log('v',l2);
