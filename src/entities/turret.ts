import * as THREE from 'three';
import { angleDiff, clamp } from '../core/rng';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { VoxelWorld } from '../voxel/world';
import type { TurretType } from '../world/mapTypes';
import { RNG } from '../core/rng';
import { tankParts } from '../world/prefabs';
import { VoxModel } from '../world/voxModel';

export interface TurretSpec {
  name: string;
  range: number;
  hp: number;
  turn: number; // rad/s
  /** time between shots within a burst */
  rof: number;
  burst: number;
  burstCooldown: number;
  speed: number;
  damage: number;
  spread: number;
  maxElev: number;
  minElev: number;
  /** only engages targets at least this high above ground (radar clutter / gun depression) */
  minTargetAgl: number;
  /** only engages targets at most this far above the turret */
  maxTargetRel: number;
  lockTime: number;
  reward: number;
  radarColor: string;
}

export const TURRET_SPECS: Record<TurretType, TurretSpec> = {
  mg: { name: 'MG nest', range: 160, hp: 28, turn: 2.4, rof: 0.11, burst: 8, burstCooldown: 1.9, speed: 220, damage: 0.6, spread: 0.05, maxElev: 1.45, minElev: -0.3, minTargetAgl: 0, maxTargetRel: 999, lockTime: 0, reward: 25, radarColor: '#ffb84a' },
  aaa: { name: 'AA gun', range: 215, hp: 60, turn: 1.6, rof: 0.08, burst: 12, burstCooldown: 2.4, speed: 260, damage: 0.8, spread: 0.04, maxElev: 1.5, minElev: -0.1, minTargetAgl: 0, maxTargetRel: 999, lockTime: 0, reward: 50, radarColor: '#ff7a3a' },
  flak: { name: 'Flak cannon', range: 300, hp: 70, turn: 1.0, rof: 0.7, burst: 2, burstCooldown: 3.4, speed: 150, damage: 12, spread: 0.015, maxElev: 1.5, minElev: 0.12, minTargetAgl: 14, maxTargetRel: 999, lockTime: 0, reward: 70, radarColor: '#ff5050' },
  sam: { name: 'SAM launcher', range: 420, hp: 45, turn: 1.2, rof: 0.4, burst: 1, burstCooldown: 9, speed: 60, damage: 28, spread: 0, maxElev: 1.2, minElev: 0.2, minTargetAgl: 12, maxTargetRel: 999, lockTime: 2.6, reward: 90, radarColor: '#ff3030' },
  tank: { name: 'Tank', range: 190, hp: 90, turn: 0.8, rof: 0.4, burst: 1, burstCooldown: 4.5, speed: 170, damage: 14, spread: 0.012, maxElev: 0.5, minElev: -0.15, minTargetAgl: 0, maxTargetRel: 60, lockTime: 0, reward: 80, radarColor: '#ff8a5a' },
};

interface TurretParts {
  base: VoxModel | null;
  head: VoxModel;
  gun: VoxModel;
  scale: number;
  basePivot: [number, number, number];
  headPivot: [number, number, number];
  headY: number; // world units above pos
  gunPivot: [number, number, number];
  gunY: number; // relative to head
  gunZ?: number;
  muzzle: number; // barrel length (world units)
  radius: number;
}

