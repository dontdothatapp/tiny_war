# TINY WAR

A browser tech demo for a roguelike attack-helicopter game: a top-down view with some perspective, a desert setting, voxel art, and terrain you can destroy completely. Flying is closer to a simulator than an arcade game. Each run is a series of procedurally generated sectors. In each sector you destroy the enemy bases, rescue downed crews and manage fuel and ammo, while enemy gunships hunt you and supply convoys cross the highway. Every sector has its own time of day: midday, dusk, night, a sandstorm, dawn. Between sectors you buy permanent upgrades.

![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20three.js%20%2B%20Vite-6b6b3e)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (host anywhere: GitHub Pages, itch.io, S3…)
```

You need a desktop browser with WebGL2. The build is about 770 KB of JS (about 215 KB gzipped) plus about 3 MB of audio. There are no art files: every model and texture is generated in code.

## Sound

The music and most sound effects are 8-bit samples generated with [ElevenLabs](https://elevenlabs.io) and stored in `public/audio/`. The warning alarms and menu beeps are synthesized in code. If an audio file is missing or hasn't loaded yet, the game plays the older synthesized version of that sound instead. Music can be switched off on the title screen.

- **Listen to everything:** open the game with `?sounds` (for example `http://localhost:5173/?sounds`).
- **Regenerate sounds:** the prompts live in [`server/generate-audio.ts`](server/generate-audio.ts). It needs an ElevenLabs key in `.env.local` (`npx -y @elevenlabs/cli@latest onboard init` sets one up) and ffmpeg.

```bash
node --env-file=.env.local server/generate-audio.ts                 # make whatever is missing
node --env-file=.env.local server/generate-audio.ts cannon rocket   # regenerate just these
```

Raw downloads are kept in `audio-src/` (gitignored), and `--process` redoes the trimming and leveling without calling ElevenLabs. Which track plays where is set in `MUSIC_TRACKS` in [`src/core/audio.ts`](src/core/audio.ts).

## Controls

| | |
|---|---|
| **W / S** | cyclic forward / back (nose down accelerates) |
| **A / D** | cyclic left / right (bank; the tail weathervanes you into a turn) |
| **Q / E** | turn (pedals / yaw) |
| **Space / Shift** | collective up / down (climb / descend) |
| **LMB** | 30 mm cannon |
| **RMB** | rockets |
| **F** | guided missile (locks on to an emplacement you keep ahead of the nose; unlocked by upgrade) |
| **X** | flares (unlocked by upgrade) |
| **H** | toggle flight assists (SAS on, or full manual) |
| **M** map · **P** pixel size · **Wheel** zoom · **Esc** pause · **`** debug stats |

**Aiming.** You only point the nose; there's no separate aim control. Like the co-pilot gunner in classic isometric helicopter games, an onboard gunner does the fine aiming:

- **Boresight (small green ring):** a ground point straight ahead of the nose, further out the higher you fly. With no target, the weapons fire here.
- **Gunner target (bracket with a name):** the gunner picks enemy emplacements, buildings and vehicles within about ±15° of the nose. It ignores walls, neutral buildings and debris, and prefers guns that are shooting at you and mission objectives. It holds a target until it leaves about ±26°, and only switches when another target is clearly better for a moment.
- **Aim point (crosshair):** glides between the boresight and the target. Cannon rounds and rockets both go there. It turns grey when terrain or cover blocks the line of fire.
- **Missile lock:** keep a target bracketed for 0.6 s and the bracket turns red with LOCK. Missiles can lock onto emplacements or buildings.

### Controller

Any controller with the browser's standard gamepad mapping works (Xbox, PlayStation, Switch Pro, most generic pads). Plug it in and press a button. The game switches to controller prompts and button labels, and switches back as soon as you touch the keyboard or mouse. Menus work with the D-pad or left stick, **A** to confirm and **B** to go back. Vibration can be turned on or off on the title screen.

| | |
|---|---|
| **Left stick** | fly (cyclic: forward/back, bank left/right) |
| **Right stick ◂▸** | turn (pedals / yaw) |
| **RB / LB** | climb / descend |
| **RT / LT** | cannon / rockets (straight ahead, same aiming as above) |
| **A / B** | missile / flares |
| **D-pad ▴▾** | zoom |
| **Y · View · Menu** | map · toggle SAS · pause |

PlayStation controllers show ✕ ○ □ △ and L1/R1/L2/R2 labels instead. Some browsers won't start audio until you click or press a key once, because a controller button press may not count as a user gesture. The game shows a hint when this happens.

## Game loop

1. Take off from the **FARP**, your forward rearm and refuel pad.
2. Destroy each enemy base's primary target: a radar site, command bunker, SAM battery, fuel depot or arms factory. The bases are defended by MG nests, AA guns, flak, SAMs and tanks. Sector 1 has a single base, a good flight out from the FARP. Later sectors add more bases and get larger.
3. Optionally, land beside the violet smoke to pick up downed crews, then fly them home.
4. Optionally, stop the **supply convoy**. About 20 seconds into the sortie it sets off along the highway, and the objectives panel shows how long until it leaves the sector. Trucks drop a supply crate when destroyed, the escorts shoot back, and wiping out the whole convoy pays a bonus.
5. Pick up supply crates (fuel, ammo, repairs) by hovering low and slow over them or by landing next to them. A label on the crate's marker tells you if you need to go lower or slow down. Some crates are hidden inside enemy buildings, so you have to blow the building open first.
6. **Land on the FARP pad** to refuel, rearm and repair, and to **bank the credits you're carrying**. If you lose the aircraft, you lose the credits you were carrying.
7. Once every primary target is destroyed, land at the FARP to clear the sector. Destroying the last target **scrambles an enemy gunship** (two from sector 4) that chases you home. Shoot it down or outrun it: gunships stay out of the FARP's air-defence umbrella. The next sector is larger and better defended. Spend credits in the hangar between sectors.

**Gunships** are small grey scout helicopters. From sector 2 they also patrol over the bases. They fly gun runs: close in nose-on firing bursts, break away past you, come around and repeat. The gunner picks them up like any other target (the cannon leads them; rockets mostly miss, missiles don't), and the minimap shows them as red triangles while your radar holds them.

**Kill streaks.** Each kill within 6 seconds of the last one adds 10% to the credits you earn, up to ×2. The streak and its timer show under the minimap.

**Each sector is a miniature:** a slab of desert floating over the clouds. The briefing shows the whole board, and when you launch the camera dives down to your helipad while the rotor spools up. Press Space (or A on a controller) to skip it; add `?intro=0` to the URL to turn it off.

**Conditions** change with the sector and are listed in the briefing: midday, dusk, night (enemy gunners pick you up 25% later, and your searchlight shows the ground ahead), sandstorm (strong wind; enemy sight and your radar are cut by a third) and dawn, then the cycle repeats. Add `?sky=day|dusk|night|storm|dawn` to the URL to fly any sector under a chosen sky.

**Progression** has two parts:

- **Level-ups (this run only):** destroying things, neutralising bases and boarding crews earns XP. Each time you level up, the game pauses and offers you a choice of three upgrades: armour, damage reduction, repairs in flight, fuel, engine power, cannon and rocket boosts, a better gunner, missiles, flares or bonus credits. Pick with a click, the 1/2/3 keys, or the D-pad and A.
- **Hangar shop (permanent, saved in `localStorage`):** spend banked credits between sectors. You start with four items: engine, armour, fuel and rockets. Reaching sector 2, 3 and 4 adds a few more each time, and each new sector also raises the level caps.

Design notes, engine rationale and the roadmap are in [`docs/DESIGN.md`](docs/DESIGN.md).
