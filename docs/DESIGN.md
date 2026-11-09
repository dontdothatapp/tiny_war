# TINY WAR: design notes and tech rationale

## 1. Engine choice: custom voxel engine on three.js (TypeScript + Vite)

The brief: the game runs in the browser, uses voxels, and lets you destroy the whole environment. These are the options I considered:

| Option | Pros | Cons for *this* game |
|---|---|---|
| **three.js + custom voxel layer** (chosen) | Loads instantly from a URL; the bundle is about 185 KB gzipped. We control the meshing, memory and destruction completely. Hot reload. Any static host works. | We write the voxel engine ourselves (done here: about 1.5k lines). |
| Godot 4 (web export) | Good editor, scene tooling and physics. | The web export is 30–40 MB with a slow first load, and threads need cross-origin-isolation headers. Rebuilding meshes for large voxel worlds in GDScript is slow. Godot's main voxel solution (Zylann's module) needs a custom engine build and doesn't fit the web export well. |
| Babylon.js | Close to three.js and comes with more built in. | No real advantage here; three.js has a larger ecosystem. |
| Bevy / Rust → WASM | Fast and data-oriented. | Iteration is much slower and the toolchain is heavier. Better suited to a later port than to prototyping. |

**Recommendation:** stay on three.js for the prototype and the game. If profiling ever shows the CPU is the bottleneck, move the heavy kernels (meshing, connectivity search) into Web Workers, and later into Rust/WASM workers. The rest of the architecture stays the same. three.js's WebGPU renderer is also an option later for GPU-driven particles.

## 2. World and voxel tech

- **Scale:** 1 voxel ≈ 0.5 m. The helicopter is about 33 voxels long and its main rotor radius is 14. A two-storey house is about 13 voxels tall.
- **Sparse, lazily generated chunks.** These are 32³ `Uint8` chunks (`src/voxel/world.ts`). The generator first creates a heightmap, surface materials and a list of voxel *stamps* (buildings, vehicles, palms…). A chunk is filled from these only the first time something reads it, whether that's rendering, a raycast or an explosion. Chunks that haven't been modified and are far away get evicted. This keeps a 2048² map cheap: memory only grows where the player goes.
- **Greedy meshing with per-vertex ambient occlusion** (`mesher.ts`). Faces merge only when their AO is uniform, so lighting stays correct. Vertex data is packed (Uint8 position, normal and colour), which makes it about 4× smaller than float buffers.
- **Shader:** the per-voxel colour noise comes from a world-space hash in the fragment shader, not from vertex colours. That gives the dithered old-school sand look and still lets large flat areas merge into a few quads. Light voxels use an emissive flag in the same pass.
- **Streaming renderer** (`chunkRenderer.ts`): it meshes chunks in a radius around the camera focus, nearest first, within a per-frame time budget.
- **Look:** a warm directional sun with soft shadows, a hemisphere light for ambient, sandy haze fog, and optional chunky-pixel rendering (render at ½ or ⅓ resolution and upscale with nearest-neighbour; **P** toggles it).

## 3. Destruction model

`src/voxel/destruction.ts`, `bodies.ts`, `game/structures.ts`

1. **Crater carve.** Every voxel in the blast sphere takes `power × (1 − d²/r²) × jitter` and is removed when that exceeds its material's **hardness**. Sand and palms vaporise, plaster breaks, concrete only chips, steel resists, bedrock never goes.
2. **Scorching.** Exposed sand, asphalt and grass around the crater turn into scorch voxels.
3. **Debris.** A capped sample of the removed voxels becomes instanced, lit cubes that bounce on the voxel grid, settle, and sometimes turn back into **rubble voxels**.
4. **Connectivity.** After every blast, a depth-first search (biased downward, bounded) runs from the crater rim. Any non-terrain island that no longer touches the ground breaks off as a **falling rigid voxel body**. It gets its own greedy mesh, tumbles, then shatters on impact into debris plus a rubble heap.
5. **Structural failure.** Every generated structure keeps track of its voxel count and the count in its lower, load-bearing band. Counts start only when the structure is first hit. If a structure loses too much mass overall, or about 20% of its load-bearing band, it collapses: what's left is split into blocks that fall as bodies. Blowing out the ground floor of a building brings it down, and so does the base of a radar tower.
6. **Secondary effects.** Fuel tanks chain-explode. Blasted flammable voxels start fires. Turrets fall when the ground under them is blown away. Supply crates hidden inside buildings become reachable once the walls are gone. The rotor chops through palm fronds.

