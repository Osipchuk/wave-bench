Build a polished, fully interactive **3D coastal flood / tsunami simulation** that runs directly in the browser.

This is not a mockup, not a pre-rendered animation, and not a fake water shader moving across static geometry.

The scene must contain an actual real-time simulation of water propagation interacting with terrain, barriers, and buildings.

# ONE-SHOT BENCHMARK

**You have one pass. Build everything now. There will be no retries, no follow-up fixes, and no second attempt. This is your benchmark.**

Do not ask clarifying questions.

Make reasonable engineering and visual decisions yourself.

Do not stop at scaffolding.

Do not leave TODOs, placeholder buttons, fake interactions, or unfinished core features.

Before considering the task complete, test the entire interaction loop mentally and make sure the application can run multiple experiments without reloading the page.

# LANGUAGE

**The entire demo must be in English.**

All:

- buttons;
- labels;
- tooltips;
- metrics;
- onboarding text;
- status messages;
- object names;

must be in English.

# CORE EXPERIENCE

Create a small 3D coastal environment viewed from an elevated perspective.

The user should be able to:

1. inspect a calm coastal town;
2. place different flood-defense structures;
3. choose wave intensity;
4. press **Launch Wave**;
5. watch a physically simulated wave propagate through the water;
6. watch it hit the beach and defenses;
7. observe flooding, erosion, and building destruction;
8. inspect the resulting damage;
9. reset the simulation;
10. build a different defense layout and run the experiment again.

The application should feel like an interactive science-museum exhibit or engineering sandbox rather than a developer prototype.

# 3D SCENE

The environment must be genuinely 3D.

Include:

- a body of ocean water;
- an underwater seabed with increasing depth offshore;
- shallow coastal water;
- a sandy beach;
- elevated inland terrain;
- multiple buildings of different sizes;
- roads or paths;
- small environmental details for scale;
- coastal defenses placed by the user.

Use:

- perspective camera;
- shadows;
- physically readable lighting;
- depth;
- reflections/specular response where appropriate;
- smooth camera controls.

The user should clearly perceive wave height, water depth, obstacles, buildings, and terrain elevation.

Allow camera interaction such as:

- orbit;
- pan;
- zoom.

Prevent camera controls from interfering with object placement.

# ACTUAL WATER SIMULATION

The central requirement is the water simulation.

Do NOT implement the flood as:

- a translated blue plane;
- a sine-wave mesh moving toward shore;
- a purely shader-based visual wave with no physical interaction;
- a predetermined animation;
- a scripted flood mask.

Water behavior must be calculated dynamically over time.

Use an appropriate real-time approximation such as:

- shallow-water equations;
- height-field fluid simulation;
- grid-based fluid simulation;
- GPU compute simulation;
- finite-difference approximation;
- another physically motivated real-time method.

Full Navier–Stokes accuracy is not required.

Visual plausibility and meaningful interaction with geometry are more important than engineering-grade CFD accuracy.

The simulation must track meaningful quantities such as:

- water height;
- local water velocity;
- flow direction;
- momentum or an equivalent approximation.

The simulated state must evolve every frame or simulation step.

# WAVE GENERATION

Add a prominent button:

**Launch Wave**

When pressed, generate a large incoming wave offshore.

The wave should propagate naturally toward the coast.

As the wave reaches shallower water, it should visibly change:

- wave height should increase;
- propagation speed should change;
- the wave front should deform;
- the wave should interact with terrain;
- water should spread laterally.

The wave must not remain a perfectly straight wall.

It should evolve according to the simulated environment.

# WAVE INTENSITY

Provide three presets:

- **Moderate**
- **Severe**
- **Extreme**

Wave intensity must meaningfully affect:

- initial wave height;
- wave energy;
- water velocity;
- inland penetration;
- flood depth;
- erosion;
- structural damage.

Changing the preset must produce visibly different outcomes.

# WATER–OBSTACLE INTERACTION

This is one of the most important evaluation criteria.

Water must dynamically interact with user-placed structures.

It should be able to:

- hit barriers;
- slow down;
- pile up in front of barriers;
- flow around their ends;
- pass through openings;
- split into multiple streams;
- create protected areas behind barriers;
- partially reflect;
- overtop sufficiently low barriers;
- recombine behind obstacles.

A barrier placed in a different location or orientation must change the resulting flow.

Objects must not merely trigger predefined damage modifiers.

Their actual spatial placement must affect the simulation.

# BUILD MODE

Before launching the wave, allow the user to construct coastal defenses.

Provide at least four structure types.

## 1. Seawall

A tall continuous wall.

Characteristics:

- strongly blocks water;
- causes water buildup;
- can redirect flow around its edges;
- sufficiently extreme waves may overtop it.

## 2. Breakwater

A lower heavy offshore structure.

