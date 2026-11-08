import { M, MAT_TERRAIN } from './materials';

export const CS = 32; // chunk size (cubic)
export const CS_SHIFT = 5;
export const CS_MASK = 31;
export const CHUNK_VOL = CS * CS * CS;

export class Chunk {
  data: Uint8Array | null = null; // null until generated
  generated = false;
  modified = false; // changed after generation (cannot be evicted)
  dirty = true; // mesh is stale
  solidCount = 0;
  lastTouch = 0;
  constructor(
    public cx: number,
    public cy: number,
    public cz: number,
  ) {}
}

/** Fills a freshly allocated chunk. Implemented by the world generator. */
export interface ChunkFiller {
  fill(chunk: Chunk, data: Uint8Array): void;
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  mat: number;
  dist: number;
  nx: number;
  ny: number;
  nz: number;
}

export const vidx = (x: number, y: number, z: number) => x | (z << CS_SHIFT) | (y << (CS_SHIFT * 2));

/**
 * Sparse, lazily generated voxel world. Chunks are produced on first access
 * from the procedural generator, so the map can be large while memory only
 * grows around where the player actually goes.
 */
export class VoxelWorld {
  readonly ncx: number;
  readonly ncy: number;
  readonly ncz: number;
  readonly chunks: Chunk[];
  filler: ChunkFiller | null = null;
  frame = 0;
  generatedCount = 0;
  /** Called whenever a voxel changes (for listeners like structure tracking). */
  onDirtyChunk: ((c: Chunk) => void) | null = null;

  constructor(
    public readonly sx: number,
    public readonly sy: number,
    public readonly sz: number,
  ) {
    this.ncx = Math.ceil(sx / CS);
    this.ncy = Math.ceil(sy / CS);
    this.ncz = Math.ceil(sz / CS);
    this.chunks = new Array(this.ncx * this.ncy * this.ncz);
    for (let cy = 0; cy < this.ncy; cy++)
      for (let cz = 0; cz < this.ncz; cz++)
        for (let cx = 0; cx < this.ncx; cx++) this.chunks[this.ckey(cx, cy, cz)] = new Chunk(cx, cy, cz);
  }

  ckey(cx: number, cy: number, cz: number): number {
    return cx + cz * this.ncx + cy * this.ncx * this.ncz;
  }

