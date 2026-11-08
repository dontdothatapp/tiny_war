import * as THREE from 'three';
import { buildPaddedChunk, greedyMesh, meshDataToGeometry } from './mesher';
import { createVoxelMaterial } from './voxelMaterial';
import { CS, Chunk, VoxelWorld } from './world';

/**
 * Streams chunk meshes in a radius around a focus point. Meshing has a per
 * frame time budget; dirty chunks closest to the focus are rebuilt first.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly material = createVoxelMaterial();
  private meshes = new Map<Chunk, THREE.Mesh>();
  private queue: Chunk[] = [];
  viewRadius = 230;
  budgetMs = 7;
  meshedThisFrame = 0;

  constructor(private world: VoxelWorld) {
    this.group.name = 'chunks';
  }

  /** Synchronously mesh everything around a point (used during loading). */
  prime(fx: number, fz: number, radius = this.viewRadius) {
    this.update(fx, fz, Infinity, radius);
  }

  update(fx: number, fz: number, budgetMs = this.budgetMs, radius = this.viewRadius) {
    const w = this.world;
    const r = radius / CS;
    const ccx = fx / CS;
    const ccz = fz / CS;
    const minX = Math.max(0, Math.floor(ccx - r));
    const maxX = Math.min(w.ncx - 1, Math.floor(ccx + r));
    const minZ = Math.max(0, Math.floor(ccz - r));
    const maxZ = Math.min(w.ncz - 1, Math.floor(ccz + r));
    const q = this.queue;
    q.length = 0;
    for (let cz = minZ; cz <= maxZ; cz++)
      for (let cx = minX; cx <= maxX; cx++) {
        const dx = cx + 0.5 - ccx;
        const dz = cz + 0.5 - ccz;
        if (dx * dx + dz * dz > r * r) continue;
        for (let cy = 0; cy < w.ncy; cy++) {
          const c = w.chunkAt(cx, cy, cz)!;
          if (c.dirty || !c.generated) q.push(c);
        }
      }
    if (q.length) {
      q.sort((a, b) => {
        const da = (a.cx + 0.5 - ccx) ** 2 + (a.cz + 0.5 - ccz) ** 2;
        const db = (b.cx + 0.5 - ccx) ** 2 + (b.cz + 0.5 - ccz) ** 2;
        return da - db;
      });
      const t0 = performance.now();
      this.meshedThisFrame = 0;
      for (const c of q) {
        this.rebuild(c);
        this.meshedThisFrame++;
        if (performance.now() - t0 > budgetMs) break;
      }
    }
    // drop meshes far outside the view radius
    const far = (r + 2) * (r + 2);
    for (const [c, mesh] of this.meshes) {
      const dx = c.cx + 0.5 - ccx;
      const dz = c.cz + 0.5 - ccz;
      if (dx * dx + dz * dz > far) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(c);
        c.dirty = true; // needs a rebuild when we come back
      }
    }
  }

  private rebuild(c: Chunk) {
    const w = this.world;
    w.ensure(c);
    c.dirty = false;
    let mesh = this.meshes.get(c);
    // Empty chunk with no exposed faces? (still have to check neighbours' faces: only own voxels emit faces)
    if (!c.data) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(c);
      }
      return;
    }
    const vol = buildPaddedChunk(w, c.cx, c.cy, c.cz);
    const md = greedyMesh(vol, CS, CS, CS);
    if (!md) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(c);
      }
      return;
    }
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = meshDataToGeometry(md);
    } else {
      mesh = new THREE.Mesh(meshDataToGeometry(md), this.material);
      mesh.position.set(c.cx * CS, c.cy * CS, c.cz * CS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.meshes.set(c, mesh);
      this.group.add(mesh);
    }
  }

  /** Called when chunk data was evicted so its mesh goes too. */
  forget(c: Chunk) {
    const mesh = this.meshes.get(c);
    if (mesh) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(c);
    }
  }

  get meshCount() {
    return this.meshes.size;
  }
}
