import * as THREE from 'three';
import { angleDiff, clamp, lerp } from '../core/rng';
import { MAT_SOFT } from '../voxel/materials';
import { VoxelWorld } from '../voxel/world';
import type { HeliStats } from '../game/progression';
import { buildHeliVisual, HeliVisual } from './heliModel';

export const G = 20; // gravity, voxel units / s^2 (1 voxel ~ 0.5 m)

export interface HeliControls {
  /** +1 = cyclic forward (nose down) */
  pitch: number;
  /** +1 = cyclic right */
  roll: number;
  /** +1 = right pedal (nose right) */
  yaw: number;
  /** -1..1 collective input */
  collective: number;
}

export interface RotorStrike {
  x: number;
  y: number;
  z: number;
  hard: boolean;
}

const EMPTY_MASS = 62;
const REF_MASS = 85;

// ---- handling (assists on)
/** Attitude spring and damper: about 0.4 s to reach a commanded tilt, no overshoot. */
const ATT_STIFF = 80;
const ATT_DAMP = 16.5;
/** Horizontal drag: quadratic and linear coefficients on air speed. */
const DRAG_QUAD = 0.0034;
const DRAG_LIN = 0.07;
/** Tilt (rad) the SAS applies per unit of ground speed it is cancelling. */
const HOLD_GAIN = 0.1;
/** Share of max tilt the SAS uses to brake when the stick is released (opposite stick brakes harder). */
const BRAKE_TILT = 0.8;
/** Pedal turn rate (rad/s) in the hover and at cruise speed. */
const YAW_RATE_HOVER = 1.6;
const YAW_RATE_CRUISE = 0.9;
/** Side force per unit of forward speed x sideslip speed. */
const KEEL = 0.02;

/**
 * Simulation-leaning flight model:
 *  - thrust along the rotor axis, attitude via cyclic, heading via pedals
 *  - inertia + quadratic drag, wind, fuselage side force (the track follows the nose at speed)
 *  - ground effect, translational lift, vortex-ring state, rotor RPM / autorotation
 *  - weight from fuel, ammo and passengers
 * Assists (SAS): attitude hold, hover hold on a centred stick, turn coordination,
 * heading hold and vertical-speed hold. With assists off the controls are raw.
 */
export class Helicopter {
  readonly visual: HeliVisual;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0; // + nose up
  roll = 0; // + right wing down
  private pitchRate = 0;
  private rollRate = 0;
  yawRate = 0;
  collective = 0;
  rpm = 0;
  engineOn = true;
  fuel = 100;
  hp = 100;
  onGround = true;
  landed = true;
  crashed = false;
  dead = false;
  assists = true;
  agl = 0;
  vrs = 0;
  overG = 0;
  wind = new THREE.Vector3();
  /** extra mass from ammo + passengers, set by game each frame */
  payload = 0;
  crew = 0;
  private rotorAngle = 0;
  private tailAngle = 0;
  readonly quat = new THREE.Quaternion();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private prevPos = new THREE.Vector3();
  lastImpact = 0;
  onDamage: ((amount: number, cause: string) => void) | null = null;
  onRotorStrike: ((s: RotorStrike) => void) | null = null;
  shake = 0;

  constructor(
    private world: VoxelWorld,
    public stats: HeliStats,
  ) {
    this.visual = buildHeliVisual();
  }

  reset(x: number, y: number, z: number, yaw: number) {
    // the model is hidden when the aircraft is destroyed
    this.visual.root.visible = true;
    (this.visual.material.userData.flash as { value: number }).value = 0;
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = this.roll = 0;
    this.pitchRate = this.rollRate = this.yawRate = 0;
    this.collective = 0;
    this.rpm = 0;
    this.engineOn = true;
    this.fuel = this.stats.maxFuel;
    this.hp = this.stats.maxHp;
    this.onGround = this.landed = true;
    this.crashed = this.dead = false;
    this.crew = 0;
    this.syncVisual(0);
  }

  get mass() {
    return EMPTY_MASS + this.fuel * 0.12 + this.payload;
  }

