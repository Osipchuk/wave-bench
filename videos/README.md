# Side-by-side comparison

`wave_bench_comparison.mp4` (2560x1760, 62 s): the four builds, run unmodified, in one identical scenario:

1. Load the app, dismiss the intro, pick **Extreme**.
2. Select **Seawall** and click the same screen point (800, 560) at 1600x900, default rotation. Press Esc.
3. The camera is set from outside the page (`scripts/cam.mjs`) to the same view in all four apps: from the sea side, turned 28 degrees along the beach, 34 degrees elevation, aimed at the seawall. Around the wave impact it dollies in (over 6 s) to a closer pose behind the wall so damage is visible. Distances are tuned per app because the scenes use different units.
4. Press **Launch Wave** and record 75 s. The apps start the wave at different delays, so the tiles are time-aligned: the recorder polls each app's *Maximum Flood Depth* readout, and the moment it first exceeds 0.2 m is placed at 12 s in every tile (`Impact +Ns` counter in the footer).

Each footer shows the model, effort level and what it cost to *build* the app (active time, total tokens, estimated USD; see [../results.json](../results.json)).
The four runs were recorded one after another on the same machine in real Chrome (headed, GPU) and composited side by side.
Frames are captured with the Chrome DevTools screencast, so the slower solvers show a lower frame rate.

`scripts/` has the recorder (`record.mjs`, Playwright), the camera rig (`cam.mjs`, `hook.js`), a static server for the four folders (`serve.mjs`), per-app selectors (`apps.mjs`) and the ffmpeg composition (`build.py`).
No app code was touched.
