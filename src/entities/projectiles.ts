import * as THREE from 'three';
import { ParticleSystem } from '../fx/particles';
import { VoxelWorld } from '../voxel/world';

export type ProjKind = 'bullet' | 'rocket' | 'missile' | 'ebullet' | 'shell' | 'flak' | 'sam' | 'flare';

export interface Projectile {
  kind: ProjKind;
  player: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  radius: number; // blast radius
  power: number; // voxel blast power
  damage: number; // entity damage
  /** guidance target (missile/sam) */
  target: THREE.Vector3 | null;
  targetRef: { pos: THREE.Vector3; alive: boolean } | null;
  turn: number;
  speed: number;
  accel: number;
  maxSpeed: number;
  fuse: number; // flak: time to burst; sam: proximity
  trailT: number;
  color: number;
  dead: boolean;
}

export interface HitTarget {
  pos: THREE.Vector3;
  radius: number;
  alive: boolean;
}

export interface ProjectileEvents {
  /** a projectile detonated (voxel hit, entity hit, fuse, or expired) */
  detonate(p: Projectile, x: number, y: number, z: number, direct: HitTarget | null): void;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/**
 * All ballistic and guided munitions. Collision is a voxel DDA along each
 * frame's travel segment plus segment-vs-sphere tests against live targets.
 */
export class Projectiles {
  readonly list: Projectile[] = [];
  readonly tracerMesh: THREE.InstancedMesh;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  private zAxis = new THREE.Vector3(0, 0, 1);
  /** potential direct-hit targets for player shots */
  enemyTargets: HitTarget[] = [];
  /** the player heli as a target for enemy shots */
  playerTarget: HitTarget | null = null;
  /** active decoys */
  flares: Projectile[] = [];

  constructor(
    private world: VoxelWorld,
    private smoke: ParticleSystem,
    private glow: ParticleSystem,
    private events: ProjectileEvents,
  ) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.tracerMesh = new THREE.InstancedMesh(geo, mat, 1500);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.setColorAt(0, this.col.set(1, 1, 1));
    this.tracerMesh.count = 0;
    this.tracerMesh.frustumCulled = false;
  }

  spawn(p: Partial<Projectile> & { kind: ProjKind; pos: THREE.Vector3; vel: THREE.Vector3 }): Projectile {
    const full: Projectile = {
      player: false,
      life: 3,
      radius: 1,
      power: 1,
      damage: 1,
      target: null,
      targetRef: null,
      turn: 0,
      speed: p.vel.length(),
      accel: 0,
      maxSpeed: 0,
      fuse: 0,
      trailT: 0,
      color: 0xffd27a,
      dead: false,
      ...p,
    } as Projectile;
    full.pos = p.pos.clone();
    full.vel = p.vel.clone();
    this.list.push(full);
    if (full.kind === 'flare') this.flares.push(full);
    return full;
  }