  get maxThrust() {
    return this.stats.twr * G * REF_MASS;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  right(out = new THREE.Vector3()) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Ground (top of solid) under a point, searching downward from y. */
  groundY(x: number, z: number, fromY: number): number {
    return this.world.topY(x, z, Math.floor(fromY)) + 1;
  }

  update(dt: number, c: HeliControls) {
    if (this.dead) return;
    const st = this.stats;
    this.prevPos.copy(this.pos);
    const fwd = this.forward(new THREE.Vector3());
    const rgt = this.right(new THREE.Vector3());

    // ---- engine / rotor
    if (this.fuel <= 0 || this.crashed) this.engineOn = false;
    const airVel = new THREE.Vector3().subVectors(this.vel, this.wind);
    if (this.engineOn) {
      this.rpm = Math.min(1, this.rpm + dt * 0.5);
    } else {
      // autorotation: descending air drives the rotor, collective bleeds it
      const drive = Math.max(0, -airVel.y) / 26;
      this.rpm += (drive - this.collective * 0.45 * this.rpm - 0.06) * dt;
      this.rpm = clamp(this.rpm, 0, 1.08);
    }

    // ---- attitude
    const crash = this.crashed;
    // ground-relative velocity in the body frame (what the pilot sees: track over the ground)
    const gFwd = this.vel.dot(fwd);
    const gRight = this.vel.dot(rgt);
    if (this.assists && !crash) {
      // The stick commands tilt. An axis left centred is flown by the SAS instead, which
      // tilts against the ground speed on that axis: let go and the aircraft flares to a
      // hover, sideslip is banked away so the track follows the nose, and wind is held.
      // The hold fades out as the stick moves, so on an analog stick a small deflection
      // is a slow, precise creep and full deflection is the raw tilt.
      const hold = this.onGround ? 0 : 1;
      const holdP = hold * (1 - Math.abs(c.pitch)) ** 2;
      const holdR = hold * (1 - Math.abs(c.roll)) ** 2;
      // lean into the wind by the amount that cancels its push in a hover
      const windF = this.wind.dot(fwd);
      const windR = this.wind.dot(rgt);
      const windPush = (DRAG_QUAD * this.wind.length() + DRAG_LIN) / G;
      const trimP = windPush * windF;
      const trimR = -(windPush + (KEEL * Math.abs(windF)) / G) * windR;
      const brakeP = clamp(HOLD_GAIN * gFwd + trimP, -BRAKE_TILT * st.maxTilt, BRAKE_TILT * st.maxTilt);
      const brakeR = clamp(-HOLD_GAIN * gRight + trimR, -st.maxTilt, st.maxTilt);
      const tP = clamp(-c.pitch * st.maxTilt + holdP * brakeP, -st.maxTilt, st.maxTilt);
      const tR = clamp(c.roll * st.maxTilt + holdR * brakeR, -st.maxTilt, st.maxTilt);
      this.pitchRate += (ATT_STIFF * (tP - this.pitch) - ATT_DAMP * this.pitchRate) * dt;
      this.rollRate += (ATT_STIFF * (tR - this.roll) - ATT_DAMP * this.rollRate) * dt;
    } else if (!crash) {
      // rate command, weak natural damping, no auto-level
      this.pitchRate += (-c.pitch * 2.6 - 1.2 * this.pitchRate) * dt;
      this.rollRate += (c.roll * 2.6 - 1.2 * this.rollRate) * dt;
    } else {
      this.rollRate += (Math.sin(performance.now() * 0.003) * 2 - 0.5 * this.rollRate) * dt;
    }
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -0.9, 0.9);
    this.roll = clamp(this.roll + this.rollRate * dt, -0.9, 0.9);

    // heading
    const vFwd = airVel.dot(fwd);
    const vRight = airVel.dot(rgt);
    let yawAcc: number;
    if (this.assists && !crash) {
      // Pedals command a turn rate and the heading holds when they are released. Pedal
      // authority fades with speed (the fin stiffens). A banked turn at speed brings the
      // nose round with it: at the coordinated rate up to medium speed, and a little ahead
      // of it when fast, so a full-speed turn doesn't take the whole map.
      const fast = clamp(Math.abs(gFwd) / 40, 0, 1);
      const coord = clamp((gFwd - 6) / 10, 0, 1);
      const bankTurn = (G * Math.tan(c.roll * st.maxTilt)) / clamp(gFwd, 12, 22);
      const target = -c.yaw * lerp(YAW_RATE_HOVER, YAW_RATE_CRUISE, fast) - coord * bankTurn;
      // ease into a turn so a tap is a small correction, stop firmly when the pedal is released
      yawAcc = (c.yaw !== 0 ? 5 : 12) * (target - this.yawRate);
    } else {
      // raw pedals with a weathervaning tail
      const wv = vFwd > 4 ? -0.018 * vRight * clamp(vFwd / 25, 0, 1.4) : 0;
      yawAcc = -c.yaw * 3.2 + wv * 6 - 0.7 * this.yawRate;
    }
    // torque reaction when the anti-torque system is lost
    if (crash) yawAcc += 4.5;
    this.yawRate = clamp(this.yawRate + yawAcc * dt, -3.5, 3.5);
    if (this.onGround && this.landed) this.yawRate *= Math.exp(-8 * dt);
    this.yaw += this.yawRate * dt;

    this.euler.set(this.pitch, this.yaw, -this.roll, 'YXZ');
    this.quat.setFromEuler(this.euler);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);

