import { BBox, CarveListener, Destruction } from '../voxel/destruction';
import { MAT_TERRAIN } from '../voxel/materials';
import { VoxelWorld } from '../voxel/world';
import type { StructureDef } from '../world/mapTypes';

export interface StructureState {
  def: StructureDef;
  initial: number; // -1 until first touched
  current: number;
  /** voxels in the load-bearing lower band */
  initialBase: number;
  currentBase: number;
  destroyed: boolean;
}

/** Fraction of the load-bearing band that can go before the structure fails. */
const BASE_FAIL = 0.8;

/**
 * Tracks voxel integrity of generated structures. Counts are initialised
 * lazily right before the first blast that touches a structure, so untouched
 * parts of the map never need to be generated.
 */
export class StructureTracker implements CarveListener {
  readonly states: StructureState[];
  private grid = new Map<number, number[]>();
  private pending = new Set<number>();
  onDestroyed: ((s: StructureState) => void) | null = null;

  constructor(
    private world: VoxelWorld,
    private destruction: Destruction,
    defs: StructureDef[],
  ) {
    this.states = defs.map((def) => ({ def, initial: -1, current: -1, initialBase: -1, currentBase: -1, destroyed: false }));
    for (const s of this.states) {
      const d = s.def;
      for (let gz = d.z0 >> 6; gz <= d.z1 >> 6; gz++)
        for (let gx = d.x0 >> 6; gx <= d.x1 >> 6; gx++) {
          const k = gx + gz * 1024;
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(d.id);
        }
    }
  }

  private query(b: BBox): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let gz = b.z0 >> 6; gz <= b.z1 >> 6; gz++)
      for (let gx = b.x0 >> 6; gx <= b.x1 >> 6; gx++) {
        const l = this.grid.get(gx + gz * 1024);
        if (!l) continue;
        for (const id of l) {
          if (seen.has(id)) continue;
          seen.add(id);
          const d = this.states[id].def;
          if (d.x1 < b.x0 || d.x0 > b.x1 || d.y1 < b.y0 || d.y0 > b.y1 || d.z1 < b.z0 || d.z0 > b.z1) continue;
          out.push(id);
        }
      }
    return out;
  }

  /** Returns [total, lowerBand] non-terrain voxel counts. */
  private count(d: StructureDef): [number, number] {
    const w = this.world;
    const band = d.y0 + Math.max(4, Math.round((d.y1 - d.y0) * 0.4));
    let n = 0,
      nb = 0;
    for (let y = d.y0; y <= d.y1; y++)
      for (let z = d.z0; z <= d.z1; z++)
        for (let x = d.x0; x <= d.x1; x++) {
          const m = w.get(x, y, z);
          if (m !== 0 && !MAT_TERRAIN[m]) {
            n++;
            if (y <= band) nb++;
          }
        }
    return [n, nb];
  }

  beforeCarve(b: BBox): void {
    for (const id of this.query(b)) {
      const s = this.states[id];
      if (s.initial < 0) {
        const [n, nb] = this.count(s.def);
        s.initial = s.current = Math.max(1, n);
        s.initialBase = s.currentBase = Math.max(1, nb);
      }
    }
  }

  afterCarve(b: BBox): void {
    for (const id of this.query(b)) this.pending.add(id);
  }

  /** Re-count touched structures (deferred a frame so falling bodies have left). */
  update() {
    if (!this.pending.size) return;
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      const s = this.states[id];
      if (s.destroyed || s.initial < 0) continue;
      [s.current, s.currentBase] = this.count(s.def);
      const baseFail = s.def.collapseAt > 0 && s.currentBase / s.initialBase <= BASE_FAIL;
      if (s.current / s.initial <= s.def.collapseAt || s.current < 6 || baseFail) {
        s.destroyed = true;
        if (s.def.collapseAt > 0) this.destruction.collapse(s.def);
        this.onDestroyed?.(s);
      }
    }
  }

  integrity(id: number): number {
    const s = this.states[id];
    if (s.destroyed) return 0;
    if (s.initial < 0) return 1;
    const a = (s.current / s.initial - s.def.collapseAt) / (1 - s.def.collapseAt);
    const b = (s.currentBase / s.initialBase - BASE_FAIL) / (1 - BASE_FAIL);
    return Math.max(0, Math.min(1, a, b));
  }
}
