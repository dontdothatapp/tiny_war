import * as THREE from 'three';
import { Audio } from '../core/audio';
import { Input } from '../core/input';
import { RNG, clamp, lerp } from '../core/rng';
import { DebrisSystem } from '../fx/debris';
import { Effects } from '../fx/effects';
import { ParticleSystem } from '../fx/particles';
import { Helicopter, HeliControls } from '../entities/helicopter';
import { PICKUP_COLOR, PICKUP_LABEL, Pickup, RescueSite } from '../entities/pickups';
import { HitTarget, Projectile, Projectiles } from '../entities/projectiles';
import { TURRET_SPECS, Turret } from '../entities/turret';
import { Hud, HudObjective, RadarBlip } from '../ui/hud';
import { Menus } from '../ui/menus';
import { BodySystem } from '../voxel/bodies';
import { ChunkRenderer } from '../voxel/chunkRenderer';
import { Destruction } from '../voxel/destruction';
import { M } from '../voxel/materials';
import { VoxelWorld } from '../voxel/world';
import { MapGenerator, WORLD_HEIGHT } from '../world/generator';
import type { BaseDef, MapData } from '../world/mapTypes';
import * as P from '../world/prefabs';
import { HeliStats, SaveData, computeStats, level, levelCap, loadSave, upgradeCost, writeSave } from './progression';
import { SceneRig } from './scene';
import { StructureState, StructureTracker } from './structures';

type State = 'title' | 'briefing' | 'playing' | 'paused' | 'over' | 'menu';

interface RunState {
  seed: number;
  sector: number;
  pending: number; // credits carried in the aircraft
  earned: number; // banked this run
  kills: number;
  structures: number;
  rescued: number;
  sectorsCleared: number;
  startTime: number;
}

interface Ammo {
  gun: number;
  rockets: number;
  missiles: number;
  flares: number;
}

const SUN_DIR = new THREE.Vector3(-0.5, 0.85, 0.35).normalize();

export class Game {
  readonly rig: SceneRig;
  readonly input: Input;
  readonly audio = new Audio();
  readonly hud: Hud;
  readonly menus: Menus;
  save: SaveData;
  stats: HeliStats;
  state: State = 'title';

  // sector
  map!: MapData;
  gen!: MapGenerator;
  world!: VoxelWorld;
  chunks!: ChunkRenderer;
  debris!: DebrisSystem;
  smoke!: ParticleSystem;
  glow!: ParticleSystem;
  bodies!: BodySystem;
  destruction!: Destruction;
  tracker!: StructureTracker;
  projectiles!: Projectiles;
  fx!: Effects;
  heli!: Helicopter;
  turrets: Turret[] = [];
  pickups: Pickup[] = [];
  rescues: RescueSite[] = [];
  private sectorGroup = new THREE.Group();
  private heliTarget: HitTarget = { pos: new THREE.Vector3(), radius: 4.5, alive: true };
  private pendingBlasts: { t: number; x: number; y: number; z: number; r: number; p: number }[] = [];