  update(dt: number) {
    const w = this.world;
    for (const p of this.list) {
      if (p.dead) continue;
      p.life -= dt;
      // guidance
      if ((p.kind === 'missile' || p.kind === 'sam') && (p.targetRef || p.target)) {
        if (p.targetRef && !p.targetRef.alive) p.targetRef = null;
        const tgt = p.targetRef ? p.targetRef.pos : p.target;
        if (tgt) {
          // lead a little
          tmp.subVectors(tgt, p.pos);
          const dist = tmp.length();
          const desired = tmp.normalize();
          const cur = tmp2.copy(p.vel).normalize();
          const ang = cur.angleTo(desired);
          if (ang > 1e-4) {
            const maxTurn = p.turn * dt;
            const t = Math.min(1, maxTurn / ang);
            cur.lerp(desired, t).normalize();
          }
          p.speed = Math.min(p.maxSpeed, p.speed + p.accel * dt);
          p.vel.copy(cur).multiplyScalar(p.speed);
          if (p.kind === 'sam' && dist < p.fuse) {
            this.detonate(p, p.pos.x, p.pos.y, p.pos.z, null);
            continue;
          }
        }
      } else if (p.kind === 'rocket') {
        p.speed = Math.min(p.maxSpeed, p.speed + p.accel * dt);
        p.vel.setLength(p.speed);
        p.vel.y -= 2 * dt;
      } else if (p.kind === 'shell') {
        p.vel.y -= 6 * dt;
      } else if (p.kind === 'flare') {
        p.vel.y -= 14 * dt;
        p.vel.multiplyScalar(Math.exp(-1.2 * dt));
      }

      const sx = p.pos.x,
        sy = p.pos.y,
        sz = p.pos.z;
      const stepLen = p.vel.length() * dt;
      // flak: burst on fuse
      if (p.kind === 'flak') {
        p.fuse -= dt;
        if (p.fuse <= 0) {
          this.detonate(p, sx, sy, sz, null);
          continue;
        }
      }
      if (p.kind !== 'flare' && stepLen > 0) {
        // voxel hit
        const hit = w.raycast(sx, sy, sz, p.vel.x, p.vel.y, p.vel.z, stepLen);
        // entity hit
        let direct: HitTarget | null = null;
        let directT = hit ? hit.dist : stepLen;
        const targets = p.player ? this.enemyTargets : this.playerTarget ? [this.playerTarget] : [];
        for (const t of targets) {
          if (!t.alive) continue;
          const d = segSphere(sx, sy, sz, p.vel, stepLen, t.pos, t.radius);
          if (d >= 0 && d < directT) {
            directT = d;
            direct = t;
          }
        }
        if (direct || hit) {
          const inv = 1 / (p.vel.length() || 1);
          const hx = sx + p.vel.x * inv * directT;
          const hy = sy + p.vel.y * inv * directT;
          const hz = sz + p.vel.z * inv * directT;
          this.detonate(p, hx, hy, hz, direct);
          continue;
        }
      }
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < -5) p.life = 0;
      if (p.life <= 0) {
        if (p.kind === 'flare' || p.kind === 'bullet' || p.kind === 'ebullet') p.dead = true;
        else this.detonate(p, p.pos.x, p.pos.y, p.pos.z, null);
        continue;
      }
      this.trail(p, dt);
    }
    // compact
    let j = 0;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].dead) this.list[j++] = this.list[i];
    this.list.length = j;
    this.flares = this.flares.filter((f) => !f.dead);
    this.render();
  }

  private detonate(p: Projectile, x: number, y: number, z: number, direct: HitTarget | null) {
    p.dead = true;
    p.pos.set(x, y, z);
    this.events.detonate(p, x, y, z, direct);
  }

  private trail(p: Projectile, dt: number) {
    p.trailT -= dt;
    if (p.trailT > 0) return;
    if (p.kind === 'rocket' || p.kind === 'missile' || p.kind === 'sam') {
      p.trailT = 0.012;
      this.smoke.spawn({
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        vx: (Math.random() - 0.5) * 2,
        vy: Math.random() * 2,
        vz: (Math.random() - 0.5) * 2,
        life: p.kind === 'sam' ? 2.2 : 0.8,
        size0: 0.7,
        size1: p.kind === 'sam' ? 3.5 : 1.8,
        c0: 0xe9e2d4,
        c1: 0xbdb4a4,
        a0: 0.75,
        a1: 0,
        drag: 2,
        grav: 1,
      });
      this.glow.spawn({ x: p.pos.x, y: p.pos.y, z: p.pos.z, life: 0.08, size0: 1.2, size1: 0.4, c0: 0xffd070, c1: 0xff6a20, emissive: 1 });
    } else if (p.kind === 'flare') {
      p.trailT = 0.03;
      this.glow.spawn({ x: p.pos.x, y: p.pos.y, z: p.pos.z, life: 0.5, size0: 1.4, size1: 0.2, c0: 0xfff2c0, c1: 0xff8a30, emissive: 1 });
      this.smoke.spawn({ x: p.pos.x, y: p.pos.y, z: p.pos.z, vy: 1, life: 1.6, size0: 0.6, size1: 2.4, c0: 0xf0ece4, a0: 0.6, a1: 0, drag: 1 });
    } else if (p.kind === 'shell' || p.kind === 'flak') {
      p.trailT = 0.04;
      this.smoke.spawn({ x: p.pos.x, y: p.pos.y, z: p.pos.z, life: 0.5, size0: 0.5, size1: 1.2, c0: 0x9a9286, a0: 0.4, a1: 0 });
    }
  }

  private render() {
    const mesh = this.tracerMesh;
    let n = 0;
    for (const p of this.list) {
      if (n >= 1500) break;
      let len = 0,
        thick = 0;
      switch (p.kind) {
        case 'bullet':
          len = 5;
          thick = 0.35;
          break;
        case 'ebullet':
          len = 4;
          thick = 0.4;
          break;
        case 'rocket':
          len = 2.2;
          thick = 0.5;
          break;
        case 'missile':
        case 'sam':
          len = 3;
          thick = 0.7;
          break;
        case 'shell':
        case 'flak':
          len = 1.6;
          thick = 0.7;
          break;
        case 'flare':
          len = 1;
          thick = 1;
          break;
      }
      tmp.copy(p.vel).normalize();
      if (tmp.lengthSq() < 0.5) tmp.set(0, 0, 1);
      this.q.setFromUnitVectors(this.zAxis, tmp);
      this.s.set(thick, thick, len);
      tmp2.copy(p.pos).addScaledVector(tmp, -len * 0.5);
      this.m4.compose(tmp2, this.q, this.s);
      mesh.setMatrixAt(n, this.m4);
      this.col.setHex(p.color);
      mesh.setColorAt(n, this.col);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.list.length = 0;
    this.flares.length = 0;
    this.tracerMesh.count = 0;
  }
}

/** Distance along the ray to the sphere surface (or -1). */
function segSphere(ox: number, oy: number, oz: number, vel: THREE.Vector3, len: number, c: THREE.Vector3, r: number): number {
  const l = vel.length() || 1;
  const dx = vel.x / l,
    dy = vel.y / l,
    dz = vel.z / l;
  const mx = ox - c.x,
    my = oy - c.y,
    mz = oz - c.z;
  const b = mx * dx + my * dy + mz * dz;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = Math.max(0, -b - Math.sqrt(disc));
  return t <= len ? t : -1;
}