function parts(type: TurretType): TurretParts {
  const D = M.METAL_DARK,
    O = M.METAL_TAN,
    O2 = M.OLIVE_DARK,
    S = M.STEEL;
  if (type === 'mg') {
    // tripod heavy MG with ammo can and a gun shield
    const head = new VoxModel(9, 7, 9);
    head.line(4, 3, 4, 0, 0, 7, D);
    head.line(4, 3, 4, 8, 0, 7, D);
    head.line(4, 3, 4, 4, 0, 0, D);
    head.box(3, 3, 3, 5, 4, 5, D);
    head.box(0, 3, 2, 8, 6, 2, O2); // shield
    head.box(3, 5, 2, 5, 5, 2, 0); // sight slit
    head.box(6, 3, 5, 7, 4, 7, O2);
    head.set(7, 4, 6, M.YELLOW_MARK);
    const gun = new VoxModel(3, 3, 16);
    gun.box(0, 0, 10, 2, 2, 15, D);
    gun.box(1, 2, 12, 1, 2, 13, S);
    for (let z = 2; z < 10; z++) gun.set(1, 1, z, z % 2 ? S : D);
    gun.box(0, 1, 0, 2, 1, 1, D);
    gun.box(1, 0, 0, 1, 2, 1, D);
    return { base: null, head, gun, scale: 0.5, basePivot: [0, 0, 0], headPivot: [4.5, 0, 4.5], headY: 0, gunPivot: [1.5, 1.5, 11], gunY: 2.0, muzzle: 5.5, radius: 3 };
  }
  if (type === 'aaa') {
    // twin-barrel AA gun on a turntable with ammo boxes and a gunner's seat
    const head = new VoxModel(13, 8, 13);
    head.cylinder(6, 6, 6, 0, 0, D);
    head.cylinder(6, 6, 5.4, 1, 1, O);
    head.box(1, 2, 3, 2, 6, 8, O); // cradle side plates
    head.box(10, 2, 3, 11, 6, 8, O);
    head.box(0, 2, 4, 0, 4, 7, O2); // ammo boxes
    head.box(12, 2, 4, 12, 4, 7, O2);
    head.set(0, 4, 5, M.YELLOW_MARK);
    head.set(12, 4, 5, M.YELLOW_MARK);
    head.box(5, 2, 9, 7, 3, 10, O2); // seat
    head.box(6, 4, 10, 6, 5, 10, D);
    head.box(6, 6, 7, 6, 7, 7, D); // sight post
    head.set(6, 7, 6, M.GLASS);
    const gun = new VoxModel(11, 5, 22);
    for (const x of [2, 8]) {
      gun.box(x - 1, 1, 13, x + 1, 3, 18, D); // receivers
      for (let z = 2; z < 13; z++) gun.set(x, 2, z, z < 9 && z % 3 === 0 ? D : S);
      gun.box(x, 1, 0, x, 3, 1, D); // flash hiders
      gun.box(x - 1, 2, 0, x + 1, 2, 1, D);
    }
    gun.box(3, 2, 15, 7, 2, 16, O2);
    gun.box(4, 3, 16, 6, 4, 18, O);
    return { base: null, head, gun, scale: 0.5, basePivot: [0, 0, 0], headPivot: [6.5, 0, 6.5], headY: 0, gunPivot: [5.5, 2.5, 16], gunY: 3.0, muzzle: 8, radius: 4 };
  }
  if (type === 'flak') {
    // heavy gun on a cruciform carriage: outriggers static, upper carriage turns
    const base = new VoxModel(22, 3, 22);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      for (let i = 2; i <= 10; i++) base.set(11 + dx * i, 0, 11 + dz * i, O2);
      base.box(11 + dx * 10 - 1, 0, 11 + dz * 10 - 1, 11 + dx * 10 + 1, 0, 11 + dz * 10 + 1, D);
    }
    base.cylinder(11, 11, 3, 0, 1, D);
    const head = new VoxModel(15, 10, 15);
    head.cylinder(7, 7, 4.5, 0, 1, O);
    head.box(3, 2, 4, 4, 6, 10, O);
    head.box(10, 2, 4, 11, 6, 10, O);
    // angled gun shield
    for (let x = 0; x <= 14; x++) {
      const bend = Math.abs(x - 7) > 4 ? 1 : 0;
      head.box(x, 3, 3 + bend, x, 8, 3 + bend, O);
    }
    head.box(6, 4, 3, 8, 6, 3, 0); // barrel opening
    head.box(1, 2, 9, 2, 3, 10, O2); // seats
    head.box(12, 2, 9, 13, 3, 10, O2);
    head.box(11, 4, 11, 13, 5, 12, D); // shells rack
    const gun = new VoxModel(7, 7, 30);
    gun.hcylinder('z', 0, 20, 3, 3, 1.1, S);
    gun.hcylinder('z', 0, 2, 3, 3, 2, D); // muzzle brake
    gun.box(1, 3, 0, 5, 3, 1, D);
    gun.hcylinder('z', 12, 22, 5, 3, 0.8, O2); // recuperator above barrel
    gun.box(1, 1, 20, 5, 5, 27, D); // breech
    gun.box(2, 2, 28, 4, 4, 29, O2);
    return { base, head, gun, scale: 0.5, basePivot: [11, 0, 11], headPivot: [7.5, 0, 7.5], headY: 0.8, gunPivot: [3.5, 3.5, 22], gunY: 3.0, muzzle: 11, radius: 4.5 };
  }
  if (type === 'sam') {
    // launcher on a 6-wheel chassis: cab, outriggers, turntable, 4-round canister rack
    const base = new VoxModel(18, 7, 30);
    for (const z of [3, 9, 22]) {
      base.box(0, 0, z, 1, 2, z + 2, M.RUBBER);
      base.box(16, 0, z, 17, 2, z + 2, M.RUBBER);
      base.set(0, 1, z + 1, M.METAL_LIGHT);
      base.set(17, 1, z + 1, M.METAL_LIGHT);
    }
    base.box(2, 2, 1, 15, 4, 28, O2);
    base.box(2, 5, 1, 15, 6, 6, O2); // cab
    base.box(3, 5, 0, 14, 5, 0, M.GLASS);
    base.box(2, 5, 3, 2, 5, 5, M.GLASS);
    base.box(15, 5, 3, 15, 5, 5, M.GLASS);
    base.set(3, 3, 0, M.LAMP);
    base.set(14, 3, 0, M.LAMP);
    for (const [x, z] of [
      [0, 13],
      [17, 13],
      [0, 26],
      [17, 26],
    ])
      base.box(x, 0, z, x, 3, z, D);
    base.cylinder(9, 17, 4, 5, 5, D);
    base.box(3, 5, 24, 6, 6, 27, O2); // generator
    const head = new VoxModel(10, 6, 10);
    head.cylinder(5, 5, 4.5, 0, 0, O2);
    head.box(1, 1, 3, 2, 5, 7, D);
    head.box(7, 1, 3, 8, 5, 7, D);
    head.box(3, 1, 7, 6, 3, 9, O2); // guidance box
    head.box(4, 4, 8, 5, 5, 9, M.DISH);
    const gun = new VoxModel(14, 10, 26);
    for (const [x, y] of [
      [1, 1],
      [8, 1],
      [1, 6],
      [8, 6],
    ]) {
      gun.box(x, y, 1, x + 4, y + 2, 24, M.PLASTER_WHITE);
      gun.box(x, y, 0, x + 4, y + 2, 0, M.RED_MARK);
      gun.box(x, y, 8, x + 4, y + 2, 8, M.OLIVE_LIGHT);
      gun.box(x, y, 17, x + 4, y + 2, 17, M.OLIVE_LIGHT);
      gun.box(x, y, 25, x + 4, y + 2, 25, D);
    }
    gun.box(6, 0, 6, 7, 9, 19, D); // central frame
    gun.box(0, 4, 10, 13, 5, 11, D);
    return { base, head, gun, scale: 0.5, basePivot: [9, 0, 17], headPivot: [5, 0, 5], headY: 3.0, gunPivot: [7, 5, 14], gunY: 3.0, muzzle: 7, radius: 5 };
  }
  // tank: same parts as the world vehicle prefab, turned to face -Z
  const tp = tankParts(new RNG(77), M.METAL_TAN);
  return {
    base: tp.hull.rotated(3),
    head: tp.turret.rotated(3),
    gun: tp.barrel.rotated(3),
    scale: 1,
    basePivot: [6.5, 0, 10.5],
    headPivot: [4.5, 0, 5.5],
    headY: 5,
    gunPivot: [1.5, 1.5, 11],
    gunY: 1.5,
    gunZ: -5.5,
    muzzle: 11,
    radius: 6,
  };
}

