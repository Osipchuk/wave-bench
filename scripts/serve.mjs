// Serves dist/ the way Cloudflare Pages does, including the headers from dist/_headers
// (so the CSP is exercised locally) and /dir → /dir/index.html.
//
//   npm run build && npm run preview     # http://localhost:8788

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = Number(process.env.PORT) || 8788;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** [{ pattern: RegExp, headers: [name, value][] }] from _headers; `*` is a splat. */
function parseHeaders() {
  const rules = [];
  for (const line of readFileSync(join(DIST, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const re = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      rules.push({ pattern: new RegExp(`^${re}$`), headers: [] });
    } else {
      const i = line.indexOf(":");
      rules.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith("/")) return res.writeHead(308, { Location: `${path}/` }).end();
    file = join(file, "index.html");
  }
  const found = existsSync(file);
  const headers = {};
  for (const rule of parseHeaders()) {
    if (!rule.pattern.test(path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value; // Pages joins repeats with a comma
    }
  }
  headers["content-type"] = MIME[extname(found ? file : ".html")] || "application/octet-stream";
  res.writeHead(found ? 200 : 404, headers);
  res.end(readFileSync(found ? file : join(DIST, "404.html")));
}).listen(PORT, () => console.log(`Wave Bench preview at http://localhost:${PORT}`));
