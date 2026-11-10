import * as THREE from 'three';
import { RNG, angleDiff, clamp, lerp, valueNoise } from '../core/rng';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { VoxelWorld } from '../voxel/world';
import * as P from '../world/prefabs';
import { VoxModel } from '../world/voxModel';
import type { HitTarget } from './projectiles';

// Enemies that move: gunships that hunt the player, and convoy vehicles that
// drive the highway. They are plain kinematic entities (no voxel physics);
// the game applies damage, fires their shots and leaves their wrecks.

export type MobileKind = 'gunship' | 'truck' | 'technical' | 'apc';

export interface MobileSpec {
  label: string;
  hp: number;
  reward: number;
  radius: number;
  radarColor: string;
}

export const MOBILE_SPECS: Record<MobileKind, MobileSpec> = {
  gunship: { label: 'GUNSHIP', hp: 72, reward: 120, radius: 5, radarColor: '#ff5a8a' },
  truck: { label: 'SUPPLY TRUCK', hp: 30, reward: 50, radius: 5.5, radarColor: '#ffd24a' },
  technical: { label: 'TECHNICAL', hp: 26, reward: 40, radius: 4.5, radarColor: '#ffb84a' },
  apc: { label: 'APC', hp: 70, reward: 70, radius: 6, radarColor: '#ff8a5a' },
};

/** What a mobile needs to know about the world and the player each tick. */
export interface MobileEnv {
  world: VoxelWorld;
  heights: Uint8Array;
  size: number;
  target: THREE.Vector3;
  targetVel: THREE.Vector3;
  targetAlive: boolean;
  /** FARP pad: gunships stay out of its air-defence umbrella */
  farpX: number;
  farpZ: number;
  /** multiplier on how far crews can see (night, sandstorm) */
  sight: number;
}

export interface MobileShot {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  damage: number;
}

/** Fires short bursts with a pause between them. */
class BurstGun {
  private cooldown = 1 + Math.random() * 1.5;
  private burstLeft = 0;
  private shotT = 0;
  constructor(
    private rof: number,
    private burst: number,
    private pause: number,
  ) {}
  /** True on a frame when a round leaves the barrel. */
  tick(dt: number, canFire: boolean): boolean {
    this.cooldown -= dt;
    if (this.burstLeft > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT += this.rof;
        this.burstLeft--;
        if (this.burstLeft === 0) this.cooldown = this.pause * (0.8 + Math.random() * 0.5);
        return true;
      }
      return false;
    }
    if (canFire && this.cooldown <= 0) {
      this.burstLeft = this.burst;
      this.shotT = 0;
    }
    return false;
  }
}

export abstract class Mobile {
  readonly spec: MobileSpec;
  hp: number;
  readonly maxHp: number;
  alive = true;
  /** gone for good: the game drops it from the scene */
  removed = false;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** centre of mass, used for hits, brackets and blast damage */
  readonly center = new THREE.Vector3();
  /** where the player's gunner should aim to hit it (lead included) */
  readonly aimPoint = new THREE.Vector3();
  readonly hitTarget: HitTarget;
  readonly root = new THREE.Object3D();
  readonly material = createVoxelMaterial({ localHash: true });
  flash = 0;
  yaw = 0;
  /** true while it is actively engaging the player */
  hunting = false;
  abstract readonly air: boolean;
  protected centerLift = 3;

  constructor(
    readonly kind: MobileKind,
    difficulty: number,
  ) {
    this.spec = MOBILE_SPECS[kind];
    this.hp = this.maxHp = this.spec.hp * (1 + 0.1 * difficulty);
    this.hitTarget = { pos: this.center, radius: this.spec.radius, alive: true };
  }

  abstract update(dt: number, env: MobileEnv, shots: MobileShot[]): void;

  protected sync(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 6);
    (this.material.userData.flash as { value: number }).value = this.flash;
    this.center.copy(this.pos);
    this.center.y += this.centerLift;
    this.root.position.copy(this.pos);
  }

  /** Lead point for a shooter at `from` firing rounds at `speed`. */
  updateAim(from: THREE.Vector3, speed: number) {
    const t = from.distanceTo(this.center) / speed;
    this.aimPoint.copy(this.center).addScaledVector(this.vel, t);
  }
}

// ---------------------------------------------------------------- gunship

