import * as THREE from 'three';
import { MATERIALS, M } from '../voxel/materials';
import { VoxelWorld } from '../voxel/world';

// Physical voxel debris: little lit cubes that bounce on the voxel world,
// tumble, settle and occasionally turn into rubble voxels.

const STRIDE = 12; // x y z vx vy vz rx ry spin life size mat

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  private D: Float32Array;
  private n = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  /** Max rubble voxels written to the world per frame (bounds remeshing). */
  rubbleBudget = 30;
  private rubbleThisFrame = 0;

  constructor(
    private world: VoxelWorld,
    private cap = 3500,
  ) {
    this.D = new Float32Array(cap * STRIDE);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
  }

  get count() {
    return this.n;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, mat: number, size = 1, life = 4 + Math.random() * 3) {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap);
    const o = i * STRIDE;
    const D = this.D;
    D[o] = x;
    D[o + 1] = y;
    D[o + 2] = z;
    D[o + 3] = vx;
    D[o + 4] = vy;
    D[o + 5] = vz;
    D[o + 6] = Math.random() * 6;
    D[o + 7] = Math.random() * 6;
    D[o + 8] = (Math.random() - 0.5) * 14;
    D[o + 9] = life;
    D[o + 10] = size;
    D[o + 11] = mat;
    this.setColor(i, mat);
  }

  private setColor(i: number, mat: number) {
    const def = MATERIALS[mat] ?? MATERIALS[M.RUBBLE];
    this.col.setHex(def.color);
    const j = 0.85 + Math.random() * 0.25;
    this.col.multiplyScalar(j);
    this.mesh.setColorAt(i, this.col);
  }

  update(dt: number) {
    const D = this.D;
    const w = this.world;
    this.rubbleThisFrame = 0;
    let i = 0;
    while (i < this.n) {
      const o = i * STRIDE;
      D[o + 9] -= dt;
      if (D[o + 9] <= 0) {
        this.remove(i);
        continue;
      }
      // integrate
      D[o + 4] -= 30 * dt;
      const px = D[o],
        py = D[o + 1],
        pz = D[o + 2];
      let nx = px + D[o + 3] * dt;
      let ny = py + D[o + 4] * dt;
      let nz = pz + D[o + 5] * dt;
      let resting = false;
      if (w.solidAt(px, ny, pz)) {
        if (D[o + 4] < 0) {
          ny = Math.floor(py) + 0.01;
          if (ny < py - 1) ny = py;
          D[o + 4] *= -0.25;
          D[o + 3] *= 0.55;
          D[o + 5] *= 0.55;
          D[o + 8] *= 0.6;
          if (Math.abs(D[o + 4]) < 2) {
            D[o + 4] = 0;
            resting = true;
          }
        } else {
          ny = py;
          D[o + 4] = 0;
        }
      }
      if (w.solidAt(nx, ny, pz)) {
        nx = px;
        D[o + 3] *= -0.3;
      }
      if (w.solidAt(nx, ny, nz)) {
        nz = pz;
        D[o + 5] *= -0.3;
      }
      D[o] = nx;
      D[o + 1] = ny;
      D[o + 2] = nz;
      if (resting) {
        D[o + 6] = Math.round(D[o + 6] / (Math.PI / 2)) * (Math.PI / 2);
        D[o + 7] = Math.round(D[o + 7] / (Math.PI / 2)) * (Math.PI / 2);
        // big settled pieces become rubble voxels
        const sp = Math.abs(D[o + 3]) + Math.abs(D[o + 5]);
        if (sp < 1.5 && D[o + 10] >= 0.9 && this.rubbleThisFrame < this.rubbleBudget && Math.random() < 0.35) {
          const vx = Math.floor(nx),
            vy = Math.floor(ny),
            vz = Math.floor(nz);
          if (w.get(vx, vy, vz) === 0 && w.get(vx, vy - 1, vz) !== 0) {
            const m = D[o + 11];
            w.set(vx, vy, vz, MATERIALS[m]?.soft ? M.RUBBLE : m === M.FUEL_TANK ? M.WRECK : m);
            this.rubbleThisFrame++;
            this.remove(i);
            continue;
          }
        }
      } else {
        D[o + 6] += D[o + 8] * dt;
        D[o + 7] += D[o + 8] * 0.7 * dt;
      }
      // render
      const life = D[o + 9];
      const sz = D[o + 10] * Math.min(1, life * 1.5);
      this.e.set(D[o + 6], D[o + 7], 0);
      this.q.setFromEuler(this.e);
      this.v.set(nx, ny + sz * 0.5, nz);
      this.s.set(sz, sz, sz);
      this.m4.compose(this.v, this.q, this.s);
      this.m4.toArray(this.mesh.instanceMatrix.array, i * 16);
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private remove(i: number) {
    const last = --this.n;
    if (i !== last) {
      this.D.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
      const c = this.mesh.instanceColor!.array as Float32Array;
      c[i * 3] = c[last * 3];
      c[i * 3 + 1] = c[last * 3 + 1];
      c[i * 3 + 2] = c[last * 3 + 2];
    }
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}