## 4. Flight model

`src/entities/helicopter.ts`

Thrust acts along the rotor axis, and the craft has mass, inertia and quadratic drag. On top of that:

- **Cyclic** controls attitude, so tilting is how you accelerate. **Pedals** control yaw. The **collective** sets thrust.
- **Weathervaning tail:** at speed, sideslip yaws the nose into the airflow, so banking produces coordinated turns without any scripting.
- **Ground effect** gives extra lift close to the ground, and **translational lift** rewards moving off a hover.
- **Vortex ring state:** descending fast with little forward speed loses up to 38% of lift, with buffeting and a warning. To recover, gain forward speed.
- **Rotor RPM spool-up and autorotation:** if you run out of fuel, the engine flames out. Descending air keeps the rotor turning, and you can flare by raising the collective before touchdown.
- **Weight** depends on fuel, ammo and passengers. A full tank and a full cabin make the aircraft sluggish.
- **Wind** is set per sector and pushes the aircraft around.
- **Crash physics:** a hard landing, rotor strike or collision damages you based on speed, sink rate and tilt.
- **Assists (SAS, on by default):** attitude hold, heading hold, vertical-speed hold and an auto-flare limit near the ground. Press **H** to switch to full manual. The collective then becomes a lever that stays where you leave it, and pitch and roll command a rotation rate instead of returning to level.

## 5. Combat and enemies

`src/entities/turret.ts`, `projectiles.ts`

- **MG nest / AA gun:** tracer bursts with a lead that tracks imperfectly. Accuracy drops with range.
- **Flak:** shells with timed fuses that burst near you. They **can't engage targets below about 14 voxels AGL**.
- **SAM:** a radar lock with a warning tone, then a guided missile with a limited turn rate. It **can't lock targets flying under about 12 AGL**. Flares decoy it.
- **Tank:** a slow, heavy shell. It can't elevate high, so flying high counters it.
- Every emplacement needs **line of sight** through the voxel world, and takes a moment to react once it spots you. Buildings, mesas and dunes are real cover, and destroying cover changes the fight.

The altitude trade-off is deliberate. Flying low (nap-of-the-earth) beats flak and SAMs but exposes you to guns and tanks. Flying high does the opposite.

Player weapons:

