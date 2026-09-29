# Side-by-side comparison

`wave_bench_comparison.mp4` (2560x1760, 58 s): the four builds, run unmodified, in one identical scenario:

1. Load the app, dismiss the intro, pick **Severe**.
2. Select **Seawall** and click the same screen point (800, 560) at 1600x900 with the app's default camera and rotation.
3. Press **Launch Wave** and record 55 s (T+ counter in the footer starts at launch).

Each footer shows the model, effort level and what it cost to *build* the app (active time, total tokens, estimated USD; see [../results.json](../results.json)).
The four runs were recorded one after another on the same machine in real Chrome (headed, GPU) and composited side by side.
Frames are captured with the Chrome DevTools screencast, so the slower solvers show a lower frame rate.

`scripts/` has the recorder (`record.mjs`, Playwright), a static server for the four folders (`serve.mjs`), per-app selectors (`apps.mjs`) and the ffmpeg composition (`build.py`).
No app code was touched.