    // ---- collective (with vertical speed hold assist)
    const m = this.mass;
    const effBase = this.rpm * this.rpm;
    this.agl = this.pos.y - this.groundY(this.pos.x, this.pos.z, this.pos.y + 0.5);
    const ge = 1 + 0.14 * clamp(1 - this.agl / 16, 0, 1);
    const speedH = Math.hypot(airVel.x, airVel.z);
    const etl = 1 + 0.09 * clamp((speedH - 6) / 14, 0, 1);
    // vortex ring state: fast descent with little forward speed
    const vrsSev = clamp((-airVel.y - 9) / 8, 0, 1) * clamp(1 - speedH / 14, 0, 1);
    this.vrs = lerp(this.vrs, vrsSev, 1 - Math.exp(-4 * dt));
    const vrsF = 1 - 0.38 * this.vrs;
    const eff = effBase * ge * etl * vrsF;
    if (this.assists && !crash && this.engineOn) {
      const hover = (m * G) / (this.maxThrust * Math.max(0.2, eff) * Math.max(0.5, up.y));
      let targetVs = c.collective * 16;
      if (targetVs < 0) {
        // the assist keeps a slow descent out of vortex ring state...
        targetVs = Math.max(targetVs, -lerp(9.5, 16, clamp(speedH / 14, 0, 1)));
        // ...and auto-flares: it won't let you fly into the ground faster than a firm landing
        targetVs = Math.max(targetVs, -(2.5 + this.agl * 0.7));
      }
      const vsErr = targetVs - this.vel.y;
      const want = clamp(hover + vsErr * 0.11, 0, 1);
      this.collective = lerp(this.collective, want, 1 - Math.exp(-9 * dt));
      if (this.onGround && c.collective <= 0) this.collective = Math.min(this.collective, hover * 0.85);
    } else {
      this.collective = clamp(this.collective + c.collective * 0.55 * dt, 0, 1);
    }

    // ---- forces
    const thrust = this.collective * this.maxThrust * eff;
    const acc = new THREE.Vector3().copy(up).multiplyScalar(thrust / m);
    acc.y -= G;
    // drag on air-relative velocity
    const cV = 0.02;
    acc.x -= (DRAG_QUAD * speedH + DRAG_LIN) * airVel.x;
    acc.z -= (DRAG_QUAD * speedH + DRAG_LIN) * airVel.z;
    acc.y -= cV * Math.abs(airVel.y) * airVel.y + 0.15 * airVel.y;
    // fuselage and fin side force: flying forward, the airframe resists sliding sideways,
    // so the flight path swings round after the nose instead of skating on
    const side = -KEEL * Math.abs(vFwd) * vRight;
    acc.x += rgt.x * side;
    acc.z += rgt.z * side;
    // VRS buffet
    if (this.vrs > 0.2) {
      acc.x += (Math.random() - 0.5) * 18 * this.vrs;
      acc.z += (Math.random() - 0.5) * 18 * this.vrs;
      this.shake = Math.max(this.shake, this.vrs * 0.5);
    }
    this.overG = thrust / (m * G);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    // ---- fuel
    if (this.engineOn) this.fuel = Math.max(0, this.fuel - (0.16 + 0.32 * this.collective * this.rpm) * dt);

