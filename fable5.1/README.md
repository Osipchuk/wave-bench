# Coastal Defense Lab

An interactive 3D coastal flood / tsunami sandbox that runs entirely in the browser.
Water is simulated live on a 160 x 160 shallow-water grid (2 m cells, 320 m x 320 m),
so every seawall, breakwater and embankment you place changes how the wave moves.

## Run

Any static file server works (Three.js is loaded from a CDN, so an internet connection is needed):

```bash
npx -y http-server -p 8123 -c-1 .
```

Then open <http://localhost:8123/>.

## How to use

1. Pick a defense (Seawall, Breakwater, Segmented Breakwater, Sloped Embankment), move the ghost
   into the scene and click to place it. `R`/`E`/`Q` rotate, `Esc` cancels, click a placed structure to
   select it, `Delete` removes it.
2. Choose a wave intensity (Moderate / Severe / Extreme) and press **Launch Wave**.
3. Watch the wave shoal, hit the defenses, flood the town, erode the beach and wreck buildings.
   **Show Flow** overlays velocity arrows, **Follow Wave** tracks the crest with the camera.
4. **Reset Simulation** restores water, terrain, buildings and metrics but keeps your defenses.
   **Clear Defenses** removes them.

## Files

- `index.html`, `style.css` – UI
- `sim.js` – shallow-water solver (staggered grid, upwind advection, wet/dry handling, wave maker,
  erosion, foam, wetness)
- `world.js` – terrain generation, lighting, terrain and water meshes, decoration
- `objects.js` – defenses, buildings with structural health, debris, flow arrows, spray
- `main.js` – camera, placement, UI wiring, main loop, metrics

`app.simulate(seconds)` (in the browser console) advances the simulation synchronously without
rendering; it is handy for automated checks.