/** Light scout/attack helicopter: bubble canopy, skids, gun pods. Nose points to -Z. */
export function scoutAirframe(): VoxModel {
  const m = new VoxModel(17, 17, 48);
  const B = M.CONCRETE_DARK,
    B2 = M.METAL_DARK,
    D = M.RUBBER;
  // skids on struts
  for (const [x, sx] of [
    [4, 5],
    [12, 11],
  ]) {
    m.box(x, 0, 5, x, 0, 22, D);
    m.set(x, 1, 4, D);
    for (const z of [9, 18]) m.line(x, 1, z, sx, 3, z, D);
  }
  // egg-shaped cabin with a framed bubble canopy
  const cx = 8,
    cy = 7,
    cz = 12,
    rx = 4.7,
    ry = 4.6,
    rz = 10;
  for (let y = 2; y <= 12; y++)
    for (let z = 2; z <= 22; z++)
      for (let x = 3; x <= 13; x++) {
        const ex = (x - cx) / rx,
          ey = (y - cy) / ry,
          ez = (z - cz) / rz;
        if (ex * ex + ey * ey + ez * ez > 1) continue;
        const glass = z <= 11 && y >= 7 && x !== 8 && z !== 7;
        m.set(x, y, z, glass ? M.GLASS : B);
      }
  // engine housing, exhaust, mast
  m.box(6, 11, 13, 10, 13, 23, B2);
  m.box(7, 11, 24, 9, 12, 26, D);
  m.box(7, 11, 27, 9, 12, 27, M.SOOT);
  m.box(8, 14, 17, 8, 16, 18, D);
  // tail boom, ID band, fin and stabiliser
  m.box(7, 8, 21, 9, 10, 29, B);
  m.box(8, 8, 30, 8, 9, 43, B);
  m.box(8, 8, 34, 8, 9, 36, M.RED_MARK);
  for (let y = 6; y <= 14; y++) m.box(8, y, 41 + Math.floor((y - 6) * 0.25), 8, y, 45, B2);
  m.box(5, 9, 38, 11, 9, 40, B2);
  m.set(8, 15, 45, M.LIGHT_RED);
  // stub pylons with gun pods
  m.box(2, 5, 11, 3, 5, 14, D);
  m.box(13, 5, 11, 14, 5, 14, D);
  for (const cc of [1.5, 14.5]) {
    m.hcylinder('z', 8, 16, 4.5, cc, 1.4, B2);
    m.set(Math.floor(cc), 4, 7, M.STEEL);
  }
  m.set(8, 3, 3, M.LAMP);
  // two-tone camouflage
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        if (m.get(x, y, z) !== B) continue;
        if (valueNoise(x * 0.17 + y * 0.09, z * 0.17 - y * 0.06, 977) > 0.6) m.set(x, y, z, M.TAN_DARK);
      }
  return m;
}

export interface ScoutVisual {
  root: THREE.Object3D;
  rotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  blur: THREE.Mesh;
}

const SCOUT_SCALE = 0.5;
const SCOUT_PIVOT: [number, number, number] = [8.5, 0, 17];

export function buildScoutVisual(material: THREE.Material, root = new THREE.Object3D()): ScoutVisual {
  const s = SCOUT_SCALE;
  root.add(buildModelMesh(scoutAirframe(), material, SCOUT_PIVOT, s));
  const bladeMat = new THREE.MeshLambertMaterial({ color: 0x1f201d });
  const rotor = new THREE.Object3D();
  rotor.position.set(0, 16.4 * s, 0.5 * s);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.22, 0.9), bladeMat);
    blade.position.x = 4.9;
    blade.castShadow = true;
    const arm = new THREE.Object3D();
    arm.rotation.y = (i * Math.PI * 2) / 3;
    arm.add(blade);
    rotor.add(arm);
  }
  rotor.add(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.6, 1.3), bladeMat));
  root.add(rotor);
  const blur = new THREE.Mesh(new THREE.CircleGeometry(9.8, 28), new THREE.MeshBasicMaterial({ color: 0x1f201d, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
  blur.rotation.x = -Math.PI / 2;
  blur.position.copy(rotor.position);
  blur.position.y += 0.1;
  root.add(blur);
  const tailRotor = new THREE.Object3D();
  tailRotor.position.set(0.75, 12 * s, (44 - SCOUT_PIVOT[2]) * s);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.6, 0.5), bladeMat);
    b.rotation.x = (i * Math.PI) / 2;
    tailRotor.add(b);
  }
  root.add(tailRotor);
  return { root, rotor, tailRotor, blur };
}