  run: RunState | null = null;
  ammo: Ammo = { gun: 0, rockets: 0, missiles: 0, flares: 0 };
  private gunT = 0;
  private rocketT = 0;
  private flareT = 0;
  private podLeft = true;
  private lockTurret: Turret | null = null;
  private lockT = 0;
  private aim = new THREE.Vector3();
  private aimValid = false;
  private ccip = new THREE.Vector3();
  private ccipValid = false;
  private camFocus = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private zoom = 210;
  private shake = 0;
  private sectorCleared = false;
  private overT = 0;
  private overReason = '';
  private serviceT = 0;
  private evictT = 0;
  private titleT = 0;
  private incomingMissile = false;
  private lockedBySam = false;
  private winchTarget: Pickup | null = null;
  private winchLine: THREE.Line;
  private damageSmokeT = 0;
  private fps = 60;
  private hudT = 0;
  private debug = false;
  private debugEl: HTMLElement;
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement) {
    this.rig = new SceneRig(container);
    this.input = new Input(this.rig.renderer.domElement);
    this.hud = new Hud(container);
    this.menus = new Menus(container);
    this.save = loadSave();
    this.stats = computeStats(this.save);
    this.rig.setPixelScale(this.save.settings.pixelScale);
    this.audio.volume = this.save.settings.volume;
    this.rig.scene.add(this.sectorGroup);
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.winchLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x1a1a1a }));
    this.winchLine.visible = false;
    this.winchLine.frustumCulled = false;
    this.rig.scene.add(this.winchLine);
    this.debugEl = document.createElement('div');
    this.debugEl.className = 'debug';
    container.appendChild(this.debugEl);
    const unlock = () => this.audio.init();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ======================================================================== flow

  boot() {
    const seed = Math.floor(Math.random() * 1e6);
    this.loadSector(seed, 1);
    this.showTitle();
  }

  private showTitle() {
    this.state = 'title';
    this.hud.setVisible(false);
    this.menus.title(this.save, {
      newRun: () => this.startRun(),
      hangar: () => this.showHangar(false),
      toggleAssist: () => {
        this.save.settings.assists = !this.save.settings.assists;
        writeSave(this.save);
        this.audio.ui();
        this.showTitle();
      },
      pixel: () => {
        this.save.settings.pixelScale = (this.save.settings.pixelScale % 3) + 1;
        this.rig.setPixelScale(this.save.settings.pixelScale);
        writeSave(this.save);
        this.audio.ui();
        this.showTitle();
      },
    });
  }

  private startRun() {
    this.audio.init();
    this.save.runs++;
    writeSave(this.save);
    const seed = this.map && this.map.sector === 1 ? this.map.seed : Math.floor(Math.random() * 1e6);
    this.run = { seed, sector: 1, pending: 0, earned: 0, kills: 0, structures: 0, rescued: 0, sectorsCleared: 0, startTime: performance.now() };
    if (!this.map || this.map.sector !== 1 || this.map.seed !== seed || this.world.generatedCount > 4000) this.loadSector(seed, 1);
    else this.resetSectorEntities();
    this.showBriefing();
  }

  private showBriefing() {
    const r = this.run!;
    this.state = 'briefing';
    this.hud.setVisible(false);
    const threats = new Set<string>();
    for (const t of this.map.turrets) threats.add(TURRET_SPECS[t.type].name + 's');
    const w = this.windVec();
    this.menus.briefing(
      {
        sector: r.sector,
        seed: this.map.seed,
        size: this.map.size,
        objectives: this.map.bases.map((b) => `Destroy ${b.name}`),
        rescues: this.map.rescues.length,
        threats: [...threats],
        wind: `${Math.round(w.length() * 1.8)} km/h`,
      },
      () => this.launch(),
    );
  }

  private launch() {
    this.menus.hide();
    this.hud.setVisible(true);
    this.hud.showHelp(true);
    setTimeout(() => this.hud.showHelp(false), 9000);
    this.state = 'playing';
    this.audio.init();
    this.hud.message('ENGINES START · ROTOR SPOOL-UP', '#9dff9a');
    this.hud.message('Hold SPACE to lift off', '#9dff9a', 5000);
  }

  private showHangar(midRun: boolean) {
    this.state = 'menu';
    this.hud.setVisible(false);
    const label = midRun && this.run ? `LAUNCH SECTOR ${this.run.sector} ▸` : 'START RUN ▸';
    this.menus.hangar(this.save, this.stats, label, {
      buy: (u) => {
        const lv = level(this.save, u.id);
        const cost = upgradeCost(u, lv);
        if (lv >= levelCap(u, this.save.bestSector) || this.save.credits < cost) {
          this.audio.deny();
          return;
        }
        this.save.credits -= cost;
        this.save.levels[u.id] = lv + 1;
        writeSave(this.save);
        this.stats = computeStats(this.save);
        this.audio.ui();
        this.showHangar(midRun);
      },
      launch: () => {
        if (midRun && this.run) {
          this.loadSector(this.run.seed, this.run.sector);
          this.showBriefing();
        } else this.startRun();
      },
      back: midRun ? undefined : () => this.showTitle(),
    });
  }

  private endRun(reason: string, survived: boolean) {
    const r = this.run!;
    this.state = 'over';
    this.overReason = reason;
    this.overT = 0;
    if (!survived) {
      this.hud.message(reason, '#ff6a5a', 4000);
    }
    void r;
  }

  private showDebrief() {
    const r = this.run!;
    const lost = r.pending;
    const mins = Math.floor((performance.now() - r.startTime) / 60000);
    this.state = 'menu';
    this.hud.setVisible(false);
    this.menus.debrief(
      {
        title: 'RUN OVER',
        subtitle: this.overReason,
        good: false,
        lines: [
          ['Sectors cleared', String(r.sectorsCleared)],
          ['Reached sector', String(r.sector)],
          ['Enemy emplacements destroyed', String(r.kills)],
          ['Structures destroyed', String(r.structures)],
          ['Crew rescued', String(r.rescued)],
          ['Credits banked this run', `${r.earned} CR`],
          ['Credits lost with aircraft', `${lost} CR`],
          ['Flight time', `${mins} min`],
        ],
      },
      () => {
        this.run = null;
        this.showHangar(false);
      },
    );
  }

  private completeSector() {
    const r = this.run!;
    const bonus = 250 + r.sector * 150;
    const rescueBonus = this.rescues.every((s) => s.done && s.boarded === 0) ? 200 : 0;
    this.bank();
    this.save.credits += bonus + rescueBonus;
    r.earned += bonus + rescueBonus;
    r.sectorsCleared++;
    const next = r.sector + 1;
    this.save.bestSector = Math.max(this.save.bestSector, next);
    writeSave(this.save);
    this.state = 'menu';
    this.hud.setVisible(false);
    this.menus.debrief(
      {
        title: `SECTOR ${r.sector} CLEARED`,
        subtitle: `Sector ${next} unlocked new upgrade tiers. The next theatre is larger and better defended.`,
        good: true,
        lines: [
          ['Sector bonus', `${bonus} CR`],
          ['All crews recovered', rescueBonus ? `${rescueBonus} CR` : '—'],
          ['Credits banked this run', `${r.earned} CR`],
          ['Emplacements destroyed', String(r.kills)],
          ['Crew rescued', String(r.rescued)],
        ],
      },
      () => {
        r.sector = next;
        this.showHangar(true);
      },
    );
  }

  // ======================================================================== sector setup

  private disposeSector() {
    for (const c of [...this.sectorGroup.children]) this.sectorGroup.remove(c);
    this.turrets = [];
    this.pickups = [];
    this.rescues = [];
    this.pendingBlasts = [];
    this.projectiles?.clear();
    this.debris?.clear();
    this.smoke?.clear();
    this.glow?.clear();
    this.bodies?.clear();
    this.fx?.clear();
  }

  loadSector(seed: number, sector: number) {
    this.disposeSector();
    const t0 = performance.now();
    this.gen = new MapGenerator(seed, sector);
    this.map = this.gen.generate();
    const S = this.map.size;
    this.world = new VoxelWorld(S, WORLD_HEIGHT, S);
    this.world.filler = this.gen;
    this.chunks = new ChunkRenderer(this.world);
    this.sectorGroup.add(this.chunks.group);
    const fog = this.rig.scene.fog as THREE.Fog;
    this.debris = new DebrisSystem(this.world);
    this.sectorGroup.add(this.debris.mesh);
    this.smoke = new ParticleSystem(4000, SUN_DIR, fog);
    this.glow = new ParticleSystem(2500, SUN_DIR, fog);
    this.sectorGroup.add(this.smoke.mesh, this.glow.mesh);
    this.bodies = new BodySystem(this.world, this.debris, this.smoke);
    this.sectorGroup.add(this.bodies.group);
    this.destruction = new Destruction(this.world, this.debris, this.bodies);
    this.tracker = new StructureTracker(this.world, this.destruction, this.map.structures);
    this.destruction.listener = this.tracker;
    this.tracker.onDestroyed = (s) => this.onStructureDestroyed(s);
    this.fx = new Effects(this.sectorGroup, this.smoke, this.glow);
    this.destruction.onFlammable = (x, y, z) => this.fx.addFire(x + 0.5, y, z + 0.5, 0.8 + Math.random(), 6 + Math.random() * 10, false);
    this.bodies.onImpact = (x, _y, z, n) => {
      this.audio.crumble(x, z, n);
      this.addShake(x, z, Math.min(0.5, n / 1500));
    };
    this.projectiles = new Projectiles(this.world, this.smoke, this.glow, { detonate: (p, x, y, z, d) => this.onDetonate(p, x, y, z, d) });
    this.sectorGroup.add(this.projectiles.tracerMesh);
    this.heli = new Helicopter(this.world, this.stats);
    this.sectorGroup.add(this.heli.visual.root);
    this.heli.onDamage = (d, cause) => this.damageHeli(d, cause);
    this.heli.onRotorStrike = (s) => this.onRotorStrike(s);
    this.hud.setMap(this.map.minimap, this.map.minimapRes);
    this.resetSectorEntities();
    console.log(`sector ${sector} (${S}²) generated in ${(performance.now() - t0).toFixed(0)} ms, ${this.map.stamps.length} stamps, ${this.map.turrets.length} turrets`);
  }

  /** (Re)create entities + heli state for the current map. */
  private resetSectorEntities() {
    for (const t of this.turrets) this.sectorGroup.remove(t.root);
    for (const p of this.pickups) this.sectorGroup.remove(p.obj);
    for (const r of this.rescues) this.sectorGroup.remove(r.beacon);
    const diff = this.map.sector - 1;
    this.turrets = this.map.turrets.map((t) => {
      const tu = new Turret(t.type, new THREE.Vector3(t.x, t.y, t.z), t.yaw, t.baseId, diff);
      this.sectorGroup.add(tu.root);
      return tu;
    });
    this.pickups = this.map.pickups.map((p) => {
      const pk = new Pickup(p.type, new THREE.Vector3(p.x, p.y, p.z));
      this.sectorGroup.add(pk.obj);
      return pk;
    });
    this.rescues = this.map.rescues.map((r) => {
      const rs = new RescueSite(new THREE.Vector3(r.x, r.y, r.z), r.crew);
      this.sectorGroup.add(rs.beacon);
      return rs;
    });
    this.projectiles.enemyTargets = this.turrets.map((t) => t.hitTarget);
    this.projectiles.playerTarget = this.heliTarget;
    this.stats = computeStats(this.save);
    this.heli.stats = this.stats;
    this.heli.assists = this.save.settings.assists;
    const f = this.map.farp;
    this.heli.reset(f.padX, f.y, f.padZ, 0);
    this.heli.wind.copy(this.windVec());
    this.ammo = { gun: this.stats.gunAmmo, rockets: this.stats.rockets, missiles: this.stats.missiles, flares: this.stats.flares };
    this.sectorCleared = false;
    this.heliTarget.alive = true;
    this.camFocus.set(f.padX, f.y, f.padZ);
    this.chunks.prime(f.padX, f.padZ - 40, 240);
  }

  private windVec() {
    const r = new RNG(this.map.seed * 3 + this.map.sector);
    const a = r.range(0, Math.PI * 2);
    const s = r.range(1, 3 + this.map.sector * 1.5);
    return new THREE.Vector3(Math.cos(a) * s, 0, Math.sin(a) * s);
  }

  // ======================================================================== main update

  update(dtRaw: number) {
    const dt = Math.min(dtRaw, 1 / 20);
    this.fps = lerp(this.fps, 1 / Math.max(1e-3, dtRaw), 0.05);
    this.world.frame++;
    const inp = this.input;
    if (inp.hit('Backquote')) this.debug = !this.debug;
    if (inp.hit('KeyP')) {
      this.save.settings.pixelScale = (this.save.settings.pixelScale % 3) + 1;
      this.rig.setPixelScale(this.save.settings.pixelScale);
      writeSave(this.save);
    }

    if (this.state === 'playing' || this.state === 'over') this.updatePlaying(dt);
    else if (this.state === 'paused') {
      if (inp.hit('Escape')) this.resume();
    } else {
      // attract mode: slow pan over the map behind menus
      this.titleT += dt;
      const f = this.map.farp;
      const t = this.titleT * 0.04;
      this.camFocus.set(f.x + Math.sin(t) * 120, f.y, f.z - 120 - Math.cos(t * 0.7) * 80);
      this.updateWorldSystems(dt);
    }
    this.updateCamera(dt);
    this.chunks.update(this.camFocus.x, this.camFocus.z - 30);
    this.evictT -= dt;
    if (this.evictT <= 0) {
      this.evictT = 2;
      const dropped = this.world.evict(this.camFocus.x, this.camFocus.z, 420, 1500);
      for (const c of dropped) this.chunks.forget(c);
    }
    this.rig.updateSun(this.camFocus);
    this.rig.render();
    if (this.debug) {
      const info = this.rig.renderer.info;
      this.debugEl.style.display = 'block';
      this.debugEl.textContent = `fps ${this.fps.toFixed(0)} · draw ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k · chunks ${this.chunks.meshCount}/${this.world.generatedCount} · debris ${this.debris.count} · bodies ${this.bodies.count} · fx ${this.smoke.count + this.glow.count} · proj ${this.projectiles.list.length}`;
    } else this.debugEl.style.display = 'none';
    inp.endFrame();
  }

  /** Advance the simulation without rendering (automated tests / benchmarks). */
  simulate(seconds: number, dt = 1 / 60) {
    for (let t = 0; t < seconds; t += dt) {
      this.world.frame++;
      if (this.state === 'playing' || this.state === 'over') this.updatePlaying(dt);
      this.updateCamera(dt);
      this.chunks.update(this.camFocus.x, this.camFocus.z - 30, 2);
    }
  }

  private resume() {
    this.menus.hide();
    this.state = 'playing';
    this.hud.setVisible(true);
  }

  private updateWorldSystems(dt: number) {
    this.debris.update(dt);
    this.bodies.update(dt);
    this.smoke.update(dt);
    this.glow.update(dt);
    this.fx.update(dt);
    this.tracker.update();
    for (let i = this.pendingBlasts.length - 1; i >= 0; i--) {
      const b = this.pendingBlasts[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.pendingBlasts.splice(i, 1);
        this.explode(b.x, b.y, b.z, b.r, b.p, { dmg: b.p * 4 });
      }
    }
  }

  private updatePlaying(dt: number) {
    const inp = this.input;
    const h = this.heli;
    if (this.state === 'playing') {
      if (inp.hit('Escape')) {
        this.state = 'paused';
        this.menus.pause({
          resume: () => this.resume(),
          abort: () => {
            this.menus.hide();
            this.overReason = 'Run abandoned';
            this.run!.pending = 0;
            this.showDebrief();
          },
        });
        return;
      }
      if (inp.hit('KeyM')) this.hud.toggleMap();
      if (inp.hit('KeyH')) {
        h.assists = !h.assists;
        this.save.settings.assists = h.assists;
        writeSave(this.save);
        this.hud.message(h.assists ? 'SAS ENGAGED' : 'SAS OFF · FULL MANUAL', h.assists ? '#9dff9a' : '#ffb84a');
      }
      if (inp.wheel) this.zoom = clamp(this.zoom + inp.wheel * 18, 150, 360);
    }

    // controls
    const alive = this.state === 'playing' && !h.crashed;
    const c: HeliControls = alive
      ? {
          pitch: inp.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']),
          roll: inp.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
          yaw: inp.axis(['KeyQ'], ['KeyE']),
          collective: inp.axis(['ShiftLeft', 'ShiftRight', 'KeyC'], ['Space']),
        }
      : { pitch: 0, roll: 0, yaw: 0, collective: -1 };
    h.payload = this.ammo.gun * 0.006 + this.ammo.rockets * 0.45 + this.ammo.missiles * 1.2 + h.crew * 1.6;
    if (!h.dead) h.update(dt, c);
    this.heliTarget.pos.copy(h.pos).y += 3;
    this.heliTarget.alive = !h.dead && !h.crashed;

    // crash handling
    if (h.crashed && !h.dead && h.onGround) this.heliDestroyed();

    if (alive) {
      this.updateAim(dt);
      this.updateWeapons(dt);
      this.updateWinch(dt);
      this.updateRescue(dt);
      this.updateFarp(dt);
    } else {
      this.winchLine.visible = false;
    }

    // world + entities
    this.updateTurrets(dt);
    this.projectiles.update(dt);
    this.updateWorldSystems(dt);
    this.updatePickupsVisual(dt);
    this.updateHeliFx(dt);

    // audio
    this.audio.setListener(h.pos.x, h.pos.z);
    this.audio.engine(h.rpm, h.collective, h.vel.length(), !h.dead);
    const warnings = this.collectWarnings(dt);

    // fail states
    if (this.state === 'playing' && !h.crashed && h.fuel <= 0 && h.landed && !this.atFarp()) {
      this.overT += dt;
      if (this.overT > 4) this.endRun('Out of fuel — stranded in hostile territory', false);
    }
    if (this.state === 'over') {
      this.overT += dt;
      if (this.overT > 3.2) this.showDebrief();
    }

    this.drawHud(dt, warnings);
  }

  // ======================================================================== aiming + weapons

  private updateAim(dt: number) {
    const cam = this.rig.camera;
    this.raycaster.setFromCamera(new THREE.Vector2(this.input.ndcX, this.input.ndcY), cam);
    const o = this.raycaster.ray.origin,
      d = this.raycaster.ray.direction;
    const hit = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 900);
    if (hit) {
      this.aim.set(o.x + d.x * hit.dist, o.y + d.y * hit.dist, o.z + d.z * hit.dist);
      this.aimValid = true;
    } else {
      // plane at the heli's ground level
      const gy = this.heli.pos.y - this.heli.agl;
      const t = (gy - o.y) / (d.y || -1);
      this.aim.set(o.x + d.x * t, gy, o.z + d.z * t);
      this.aimValid = t > 0;
    }
    // turret under cursor for missile lock
    let best: Turret | null = null;
    let bestD = 22;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const dd = Math.hypot(t.center.x - this.aim.x, t.center.z - this.aim.z);
      if (dd < bestD && t.center.distanceTo(this.heli.pos) < 520) {
        bestD = dd;
        best = t;
      }
    }
    if (best && best === this.lockTurret) this.lockT += dt;
    else {
      this.lockTurret = best;
      this.lockT = 0;
    }
    // CCIP for rockets: straight-line impact along boresight
    const bs = this.heli.boresight(new THREE.Vector3());
    const start = this.heli.pos.clone().add(new THREE.Vector3(0, 2, 0));
    const rh = this.world.raycast(start.x, start.y, start.z, bs.x, bs.y, bs.z, 420);
    this.ccipValid = !!rh;
    if (rh) this.ccip.copy(start).addScaledVector(bs, rh.dist);
  }

  private updateWeapons(dt: number) {
    const h = this.heli;
    const inp = this.input;
    const st = this.stats;
    this.gunT -= dt;
    this.rocketT -= dt;
    this.flareT -= dt;
    const aimDir = h.aimGun(this.aim, new THREE.Vector3());
    // cannon
    if (inp.lmb && this.gunT <= 0 && this.ammo.gun > 0 && h.rpm > 0.8) {
      this.gunT = 1 / st.gunRof;
      this.ammo.gun--;
      const m = h.muzzleWorld(new THREE.Vector3());
      const spread = 0.012;
      const dir = aimDir.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread)).normalize();
      this.projectiles.spawn({
        kind: 'bullet',
        player: true,
        pos: m,
        vel: dir.multiplyScalar(300).add(h.vel),
        life: 2.2,
        radius: st.gunRadius,
        power: st.gunPower,
        damage: 7 + 2 * level(this.save, 'gunDmg'),
        color: 0xffe28a,
      });
      this.fx.muzzle(m.x, m.y, m.z);
      this.audio.gun();
      h.shake = Math.max(h.shake, 0.06);
    } else if (inp.mouseHit(0) && this.ammo.gun <= 0) {
      this.audio.deny();
      this.hud.message('CANNON WINCHESTER — no rounds left', '#ffb84a', 1500);
    }
    // rockets
    if (inp.rmb && this.rocketT <= 0 && this.ammo.rockets > 0 && h.rpm > 0.8) {
      this.rocketT = 0.17;
      this.ammo.rockets--;
      this.podLeft = !this.podLeft;
      const p = h.podWorld(this.podLeft, new THREE.Vector3());
      const dir = h.boresight(new THREE.Vector3());
      dir.x += (Math.random() - 0.5) * 0.015;
      dir.y += (Math.random() - 0.5) * 0.015;
      dir.z += (Math.random() - 0.5) * 0.015;
      dir.normalize();
      this.projectiles.spawn({
        kind: 'rocket',
        player: true,
        pos: p,
        vel: dir.clone().multiplyScalar(110).add(h.vel),
        speed: 110,
        accel: 300,
        maxSpeed: 220,
        life: 3.5,
        radius: st.rocketRadius,
        power: st.rocketPower,
        damage: 40,
        color: 0xfff0c0,
      });
      this.fx.muzzle(p.x, p.y, p.z, true);
      this.audio.rocket();
    } else if (inp.mouseHit(2) && this.ammo.rockets <= 0) {
      this.audio.deny();
      this.hud.message('NO ROCKETS — land at the FARP or winch an ammo crate', '#ffb84a', 1800);
    }
    // missiles
    if (inp.hit('KeyF')) {
      if (st.missiles <= 0) this.hud.message('Guided missiles not installed (hangar upgrade)', '#ffb84a', 1800);
      else if (this.ammo.missiles <= 0) this.audio.deny();
      else if (!this.lockTurret || this.lockT < 0.6) {
        this.audio.deny();
        this.hud.message('NO LOCK — hold the cursor over a target', '#ffb84a', 1500);
      } else {
        this.ammo.missiles--;
        const t = this.lockTurret;
        const p = h.podWorld(this.podLeft, new THREE.Vector3());
        p.y -= 1;
        this.podLeft = !this.podLeft;
        this.projectiles.spawn({
          kind: 'missile',
          player: true,
          pos: p,
          vel: h.boresight(new THREE.Vector3()).multiplyScalar(60).add(h.vel),
          speed: 60,
          accel: 120,
          maxSpeed: 170,
          turn: 3.2,
          life: 7,
          radius: 5.5,
          power: 16,
          damage: 140,
          targetRef: t.hitTarget,
          color: 0xffffff,
        });
        this.audio.missile();
      }
    }
    // flares
    if (inp.hit('KeyX')) {
      if (st.flares <= 0) this.hud.message('Countermeasures not installed (hangar upgrade)', '#ffb84a', 1800);
      else if (this.ammo.flares > 0 && this.flareT <= 0) {
        this.ammo.flares--;
        this.flareT = 0.8;
        for (let i = 0; i < 4; i++) {
          const side = i % 2 ? 1 : -1;
          const r = h.right(new THREE.Vector3()).multiplyScalar(side * (12 + Math.random() * 8));
          this.projectiles.spawn({
            kind: 'flare',
            pos: h.pos.clone().add(new THREE.Vector3(0, 2, 0)),
            vel: r.add(h.vel).add(new THREE.Vector3(0, 6 + Math.random() * 6, 0)),
            life: 3.5,
            color: 0xfff6d0,
          });
        }
        this.audio.flare();
        // decoy incoming SAMs
        for (const p of this.projectiles.list) {
          if (p.kind === 'sam' && p.targetRef === this.heliTarget && p.pos.distanceTo(h.pos) < 220 && Math.random() < 0.85) {
            const f = this.projectiles.flares[Math.floor(Math.random() * this.projectiles.flares.length)];
            if (f) {
              p.targetRef = { pos: f.pos, alive: true };
            }
          }
        }
      }
    }
  }

  // ======================================================================== explosions / damage

  explode(x: number, y: number, z: number, r: number, power: number, o: { dmg?: number; carve?: boolean; airburst?: boolean; direct?: HitTarget | null; quiet?: boolean } = {}) {
    if (o.carve !== false) this.destruction.explode(x, y, z, r, power, { debris: Math.min(2, 0.6 + r / 6) });
    if (!o.quiet) {
      this.fx.explosion(x, y, z, r, o.airburst);
      this.audio.explosion(x, z, r);
      this.addShake(x, z, Math.min(1, r / 6));
    }
    const dmg = o.dmg ?? power * 3;
    // turrets
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const d = t.center.distanceTo(new THREE.Vector3(x, y, z)) - t.radius;
      let amount = 0;
      if (o.direct === t.hitTarget) amount = dmg;
      else if (d < r) amount = dmg * clamp(1 - d / r, 0.15, 1) * 0.8;
      if (amount > 0) {
        t.hp -= amount;
        t.flash = 1;
        if (t.hp <= 0) this.killTurret(t);
      }
    }
    // heli (self-damage too)
    const h = this.heli;
    if (!h.dead) {
      const d = h.pos.clone().add(new THREE.Vector3(0, 3, 0)).distanceTo(new THREE.Vector3(x, y, z)) - 4;
      if (d < r) this.damageHeli(dmg * 0.5 * clamp(1 - d / r, 0.1, 1), 'blast');
    }
    // pickups are fragile
    for (const p of this.pickups) {
      if (!p.alive) continue;
      if (p.pos.distanceTo(new THREE.Vector3(x, y, z)) < r + 1) {
        p.alive = false;
        p.obj.visible = false;
        if (p.type === 'fuel') this.pendingBlasts.push({ t: 0.15, x: p.pos.x, y: p.pos.y + 1, z: p.pos.z, r: 4, p: 7 });
      }
    }
  }

  private onDetonate(p: Projectile, x: number, y: number, z: number, direct: HitTarget | null) {
    switch (p.kind) {
      case 'bullet':
        this.destruction.explode(x, y, z, p.radius, p.power, { debris: 0.5, scorch: false, speed: 0.6 });
        this.fx.impactPuff(x, y, z);
        this.audio.impact(x, z);
        this.explode(x, y, z, p.radius, p.power, { dmg: p.damage, carve: false, quiet: true, direct });
        break;
      case 'rocket':
        this.explode(x, y, z, p.radius, p.power, { dmg: p.damage, direct });
        break;
      case 'missile':
        this.explode(x, y, z, p.radius, p.power, { dmg: p.damage, direct });
        break;
      case 'ebullet':
        if (direct === this.heliTarget) this.damageHeli(p.damage, 'gunfire');
        else {
          this.destruction.explode(x, y, z, 1.1, 1.6, { debris: 0.3, scorch: false, speed: 0.5 });
          this.fx.impactPuff(x, y, z);
        }
        break;
      case 'shell':
        this.explode(x, y, z, 3.2, 6, { dmg: p.damage, direct });
        break;
      case 'flak': {
        this.fx.explosion(x, y, z, 3, true);
        this.audio.explosion(x, z, 4);
        const d = this.heli.pos.distanceTo(new THREE.Vector3(x, y, z));
        if (d < 13 && !this.heli.dead) this.damageHeli(p.damage * (1 - d / 13), 'flak');
        break;
      }
      case 'sam': {
        const nearGround = this.world.solidAt(x, y - 2, z);
        this.explode(x, y, z, 4, 8, { dmg: 0, carve: nearGround, airburst: !nearGround });
        const d = this.heli.pos.distanceTo(new THREE.Vector3(x, y, z));
        if (d < 10 && !this.heli.dead) this.damageHeli(p.damage * (1 - d / 14), 'missile');
        break;
      }
    }
  }

  private damageHeli(amount: number, cause: string) {
    const h = this.heli;
    if (h.dead || amount <= 0 || this.state !== 'playing') return;
    h.hp -= amount;
    h.shake = Math.max(h.shake, Math.min(1, amount / 25));
    this.hud.damageFlash(amount);
    this.audio.hit();
    (h.visual.material.userData.flash as { value: number }).value = 0.6;
    if (h.hp <= 0 && !h.crashed) {
      h.hp = 0;
      h.crashed = true;
      h.engineOn = false;
      this.hud.message(`AIRCRAFT LOST — ${cause.toUpperCase()}`, '#ff5a4a', 4000);
      if (h.onGround) this.heliDestroyed();
    }
  }

  private heliDestroyed() {
    const h = this.heli;
    if (h.dead) return;
    h.dead = true;
    h.visual.root.visible = false;
    this.explode(h.pos.x, h.pos.y + 2, h.pos.z, 6, 12, { dmg: 0 });
    this.fx.addFire(h.pos.x, h.pos.y, h.pos.z, 2.5, 30);
    // wreck voxels
    const wreck = P.heliWreck(new RNG(1));
    wreck.replace(M.OLIVE_DARK, M.WRECK);
    for (let y = 0; y < wreck.sy; y++)
      for (let z = 0; z < wreck.sz; z++)
        for (let x = 0; x < wreck.sx; x++) {
          const m = wreck.get(x, y, z);
          if (!m) continue;
          const wx = Math.floor(h.pos.x - wreck.sx / 2 + x),
            wz = Math.floor(h.pos.z - wreck.sz / 2 + z);
          const wy = Math.floor(h.pos.y) + y;
          if (this.world.get(wx, wy, wz) === 0) this.world.set(wx, wy, wz, m);
        }
    if (this.state === 'playing') this.endRun('Aircraft destroyed', false);
  }

  private killTurret(t: Turret) {
    if (!t.alive) return;
    t.alive = false;
    t.hitTarget.alive = false;
    t.root.visible = false;
    this.sectorGroup.remove(t.root);
    const big = t.type === 'tank' || t.type === 'sam' || t.type === 'flak';
    this.explode(t.center.x, t.center.y, t.center.z, big ? 5 : 3.5, big ? 10 : 7, { dmg: 0 });
    this.fx.addFire(t.center.x, t.pos.y, t.center.z, big ? 2 : 1.2, 20 + Math.random() * 20);
    // leave a wreck in the voxel world
    const rng = new RNG(Math.floor(t.pos.x * 31 + t.pos.z));
    const m = t.type === 'tank' ? P.vehicle(rng, 'tank', true).rotated(rng.int(0, 3)) : P.vehicle(rng, 'technical', true);
    if (t.type !== 'tank') {
      m.replace(M.PLASTER_WHITE, M.WRECK);
    }
    const ox = Math.floor(t.pos.x - m.sx / 2),
      oz = Math.floor(t.pos.z - m.sz / 2),
      oy = Math.floor(t.pos.y);
    for (let y = 0; y < m.sy; y++)
      for (let z = 0; z < m.sz; z++)
        for (let x = 0; x < m.sx; x++) {
          const v = m.get(x, y, z);
          if (v && this.world.get(ox + x, oy + y, oz + z) === 0) this.world.set(ox + x, oy + y, oz + z, v);
        }
    if (this.run) {
      this.run.kills++;
      this.addCredits(t.spec.reward, `${t.spec.name} destroyed`);
    }
    this.checkObjectives();
  }

  private onStructureDestroyed(s: StructureState) {
    const d = s.def;
    const cx = (d.x0 + d.x1) / 2,
      cy = (d.y0 + d.y1) / 2,
      cz = (d.z0 + d.z1) / 2;
    if (d.explosive) {
      this.pendingBlasts.push({ t: 0.1 + Math.random() * 0.25, x: cx, y: d.y0 + 3, z: cz, r: d.explosive * 0.6, p: 12 });
      this.pendingBlasts.push({ t: 0.35 + Math.random() * 0.3, x: cx, y: cy + 2, z: cz, r: d.explosive, p: 14 });
      this.fx.addFire(cx, d.y0, cz, 3.5, 45);
    } else if (d.team === 'enemy' && d.kind !== 'wall') {
      this.fx.addFire(cx, d.y0 + 1, cz, 1.8, 25);
    }
    if (d.team === 'enemy' && this.run) {
      this.run.structures++;
      if (d.reward) this.addCredits(d.reward, `${d.label} destroyed`);
    }
    this.checkObjectives();
  }

  private addCredits(n: number, why: string) {
    if (!this.run || this.state !== 'playing') return;
    this.run.pending += n;
    this.hud.message(`+${n} CR · ${why}`, '#e8d24a', 2200);
  }

  private bank() {
    const r = this.run;
    if (!r || r.pending <= 0) return;
    this.save.credits += r.pending;
    r.earned += r.pending;
    this.hud.message(`${r.pending} CR BANKED`, '#e8d24a');
    r.pending = 0;
    writeSave(this.save);
  }

  private baseDone(b: BaseDef): boolean {
    return b.objectives.every((o) => (o.kind === 'structure' ? this.tracker.states[o.index].destroyed : !this.turrets[o.index].alive));
  }

  private baseProgress(b: BaseDef): [number, number] {
    let done = 0;
    for (const o of b.objectives) if (o.kind === 'structure' ? this.tracker.states[o.index].destroyed : !this.turrets[o.index].alive) done++;
    return [done, b.objectives.length];
  }

  private checkObjectives() {
    if (this.sectorCleared || !this.run) return;
    for (const b of this.map.bases) {
      const key = `__done_${b.id}`;
      const bb = b as BaseDef & Record<string, unknown>;
      if (!bb[key] && this.baseDone(b)) {
        bb[key] = true;
        this.addCredits(150, `${b.name} neutralised`);
        this.hud.message(`${b.name} NEUTRALISED`, '#9dff9a', 4000);
      }
    }
    if (this.map.bases.every((b) => this.baseDone(b))) {
      this.sectorCleared = true;
      this.hud.message('ALL PRIMARY TARGETS DESTROYED — RETURN TO FARP', '#9dff9a', 6000);
    }
  }

  private onRotorStrike(s: { x: number; y: number; z: number; hard: boolean }) {
    // rotor chops foliage / light stuff; hard strikes spray sparks
    const m = this.world.get(s.x, s.y, s.z);
    if (!m) return;
    if (!s.hard) {
      this.world.set(s.x, s.y, s.z, 0);
      this.debris.spawn(s.x + 0.5, s.y + 0.5, s.z + 0.5, (Math.random() - 0.5) * 20, 5 + Math.random() * 8, (Math.random() - 0.5) * 20, m, 0.5);
    } else {
      this.fx.impactPuff(s.x + 0.5, s.y + 0.5, s.z + 0.5, 0x9a8a70);
      this.audio.impact(s.x, s.z);
    }
  }

  private addShake(x: number, z: number, amount: number) {
    const d = Math.hypot(x - this.camFocus.x, z - this.camFocus.z);
    this.shake = Math.max(this.shake, amount * clamp(1 - d / 300, 0, 1));
  }

  // ======================================================================== entities

  private updateTurrets(dt: number) {
    const h = this.heli;
    const target = h.pos.clone().add(new THREE.Vector3(0, 1, 0));
    const live = !h.dead && !h.crashed && this.state === 'playing';
    let missile = false;
    let locked = false;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const dx = t.pos.x - h.pos.x,
        dz = t.pos.z - h.pos.z;
      if (dx * dx + dz * dz > 600 * 600) continue;
      const fire = t.update(dt, this.world, target, h.vel, h.agl, live);
      if (t.hp <= 0) {
        this.killTurret(t);
        continue;
      }
      if (t.type === 'sam' && t.lock > 0.3) locked = true;
      if (fire) this.turretFire(t);
    }
    for (const p of this.projectiles.list) if (p.kind === 'sam' && p.targetRef === this.heliTarget) missile = true;
    this.incomingMissile = missile;
    this.lockedBySam = locked;
  }

  private turretFire(t: Turret) {
    const m = t.muzzle(new THREE.Vector3());
    const s = t.spec;
    const dir = t.aimDir.clone();
    // dispersion grows with range
    const sp = s.spread * (0.6 + t.dist / s.range);
    dir.x += (Math.random() - 0.5) * sp * 2;
    dir.y += (Math.random() - 0.5) * sp * 2;
    dir.z += (Math.random() - 0.5) * sp * 2;
    dir.normalize();
    if (t.type === 'mg' || t.type === 'aaa') {
      this.projectiles.spawn({ kind: 'ebullet', pos: m, vel: dir.multiplyScalar(s.speed), life: s.range / s.speed + 0.3, damage: s.damage, color: t.type === 'aaa' ? 0xff7040 : 0xffa050 });
      this.fx.muzzle(m.x, m.y, m.z);
      this.audio.enemyFire(m.x, m.z, false);
    } else if (t.type === 'flak') {
      const dist = m.distanceTo(this.heli.pos);
      this.projectiles.spawn({ kind: 'flak', pos: m, vel: dir.multiplyScalar(s.speed), life: 4, fuse: dist / s.speed + (Math.random() - 0.5) * 0.25, damage: s.damage, color: 0xffc070 });
      this.fx.muzzle(m.x, m.y, m.z, true);
      this.audio.enemyFire(m.x, m.z, true);
    } else if (t.type === 'tank') {
      this.projectiles.spawn({ kind: 'shell', pos: m, vel: dir.multiplyScalar(s.speed), life: 3, damage: s.damage, color: 0xffd080 });
      this.fx.muzzle(m.x, m.y, m.z, true);
      this.audio.enemyFire(m.x, m.z, true);
    } else if (t.type === 'sam') {
      const up = new THREE.Vector3(dir.x * 0.4, 1, dir.z * 0.4).normalize();
      this.projectiles.spawn({ kind: 'sam', pos: m, vel: up.multiplyScalar(40), speed: 40, accel: 70, maxSpeed: 135, turn: 1.7, life: 9, fuse: 5, damage: s.damage, targetRef: this.heliTarget, color: 0xffffff });
      this.audio.enemyFire(m.x, m.z, true);
      this.hud.message('MISSILE LAUNCH!', '#ff5a4a', 2000);
    }
  }

  private nearestPickup(): Pickup | null {
    const h = this.heli;
    let best: Pickup | null = null;
    let bd = 8;
    for (const p of this.pickups) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - h.pos.x, p.pos.z - h.pos.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  private updateWinch(dt: number) {
    const h = this.heli;
    const p = this.nearestPickup();
    const hspeed = Math.hypot(h.vel.x, h.vel.z);
    const height = p ? h.pos.y - p.pos.y : 99;
    const ok = p && height < 26 && height > 1 && hspeed < 12 && this.world.lineClear(p.pos.x, p.pos.y + 1.5, p.pos.z, h.pos.x, h.pos.y, h.pos.z, 0.5, 1.5);
    if (this.winchTarget && this.winchTarget !== p) {
      this.winchTarget.winch = 0;
      this.winchTarget.lift = 0;
    }
    this.winchTarget = ok ? p : null;
    if (p && ok) {
      p.winch += dt / this.stats.winchTime;
      p.lift = p.winch * Math.max(0, height - 3);
      if (Math.random() < dt * 8) this.audio.winch();
      if (p.winch >= 1) this.collect(p);
    }
    this.winchLine.visible = !!(p && ok && p.alive);
    if (this.winchLine.visible && p) {
      const pos = this.winchLine.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, h.pos.x, h.pos.y + 1.5, h.pos.z);
      pos.setXYZ(1, p.pos.x, p.pos.y + p.lift + 2.5, p.pos.z);
      pos.needsUpdate = true;
    }
  }

  private collect(p: Pickup) {
    p.alive = false;
    p.obj.visible = false;
    const st = this.stats;
    this.audio.pickup();
    if (p.type === 'fuel') {
      this.heli.fuel = Math.min(st.maxFuel, this.heli.fuel + st.maxFuel * 0.4);
      this.hud.message('FUEL +40%', PICKUP_COLOR.fuel);
    } else if (p.type === 'ammo') {
      this.ammo.gun = Math.min(st.gunAmmo, this.ammo.gun + Math.round(st.gunAmmo * 0.5));
      this.ammo.rockets = Math.min(st.rockets, this.ammo.rockets + 8);
      this.ammo.missiles = Math.min(st.missiles, this.ammo.missiles + 2);
      this.ammo.flares = Math.min(st.flares, this.ammo.flares + 4);
      this.hud.message('AMMO RESUPPLIED', PICKUP_COLOR.ammo);
    } else {
      this.heli.hp = Math.min(st.maxHp, this.heli.hp + 35);
      this.hud.message('FIELD REPAIR +35', PICKUP_COLOR.repair);
    }
  }

  private updatePickupsVisual(dt: number) {
    for (const p of this.pickups) {
      if (!p.alive) continue;
      p.obj.position.y = p.pos.y + p.lift;
      if (p.lift > 0) p.obj.rotation.y += dt * 2;
      if (p !== this.winchTarget && p.winch > 0) {
        p.winch = Math.max(0, p.winch - dt);
        p.lift = Math.max(0, p.lift - dt * 10);
      }
    }
    // rescue beacons
    const t = performance.now() / 1000;
    for (const r of this.rescues) {
      r.beacon.visible = !r.done && Math.sin(t * 8) > 0;
      if (r.done) continue;
      r.smokeT -= dt;
      if (r.smokeT <= 0) {
        r.smokeT = 0.18;
        this.fx.signalSmoke(r.pos.x, r.pos.y + 1, r.pos.z, 0xd84a32);
      }
    }
  }

  private updateRescue(dt: number) {
    const h = this.heli;
    for (const r of this.rescues) {
      if (r.done) continue;
      const d = Math.hypot(r.pos.x - h.pos.x, r.pos.z - h.pos.z);
      if (d < 30 && h.landed) {
        if (h.crew >= this.stats.cabin) {
          if (r.boardT === 0) this.hud.message('CABIN FULL — drop crew at the FARP', '#ffb84a');
          r.boardT = 0.01;
          continue;
        }
        r.boardT += dt;
        if (r.boardT >= 1.1) {
          r.boardT = 0.01;
          r.crew--;
          r.boarded++;
          h.crew++;
          this.audio.ui();
          this.hud.message(`CREW BOARDED ${r.boarded}/${r.total}`, '#9dff9a', 1500);
          if (r.done) this.hud.message('All crew aboard — fly them home to the FARP', '#9dff9a');
        }
      } else r.boardT = 0;
    }
  }

  private atFarp(): boolean {
    const f = this.map.farp;
    return Math.hypot(this.heli.pos.x - f.padX, this.heli.pos.z - f.padZ) < f.padR;
  }

  private updateFarp(dt: number) {
    const h = this.heli;
    if (!h.landed || !this.atFarp()) {
      this.serviceT = 0;
      return;
    }
    const st = this.stats;
    this.serviceT += dt;
    if (this.serviceT < 0.6) return;
    if (this.run && this.run.pending > 0) this.bank();
    if (h.crew > 0) {
      const n = h.crew;
      h.crew = 0;
      if (this.run) this.run.rescued += n;
      this.save.rescuedTotal += n;
      this.save.credits += n * 120;
      if (this.run) this.run.earned += n * 120;
      writeSave(this.save);
      this.hud.message(`${n} CREW RECOVERED · +${n * 120} CR`, '#9dff9a', 3500);
      // all delivered bonus is handled at sector end
      for (const r of this.rescues) if (r.done) r.boarded = 0;
    }
    h.fuel = Math.min(st.maxFuel, h.fuel + dt * 30);
    h.hp = Math.min(st.maxHp, h.hp + dt * 10);
    this.ammo.gun = Math.min(st.gunAmmo, this.ammo.gun + Math.ceil(dt * 150));
    if (this.serviceT % 0.35 < dt) {
      this.ammo.rockets = Math.min(st.rockets, this.ammo.rockets + 1);
      this.ammo.flares = Math.min(st.flares, this.ammo.flares + 1);
    }
    if (this.serviceT % 1.2 < dt) this.ammo.missiles = Math.min(st.missiles, this.ammo.missiles + 1);
    if (this.sectorCleared && this.serviceT > 1.2) this.completeSector();
  }

  private updateHeliFx(dt: number) {
    const h = this.heli;
    if (h.dead) return;
    // rotor downwash dust
    if (h.rpm > 0.5 && h.agl < 22) {
      const strength = (1 - h.agl / 22) * h.collective;
      const gy = h.pos.y - h.agl;
      if (Math.random() < strength * 3) this.fx.dust(h.pos.x, gy, h.pos.z, strength);
    }
    // damage smoke
    const frac = h.hp / this.stats.maxHp;
    this.damageSmokeT -= dt;
    if (frac < 0.5 && this.damageSmokeT <= 0) {
      this.damageSmokeT = frac < 0.25 ? 0.03 : 0.08;
      const p = h.pos.clone().add(new THREE.Vector3(0, 6, 0)).addScaledVector(h.forward(new THREE.Vector3()), -5);
      this.smoke.spawn({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 3, vy: 3, vz: (Math.random() - 0.5) * 3, life: 2, size0: 1, size1: 4, c0: frac < 0.25 ? 0x221e1c : 0x6a645c, a0: 0.8, a1: 0, drag: 1 });
      if (frac < 0.25) this.glow.spawn({ x: p.x, y: p.y, z: p.z, life: 0.25, size0: 1.2, size1: 0.3, c0: 0xffa040, emissive: 1 });
    }
    const fl = h.visual.material.userData.flash as { value: number };
    fl.value = Math.max(0, fl.value - dt * 4);
  }

  // ======================================================================== camera + hud

  private updateCamera(dt: number) {
    const cam = this.rig.camera;
    let target: THREE.Vector3;
    if (this.state === 'playing' || this.state === 'over' || this.state === 'paused') {
      const h = this.heli;
      target = h.pos.clone().addScaledVector(h.vel, 0.55);
      target.y = h.pos.y - h.agl * 0.6;
      // springy follow
      const k = 1 - Math.exp(-4 * dt);
      this.camFocus.lerp(target, k);
    } else target = this.camFocus;
    void this.camVel;
    const pitch = 0.98; // ~56 degrees
    const dist = this.zoom;
    const shake = Math.max(this.shake, this.heli?.shake ?? 0);
    this.shake = Math.max(0, this.shake - dt * 2);
    const sx = (Math.random() - 0.5) * shake * 3,
      sy = (Math.random() - 0.5) * shake * 3;
    cam.position.set(this.camFocus.x + sx, this.camFocus.y + Math.sin(pitch) * dist + sy, this.camFocus.z + Math.cos(pitch) * dist);
    cam.lookAt(this.camFocus.x + sx * 0.5, this.camFocus.y, this.camFocus.z + sy * 0.5);
  }

  private collectWarnings(dt: number): string[] {
    const h = this.heli;
    const w: string[] = [];
    if (this.state !== 'playing' || h.dead) return w;
    if (this.incomingMissile) {
      w.push('◆ MISSILE ◆');
      this.audio.alarm('missile', dt);
    } else if (this.lockedBySam) {
      w.push('SAM RADAR LOCK');
      this.audio.alarm('lock', dt);
    } else if (h.vrs > 0.35) {
      w.push('VORTEX RING · ADD SPEED');
      this.audio.alarm('vrs', dt);
    } else if (h.fuel < this.stats.maxFuel * 0.15) {
      w.push(h.fuel <= 0 ? 'ENGINE FLAMEOUT · AUTOROTATE' : 'LOW FUEL');
      this.audio.alarm('fuel', dt);
    }
    if (h.rpm < 0.97 && h.engineOn) w.push(`~ROTOR SPOOL ${Math.round(h.rpm * 100)}%`);
    if (h.overG > 1.0 && h.collective > 0.98) w.push('TORQUE LIMIT');
    if (h.hp < this.stats.maxHp * 0.25) w.push('HULL CRITICAL');
    if (h.crew >= this.stats.cabin && this.rescues.some((r) => !r.done)) w.push('CABIN FULL');
    return w;
  }

  private drawHud(dt: number, warnings: string[]) {
    const h = this.heli;
    const r = this.run;
    const hud = this.hud;
    // objectives
    const objs: HudObjective[] = this.map.bases.map((b) => {
      const [d, n] = this.baseProgress(b);
      return { text: `${b.name}${n > 1 ? ` ${d}/${n}` : ''}`, done: d === n };
    });
    const rescued = this.rescues.reduce((a, s) => a + (s.total - s.crew), 0);
    const total = this.rescues.reduce((a, s) => a + s.total, 0);
    objs.push({ text: `Rescue crews ${rescued}/${total}${h.crew ? ` (${h.crew} aboard)` : ''}`, done: rescued === total && h.crew === 0 });
    if (this.sectorCleared) objs.push({ text: '> RETURN TO FARP AND LAND', done: false, active: true });
    // text panels are DOM: refresh at ~15 Hz rather than every frame
    this.hudT -= dt;
    const refresh = this.hudT <= 0;
    if (refresh) this.hudT = 0.066;
    if (refresh) hud.update({
      hp: Math.max(0, h.hp),
      maxHp: this.stats.maxHp,
      fuel: h.fuel,
      maxFuel: this.stats.maxFuel,
      gun: this.ammo.gun,
      rockets: this.ammo.rockets,
      missiles: this.ammo.missiles,
      maxMissiles: this.stats.missiles,
      flares: this.ammo.flares,
      maxFlares: this.stats.flares,
      crew: h.crew,
      cabin: this.stats.cabin,
      alt: h.agl,
      speed: Math.hypot(h.vel.x, h.vel.z),
      vs: h.vel.y,
      torque: h.collective,
      rpm: h.rpm,
      heading: h.yaw,
      assists: h.assists,
      mass: h.mass,
      windDir: Math.atan2(h.wind.x, -h.wind.z),
      windSpeed: h.wind.length(),
      credits: this.save.credits,
      pending: r?.pending ?? 0,
      sector: this.map.sector,
      warnings,
      objectives: objs,
    });

    // radar
    const blips: RadarBlip[] = [];
    for (const t of this.turrets) if (t.alive) blips.push({ x: t.pos.x, z: t.pos.z, color: t.spec.radarColor, size: t.type === 'sam' ? 3.5 : 2.5, shape: t.type === 'sam' ? 'diamond' : 'dot' });
    for (const b of this.map.bases) if (!this.baseDone(b)) blips.push({ x: b.x, z: b.z, color: '#ff4a3a', size: 4, shape: 'ring' });
    for (const p of this.pickups) if (p.alive) blips.push({ x: p.pos.x, z: p.pos.z, color: PICKUP_COLOR[p.type], size: 2, shape: 'square' });
    for (const s of this.rescues) if (!s.done) blips.push({ x: s.pos.x, z: s.pos.z, color: '#ff9adf', size: 3.5, shape: 'diamond' });
    blips.push({ x: this.map.farp.padX, z: this.map.farp.padZ, color: '#7dffb0', size: 4, shape: 'diamond' });
    hud.drawRadar(h.pos.x, h.pos.z, h.yaw, this.stats.radarRange, blips.filter((b) => b.shape !== 'square' || Math.hypot(b.x - h.pos.x, b.z - h.pos.z) < this.stats.radarRange), dt);
    hud.drawMap(this.map.size, { x: h.pos.x, z: h.pos.z, heading: h.yaw }, blips);

    // overlay
    hud.clearOverlay();
    if (this.state !== 'playing' || h.dead) return;
    const cam = this.rig.camera;
    const sp = { x: 0, y: 0, behind: false };
    // gun aim
    if (this.aimValid) {
      hud.project(this.aim, cam, sp);
      hud.crosshair(sp.x, sp.y, this.ammo.gun > 0 ? '#9dff9a' : '#ff6a5a');
    }
    // CCIP
    if (this.ccipValid && this.ammo.rockets > 0) {
      hud.project(this.ccip, cam, sp);
      const hp = { x: 0, y: 0, behind: false };
      hud.project(h.pos, cam, hp);
      hud.line(hp.x, hp.y, sp.x, sp.y, 'rgba(255,228,106,0.35)', true);
      hud.pipper(sp.x, sp.y);
    }
    // missile lock
    if (this.lockTurret && this.stats.missiles > 0) {
      hud.project(this.lockTurret.center, cam, sp);
      const locked = this.lockT >= 0.6;
      hud.bracket(sp.x, sp.y, 16, locked ? '#ff4a3a' : '#ffe46a', locked ? 'LOCK' : '');
    }
    // nearby threats get small brackets
    for (const t of this.turrets) {
      if (!t.alive || t === this.lockTurret || !t.awake) continue;
      hud.project(t.center, cam, sp);
      if (sp.behind || sp.x < 0 || sp.y < 0 || sp.x > hud.overlay.width || sp.y > hud.overlay.height) continue;
      hud.bracket(sp.x, sp.y, 10, t.hasLOS ? 'rgba(255,90,70,0.9)' : 'rgba(255,170,90,0.45)');
    }
    // pickups / rescues / farp markers
    for (const p of this.pickups) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - h.pos.x, p.pos.z - h.pos.z);
      if (d > 160) continue;
      hud.project(new THREE.Vector3(p.pos.x, p.pos.y + 3, p.pos.z), cam, sp);
      hud.edgeMarker(sp.x, sp.y, PICKUP_COLOR[p.type], PICKUP_LABEL[p.type], sp.behind);
      if (p === this.winchTarget) hud.progressRing(sp.x, sp.y + 10, p.winch, PICKUP_COLOR[p.type]);
    }
    for (const s of this.rescues) {
      if (s.done) continue;
      hud.project(new THREE.Vector3(s.pos.x, s.pos.y + 4, s.pos.z), cam, sp);
      hud.edgeMarker(sp.x, sp.y, '#ff9adf', `CREW ×${s.crew}`, sp.behind);
      if (s.boardT > 0.02) hud.progressRing(sp.x, sp.y + 10, s.boardT / 1.1, '#ff9adf');
    }
    const f = this.map.farp;
    hud.project(new THREE.Vector3(f.padX, f.y + 3, f.padZ), cam, sp);
    hud.edgeMarker(sp.x, sp.y, '#7dffb0', 'FARP', sp.behind);
    if (this.sectorCleared || h.fuel < this.stats.maxFuel * 0.25) {
      // emphasise home
      hud.edgeMarker(sp.x, sp.y, '#7dffb0', 'FARP', sp.behind);
    }
    // objective markers (off-screen only)
    for (const b of this.map.bases) {
      if (this.baseDone(b)) continue;
      hud.project(new THREE.Vector3(b.x, f.y + 5, b.z), cam, sp);
      const on = !sp.behind && sp.x > 40 && sp.y > 40 && sp.x < hud.overlay.width - 40 && sp.y < hud.overlay.height - 40;
      if (!on) hud.edgeMarker(sp.x, sp.y, '#ff6a5a', b.name.split(' ').slice(-1)[0], sp.behind);
    }
  }
}
