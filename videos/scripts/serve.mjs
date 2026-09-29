import http from 'http'; import fs from 'fs'; import path from 'path';
const apps={fable:['../../fable5.1',9001],opus:['../../opus5.5',9002],s5:['../../sonnet5',9003],s55:['../../sonnet5.5',9004]};
const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'};
for(const [k,[dir,port]] of Object.entries(apps)){const root=path.resolve(dir);
 http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);
  fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{'Content-Type':(T[path.extname(f)]||'application/octet-stream')+'; charset=utf-8'});r.end(d)})}).listen(port);}
console.log('up');