/**
 * Enemy scout helicopter. Patrols around a home point until it sees the
 * player, then flies gun runs: closes nose-on firing bursts, breaks away past
 * the target, comes around and repeats. Stays out of the FARP's umbrella.
 */
export class Gunship extends Mobile {
  readonly air = true;
  state: 'patrol' | 'attack' | 'breakoff' | 'falling' = 'patrol';
  /** hit the ground after being shot down (the game adds the fireball and wreck) */
  crashed = false;
  /** scrambled to hunt: chases from any distance */
  alerted = false;
  private speed = 0;
  private stateT = 0;
  private readonly home = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private orbitA = Math.random() * Math.PI * 2;
  private gun = new BurstGun(0.1, 7, 2.1);
  private visual: ScoutVisual;
  private rotorA = 0;
  private bank = 0;
  private pitchVis = 0;
  private losT = Math.random() * 0.3;
  private los = false;
  private wobble = Math.random() * 10;
  private readonly damage: number;
  private readonly spread: number;

  constructor(x: number, y: number, z: number, difficulty: number) {
    super('gunship', difficulty);
    this.centerLift = 3.5;
    this.damage = 0.6 * (1 + 0.12 * difficulty);
    this.spread = 0.065 * Math.max(0.6, 1 - 0.07 * difficulty);
    this.visual = buildScoutVisual(this.material, this.root);
    this.pos.set(x, y, z);
    this.home.set(x, y, z);
    this.yaw = Math.random() * Math.PI * 2;
    this.sync(0);
  }

  /** Killed in the air: spin down trailing smoke until it hits the ground. */
  shootDown() {
    this.alive = false;
    this.hitTarget.alive = false;
    this.hunting = false;
    this.state = 'falling';
    this.stateT = 0;
  }