    // ---- ground contact
    this.groundContact(dt, fwd, rgt);
    // ---- obstacle collisions
    this.obstacleCollisions(dt, fwd, rgt, up);

    // map bounds (soft wall)
    const S = this.world.sx;
    if (this.pos.x < 8) this.vel.x += (8 - this.pos.x) * 4 * dt;
    if (this.pos.z < 8) this.vel.z += (8 - this.pos.z) * 4 * dt;
    if (this.pos.x > S - 8) this.vel.x -= (this.pos.x - S + 8) * 4 * dt;
    if (this.pos.z > S - 8) this.vel.z -= (this.pos.z - S + 8) * 4 * dt;
    // service ceiling: thrust fades near the top of the world
    if (this.pos.y > 150) this.vel.y -= (this.pos.y - 150) * 2 * dt;

    this.syncVisual(dt);
  }

  private groundContact(dt: number, fwd: THREE.Vector3, rgt: THREE.Vector3) {
    // skid points
    const pts = [
      [3.2, -3.5],
      [-3.2, -3.5],
      [0, 8],
    ];
    let maxG = -Infinity;
    for (const [rx, fz] of pts) {
      const x = this.pos.x + rgt.x * rx + fwd.x * fz;
      const z = this.pos.z + rgt.z * rx + fwd.z * fz;
      const g = this.groundY(x, z, this.pos.y + 1.5);
      if (g > maxG) maxG = g;
    }
    this.agl = Math.max(0, this.pos.y - maxG);
    if (this.pos.y <= maxG) {
      const impactV = -this.vel.y;
      const hSpeed = Math.hypot(this.vel.x, this.vel.z);
      const tilt = Math.max(Math.abs(this.pitch), Math.abs(this.roll));
      this.pos.y = maxG;
      if (!this.onGround) {
        let dmg = 0;
        if (impactV > 11) dmg += (impactV - 11) * 4;
        if (hSpeed > 14) dmg += (hSpeed - 14) * 1.5;
        if (tilt > 0.45) dmg += (tilt - 0.45) * 60;
        if (dmg > 0 && performance.now() - this.lastImpact > 300) {
          this.lastImpact = performance.now();
          this.onDamage?.(dmg, 'hard landing');
          this.shake = Math.max(this.shake, Math.min(1, dmg / 30));
        }
      }
      this.onGround = true;
      if (this.vel.y < 0) this.vel.y = 0;
      const f = Math.exp(-5 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
      // gear levels the airframe
      this.pitch *= Math.exp(-6 * dt);
      this.roll *= Math.exp(-6 * dt);
      this.pitchRate *= 0.8;
      this.rollRate *= 0.8;
      const hover = (this.mass * G) / this.maxThrust;
      this.landed = this.collective < hover * 0.95 && hSpeed < 3;
    } else {
      this.onGround = this.pos.y - maxG < 0.15;
      this.landed = false;
    }
  }

  private obstacleCollisions(dt: number, fwd: THREE.Vector3, rgt: THREE.Vector3, up: THREE.Vector3) {
    const w = this.world;
    const speed = this.vel.length();
    const tmp = new THREE.Vector3();
    // fuselage probes (body frame: right, up, forward)
    const body: [number, number, number][] = [
      [0, 2.5, 12],
      [0, 3, 6],
      [0, 3.5, 0],
      [0, 4.5, -9],
      [0, 5, -16],
      [5.5, 4.3, -1],
      [-5.5, 4.3, -1],
    ];
    let hit = false;
    let hitDir = new THREE.Vector3();
    for (const [r, u, f] of body) {
      tmp.copy(this.pos).addScaledVector(rgt, r).addScaledVector(up, u).addScaledVector(fwd, f);
      if (w.solidAt(tmp.x, tmp.y, tmp.z)) {
        hit = true;
        hitDir.subVectors(tmp, this.pos);
        break;
      }
    }
    // rotor disc probes
    const rh = this.visual.rotorHeight;
    const hub = tmp.copy(this.pos).addScaledVector(up, rh).addScaledVector(fwd, 0.5);
    const hx = hub.x,
      hy = hub.y,
      hz = hub.z;
    const strikes: RotorStrike[] = [];
    if (this.rpm > 0.2) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + this.rotorAngle;
        for (const rad of [8, 13.5]) {
          const lx = Math.cos(a) * rad,
            lz = Math.sin(a) * rad;
          const px = hx + rgt.x * lx + fwd.x * lz,
            pz = hz + rgt.z * lx + fwd.z * lz;
          const py = hy + (rgt.y * lx + fwd.y * lz);
          const vx = Math.floor(px),
            vy = Math.floor(py),
            vz = Math.floor(pz);
          const mat = w.get(vx, vy, vz);
          if (mat) {
            strikes.push({ x: vx, y: vy, z: vz, hard: !MAT_SOFT[mat] });
          }
        }
      }
    }
    for (const s of strikes) this.onRotorStrike?.(s);
    const hard = strikes.filter((s) => s.hard);
    if (hard.length) {
      hit = true;
      hitDir.set(hard[0].x + 0.5 - this.pos.x, 0, hard[0].z + 0.5 - this.pos.z);
    }
    if (hit) {
      // push back out, reflect velocity
      this.pos.copy(this.prevPos);
      const n = hitDir.normalize();
      const vn = this.vel.dot(n);
      if (vn > 0) this.vel.addScaledVector(n, -vn * 1.5);
      this.vel.multiplyScalar(0.6);
      this.pos.addScaledVector(n, -0.3);
      if (performance.now() - this.lastImpact > 250) {
        this.lastImpact = performance.now();
        const dmg = (hard.length ? 5 : 0) + Math.max(0, speed - 4) * 0.9;
        if (dmg > 0) this.onDamage?.(dmg, hard.length ? 'rotor strike' : 'collision');
        this.shake = Math.max(this.shake, 0.6);
      }
    }
    void dt;
  }

  syncVisual(dt: number) {
    const v = this.visual;
    v.root.position.copy(this.pos);
    v.root.quaternion.copy(this.quat);
    this.rotorAngle += this.rpm * 28 * dt;
    this.tailAngle += this.rpm * 60 * dt;
    v.rotor.rotation.y = -this.rotorAngle;
    v.tailRotor.rotation.x = this.tailAngle;
    const blur = clamp((this.rpm - 0.4) / 0.6, 0, 1);
    (v.rotorBlur.material as THREE.MeshBasicMaterial).opacity = blur * 0.32;
    for (const c of v.rotor.children) if (c.children.length) c.visible = blur < 0.95 || Math.random() < 0.5;
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  /** Point the chin gun at a world position; returns the clamped world aim direction. */
  aimGun(target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const v = this.visual;
    v.root.updateMatrixWorld(true);
    const local = v.body.worldToLocal(target.clone());
    local.sub(v.gunYaw.position);
    let az = Math.atan2(-local.x, -local.z);
    az = clamp(az, -1.9, 1.9);
    const horiz = Math.hypot(local.x, local.z);
    let el = Math.atan2(local.y, horiz);
    el = clamp(el, -1.2, 0.25);
    v.gunYaw.rotation.y = az;
    v.gunPitch.rotation.x = el;
    // world direction
    out.set(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    out.applyQuaternion(this.quat).normalize();
    return out;
  }

  muzzleWorld(out: THREE.Vector3) {
    const v = this.visual;
    v.gunPitch.updateWorldMatrix(true, false);
    return out.set(0, 0, -2.5).applyMatrix4(v.gunPitch.matrixWorld);
  }

  podWorld(left: boolean, out: THREE.Vector3) {
    return out.copy(left ? this.visual.podL : this.visual.podR).applyQuaternion(this.quat).add(this.pos);
  }

  /** Airframe boresight for rockets: forward, pitched down a few degrees. */
  boresight(out: THREE.Vector3) {
    return out.set(0, Math.sin(-0.09), -Math.cos(-0.09)).applyQuaternion(this.quat).normalize();
  }

  headingTo(x: number, z: number) {
    return angleDiff(this.yaw, Math.atan2(-(x - this.pos.x), -(z - this.pos.z)));
  }
}