export class Turret {
  readonly spec: TurretSpec;
  readonly root = new THREE.Object3D();
  readonly headObj: THREE.Object3D;
  readonly gunObj: THREE.Object3D;
  readonly material = createVoxelMaterial({ localHash: true });
  readonly center = new THREE.Vector3();
  yaw: number;
  pitch = 0.2;
  hp: number;
  alive = true;
  /** for projectile direct-hit tests */
  readonly hitTarget: { pos: THREE.Vector3; radius: number; alive: boolean };
  awake = false;
  hasLOS = false;
  private losT = Math.random() * 0.3;
  private supportT = Math.random();
  burstLeft = 0;
  shotT = 0;
  cooldown = 1 + Math.random() * 2;
  lock = 0;
  flash = 0;
  readonly radius: number;
  private muzzleLen: number;
  /** set by game when the turret wants to fire */
  wantFire = false;
  private wobbleT = Math.random() * 10;
  /** distance to target at last update */
  dist = 0;
  readonly aimDir = new THREE.Vector3();

  constructor(
    readonly type: TurretType,
    readonly pos: THREE.Vector3,
    yaw: number,
    readonly baseId: number,
    difficulty: number,
  ) {
    this.spec = { ...TURRET_SPECS[type] };
    this.spec.damage *= 1 + 0.12 * difficulty;
    this.spec.spread *= Math.max(0.55, 1 - 0.08 * difficulty);
    this.hp = this.spec.hp * (1 + 0.1 * difficulty);
    this.yaw = yaw;
    const p = parts(type);
    this.radius = p.radius;
    this.muzzleLen = p.muzzle;
    this.root.position.copy(pos);
    if (p.base) {
      const b = buildModelMesh(p.base, this.material, p.basePivot, p.scale);
      b.rotation.y = yaw;
      this.root.add(b);
    }
    this.headObj = new THREE.Object3D();
    this.headObj.position.y = p.headY;
    this.headObj.add(buildModelMesh(p.head, this.material, p.headPivot, p.scale));
    this.root.add(this.headObj);
    this.gunObj = new THREE.Object3D();
    this.gunObj.position.y = p.gunY;
    this.gunObj.position.z = p.gunZ ?? 0;
    this.gunObj.add(buildModelMesh(p.gun, this.material, p.gunPivot, p.scale));
    this.headObj.add(this.gunObj);
    this.center.set(pos.x, pos.y + p.headY + p.gunY * 0.6, pos.z);
    this.hitTarget = { pos: this.center, radius: this.radius, alive: true };
    this.sync();
  }