  update(dt: number, env: MobileEnv, shots: MobileShot[]) {
    if (this.removed) return;
    this.stateT += dt;
    const S = env.size;
    const ground = (x: number, z: number) => env.heights[clamp(Math.floor(x), 0, S - 1) + clamp(Math.floor(z), 0, S - 1) * S];
    const p = this.pos;

    if (this.state === 'falling') {
      this.vel.y -= 26 * dt;
      const f = Math.exp(-0.5 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
      p.addScaledVector(this.vel, dt);
      this.yaw += 7.5 * dt;
      this.bank = lerp(this.bank, 0.5, 1 - Math.exp(-2 * dt));
      this.rotorA += 9 * dt;
      if (p.y <= ground(p.x, p.z) + 1.5 || env.world.solidAt(p.x, p.y + 1, p.z)) {
        this.crashed = true;
        this.removed = true;
      }
      this.applyVisual(dt);
      return;
    }

    const tgt = env.target;
    const dx = tgt.x - p.x,
      dz = tgt.z - p.z;
    const dist = Math.hypot(dx, dz);
    const playerSafe = Math.hypot(tgt.x - env.farpX, tgt.z - env.farpZ) < 150;
    const canHunt = env.targetAlive && !playerSafe && (this.alerted || dist < 320 * env.sight);
    if (this.state === 'patrol' && canHunt) {
      this.state = 'attack';
      this.stateT = 0;
    } else if (this.state !== 'patrol' && (!env.targetAlive || playerSafe || (!this.alerted && dist > 430))) {
      this.state = 'patrol';
      this.stateT = 0;
      // hold where it gave up the chase rather than flying all the way home
      if (playerSafe) this.home.set(clamp(p.x, 60, S - 60), p.y, clamp(p.z - 60, 60, S - 60));
    }

    let wantSpeed = 26;
    if (this.state === 'patrol') {
      this.orbitA += this.orbitDir * dt * 0.28;
      this.goal.set(this.home.x + Math.cos(this.orbitA) * 85, 0, this.home.z + Math.sin(this.orbitA) * 85);
    } else if (this.state === 'attack') {
      wantSpeed = 52;
      this.goal.set(tgt.x + env.targetVel.x * 0.6, 0, tgt.z + env.targetVel.z * 0.6);
      if (dist < 52 && this.stateT > 1) {
        // break away past the target, to one side
        this.state = 'breakoff';
        this.stateT = 0;
        const a = this.yaw + (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.6);
        this.goal.set(p.x - Math.sin(a) * 190, 0, p.z - Math.cos(a) * 190);
      }
    } else {
      wantSpeed = 56;
      if (this.stateT > 2.4 + Math.random() * 0.02 || Math.hypot(this.goal.x - p.x, this.goal.z - p.z) < 30) {
        this.state = 'attack';
        this.stateT = 0;
      }
    }
    // stay over the map
    this.goal.x = clamp(this.goal.x, 20, S - 20);
    this.goal.z = clamp(this.goal.z, 20, S - 20);

    // steer: turn towards the goal at a limited rate, fly where the nose points
    const wantYaw = Math.atan2(-(this.goal.x - p.x), -(this.goal.z - p.z));
    const turn = clamp(angleDiff(this.yaw, wantYaw) * 2.6, -1.5, 1.5);
    this.yaw += turn * dt;
    this.speed = lerp(this.speed, wantSpeed, 1 - Math.exp(-1.1 * dt));
    const fx = -Math.sin(this.yaw),
      fz = -Math.cos(this.yaw);
    this.vel.x = fx * this.speed;
    this.vel.z = fz * this.speed;
    // altitude: follow the terrain, and match the player while fighting
    const g = Math.max(ground(p.x, p.z), ground(p.x + fx * 25, p.z + fz * 25), ground(p.x + fx * 50, p.z + fz * 50));
    let wantY = g + 30;
    if (this.state !== 'patrol') wantY = clamp(tgt.y - 4, g + 22, g + 46);
    if (env.world.solidAt(p.x + fx * 14, p.y - 2, p.z + fz * 14) || env.world.solidAt(p.x + fx * 26, p.y - 2, p.z + fz * 26)) wantY = p.y + 22;
    this.vel.y = clamp((wantY - p.y) * 1.4, -14, 16);
    p.addScaledVector(this.vel, dt);
    p.x = clamp(p.x, 6, S - 6);
    p.z = clamp(p.z, 6, S - 6);

    // gun: bursts while nose-on, in range and with a clear line
    this.hunting = this.state !== 'patrol';
    this.losT -= dt;
    if (this.losT <= 0) {
      this.losT = 0.25;
      this.los = this.state === 'attack' && dist < 190 && env.world.lineClear(p.x, p.y + 1, p.z, tgt.x, tgt.y + 2, tgt.z, 5, 6);
    }
    const noseOn = Math.abs(angleDiff(this.yaw, Math.atan2(-dx, -dz))) < 0.17;
    if (this.gun.tick(dt, this.state === 'attack' && noseOn && this.los && dist < 175)) {
      const muzzle = new THREE.Vector3(p.x + fx * 5, p.y + 1.6, p.z + fz * 5);
      const t = muzzle.distanceTo(tgt) / 240;
      this.wobble += 0.9;
      const w = 2 + dist * 0.02;
      const aim = new THREE.Vector3(tgt.x + env.targetVel.x * t * 0.8 + Math.sin(this.wobble * 1.3) * w, tgt.y + 2 + env.targetVel.y * t * 0.6, tgt.z + env.targetVel.z * t * 0.8 + Math.cos(this.wobble * 1.1) * w);
      const dir = aim.sub(muzzle).normalize();
      const sp = this.spread * (0.6 + dist / 190);
      dir.x += (Math.random() - 0.5) * sp * 2;
      dir.y += (Math.random() - 0.5) * sp * 2;
      dir.z += (Math.random() - 0.5) * sp * 2;
      shots.push({ pos: muzzle, dir: dir.normalize(), speed: 240, damage: this.damage });
    }

    this.bank = lerp(this.bank, turn * 0.32, 1 - Math.exp(-5 * dt));
    this.pitchVis = lerp(this.pitchVis, -0.24 * (this.speed / 56), 1 - Math.exp(-3 * dt));
    this.rotorA += 30 * dt;
    this.applyVisual(dt);
  }

  private applyVisual(dt: number) {
    this.sync(dt);
    this.root.rotation.set(this.pitchVis, this.yaw, this.bank, 'YXZ');
    this.visual.rotor.rotation.y = -this.rotorA;
    this.visual.tailRotor.rotation.x = this.rotorA * 2;
  }
}

// ---------------------------------------------------------------- convoy vehicles

export interface ConvoyPath {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/**
 * A vehicle driving a straight stretch of highway. Armed kinds fire bursts at
 * the player. Anything left on the road ahead is flagged for the game to
 * knock out of the way (`plow`).
 */
export class GroundVehicle extends Mobile {
  readonly air = false;
  /** reached the end of the route */
  escaped = false;
  halted = true;
  /** set when something solid blocks the road ahead; the game clears it */
  plow: THREE.Vector3 | null = null;
  /** where the route leaves the sector */
  readonly end = new THREE.Vector3();
  private gun: BurstGun | null;
  private losT = Math.random() * 0.3;
  private los = false;
  private plowT = 0;
  private readonly len: number;
  private readonly ux: number;
  private readonly uz: number;
  private readonly halfLen: number;
  private readonly damage: number;

