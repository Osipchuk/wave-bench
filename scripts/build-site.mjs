// Builds the public site into dist/: a home page to pick a model, a player page per model
// that frames its build, a stats page and the prompt. The builds themselves are copied
// verbatim into dist/builds/<dir>/ (never edited: they are the benchmark output).
//
//   node scripts/build-site.mjs
//
// No dependencies. Deployed to Cloudflare Pages (wave-bench.evgenyosipchuk.com) and framed
// by the blog at evgenyosipchuk.com/demos/wave-bench/.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(ROOT, "dist");

const results = JSON.parse(readFileSync(join(ROOT, "results.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(SITE, "models.json"), "utf8"));

// ---------- data ----------

const CODE_EXT = new Set([".js", ".mjs", ".html", ".css"]);

function* walk(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules") continue;
      yield* walk(join(path, name));
    }
  } else {
    yield path;
  }
}

/** Non-blank lines of code in the model's own files (vendored libraries and bundles excluded). */
function countLines(dir, paths) {
  let lines = 0;
  let files = 0;
  for (const p of paths) {
    for (const file of walk(join(ROOT, dir, p))) {
      if (!CODE_EXT.has(extname(file))) continue;
      files++;
      lines += readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
    }
  }
  return { lines, files };
}

const runs = results.runs.map((run) => {
  const m = meta.models.find((x) => x.dir === run.dir);
  if (!m) throw new Error(`site/models.json has no entry for ${run.dir}`);
  const code = countLines(run.dir, m.source);
  return {
    ...run,
    ...m,
    code_lines: code.lines,
    code_files: code.files,
    cells: m.grid[0] * m.grid[1],
    tokens_per_min: Math.round(run.output_tokens / run.active_min),
    image: existsSync(join(SITE, "img", `${run.dir}.jpg`)) ? `/img/${run.dir}.jpg` : null,
  };
});

// ---------- formatting ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const int = (n) => n.toLocaleString("en-US");
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
const usd = (n) => `$${n.toFixed(2)}`;
const min = (n) => `${Math.round(n)} min`;
const shortName = (model) => model.replace(/^Claude /, "");

// ---------- layout ----------

const SITE_TITLE = "Wave Bench";
const DESCRIPTION =
  "One prompt, four Claude models, one pass each: an interactive 3D coastal flood simulation built in the browser. Run every build and compare the runs.";

function page({ title, description = DESCRIPTION, active, body, bodyClass = "" }) {
  const nav = [
    ["builds", "/", "Builds"],
    ["stats", "/stats/", "Stats"],
    ["prompt", "/prompt/", "Prompt"],
  ]
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title === SITE_TITLE ? title : `${title} · ${SITE_TITLE}`)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/Newsreader-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/JetBrainsMono-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body class="${bodyClass}">
${
  bodyClass === "player"
    ? body
    : `<div class="wrap">
<header class="site-head">
  <a class="brand" href="/">Wave&nbsp;Bench</a>
  <nav class="site-nav">${nav}</nav>
</header>
<main>
${body}
</main>
<footer class="site-foot">
  <span>Each build is the model's output exactly as it was left. Desktop browser with WebGL recommended.</span>
  <a href="https://evgenyosipchuk.com/" target="_top">evgenyosipchuk.com</a>
</footer>
</div>`
}
</body>
</html>
`;
}

// ---------- home ----------

function card(r) {
  const img = r.image
    ? `<img src="${r.image}" alt="${esc(`${r.app} by ${r.model}: the coastal town before the wave`)}" width="1024" height="640" loading="lazy">`
    : `<div class="card-noimg" aria-hidden="true"></div>`;
  return `<article class="card">
  <a class="card-shot" href="/play/${r.dir}/" tabindex="-1" aria-hidden="true">${img}</a>
  <div class="card-body">
    <div class="eyebrow">${esc(r.id)} · effort ${esc(r.effort)}</div>
    <h2 class="card-title"><a href="/play/${r.dir}/">${esc(r.model)}</a></h2>
    <p class="card-app">${esc(r.app)}</p>
    <p class="card-solver">${esc(r.solver)} · ${esc(r.grid.join(" × "))} grid</p>
    <p class="card-notes">${esc(r.notes)}</p>
    <dl class="card-stats">
      <div><dt>Active time</dt><dd>${min(r.active_min)}</dd></div>
      <div><dt>Output</dt><dd>${k(r.output_tokens)} tok</dd></div>
      <div><dt>Est. cost</dt><dd>${usd(r.cost_usd)}</dd></div>
      <div><dt>Own code</dt><dd>${int(r.code_lines)} lines</dd></div>
    </dl>
    <a class="run" href="/play/${r.dir}/">Run simulation <span aria-hidden="true">→</span></a>
  </div>
</article>`;
}

const home = page({
  title: SITE_TITLE,
  active: "builds",
  body: `<section class="hero">
  <div class="eyebrow">${runs.length} builds · one-shot · runs in your browser</div>
  <h1>One prompt. Four models. One&nbsp;pass.</h1>
  <p class="dek">Each Claude model got the same brief: build an interactive 3D coastal flood simulation with a real
  shallow-water solver, placeable defenses, erosion and building damage. No retries, no follow-up fixes.
  Pick a build, place a seawall, launch the wave.</p>
</section>
<section class="cards">
${runs.map(card).join("\n")}
</section>
<p class="more"><a href="/stats/">Compare the runs: time, tokens, cost, code →</a></p>`,
});

// ---------- player ----------

function player(r) {
  const tabs = runs
    .map(
      (x) =>
        `<a href="/play/${x.dir}/"${x.dir === r.dir ? ' aria-current="page"' : ""}>${esc(shortName(x.model))}</a>`,
    )
    .join("");
  return page({
    title: shortName(r.model),
    description: `${r.app}, built in one pass by ${r.model}. ${DESCRIPTION}`,
    bodyClass: "player",
    body: `<header class="bar">
  <a class="brand" href="/">Wave&nbsp;Bench</a>
  <nav class="tabs" aria-label="Choose a model">${tabs}</nav>
  <span class="bar-meta">effort ${esc(r.effort)} · ${min(r.active_min)} · ${usd(r.cost_usd)}</span>
  <a class="bar-link" href="/stats/">Stats</a>
  <a class="bar-link" href="/builds/${r.dir}/" target="_blank" rel="noopener">Open alone ↗</a>
</header>
<iframe class="stage" src="/builds/${r.dir}/" title="${esc(`${r.app} by ${r.model}`)}"></iframe>`,
  });
}

// ---------- stats ----------

const METRICS = [
  { key: "active_min", label: "Active time", unit: "minutes", fmt: min },
  { key: "output_tokens", label: "Output tokens", unit: "tokens written", fmt: k },
  { key: "cost_usd", label: "Estimated cost", unit: "USD at list prices", fmt: usd },
  { key: "code_lines", label: "Own code", unit: "non-blank lines", fmt: int },
  { key: "cache_read_tokens", label: "Cache reads", unit: "tokens re-read from cache", fmt: k },
  { key: "cells", label: "Simulation grid", unit: "cells", fmt: int },
];

function chart(m) {
  const max = Math.max(...runs.map((r) => r[m.key]));
  const rows = runs
    .map((r) => {
      const pct = ((r[m.key] / max) * 100).toFixed(2);
      const value = m.fmt(r[m.key]);
      return `<div class="bar-row">
      <span class="bar-label">${esc(shortName(r.model))}</span>
      <svg class="bar-track" role="img" aria-label="${esc(`${r.model}: ${value}`)}"><title>${esc(`${r.model}: ${value}`)}</title><rect width="${pct}%" height="100%" rx="3"></rect></svg>
      <span class="bar-value">${esc(value)}</span>
    </div>`;
    })
    .join("\n");
  return `<figure class="chart">
    <figcaption><b>${m.label}</b><span>${m.unit}</span></figcaption>
    ${rows}
  </figure>`;
}

const TABLE = [
  ["Effort", (r) => esc(r.effort)],
  ["Active time", (r) => `${r.active_min.toFixed(1)} min`],
  ["Wall-clock time", (r) => `${r.wall_min.toFixed(1)} min`],
  ["Input tokens", (r) => int(r.input_tokens)],
  ["Output tokens", (r) => int(r.output_tokens)],
  ["Output tokens / active min", (r) => int(r.tokens_per_min)],
  ["Cache reads", (r) => int(r.cache_read_tokens)],
  ["Cache writes", (r) => int(r.cache_write_tokens)],
  ["Estimated cost", (r) => usd(r.cost_usd)],
  ["Own code", (r) => `${int(r.code_lines)} lines · ${r.code_files} files`],
  ["Simulation grid", (r) => `${r.grid.join(" × ")}${r.cell_m ? ` · ${r.cell_m} m cells` : ""}`],
  ["Solver", (r) => esc(r.solver)],
];

const stats = page({
  title: "Stats",
  description: "Time, tokens, cost and code size of four one-shot runs of the same 3D flood-simulation prompt.",
  active: "stats",
  body: `<section class="hero">
  <div class="eyebrow">run stats · from the Claude Code session transcripts</div>
  <h1>What each run cost.</h1>
  <p class="dek">Same prompt, same harness, one session per model. Bars share a scale within each panel;
  the longest bar is the largest value.</p>
</section>
<section class="charts">
${METRICS.map(chart).join("\n")}
</section>
<section class="table-wrap">
  <h2>All numbers</h2>
  <div class="scroll">
  <table>
    <thead><tr><th scope="col"></th>${runs.map((r) => `<th scope="col"><a href="/play/${r.dir}/">${esc(shortName(r.model))}</a></th>`).join("")}</tr></thead>
    <tbody>
${TABLE.map(([label, f]) => `      <tr><th scope="row">${label}</th>${runs.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`).join("\n")}
    </tbody>
  </table>
  </div>
</section>
<section class="notes">
  <h2>How these were measured</h2>
  <ul>
    <li>Active time drops gaps over 5 minutes; wall-clock time is first to last message.</li>
    <li>${esc(results.note)}</li>
    <li>Cache reads dominate the token totals in agentic runs: every tool call re-reads the conversation so far.</li>
    <li>Own code counts non-blank lines of the model's .js/.html/.css files, including its own tests and tools,
    excluding vendored three.js and generated bundles.</li>
    <li>The Fable 5.1 session hit the output-token limit once and was told to resume; the Sonnet 5.5 session received
    some background-monitor notifications. Neither run got any additional guidance.</li>
    <li>Effort differs: Fable 5.1 and Opus 5.5 ran at medium, both Sonnets at high.</li>
  </ul>
</section>`,
});

// ---------- prompt ----------

/** Just enough Markdown for PROMPT.md: headings, paragraphs, lists, bold. */
function markdown(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of src.split("\n")) {
    let m;
    if (!line.trim()) {
      close();
    } else if ((m = line.match(/^(#{1,3}) (.*)/))) {
      close();
      const level = m[1].length + 1;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*(-|\d+\.) (.*)/))) {
      const tag = m[1] === "-" ? "ul" : "ol";
      if (list !== tag) {
        close();
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join("\n");
}

const prompt = page({
  title: "Prompt",
  description: "The one-shot prompt every model received: an interactive 3D coastal flood / tsunami simulation.",
  active: "prompt",
  body: `<section class="hero">
  <div class="eyebrow">the brief · given verbatim to every model</div>
  <h1>The prompt.</h1>
</section>
<article class="prose">
${markdown(readFileSync(join(ROOT, "PROMPT.md"), "utf8"))}
</article>`,
});

// ---------- write ----------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const write = (path, content) => {
  mkdirSync(dirname(join(OUT, path)), { recursive: true });
  writeFileSync(join(OUT, path), content);
};

for (const name of ["_headers", "404.html", "favicon.svg", "robots.txt", "assets", "fonts", "img"]) {
  if (existsSync(join(SITE, name))) cpSync(join(SITE, name), join(OUT, name), { recursive: true });
}
write("index.html", home);
write("stats/index.html", stats);
write("prompt/index.html", prompt);
for (const r of runs) {
  write(`play/${r.dir}/index.html`, player(r));
  for (const p of r.ship) cpSync(join(ROOT, r.dir, p), join(OUT, "builds", r.dir, p), { recursive: true });
}
write(
  "data/runs.json",
  JSON.stringify(
    runs.map(({ ship, source, image, notes, ...rest }) => rest),
    null,
    2,
  ),
);

console.log(`dist/ built: ${runs.map((r) => `${r.dir} (${r.code_lines} lines)`).join(", ")}`);
