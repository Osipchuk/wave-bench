# Coastal Flood Lab

An interactive 3D tsunami / coastal-flood sandbox that runs in the browser. You build coastal
defenses, launch a wave, and watch a real-time shallow-water simulation flood the town, scour the
beach and knock down buildings. Then you reset and try a different layout.

## Run

The app uses ES modules and a Web Worker, so it has to be served over HTTP (opening
`index.html` from disk won't work). There are no dependencies to install; three.js is vendored.

```bash
npm start
```

Then open http://localhost:5173. Any static server works too, for example `python -m http.server 5173`.

## Controls

| Action | Input |
| --- | --- |
| Orbit / pan / zoom | Left-drag / right-drag / mouse wheel |
| Pick a defense | Click a card in the left panel, or keys `1`–`4` |
| Place | Click on the terrain. The ghost turns green where placement is valid |
| Rotate the ghost or the selected defense | `Q` / `E`, `Shift` + wheel, or the rotate buttons |
| Select, move, delete | `Esc` for the Select tool, click a defense, drag it, then `Del` |
| Launch / pause / reset | `Space` / `P` / `R` |
| Flow arrows / camera home | `F` / `H` |

A click only counts as placement when the mouse barely moved, so orbiting the camera never drops
a structure by accident.

## How it works

**Water (js/sim.js).** This is a 2D shallow-water solver on a 240 × 200 staggered grid with 2 m cells:

* Depth sits at cell centres and velocities on cell faces (MAC grid).
* Momentum is advected semi-Lagrangian. The free-surface pressure gradient is applied explicitly.
  Manning bed friction and extra structure drag slow the flow.
* Mass fluxes are upwind with a positivity limiter, so wetting and drying stay stable and water
  never goes negative. Face depth is measured above the higher of the two beds, so walls block
  water until it rises over their crest, and then it overtops.
* The offshore boundary is a Flather radiation condition. It injects the incoming long wave: a
  leading trough (the sea draws back), then the crest, arriving at a slight angle. It also lets
  reflected and receding water leave the model.
* Shoaling, refraction over the shoal and the canyon, bore formation, reflection, diffraction
  through gaps and run-up all come out of the equations. None of it is scripted.
* The timestep adapts to a CFL limit and velocities are clamped, so the Extreme preset stays
  stable.

**Defenses** are rasterised into the bed elevation and a drag field. The rendered meshes are
generated from the same profile functions, so what you see is what the water feels.

| Type | Profile | Behaviour |
| --- | --- | --- |
| Seawall | 96 m vertical wall, crest +9.5 m | Reflects the wave, water piles up in front, flow is diverted around its ends, overtopped by Extreme |
| Breakwater | 56 m rubble mound, crest +1.6 m, high porous drag | Absorbs energy, water passes over it |
| Segmented breakwater | 4 blocks with 14 m gaps, crest +2.6 m | Jets through the gaps, sheltered zones form behind the blocks |
| Sloped embankment | Wide 1:2.2 dike, crest +6 m, moderate drag | Dissipates energy, partial overtopping, no hard reflection |

**Erosion.** Every cell has an erodible sediment layer: 3 m of sand on the beach, a thinner soil
layer inland, none on rock or roads. Shear above a critical velocity lifts sediment into
suspension. The sediment is carried along with the water fluxes and settles where the flow slows.
Over-steepened wet slopes avalanche. The terrain mesh is displaced on the GPU from the live bed
height, and scoured and deposited areas are tinted.

**Buildings.** Each building is a solid obstacle in the grid. Its load is the momentum flux
`h·u² + 0.3·g·h²`, sampled around its footprint. Loads above the building's structural resistance
damage it quickly; lighter loads that last a long time wear it down slowly. A building has three
states: intact, damaged (broken windows, mud stain, tilt) and destroyed. A destroyed building
collapses: its cells become low, high-drag rubble that water flows over, and debris chunks spawn.
Cars, boats and debris float once the water is deep enough and drift with the local velocity. They
can hit and damage buildings. Trees, palms and umbrellas are knocked over along the flow direction.

**Architecture.** The solver runs in a Web Worker (`js/sim-worker.js`) and streams snapshots to
the renderer. If workers are unavailable it falls back to running on the main thread. The water
surface is a displaced grid driven by float textures of the simulation state. The fragment shader
adds foam from the simulated foam field, crest highlighting from the surface elevation, and ripples
that move with the flow.

**Reset.** Reset restores the water, terrain, sand, buildings, debris, props, wetness, metrics and
time. Placed defenses stay, so you can run the same wave against the same layout again. Use
**Clear Defenses** to remove them.

## Headless checks

```bash
node tools/acceptance.mjs
```

This runs the acceptance scenarios with no rendering: no defenses, a parallel seawall, a diagonal
seawall at ±35°, segmented breakwaters, and Extreme with and without a wall. It prints the global
metrics plus the flooding in the town blocks directly behind the test wall.
