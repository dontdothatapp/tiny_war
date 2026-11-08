import * as THREE from 'three';
import { DebrisSystem } from '../fx/debris';
import { ParticleSystem } from '../fx/particles';
import { MATERIALS } from './materials';
import { greedyMesh, meshDataToGeometry, padModel } from './mesher';
import { createVoxelMaterial } from './voxelMaterial';
import { VoxelWorld } from './world';

// Detached voxel fragments (collapsed floors, toppled palm crowns, sheared
// walls). They fall as rigid bodies, then shatter on impact into debris and
// rubble voxels that are written back into the world.

interface Body {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  angVel: THREE.Vector3;
  /** voxels in local coords relative to the body centre */
  vox: Float32Array; // x y z per voxel
  mats: Uint8Array;
  half: THREE.Vector3;
  age: number;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class BodySystem {
  readonly group = new THREE.Group();
  private bodies: Body[] = [];
  private material = createVoxelMaterial({ localHash: true });
  maxBodies = 90;
  onImpact: ((x: number, y: number, z: number, mass: number) => void) | null = null;

  constructor(
    private world: VoxelWorld,
    private debris: DebrisSystem,
    private smoke: ParticleSystem,
  ) {}

  get count() {
    return this.bodies.length;
  }

  /**
   * Create a falling body from world voxels (already removed from the world by the caller).
   * coords: flat array of world voxel coords, mats: their materials.
   */
  spawn(coords: Int32Array | number[], mats: Uint8Array | number[], impulse: THREE.Vector3) {
    const n = mats.length;
    if (n === 0) return;
    if (this.bodies.length >= this.maxBodies) {
      // too many in flight: just shatter immediately
      this.shatterCoords(coords, mats, n, 0, 0, 0);
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3],
        y = coords[i * 3 + 1],
        z = coords[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const sx = maxX - minX + 1,
      sy = maxY - minY + 1,
      sz = maxZ - minZ + 1;
    if (sx * sy * sz > 220000) {
      this.shatterCoords(coords, mats, n, 0, 0, 0);
      return;
    }
    const dense = new Uint8Array(sx * sy * sz);
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3] - minX,
        y = coords[i * 3 + 1] - minY,
        z = coords[i * 3 + 2] - minZ;
      dense[x + z * sx + y * sx * sz] = mats[i];
    }
    const md = greedyMesh(padModel(dense, sx, sy, sz), sx, sy, sz);
    if (!md) return;
    const geo = meshDataToGeometry(md);
    const cx = sx / 2,
      cy = sy / 2,
      cz = sz / 2;
    // positions are Uint8, so offset with a child transform instead of translating the geometry
    const inner = new THREE.Mesh(geo, this.material);
    inner.position.set(-cx, -cy, -cz);
    inner.castShadow = true;
    const mesh = new THREE.Object3D();
    mesh.add(inner);
    const pos = new THREE.Vector3(minX + cx, minY + cy, minZ + cz);
    mesh.position.copy(pos);
    this.group.add(mesh);
    const vox = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      vox[i * 3] = coords[i * 3] - minX + 0.5 - cx;
      vox[i * 3 + 1] = coords[i * 3 + 1] - minY + 0.5 - cy;
      vox[i * 3 + 2] = coords[i * 3 + 2] - minZ + 0.5 - cz;
    }
    const mass = Math.max(1, n);
    const spin = 1.5 / Math.sqrt(Math.max(1, mass / 30));
    this.bodies.push({
      mesh,
      pos,
      vel: impulse.clone(),
      quat: new THREE.Quaternion(),
      angVel: new THREE.Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin * 0.5, (Math.random() - 0.5) * spin),
      vox,
      mats: Uint8Array.from(mats),
      half: new THREE.Vector3(cx, cy, cz),
      age: 0,
    });
  }

  update(dt: number) {
    const w = this.world;
    for (let bi = this.bodies.length - 1; bi >= 0; bi--) {
      const b = this.bodies[bi];
      b.age += dt;
      b.vel.y -= 30 * dt;
      b.pos.addScaledVector(b.vel, dt);
      const av = b.angVel;
      const ang = av.length();
      if (ang > 0) {
        tmpQ.setFromAxisAngle(tmpV.copy(av).divideScalar(ang), ang * dt);
        b.quat.premultiply(tmpQ);
      }
      b.mesh.position.copy(b.pos);
      b.mesh.quaternion.copy(b.quat);
      // collision: sample a subset of voxels
      const n = b.mats.length;
      const step = Math.max(1, Math.floor(n / 40));
      let hit = false;
      for (let i = 0; i < n; i += step) {
        tmpV.set(b.vox[i * 3], b.vox[i * 3 + 1], b.vox[i * 3 + 2]).applyQuaternion(b.quat).add(b.pos);
        if (w.solidAt(tmpV.x, tmpV.y - 0.5, tmpV.z) || tmpV.y < 0) {
          hit = true;
          break;
        }
      }
      if (hit || b.age > 8) {
        this.shatter(b);
        this.dispose(b);
        this.bodies.splice(bi, 1);
      }
    }
  }

  private shatter(b: Body) {
    const n = b.mats.length;
    const coords = new Int32Array(n * 3);
    for (let i = 0; i < n; i++) {
      tmpV.set(b.vox[i * 3], b.vox[i * 3 + 1], b.vox[i * 3 + 2]).applyQuaternion(b.quat).add(b.pos);
      coords[i * 3] = Math.floor(tmpV.x);
      coords[i * 3 + 1] = Math.floor(tmpV.y);
      coords[i * 3 + 2] = Math.floor(tmpV.z);
    }
    this.shatterCoords(coords, b.mats, n, b.vel.x, b.vel.y, b.vel.z);
  }

  /** Turn voxels into a rubble heap + flying debris + dust. */
  shatterCoords(coords: ArrayLike<number>, mats: ArrayLike<number>, n: number, vx: number, vy: number, vz: number) {
    const w = this.world;
    const debrisP = Math.min(1, 140 / n);
    const keepP = n > 1500 ? 0.35 : 0.6;
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3],
        y = coords[i * 3 + 1],
        z = coords[i * 3 + 2];
      sx += x;
      sy += y;
      sz += z;
      const m = mats[i];
      if (Math.random() < debrisP) {
        const sp = 6 + Math.random() * 10;
        this.debris.spawn(x + 0.5, y + 0.5, z + 0.5, vx * 0.3 + (Math.random() - 0.5) * sp, Math.abs(vy) * 0.15 + Math.random() * sp, vz * 0.3 + (Math.random() - 0.5) * sp, m, Math.random() < 0.5 ? 1 : 0.6);
        continue;
      }
      if (Math.random() > keepP || MATERIALS[m]?.soft) continue;
      // settle into the first free cell at or above
      let yy = Math.max(1, y);
      for (let k = 0; k < 10 && w.get(x, yy, z) !== 0; k++) yy++;
      // and fall down to rest on something
      for (let k = 0; k < 24 && yy > 1 && w.get(x, yy - 1, z) === 0; k++) yy--;
      w.set(x, yy, z, m);
    }
    if (n > 0) {
      const cx = sx / n,
        cy = sy / n,
        cz = sz / n;
      const puffs = Math.min(26, 4 + Math.floor(n / 25));
      for (let i = 0; i < puffs; i++) {
        this.smoke.spawn({
          x: cx + (Math.random() - 0.5) * Math.sqrt(n) * 0.4,
          y: cy,
          z: cz + (Math.random() - 0.5) * Math.sqrt(n) * 0.4,
          vx: (Math.random() - 0.5) * 12,
          vy: 2 + Math.random() * 5,
          vz: (Math.random() - 0.5) * 12,
          life: 2 + Math.random() * 2.5,
          size0: 2,
          size1: 6 + Math.random() * 4,
          c0: 0xcdb48f,
          c1: 0xd8c4a0,
          a0: 0.85,
          a1: 0,
          drag: 1.5,
          grav: 0.6,
        });
      }
      this.onImpact?.(cx, cy, cz, n);
    }
  }

  private dispose(b: Body) {
    this.group.remove(b.mesh);
    (b.mesh.children[0] as THREE.Mesh).geometry.dispose();
  }

  clear() {
    for (const b of this.bodies) this.dispose(b);
    this.bodies.length = 0;
  }
}
