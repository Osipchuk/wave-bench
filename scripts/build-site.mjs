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

// Performance benchmark (perf/perf.mjs, see PERFORMANCE.md): two runs per build, averaged.
const PERF_KEYS = { fable: "fable5.1", opus: "opus5.5", s5: "sonnet5", s55: "sonnet5.5" };
const perfRaw = JSON.parse(readFileSync(join(ROOT, "perf", "results.json"), "utf8"));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const [key, list] of Object.entries(perfRaw)) {
  const r = runs.find((x) => x.dir === PERF_KEYS[key]);
  if (!r) throw new Error(`perf/results.json: unknown key ${key}`);
  const avg = (f) => mean(list.map(f));
  r.perf = {
    runs: list.length,
    fps_idle: avg((x) => x.idle.fps),
    fps_wave: avg((x) => x.wave.fps),
    p50_ms: avg((x) => x.wave.p50ms),
    p99_ms: avg((x) => x.wave.p99ms),
    worst_ms: Math.max(...list.map((x) => x.wave.maxMs)),
    slow_frames: avg((x) => x.wave.framesOver50ms),
    long_task_s: avg((x) => x.wave.longTaskMs) / 1000,
    load_s: avg((x) => x.loadMs) / 1000,
    heap_mb: avg((x) => x.jsHeapMB),
  };
}
const hasPerf = runs.every((r) => r.perf);

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
    ["performance", "/performance/", "Performance"],
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
<p class="more"><a href="/stats/">Compare the runs: time, tokens, cost, code →</a><br>
<a href="/performance/">Frame rate, stutters and load time →</a></p>`,
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

/** One small-multiple panel: a bar per build on a shared scale. `m.get` reads the value. */
function chart(m) {
  const get = m.get ?? ((r) => r[m.key]);
  const max = Math.max(...runs.map(get)) || 1;
  const rows = runs
    .map((r) => {
      const pct = ((get(r) / max) * 100).toFixed(2);
      const value = m.fmt(get(r));
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

function table(rowsSpec) {
  return `<div class="scroll">
  <table>
    <thead><tr><th scope="col"></th>${runs.map((r) => `<th scope="col"><a href="/play/${r.dir}/">${esc(shortName(r.model))}</a></th>`).join("")}</tr></thead>
    <tbody>
${rowsSpec.map(([label, f]) => `      <tr><th scope="row">${label}</th>${runs.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`).join("\n")}
    </tbody>
  </table>
  </div>`;
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
  ${table(TABLE)}
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

// ---------- performance ----------

const fps = (n) => `${Math.round(n)} fps`;
const ms = (n) => `${Math.round(n)} ms`;
const sec = (n) => `${n.toFixed(1)} s`;

const PERF_METRICS = [
  { label: "FPS during the wave", unit: "higher is better", get: (r) => r.perf.fps_wave, fmt: fps },
  { label: "Frames over 50 ms", unit: "visible stutters, lower is better", get: (r) => r.perf.slow_frames, fmt: (n) => int(Math.round(n)) },
  { label: "Worst frame", unit: "longest freeze, lower is better", get: (r) => r.perf.worst_ms, fmt: ms },
  { label: "Load time", unit: "to the load event, lower is better", get: (r) => r.perf.load_s, fmt: sec },
];

const PERF_TABLE = [
  ["Solver runs on", (r) => esc(r.thread)],
  ["Simulation grid", (r) => `${r.grid.join(" × ")} · ${int(r.cells)} cells`],
  ["FPS idle", (r) => fps(r.perf.fps_idle)],
  ["FPS during the wave", (r) => fps(r.perf.fps_wave)],
  ["Frame time p50 / p99", (r) => `${Math.round(r.perf.p50_ms)} / ${Math.round(r.perf.p99_ms)} ms`],
  ["Worst frame", (r) => ms(r.perf.worst_ms)],
  ["Frames over 50 ms", (r) => int(Math.round(r.perf.slow_frames))],
  ["Long-task time", (r) => sec(r.perf.long_task_s)],
  ["Load time", (r) => sec(r.perf.load_s)],
  ["JS heap", (r) => `${Math.round(r.perf.heap_mb)} MB`],
];

const perfPage = page({
  title: "Performance",
  description: "Frame rate, stutters and load time of the four builds under the same Extreme wave.",
  active: "performance",
  body: `<section class="hero">
  <div class="eyebrow">performance · same scenario on every build</div>
  <h1>How smoothly each one runs.</h1>
  <p class="dek">Extreme wave against a seawall, 1600×900, desktop Chrome with a GPU: six seconds idle, then
  fifty seconds of the wave. Two runs per build, averaged. The frame limiter is off, so FPS shows headroom,
  not what a 60 Hz screen displays.</p>
</section>
<section class="charts">
${PERF_METRICS.map(chart).join("\n")}
</section>
<section class="table-wrap">
  <h2>All numbers</h2>
  ${table(PERF_TABLE)}
</section>
<section class="notes">
  <h2>Reading it</h2>
  <ul>
    <li><strong>Sonnet 5</strong> is the fastest and smoothest, but it also has the smallest grid: 12k cells,
    half of Sonnet 5.5 and a quarter of Opus 5.5, so its water is the coarsest.</li>
    <li><strong>Fable 5.1</strong> holds 65–70 FPS but stutters when the wave hits, with frames up to 300 ms.</li>
    <li><strong>Sonnet 5.5</strong> sits in between, with occasional hitches and large run-to-run variance.</li>
    <li><strong>Opus 5.5</strong> has the largest grid and the heaviest visuals. The solver runs in a Web Worker,
    yet rendering still drops to about 25 FPS during the wave. It is also the slowest to load.</li>
    <li>All four stay usable after the Extreme wave; nothing crashed or blew up numerically.</li>
  </ul>
  <h2>On a laptop it's a different story</h2>
  <p class="notes-p">On a 2019 Intel MacBook Pro with a Retina screen, only <strong>Sonnet 5.5</strong> ran without lag.
  It is the only build that lowers its own quality: when frames stay slower than about 34 ms, it drops the pixel
  ratio to 1. The other three render at 1.6–2× pixel ratio with 2048 px shadow maps and no fallback, which is
  2.5–4 times the pixels for an integrated GPU. So the desktop ranking doesn't hold on weaker or high-DPI hardware.</p>
  <p class="notes-p">Caveats: one desktop, two runs per build, measured with Playwright from
  <code>requestAnimationFrame</code> timings and the long-task observer.</p>
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
if (hasPerf) write("performance/index.html", perfPage);
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