Characteristics:

- absorbs or reduces wave energy;
- modifies the incoming wave;
- does not completely block water.

## 3. Segmented Breakwater

Several separated blocks with gaps.

Characteristics:

- water can flow through the gaps;
- wave fronts should deform around individual sections;
- protected zones should form behind the segments.

## 4. Sloped Embankment

A wide sloped coastal defense.

Characteristics:

- dissipates energy;
- allows partial overtopping;
- produces different flow behavior from a vertical seawall.

# OBJECT PLACEMENT

The user must be able to:

- select a defense type;
- preview placement with a translucent ghost object;
- place structures into the 3D world;
- place multiple structures;
- select a placed structure;
- rotate it;
- delete it.

Provide clear visual feedback for:

- currently selected tool;
- valid placement;
- selected structure;
- orientation.

Object placement should use raycasting or an equivalent proper 3D placement mechanism.

Do not restrict the experiment to predefined barrier slots.

# FLOODING

The wave must be able to cross the shoreline and flood inland terrain.

Floodwater should respond to terrain height.

It should:

- preferentially enter low areas;
- spread around buildings and defenses;
- accumulate temporarily in depressions;
- lose momentum inland;
- eventually recede toward the ocean.

The resulting flooded area must depend on the simulated wave and placed defenses.

# BEACH EROSION

Implement visible beach erosion.

High-energy water should modify the shoreline.

Possible approximation:

- maintain an erodible terrain or sediment layer;
- calculate erosion from local water velocity / shear / energy;
- lower or deform beach cells when thresholds are exceeded.

The beach should visibly change during the simulation.

Strong flows may create:

- channels;
- uneven shoreline retreat;
- washed-out areas;
- locally deeper sections.

Protected areas should generally suffer less erosion than directly exposed areas.

Do not represent erosion only as a percentage metric.

The 3D beach geometry itself must visibly change.

# BUILDING DAMAGE

Buildings must have structural resistance.

Damage should depend primarily on simulated local flood conditions such as:

- water depth;
- flow velocity;
- impact force;
- duration of exposure.

Provide at least three visual states:

- intact;
- damaged;
- destroyed.

Destroyed buildings should visibly collapse, break apart, disappear into debris, or otherwise change geometry.

Where practical, generate debris that can be pushed or transported by the water.

Buildings protected by effective defenses should experience less damage because the simulated flow reaching them is weaker — not because the game directly applies a "behind wall" bonus.

# VISUAL WATER QUALITY

Make the water visually convincing enough to showcase the simulation.

Include where practical:

- transparent or semi-transparent water;
- depth-dependent color;
- animated surface normals;
- visible wave height;
- foam around strong wave fronts;
- foam near barriers;
- spray or particles during strong impacts;
- turbulent-looking flow around obstacles;
- wet terrain after water recedes.

The visual surface must represent the underlying simulation state.

Do not let decorative water animation hide or contradict the physical state.

# FLOW VISUALIZATION

Add an optional toggle:

**Show Flow**

When enabled, visualize local water velocity using:

- arrows;
- particles;
- streamlines;
- or another clear representation.

Flow visualization should make it possible to see:

- acceleration;
- redirection;
- flow through gaps;
- protected wakes;
- water moving around structures.

# DAMAGE METRICS

Display a compact live/results panel containing at least:

- **Maximum Flood Depth**
- **Flooded Area**
- **Beach Erosion**
- **Buildings Damaged**
- **Buildings Destroyed**

Metrics should be derived from the actual simulation state.

They do not need professional engineering accuracy, but they must react consistently to different defense layouts and wave intensities.

# CONTROLS

Provide:

**Launch Wave**

**Pause / Resume**

**Reset Simulation**

**Clear Defenses**

Simulation speed:

- **0.5×**
- **1×**
- **2×**

Wave intensity:

- **Moderate**
- **Severe**
- **Extreme**

Visualization:

- **Show Flow**

# RESET BEHAVIOR

**Reset Simulation** is critical.

It must restore:

- initial water state;
- original terrain;
- original beach geometry;
- all buildings;
- building health;
- debris;
- flooding;
- erosion;
- simulation time;
- metrics.

User-placed defenses may remain after a normal simulation reset so the same configuration can be tested again.

Provide **Clear Defenses** separately to remove them.

After reset, **Launch Wave** must work again correctly.

The user must be able to perform many experiments without refreshing the browser.

# UI / VISUAL DESIGN

The interface should feel finished.

Aim for the quality of:

- an interactive science exhibit;
- a polished engineering visualization;
- a modern simulation game prototype.

Use:

- a clean dark or neutral control panel;
- compact controls;
- strong information hierarchy;
- readable typography;
- restrained animations;
- clear icons where useful.

The 3D simulation should occupy most of the available screen.

Avoid large explanatory text covering the scene.

