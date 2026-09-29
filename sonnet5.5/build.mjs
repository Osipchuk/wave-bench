import { build } from 'esbuild';
import fs from 'node:fs';
await build({ entryPoints: ['src/main.js'], bundle: true, format: 'iife', outfile: 'dist/app.js', minify: true, target: 'es2020', legalComments: 'none', logLevel: 'info' });
// single-file standalone build (works when double-clicked, no server needed)
const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('dist/app.js', 'utf8').replace(/<\/script>/g, '<\/script>');
fs.writeFileSync('coastal-flood-lab.html', html.replace('<script src="dist/app.js"></script>', () => '<script>' + js + '</script>'));
console.log('wrote coastal-flood-lab.html');
