import * as THREE from 'three';
import { angleDiff, clamp } from '../core/rng';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { VoxelWorld } from '../voxel/world';
import type { TurretType } from '../world/mapTypes';
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
    O2 = M.OLIVE_DARK;
  if (type === 'mg') {
    const head = new VoxModel(6, 5, 6);
    head.box(1, 0, 1, 4, 1, 4, D);
    head.box(2, 2, 2, 3, 4, 3, D);
    head.box(0, 2, 3, 5, 4, 3, O); // shield
    const gun = new VoxModel(3, 3, 12);
    gun.box(0, 0, 7, 2, 2, 11, D);
    gun.box(1, 1, 0, 1, 1, 7, M.STEEL);
    return { base: null, head, gun, scale: 0.5, basePivot: [0, 0, 0], headPivot: [3, 0, 3], headY: 0, gunPivot: [1.5, 1.5, 9], gunY: 2.0, muzzle: 4.5, radius: 3 };
  }
  if (type === 'aaa') {
    const head = new VoxModel(12, 7, 12);
    head.cylinder(5.5, 5.5, 5.5, 0, 1, O);
    head.box(2, 2, 3, 9, 5, 9, O);
    head.box(3, 6, 4, 8, 6, 8, O2);
    head.box(4, 3, 9, 7, 4, 9, M.GLASS);
    const gun = new VoxModel(10, 4, 18);
    for (const x of [0, 2, 7, 9]) gun.box(x, 1, 0, x, 1, 12, M.STEEL);
    for (const x of [1, 8]) gun.box(x, 2, 0, x, 2, 12, M.STEEL);
    gun.box(0, 0, 12, 9, 3, 17, D);
    return { base: null, head, gun, scale: 0.5, basePivot: [0, 0, 0], headPivot: [6, 0, 6], headY: 0, gunPivot: [5, 2, 15], gunY: 3.0, muzzle: 7.5, radius: 4 };
  }
  if (type === 'flak') {
    const head = new VoxModel(14, 8, 14);
    head.cylinder(6.5, 6.5, 6.5, 0, 1, D);
    head.box(2, 2, 2, 11, 3, 11, O);
    head.box(1, 4, 9, 12, 7, 10, O); // gun shield
    const gun = new VoxModel(6, 6, 26);
    gun.hcylinder('z', 0, 18, 3, 3, 1.2, M.STEEL);
    gun.hcylinder('z', 0, 1, 3, 3, 1.8, D);
    gun.box(1, 1, 18, 4, 5, 25, D);
    return { base: null, head, gun, scale: 0.5, basePivot: [0, 0, 0], headPivot: [7, 0, 7], headY: 0, gunPivot: [3, 3, 21], gunY: 3.0, muzzle: 10.5, radius: 4.5 };
  }
  if (type === 'sam') {
    const base = new VoxModel(16, 5, 16);
    base.box(1, 0, 1, 14, 2, 14, O2);
    base.box(0, 0, 3, 15, 1, 4, M.RUBBER);
    base.box(0, 0, 11, 15, 1, 12, M.RUBBER);
    base.cylinder(7.5, 7.5, 3.5, 3, 4, D);
    const head = new VoxModel(8, 4, 8);
    head.box(1, 0, 1, 6, 3, 6, O2);
    const gun = new VoxModel(14, 8, 26);
    // 4 missiles on a rack
    for (const [x, y] of [
      [1, 1],
      [8, 1],
      [1, 5],
      [8, 5],
    ]) {
      gun.box(x, y, 2, x + 3, y + 1, 23, M.PLASTER_WHITE);
      gun.box(x, y, 0, x + 3, y + 1, 1, M.RED_MARK);
      gun.box(x + 1, y + 2, 20, x + 2, y + 2, 23, M.PLASTER_WHITE);
    }
    gun.box(5, 0, 8, 7, 7, 16, D);
    return { base, head, gun, scale: 0.5, basePivot: [8, 0, 8], headPivot: [4, 0, 4], headY: 2.5, gunPivot: [6.5, 3.5, 12], gunY: 2.5, muzzle: 6, radius: 5 };
  }
  // tank, full voxel scale to match world vehicles
  const camo = M.METAL_TAN;
  const base = new VoxModel(11, 5, 18);
  base.box(0, 0, 1, 2, 2, 15, M.RUBBER);
  base.box(8, 0, 1, 10, 2, 15, M.RUBBER);
  base.box(0, 2, 0, 10, 4, 16, camo);
  base.box(1, 3, 0, 9, 3, 0, M.OLIVE_DARK);
  const head = new VoxModel(8, 3, 9);
  head.box(0, 0, 0, 7, 2, 8, camo);
  head.box(1, 2, 4, 3, 2, 6, M.OLIVE_DARK);
  const gun = new VoxModel(2, 2, 12);
  gun.box(0, 0, 0, 1, 1, 11, M.METAL_DARK);
  return { base, head, gun, scale: 1, basePivot: [5.5, 0, 8], headPivot: [4, 0, 5], headY: 5, gunPivot: [1, 1, 12], gunY: 1.2, gunZ: -3, muzzle: 11, radius: 6 };
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
