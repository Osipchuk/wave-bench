// test instrumentation only: exposes OrbitControls instance for the classic-script app
(()=>{let _t;Object.defineProperty(window,'THREE',{configurable:true,get(){return _t},set(v){_t=v;let oc;Object.defineProperty(v,'OrbitControls',{configurable:true,get(){return oc},set(C){oc=class extends C{constructor(...a){super(...a);window.__ctl=this;}}}});}});})();