  muzzle(out: THREE.Vector3) {
    this.root.updateMatrixWorld(true);
    return out.set(0, 0, -this.muzzleLen).applyMatrix4(this.gunObj.matrixWorld);
  }

  sync() {
    this.headObj.rotation.y = this.yaw;
    this.gunObj.rotation.x = this.pitch;
    (this.material.userData.flash as { value: number }).value = this.flash;
  }

  /**
   * AI tick. Returns true when the turret should fire this frame.
   */
  update(dt: number, world: VoxelWorld, target: THREE.Vector3, targetVel: THREE.Vector3, targetAgl: number, targetAlive: boolean): boolean {
    if (!this.alive) return false;
    this.flash = Math.max(0, this.flash - dt * 6);
    const s = this.spec;
    const dx = target.x - this.pos.x,
      dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz, target.y - this.center.y);
    this.awake = dist < s.range * 1.3;
    this.cooldown -= dt;
    // support check: did the ground under me get blown away?
    this.supportT -= dt;
    if (this.supportT <= 0) {
      this.supportT = 0.5;
      let support = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (world.solidAt(this.pos.x + dx * 1.5, this.pos.y - 0.6, this.pos.z + dz * 1.5)) support++;
          if (world.solidAt(this.pos.x + dx * 1.5, this.pos.y - 1.6, this.pos.z + dz * 1.5)) support++;
        }
      if (support === 0) {
        this.hp = 0;
        return false;
      }
    }
    if (!this.awake || !targetAlive) {
      this.yaw += dt * 0.25;
      this.lock = Math.max(0, this.lock - dt);
      this.sync();
      return false;
    }
    // line of sight (throttled)
    this.losT -= dt;
    const rel = target.y - this.center.y;
    const eligible = dist < s.range && targetAgl >= s.minTargetAgl && rel <= s.maxTargetRel;
    if (this.losT <= 0) {
      this.losT = 0.25;
      const m = this.muzzle(new THREE.Vector3());
      const los = eligible && world.lineClear(m.x, m.y, m.z, target.x, target.y + 2, target.z, 1.0, 6);
      // reaction time: a freshly spotted target isn't engaged instantly
      if (los && !this.hasLOS) this.cooldown = Math.max(this.cooldown, 0.9 + Math.random() * 0.8);
      this.hasLOS = los;
    }
    this.dist = dist;
    // aim with lead
    const tFlight = dist / Math.max(1, s.speed * (this.type === 'sam' ? 1.6 : 1));
    // gunners track imperfectly: a slowly wandering aim offset
    this.wobbleT += dt * 0.7;
    const wob = 3 + dist * 0.025;
    const ax = target.x + targetVel.x * tFlight * 0.85 - this.pos.x + Math.sin(this.wobbleT * 1.3 + this.pos.x) * wob;
    const ay = target.y + 2 + targetVel.y * tFlight * 0.6 - (this.center.y + 1) + Math.sin(this.wobbleT * 0.9) * wob * 0.5;
    const az = target.z + targetVel.z * tFlight * 0.85 - this.pos.z + Math.cos(this.wobbleT * 1.1 + this.pos.z) * wob;
    const wantYaw = Math.atan2(-ax, -az);
    const horiz = Math.hypot(ax, az);
    let wantPitch = Math.atan2(ay, horiz);
    if (this.type === 'tank' || this.type === 'flak') wantPitch += (s.speed > 0 ? (6 * horiz) / (s.speed * s.speed) : 0) * 0.5;
    wantPitch = clamp(wantPitch, s.minElev, s.maxElev);
    const dy = angleDiff(this.yaw, wantYaw);
    this.yaw += clamp(dy, -s.turn * dt, s.turn * dt);
    this.pitch += clamp(wantPitch - this.pitch, -s.turn * dt, s.turn * dt);
    this.sync();
    this.aimDir.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));

    if (!this.hasLOS) {
      this.lock = Math.max(0, this.lock - dt * 2);
      return false;
    }
    const aimed = Math.abs(dy) < 0.12;
    if (s.lockTime > 0) {
      this.lock = aimed ? this.lock + dt : Math.max(0, this.lock - dt);
      if (this.lock < s.lockTime || this.cooldown > 0) return false;
      this.lock = 0;
      this.cooldown = s.burstCooldown;
      return true;
    }
    if (this.burstLeft > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT += s.rof;
        this.burstLeft--;
        if (this.burstLeft === 0) this.cooldown = s.burstCooldown * (0.8 + Math.random() * 0.5);
        return true;
      }
      return false;
    }
    if (aimed && this.cooldown <= 0) {
      this.burstLeft = s.burst;
      this.shotT = 0;
    }
    return false;
  }
}
