# Performance

Same scenario as the video (Extreme wave, seawall, 1600x900, real Chrome with GPU), measured with [perf/perf.mjs](perf/perf.mjs) (Playwright, `requestAnimationFrame` frame timing + long-task observer, 6 s idle then 50 s of the wave).
Two runs per app, averaged. The frame limiter is off, so FPS is *headroom*, not what a 60 Hz screen would show.

| App | Sim grid (cells) | Solver runs on | FPS idle | FPS during wave | Frame ms p50 / p99 | Worst frame, ms | Frames > 50 ms | Long-task time | Load | JS heap, MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fable 5.1 | 160x160 (25.6k) | main thread | 82 | 68 | 13 / 50 | 302 | 34 | 2.3 s | 2.5 s | 7 |
| Opus 5.5 | 240x200 (48k) | Web Worker | 105 | 25 | 36 / 83 | 218 | 176 | 10.0 s | 6.1 s | 26 |
| Sonnet 5 | 120x100 (12k) | main thread | 113 | 108 | 9 / 18 | 36 | 0 | 0.0 s | 2.5 s | 14 |
| Sonnet 5.5 | 160x140 (22.4k) | main thread | 127 | 56 | 17 / 48 | 155 | 22 | 1.2 s | 5.7 s | 14 |

Reading it:

- **Sonnet 5** is the fastest and smoothest (100+ FPS, worst frame 36 ms), but it also has the smallest grid (12k cells, half of Sonnet 5.5 and a quarter of Opus 5.5), so its water is the coarsest.
- **Fable 5.1** averages 65-70 FPS but stutters when the wave hits (frames up to 300 ms; 27-42 frames over 50 ms per run).
- **Sonnet 5.5** is in between: 48-64 FPS, occasional hitches, run-to-run variance is large.
- **Opus 5.5** has the largest grid and the heaviest visuals; the solver is in a Web Worker, but rendering still drops to ~25 FPS during the wave with about 10 s of long tasks on the main thread. Slowest to load too.
- All four stay usable after the Extreme wave; nothing crashed or blew up numerically.

Caveats: one machine, two runs, no screen recording running. Sonnet 5.5 and Opus 5.5 take about twice as long to load (5.7 s and 6.1 s vs 2.5 s); I did not profile why (Sonnet 5.5 ships a 675 KB bundle, Opus 5.5 uses ES modules and a Web Worker).
Fable 5.1 loads three.js from a CDN, so it needs internet. Per-run numbers are in [perf/results.json](perf/results.json).
