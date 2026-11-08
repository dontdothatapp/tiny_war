# TINY WAR

A browser tech demo for a roguelike attack-helicopter game: a top-down view with some perspective, a desert setting, voxel art, and terrain you can destroy completely. Flying is closer to a simulator than an arcade game. Each run is a series of procedurally generated sectors. In each sector you destroy the enemy bases, rescue downed crews and manage fuel and ammo. Between sectors you buy permanent upgrades.

![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20three.js%20%2B%20Vite-6b6b3e)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (host anywhere: GitHub Pages, itch.io, S3…)
```

You need a desktop browser with WebGL2. The build is about 680 KB of JS (about 185 KB gzipped). There are no art or audio files: every model, texture and sound is generated in code.

## Controls

| | |
|---|---|
| **W / S** | cyclic forward / back (nose down accelerates) |
| **A / D** | cyclic left / right (bank; the tail weathervanes you into a turn) |
| **Q / E** | pedals (yaw), mostly for hovering |
| **Space / Shift** | collective up / down |
| **Mouse** | aim the chin cannon |
| **LMB** | 30 mm cannon |
| **RMB** | rockets. They fire along the airframe, so fly the ◇ pipper onto the target |
| **F** | guided missile (hover the cursor over a target to lock; unlocked by upgrade) |
| **X** | flares (unlocked by upgrade) |
| **H** | toggle flight assists (SAS on, or full manual) |
| **M** map · **P** pixel size · **Wheel** zoom · **Esc** pause · **`** debug stats |

## Game loop

1. Take off from the **FARP**, your forward rearm and refuel pad.
2. Destroy each enemy base's primary target: a radar site, command bunker, SAM battery, fuel depot or arms factory. The bases are defended by MG nests, AA guns, flak, SAMs and tanks.
3. Optionally, land beside the red smoke to pick up downed crews, then fly them home.
4. Hover low over supply crates to winch up fuel, ammo or repairs. Some crates are hidden inside enemy buildings, so you have to blow the building open first.
5. **Land on the FARP pad** to refuel, rearm and repair, and to **bank the credits you're carrying**. If you lose the aircraft, you lose the credits you were carrying.
6. Once every primary target is destroyed, land at the FARP to clear the sector. The next sector is larger and better defended. Spend credits in the hangar between sectors.

Upgrades persist across runs (saved in `localStorage`). Each new sector you reach raises the upgrade caps and unlocks new systems (missiles, flares, thermobaric rockets, radar).

Design notes, engine rationale and the roadmap are in [`docs/DESIGN.md`](docs/DESIGN.md).
