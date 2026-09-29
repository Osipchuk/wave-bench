# Coastal Flood Lab

An interactive 3D coastal flood / tsunami sandbox that runs entirely in the browser.

**Run it:** open `coastal-flood-lab.html` (single file, no server needed) or `index.html` (loads `dist/app.js`).
Rebuild after editing `src/`: `npm install && npm run build`.

## What is simulated

* **Water** – a real-time shallow-water solver on a 160 x 140 staggered grid (`src/sim.js`).
  State: water depth per cell, discharge (momentum) per face. Face update is the inertial
  shallow-water form with implicit Manning friction, flux limiting keeps mass conserved and
  wet/dry fronts stable. Nothing about the wave is scripted: the wave is an initial
  offshore hump with a progressive-wave velocity field; shoaling, refraction over the shoal/trench,
  bore formation, run-up, reflection, overtopping and drainage all emerge from the bed geometry.
* **Defenses** – rasterised into the bed height (`bS`) and roughness maps at launch, so their
  position and orientation directly change the hydraulics (blocking, pile-up, flow around ends,
  jets through gaps, wakes, overtopping). Rubble mounds also add drag.
* **Erosion** – erodible sand layer lowered where bed shear (speed^2) exceeds a threshold, part of
  the sediment is re-deposited downstream. The terrain mesh visibly changes.
* **Buildings** – load = momentum flux + hydrostatic head measured on the cells around each
  footprint. Damage accumulates while load exceeds the building's capacity: intact -> damaged -> destroyed
  (collapse animation, rubble, floating debris).
* **Metrics** – max open-ground flood depth, flooded area, eroded volume, damaged / destroyed counts, all read
  from the simulation state and compared with the previous run.

## Controls

| Action | Input |
| --- | --- |
| Orbit / pan / zoom | left-drag / right-drag / wheel |
| Choose tool | panel buttons or `1`-`5` |
| Place defense | click (ghost: green = valid, red = invalid) |
| Select / move | `Select` tool, click / drag a defense |
| Rotate | `R` (Shift+R reverse), heading slider or buttons |
| Delete | `Del` or Delete button |
| Launch Wave | button or `L` |
| Pause / Resume | button or `Space` |
| Reset Simulation | button (defenses stay), or press `Esc` three times |
| Show Flow | toggle or `F` |

Defenses are locked while a wave is active; press **Reset Simulation** to edit and re-run.

`window.__lab` exposes a small scripting handle (`place`, `launch`, `resetSim`, `fastForward`, ...) for experiments.
`node test-sim.mjs` runs the solver headlessly for the acceptance scenarios.