  constructor(
    kind: 'truck' | 'technical' | 'apc',
    private path: ConvoyPath,
    /** distance along the path */
    public s: number,
    readonly speed: number,
    difficulty: number,
    seed: number,
  ) {
    super(kind, difficulty);
    const model = P.vehicle(new RNG(seed), kind);
    this.root.add(buildModelMesh(model, this.material, [model.sx / 2, 0, model.sz / 2], 1));
    this.halfLen = model.sx / 2;
    this.centerLift = Math.min(4, model.sy * 0.5);
    this.len = Math.hypot(path.bx - path.ax, path.bz - path.az);
    this.ux = (path.bx - path.ax) / this.len;
    this.uz = (path.bz - path.az) / this.len;
    // vehicle models face +X
    this.yaw = Math.atan2(-this.uz, this.ux);
    this.root.rotation.y = this.yaw;
    this.gun = kind === 'truck' ? null : new BurstGun(kind === 'apc' ? 0.16 : 0.12, kind === 'apc' ? 5 : 6, 2.6);
    this.damage = (kind === 'apc' ? 0.9 : 0.6) * (1 + 0.12 * difficulty);
    this.pos.set(path.ax + this.ux * s, 0, path.az + this.uz * s);
    this.pos.y = -1;
    this.end.set(path.bx, 0, path.bz);
  }

  update(dt: number, env: MobileEnv, shots: MobileShot[]) {
    if (this.removed) return;
    const p = this.pos;
    const v = this.halted ? 0 : this.speed;
    this.s += v * dt;
    this.vel.set(this.ux * v, 0, this.uz * v);
    if (this.s >= this.len) {
      this.escaped = true;
      this.alive = false;
      this.hitTarget.alive = false;
      this.removed = true;
      return;
    }
    p.x = this.path.ax + this.ux * this.s;
    p.z = this.path.az + this.uz * this.s;
    // sit on whatever is left of the road (craters included), never above its original level
    const S = env.size;
    const h = env.heights[clamp(Math.floor(p.x), 0, S - 1) + clamp(Math.floor(p.z), 0, S - 1) * S];
    const gy = env.world.topY(p.x, p.z, h) + 1;
    p.y = p.y < 0 ? gy : lerp(p.y, gy, 1 - Math.exp(-8 * dt));
    // anything on the road ahead gets shoved aside
    this.plowT -= dt;
    if (!this.halted && this.plowT <= 0) {
      this.plowT = 0.15;
      const fx = p.x + this.ux * (this.halfLen + 2),
        fz = p.z + this.uz * (this.halfLen + 2);
      if (env.world.solidAt(fx, p.y + 2.5, fz)) this.plow = new THREE.Vector3(fx, p.y + 2.5, fz);
    }
    // gun
    if (this.gun) {
      const tgt = env.target;
      const dist = this.center.distanceTo(tgt);
      const range = 165 * env.sight;
      this.losT -= dt;
      if (this.losT <= 0) {
        this.losT = 0.3;
        this.los = env.targetAlive && dist < range && env.world.lineClear(p.x, p.y + 6, p.z, tgt.x, tgt.y + 2, tgt.z, 2, 6);
      }
      this.hunting = this.los;
      if (this.gun.tick(dt, this.los)) {
        const muzzle = new THREE.Vector3(p.x, p.y + 5, p.z);
        const t = dist / 220;
        const dir = new THREE.Vector3(tgt.x + env.targetVel.x * t * 0.8, tgt.y + 2 + env.targetVel.y * t * 0.5, tgt.z + env.targetVel.z * t * 0.8).sub(muzzle).normalize();
        const sp = 0.06 * (0.6 + dist / range);
        dir.x += (Math.random() - 0.5) * sp * 2;
        dir.y += (Math.random() - 0.5) * sp * 2;
        dir.z += (Math.random() - 0.5) * sp * 2;
        shots.push({ pos: muzzle, dir: dir.normalize(), speed: 220, damage: this.damage });
      }
    }
    this.sync(dt);
  }
}
