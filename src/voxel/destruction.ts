import * as THREE from 'three';
import { DebrisSystem } from '../fx/debris';
import { BodySystem } from './bodies';
import { M, MAT_HARD, MAT_TERRAIN, MATERIALS } from './materials';
import { VoxelWorld } from './world';

export interface BBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface CarveListener {
  beforeCarve(b: BBox): void;
  afterCarve(b: BBox): void;
}

export interface ExplodeOpts {
  /** Multiplier on debris count. */
  debris?: number;
  /** Scorch terrain around the crater. */
  scorch?: boolean;
  /** Initial debris speed scale. */
  speed?: number;
}

const SEARCH_LIMIT = 16000;

/**
 * Voxel destruction: crater carving with material hardness, scorch marks,
 * debris spawning, and structural connectivity (anything no longer attached
 * to the ground breaks off and falls).
 */
export class Destruction {
  listener: CarveListener | null = null;
  /** Called with each flammable voxel position that got blasted (for fires). */
  onFlammable: ((x: number, y: number, z: number) => void) | null = null;
  stats = { removed: 0, detached: 0 };

  constructor(
    private world: VoxelWorld,
    private debris: DebrisSystem,
    private bodies: BodySystem,
  ) {}

  explode(cx: number, cy: number, cz: number, radius: number, power: number, opts: ExplodeOpts = {}): number {
    const w = this.world;
    const r = radius;
    const box: BBox = {
      x0: Math.floor(cx - r - 2),
      y0: Math.max(0, Math.floor(cy - r - 2)),
      z0: Math.floor(cz - r - 2),
      x1: Math.ceil(cx + r + 2),
      y1: Math.ceil(cy + r + 2),
      z1: Math.ceil(cz + r + 2),
    };
    this.listener?.beforeCarve(box);
    const vol = (4 / 3) * Math.PI * r * r * r;
    const debrisP = Math.min(1, ((opts.debris ?? 1) * 110) / Math.max(1, vol));
    const speed = opts.speed ?? 1;
    let removed = 0;
    let flamCount = 0;
    const r2 = r * r;
    for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.ceil(cy + r); y++)
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x + 0.5 - cx,
            dy = y + 0.5 - cy,
            dz = z + 0.5 - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const m = w.get(x, y, z);
          if (m === 0) continue;
          const falloff = 1 - d2 / r2;
          const energy = power * falloff * (0.75 + Math.random() * 0.5);
          if (energy < MAT_HARD[m]) continue;
          w.set(x, y, z, 0);
          removed++;
          if (MATERIALS[m].flammable && flamCount < 6 && Math.random() < 0.3) {
            flamCount++;
            this.onFlammable?.(x, y, z);
          }
          if (Math.random() < debrisP) {
            const d = Math.sqrt(d2) + 0.001;
            const sp = (10 + Math.random() * 18) * speed * (0.4 + falloff);
            this.debris.spawn(
              x + 0.5,
              y + 0.5,
              z + 0.5,
              (dx / d) * sp + (Math.random() - 0.5) * 6,
              Math.abs(dy / d) * sp * 0.6 + 8 + Math.random() * 14 * speed,
              (dz / d) * sp + (Math.random() - 0.5) * 6,
              m,
              Math.random() < 0.6 ? 1 : 0.55,
            );
          }
        }
    if (opts.scorch !== false) this.scorch(cx, cy, cz, r + 1.8);
    this.stats.removed += removed;
    if (removed > 0) this.detachFloating(cx, cy, cz, r);
    this.listener?.afterCarve(box);
    return removed;
  }

  private scorch(cx: number, cy: number, cz: number, r: number) {
    const w = this.world;
    const r2 = r * r;
    for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.ceil(cy + r); y++)
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 + (z + 0.5 - cz) ** 2;
          if (d2 > r2) continue;
          const m = w.get(x, y, z);
          if (m === M.SAND || m === M.SAND_DARK || m === M.GREEN_GRASS || m === M.ROAD_LINE || m === M.ROAD_EDGE) {
            if (w.get(x, y + 1, z) === 0 && Math.random() < 0.8) w.set(x, y, z, M.SCORCH);
          } else if ((m === M.ASPHALT || m === M.PAD) && w.get(x, y + 1, z) === 0 && Math.random() < 0.5) {
            w.set(x, y, z, M.SCORCH);
          }
        }
  }

  /** Find non-terrain voxel islands near the blast that lost ground contact. */
  detachFloating(cx: number, cy: number, cz: number, r: number) {
    const w = this.world;
    const S = w.sx;
    const key = (x: number, y: number, z: number) => x + z * S + y * S * S;
    const visited = new Set<number>();
    const R = r + 1.5;
    const seeds: number[] = [];
    for (let y = Math.max(1, Math.floor(cy - R)); y <= Math.ceil(cy + R); y++)
      for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
        for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
          const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 + (z + 0.5 - cz) ** 2;
          if (d2 > R * R || d2 < (r - 1.5) ** 2) continue;
          const m = w.get(x, y, z);
          if (m === 0 || MAT_TERRAIN[m]) continue;
          seeds.push(x, y, z);
        }
    const stack: number[] = [];
    const comp: number[] = [];
    const compMats: number[] = [];
    for (let s = 0; s < seeds.length; s += 3) {
      const sx = seeds[s],
        sy = seeds[s + 1],
        sz = seeds[s + 2];
      if (visited.has(key(sx, sy, sz))) continue;
      if (w.get(sx, sy, sz) === 0) continue;
      stack.length = 0;
      comp.length = 0;
      compMats.length = 0;
      stack.push(sx, sy, sz);
      visited.add(key(sx, sy, sz));
      let grounded = false;
      while (stack.length) {
        const z = stack.pop()!,
          y = stack.pop()!,
          x = stack.pop()!;
        const m = w.get(x, y, z);
        comp.push(x, y, z);
        compMats.push(m);
        if (comp.length / 3 > SEARCH_LIMIT) {
          grounded = true;
          break;
        }
        // push order: up first so "down" is popped first (ground is usually below)
        const nb = [x, y + 1, z, x + 1, y, z, x - 1, y, z, x, y, z + 1, x, y, z - 1, x, y - 1, z];
        let found = false;
        for (let k = 0; k < 18; k += 3) {
          const nx = nb[k],
            ny = nb[k + 1],
            nz = nb[k + 2];
          if (ny < 1) {
            found = true;
            break;
          }
          const nm = w.get(nx, ny, nz);
          if (nm === 0) continue;
          if (MAT_TERRAIN[nm]) {
            found = true;
            break;
          }
          const kk = key(nx, ny, nz);
          if (visited.has(kk)) continue;
          visited.add(kk);
          stack.push(nx, ny, nz);
        }
        if (found) {
          grounded = true;
          break;
        }
      }
      if (grounded) {
        // Mark the whole remaining stack as visited (already done) and move on.
        continue;
      }
      // Detach: remove from world and spawn falling body
      const n = comp.length / 3;
      for (let i = 0; i < n; i++) w.set(comp[i * 3], comp[i * 3 + 1], comp[i * 3 + 2], 0);
      this.stats.detached += n;
      const dirX = 0,
        dirZ = 0;
      const imp = new THREE.Vector3(dirX + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, dirZ + (Math.random() - 0.5) * 3);
      this.splitAndSpawn(comp, compMats, imp);
    }
  }

  /** Large components are split into blocks so they break up as they fall. */
  splitAndSpawn(comp: number[], mats: number[], imp: THREE.Vector3, block = 10) {
    const n = mats.length;
    if (n <= 600) {
      this.bodies.spawn(comp, mats, imp);
      return;
    }
    const groups = new Map<number, { c: number[]; m: number[] }>();
    for (let i = 0; i < n; i++) {
      const x = comp[i * 3],
        y = comp[i * 3 + 1],
        z = comp[i * 3 + 2];
      const k = Math.floor(x / block) + Math.floor(y / block) * 1000 + Math.floor(z / block) * 1000000;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { c: [], m: [] }));
      g.c.push(x, y, z);
      g.m.push(mats[i]);
    }
    for (const g of groups.values()) {
      const v = imp.clone();
      v.x += (Math.random() - 0.5) * 4;
      v.z += (Math.random() - 0.5) * 4;
      this.bodies.spawn(g.c, g.m, v);
    }
  }

  /** Structural failure: everything non-terrain in the box falls apart. */
  collapse(b: BBox, push = 3) {
    const w = this.world;
    const comp: number[] = [];
    const mats: number[] = [];
    for (let y = Math.max(1, b.y0); y <= b.y1; y++)
      for (let z = b.z0; z <= b.z1; z++)
        for (let x = b.x0; x <= b.x1; x++) {
          const m = w.get(x, y, z);
          if (m === 0 || MAT_TERRAIN[m]) continue;
          comp.push(x, y, z);
          mats.push(m);
        }
    if (!mats.length) return;
    for (let i = 0; i < mats.length; i++) w.set(comp[i * 3], comp[i * 3 + 1], comp[i * 3 + 2], 0);
    this.stats.detached += mats.length;
    this.splitAndSpawn(comp, mats, new THREE.Vector3(0, push * 0.3, 0), 7);
  }
}
