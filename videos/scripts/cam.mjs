// camera rig injected from outside (no app code modified). Same azimuth (straight from the sea) and elevation for all apps.
export const RIG={
 fable:{sea:-1,wall:[-32,-25],ty:2,  wide:{inl:40,d:240,e:34},close:{inl:80,d:150,e:30}},
 opus:{sea:1,wall:[-66,59],ty:0,     wide:{inl:50,d:300,e:34},close:{inl:70,d:170,e:28}},
 s5:{sea:1,wall:[4.3,21],ty:1,       wide:{inl:15,d:120,e:34},close:{inl:22,d:80,e:28}},
 s55:{sea:-1,wall:[-7.3,-11],ty:0,   wide:{inl:15,d:95,e:34},close:{inl:22,d:52,e:28}},
};
export const INSTALL=`(cfg)=>{
 const g=window;
 let cam,ctl,fab=null;
 if(g.__lab){cam=g.__lab.camera;ctl=g.__lab.controls}
 else if(g.app&&g.app.controls&&g.app.controls.theta!==undefined){fab=g.app.controls;cam=g.app.camera;ctl=fab}
 else if(g.__ctl){cam=g.__ctl.object;ctl=g.__ctl}
 if(ctl.minDistance!==undefined){ctl.minDistance=1;ctl.maxDistance=2000;ctl.maxPolarAngle=Math.PI/2}
 if(fab){fab.minDist=1;fab.maxDist=2000}
 const lerp=(a,b,s)=>a+(b-a)*s;
 g.__pose=(s)=>{
  const w=cfg.wide,c=cfg.close;
  const az=28*Math.PI/180;const inl=lerp(w.inl,c.inl,s),d=lerp(w.d,c.d,s),e=lerp(w.e,c.e,s)*Math.PI/180;
  const tx=cfg.wall[0],tz=cfg.wall[1]-cfg.sea*inl,ty=cfg.ty;
  if(fab){fab.target.set(tx,ty,tz);fab.dist=d;fab.phi=Math.PI/2-e;fab.theta=cfg.sea>0?az:Math.PI+az;fab.update();}
  else{ctl.target.set(tx,ty,tz);cam.position.set(tx+cfg.sea*Math.sin(az)*d*Math.cos(e),ty+d*Math.sin(e),tz+cfg.sea*Math.cos(az)*d*Math.cos(e));if(ctl.update)ctl.update();}
 };
}`;
