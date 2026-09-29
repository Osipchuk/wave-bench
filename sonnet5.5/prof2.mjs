import { Sim, SIM_DT } from './src/sim.js';
const sim=new Sim(); sim.setStructures([]); sim.reset();
let t=performance.now(); for(let i=0;i<200;i++) sim.step(SIM_DT); console.log('idle step ms', (performance.now()-t)/200);
sim.launch('severe');
for (let r=0;r<5;r++){ t=performance.now(); for(let i=0;i<100;i++) sim.step(SIM_DT); console.log('running step ms', (performance.now()-t)/100, sim.t.toFixed(2)); }