On first load, display a short instruction:

**"Build coastal defenses, launch the wave, and see whether your town survives."**

# CAMERA PRESENTATION

Choose a visually impressive initial camera angle.

The viewer should immediately see:

- ocean;
- beach;
- town;
- terrain depth;
- buildings.

When the wave launches, keep manual camera control available.

Optional enhancement:

add a non-intrusive **Follow Wave** camera mode if it can be implemented reliably.

Do not sacrifice core functionality for it.

# PERFORMANCE

Target smooth real-time performance on a normal modern desktop computer.

Prefer a lower-resolution but genuinely interactive simulation over a visually expensive fake one.

Use reasonable grid resolution, time steps, geometry complexity, particles, and update frequencies.

Prevent numerical explosions and unstable values.

Clamp or stabilize simulation values where necessary.

The application must remain usable after an Extreme wave.

# TECHNICAL APPROACH

Use WebGL and an appropriate 3D browser stack.

Three.js is a reasonable default if available, but choose the best technology available in the environment.

Use GPU computation where useful, but a well-designed CPU height-field solver is acceptable if it performs adequately.

No backend is required.

Do not unnecessarily rewrite an existing project or toolchain if an appropriate frontend environment already exists.

# PRIORITY ORDER

If tradeoffs are required, prioritize:

1. real dynamic water simulation;
2. true 3D presentation;
3. water interaction with arbitrarily placed defenses;
4. visible flooding;
5. reliable reset and repeatability;
6. beach erosion;
7. building destruction;
8. visual water quality;
9. UI polish;
10. optional secondary effects.

Do not sacrifice actual physical interaction for prettier graphics.

# ACCEPTANCE TESTS

Before finishing, make sure all of the following are true.

### Test 1 — No defenses

Launch a Severe wave with no defenses.

Expected result:

- wave reaches shore;
- inland flooding occurs;
- beach erosion occurs;
- some buildings are damaged or destroyed.

### Test 2 — Continuous seawall

Reset.

Place a seawall parallel to the coast.

Launch the same Severe wave.

Expected result:

- water accumulates against the wall;
- part of the wave is blocked or reflected;
- water attempts to move around the wall edges;
- the area directly behind the wall receives less flooding;
- results differ substantially from Test 1.

### Test 3 — Barrier orientation

Reset.

Rotate the seawall so it is partly diagonal to the incoming wave.

Expected result:

- the wave is redirected differently;
- asymmetric flooding appears;
- flow visualization shows the changed direction.

### Test 4 — Segmented breakwater

Replace the wall with segmented breakwaters.

Expected result:

- water flows through the gaps;
- individual wave fronts deform around sections;
- wakes or lower-energy regions appear behind the structures.

### Test 5 — Extreme wave

Launch an Extreme wave against an existing defense.

Expected result:

- defenses are less effective;
- overtopping or stronger bypass occurs;
- flooding and destruction increase.

### Test 6 — Repeatability

Reset the simulation several times.

Expected result:

- no duplicated meshes;
- no accumulating invisible objects;
- no broken controls;
- no permanently damaged terrain;
- no duplicated event listeners;
- no degraded simulation behavior.

# IMPLEMENTATION FREEDOM

You may use **any programming language, framework, rendering engine, physics library, numerical method, shader technology, or other tools available in your environment**.

There are no restrictions on the implementation stack.

Choose the approach that gives you the best chance of producing the strongest complete result in this single attempt.

You may use, for example:

- JavaScript or TypeScript;
- WebGL or WebGPU;
- Three.js, Babylon.js, raw WebGL, or another rendering engine;
- CPU or GPU simulation;
- shaders;
- compute shaders;
- physics or numerical simulation libraries;
- custom simulation code;
- any other suitable tools available to you.

Do not choose a simpler implementation merely because it is easier to code.

The evaluation is based on the **quality and behavior of the final demo**, not on which technologies you use.

The final result must be directly runnable and interactive in the environment available to you.

If several implementation approaches are possible, choose the one you believe will produce the most convincing combination of:

1. physically meaningful wave behavior;
2. 3D visual quality;
3. interaction with user-placed defenses;
4. destruction and erosion;
5. performance;
6. reliability.

Do not ask which stack to use. Make that decision yourself.

# FINAL QUALITY BAR

The result should be immediately understandable without explanation.

Within the first few seconds, a user should be able to recognize:

**ocean → beach → town → defenses → incoming wave → physical interaction → flooding → destruction.**

The most important demonstration is this:

Run the wave with no protection.

Reset.

Build a defense.

Run exactly the same wave again.

The difference in water propagation and damage should be visually obvious and should emerge from the simulation itself.

Remember:

**You have one pass. Make all important decisions yourself and implement the complete experience now. There will be no retries. This is your benchmark.**