  chunkAt(cx: number, cy: number, cz: number): Chunk | undefined {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.ncx || cy >= this.ncy || cz >= this.ncz) return undefined;
    return this.chunks[this.ckey(cx, cy, cz)];
  }

  /** Make sure a chunk's voxel data exists. Returns null for all-air chunks. */
  ensure(c: Chunk): Uint8Array | null {
    c.lastTouch = this.frame;
    if (!c.generated) {
      const data = new Uint8Array(CHUNK_VOL);
      this.filler?.fill(c, data);
      let n = 0;
      for (let i = 0; i < CHUNK_VOL; i++) if (data[i]) n++;
      c.solidCount = n;
      c.data = n > 0 ? data : null;
      c.generated = true;
      c.dirty = true;
      this.generatedCount++;
    }
    return c.data;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return M.BEDROCK;
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz || y >= this.sy) return 0;
    const c = this.chunks[this.ckey(x >> CS_SHIFT, y >> CS_SHIFT, z >> CS_SHIFT)];
    const d = c.generated ? c.data : this.ensure(c);
    if (!d) return 0;
    return d[vidx(x & CS_MASK, y & CS_MASK, z & CS_MASK)];
  }

  /** Float-coordinate solidity test. */
  solidAt(x: number, y: number, z: number): boolean {
    return this.get(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;
  }

  set(x: number, y: number, z: number, m: number): void {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunks[this.ckey(x >> CS_SHIFT, y >> CS_SHIFT, z >> CS_SHIFT)];
    if (!c.generated) this.ensure(c);
    if (!c.data) {
      if (m === 0) return;
      c.data = new Uint8Array(CHUNK_VOL);
    }
    const lx = x & CS_MASK;
    const ly = y & CS_MASK;
    const lz = z & CS_MASK;
    const i = vidx(lx, ly, lz);
    const old = c.data[i];
    if (old === m) return;
    if (old === 0) c.solidCount++;
    else if (m === 0) c.solidCount--;
    c.data[i] = m;
    c.modified = true;
    this.markDirty(c);
    // Neighbouring chunk meshes see this voxel too (faces + AO).
    if (lx === 0) this.markDirtyAt(x - 1, y, z);
    else if (lx === CS_MASK) this.markDirtyAt(x + 1, y, z);
    if (ly === 0) this.markDirtyAt(x, y - 1, z);
    else if (ly === CS_MASK) this.markDirtyAt(x, y + 1, z);
    if (lz === 0) this.markDirtyAt(x, y, z - 1);
    else if (lz === CS_MASK) this.markDirtyAt(x, y, z + 1);
  }

  private markDirtyAt(x: number, y: number, z: number) {
    const c = this.chunkAt(x >> CS_SHIFT, y >> CS_SHIFT, z >> CS_SHIFT);
    if (c) this.markDirty(c);
  }

  private markDirty(c: Chunk) {
    if (!c.dirty) {
      c.dirty = true;
      this.onDirtyChunk?.(c);
    }
  }

  /** Highest solid voxel y in a column, or -1. */
  topY(x: number, z: number, fromY = this.sy - 1): number {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return -1;
    for (let y = Math.min(fromY, this.sy - 1); y >= 0; y--) {
      // skip empty chunks fast
      const c = this.chunks[this.ckey(x >> CS_SHIFT, y >> CS_SHIFT, z >> CS_SHIFT)];
      const d = c.generated ? c.data : this.ensure(c);
      if (!d) {
        y = (y & ~CS_MASK); // loop decrement moves into chunk below
        continue;
      }
      if (d[vidx(x & CS_MASK, y & CS_MASK, z & CS_MASK)]) return y;
    }
    return -1;
  }

  isTerrain(m: number): boolean {
    return MAT_TERRAIN[m] === 1;
  }

  /** Amanatides-Woo voxel traversal. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out?: RayHit): RayHit | null {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
    let nx = 0,
      ny = 0,
      nz = 0;
    let t = 0;
    while (t <= maxDist) {
      if (y >= this.sy && dy >= 0) return null;
      const m = this.get(x, y, z);
      if (m !== 0) {
        const h = out ?? ({} as RayHit);
        h.x = x;
        h.y = y;
        h.z = z;
        h.mat = m;
        h.dist = t;
        h.nx = nx;
        h.ny = ny;
        h.nz = nz;
        return h;
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
        nx = -stepX;
        ny = 0;
        nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
        nx = 0;
        ny = -stepY;
        nz = 0;
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        nx = 0;
        ny = 0;
        nz = -stepZ;
      }
    }
    return null;
  }

  /** Line of sight between two points (true = clear). */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skipStart = 0, skipEnd = 0): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    const ux = dx / d,
      uy = dy / d,
      uz = dz / d;
    const total = d - skipStart - skipEnd;
    if (total <= 0) return true;
    return this.raycast(ax + ux * skipStart, ay + uy * skipStart, az + uz * skipStart, ux, uy, uz, total) === null;
  }

  /** Drop unmodified, far-away chunk data to bound memory. */
  evict(centerX: number, centerZ: number, keepRadius: number, maxGenerated: number): Chunk[] {
    const dropped: Chunk[] = [];
    if (this.generatedCount <= maxGenerated) return dropped;
    const r2 = (keepRadius / CS) ** 2;
    const ccx = centerX / CS;
    const ccz = centerZ / CS;
    for (const c of this.chunks) {
      if (!c.generated || c.modified) continue;
      const dx = c.cx + 0.5 - ccx;
      const dz = c.cz + 0.5 - ccz;
      if (dx * dx + dz * dz > r2) {
        c.generated = false;
        c.data = null;
        c.dirty = true;
        this.generatedCount--;
        dropped.push(c);
      }
    }
    return dropped;
  }
}