- **Fire control** (`updateAim`, `findTarget` and `desigScore` in `game.ts`) follows a "pilot points, gunner aims" model:
  - **Boresight:** a ground point straight ahead, 60–140 voxels out depending on altitude. It uses the terrain height map, so it never jumps onto roofs.
  - **Designation:** only *enemy* emplacements and enemy structures (walls excluded) within ±15° and 230 voxels can be picked. The score is mostly angle off the nose, plus a little distance, with bonuses for emplacements that have line of sight and for mission objectives.
  - **Hysteresis:** a target is kept until it leaves ±26°. A rival must score clearly better (by 30) for 0.35 s before the gunner switches. In tests with the nose weaving through enemy bases, that came to about one switch every three seconds.
  - **Aim point:** glides toward the target or boresight with exponential smoothing (rate 9/s) and never snaps. The structure aim point sits low on the building, because knocking out the load-bearing band brings it down.
  - **Weapons:** cannon rounds and rockets fly to the aim point and don't inherit the aircraft's velocity. In tests, rockets hit the designated target about 80–90% of the time, and most misses happened when the line of fire was blocked, which the grey reticle shows.

  **Research notes.** The original Strike series worked like this:
  - The pilot only rotates and flies. A d-pad press moves forward or turns, and holding a button strafes.
  - The **co-pilot aims the guns**: the DOS manual calls the co-pilot "responsible for aiming the guns", and a better co-pilot makes the pilot's job easier.
  - Hydras had some auto-aim.
  - Hellfires home in on their target.
  - Hits and misses were shown with different explosion colours.
  - Altitude was abstracted away.

  Modern aim-assist practice adds three rules: keep the target the player is already tracking, ease rather than snap, and switch only on a clear improvement. Sources: [Sega-16 review](https://www.sega-16.com/2004/09/desert-strike-return-to-the-gulf/), [DOS manual](https://www.retrogames.cz/manualy/DOS/Desert_Strike_-_DOS_-_Manual.pdf), [Retro Looney review](https://retrolooney.co.uk/mega-drive-reviews/smd-desert-strike/), [Jungle Strike Game Gear review](https://gamefaqs.gamespot.com/gamegear/586720-jungle-strike/reviews/173307), [Overwatch aim-assist notes](https://eu.forums.blizzard.com/en/overwatch/t/console-aim-assist-updates/8697), [Insomniac aim-assist talk (GDC)](https://gdcvault.com/play/1017942/Techniques-for-Building-Aim-Assist).
- **Ideas from the same research, not yet built:** different hit and miss impact colours, and choosing a co-pilot with gunner skill (tighter cone and faster lock) as an unlock.
- **Chin cannon:** small high-explosive (HE) blasts. The turret slews toward the fire-control point.
- **Rockets:** launched from the pods and dive onto the same point.
- **Guided missiles:** lock onto the gunner's designated target (an emplacement or a building) once it has been held for 0.6 s.
- **Flares.**

## 6. Run structure and progression

`src/game/progression.ts`, `game.ts`

- A **run** is a series of sectors with a random seed. The map grows from 1024² to 2048². The number of bases, the threat types and enemy accuracy and damage all scale with the sector.
- **Credits** come from destroying targets, neutralising bases, rescues and sector-clear bonuses. They are **carried** in the aircraft until you land on the FARP pad. If you die, you lose them. This creates a push-your-luck tension between going for one more target and heading home first.
- **Hangar:** 13 permanent upgrade lines (engine, fuel, armour, ammo, cannon damage and rate of fire, rocket count and warheads, missiles, flares, cabin seats, winch, radar). **Caps rise as you reach new sectors**, and some systems only unlock at sector 2 or 3.
- **Fail states:** the aircraft is destroyed, or you run out of fuel and land outside the FARP (stranded).

The brief said there are no humans on the map. Downed crews are therefore shown only as red signal smoke and a strobe, never as figures. You land next to the smoke and they board. Tell me if you'd prefer visible survivors or captured soldiers in compounds.

## 7. Controller support

`src/core/gamepad.ts`, the `pollInput` / `menuPad` methods in `game.ts`, and focus navigation in `ui/menus.ts`

- The game reads the standard Gamepad API mapping once per simulation step. Sticks use a radial dead zone (16%) and an expo curve on the cyclic for fine control near centre. The triggers have their own small dead zone.
- **Analog flight.** Stick deflection goes straight into the same `HeliControls` as the keyboard (the two are summed and clamped). With SAS on, half deflection means half the maximum tilt or half the maximum climb rate.
- **One layout.** The left stick is the cyclic (fly). The right stick's X axis is the pedals (turn). The bumpers are the collective (climb/descend) and the triggers fire. Aiming is handled by fire control, so the right stick only turns.
- **Device switching.** Whichever device you used last decides the prompts, the HUD help text, mouse-cursor visibility and whether the controller vibrates.
- **Menus.** Spatial focus navigation moves within the same row or column first, then to the nearest control in that direction. Holding a direction repeats after a short delay. Focus stays on the same control when a screen re-renders, for example after a toggle or a purchase.
- **Rumble.** Cannon fire, rocket and missile launches, taking damage, nearby explosions, winching and losing the aircraft all vibrate the controller. It uses `vibrationActuator` where available and `hapticActuators` as a fallback.
- **Testing:** the Playwright scripts stub `navigator.getGamepads()` with a scripted controller.

## 8. Code map

```
src/
  core/      rng+noise, keyboard/mouse input, gamepad, procedural audio (WebAudio)
  voxel/     world (chunks), mesher, chunk renderer, material + shader,
             destruction, falling bodies, model meshing
  world/     map generator, prefabs (buildings, vehicles, palms…), VoxModel
  entities/  helicopter (+voxel model), turrets, projectiles, pickups/rescue
  fx/        cube particles (smoke/fire/glow), debris, explosion effects
  game/      game loop/state, progression & save, structure integrity, scene rig
  ui/        HUD (DOM + overlay canvas, radar, map), menus/hangar
```

`window.game.simulate(seconds)` advances the simulation without rendering, which is handy for automated tests and bots.

**Model gallery** (`src/dev/gallery.ts`): open the game with `?gallery=aircraft|units|buildings|vehicles|nature|props` to see every model under the game's lighting. Optional parameters: `&angle=low` for a lower camera, `&zoom=0.5`, `&only=<index>` for one model, `&seed=<n>` for other variations.

**Model conventions:**
- World prefabs use 1 voxel = 0.5 m. The helicopter, the enemy units and the pickups use half-size voxels so they read slightly finer.
- Detail comes from a few dedicated materials: light trim for frames, sills and cornices; darker base bands; shutter colours; light metal; tracks; lamps; palm rings; camo shades.
- Two-tone camouflage uses low-frequency noise.
- Wrecks keep their silhouette, mixing soot, burnt metal, surviving paint and rust.
- Mass you can't see (floors, aprons, solid bases) counts against structural integrity, so leave it out of destructible objectives.

## 9. Roadmap and more ideas

**Near term (polish and performance)**
- Move meshing and connectivity searches into a **Web Worker pool** so large collapses don't hitch.
- Batch the instanced chunk draw calls, generate the shadow cascade from the chunk AABBs only, and adapt the chunk radius to the GPU.
- Add key and button remapping, and per-stick sensitivity settings.
- Add a tutorial sector and a free-flight sandbox.

**Gameplay ideas**
- **Sling loads:** hook vehicles or containers and carry them, with the pendulum swing simulated and the weight affecting flight.
- **Component damage** instead of a single HP bar. Tail rotor hits make the aircraft spin, engine fires cause power loss, damaged hydraulics make controls stiff, a cracked canopy limits the HUD. All of it can be repaired at the FARP.
- **Run modifiers**, roguelike style: before each sector you pick one of three. Examples: *Sandstorm* (visibility and radar drop, but enemies can't see either), *Night op* (thermal FLIR view mode), *Heavy armor column* (moving convoys), or *Black market* (cheap upgrades, but no FARP repairs).
- **Moving targets:** convoys driving the road network and patrol helicopters. Trains on a rail line make good set-piece targets.
- **Forward FARPs:** capture a cleared enemy base and turn it into a second rearm point. That shortens the logistics loop as the map grows.
- **Intel pickups** that reveal SAM positions or hidden supply caches on the map.
- **Wingman drone** (an upgrade) that marks targets or launches its own rockets.
- **Weather and time of day:** dust devils that push the aircraft around, heat shimmer, sunset lighting.
- **Daily seed** with a leaderboard, so everyone flies the same procedurally generated theatre.
- **Destruction-based scoring:** precision bonuses for collapsing a target with few munitions, and penalties for collateral damage in neutral towns.
- **Bomb bay / thermobaric "door gun" variants** as alternative airframes, for example a transport helicopter with more seats and less firepower.
