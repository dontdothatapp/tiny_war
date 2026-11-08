// Dense little voxel grid used to author prefabs (buildings, vehicles, the
// helicopter...). Index = x + z*sx + y*sx*sz (same layout the mesher pads).

export const FORCE_AIR = 255;

export class VoxModel {
  data: Uint8Array;
  constructor(
    public sx: number,
    public sy: number,
    public sz: number,
  ) {
    this.data = new Uint8Array(sx * sy * sz);
  }

  inside(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  set(x: number, y: number, z: number, m: number) {
    x = Math.round(x);
    y = Math.round(y);
    z = Math.round(z);
    if (!this.inside(x, y, z)) return;
    this.data[x + z * this.sx + y * this.sx * this.sz] = m;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    return this.data[x + z * this.sx + y * this.sx * this.sz];
  }

  /** Inclusive box fill. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number | ((x: number, y: number, z: number) => number)) {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(this.sx - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(this.sy - 1, Math.max(y0, y1));
    const az = Math.max(0, Math.min(z0, z1));
    const bz = Math.min(this.sz - 1, Math.max(z0, z1));
    for (let y = ay; y <= by; y++)
      for (let z = az; z <= bz; z++)
        for (let x = ax; x <= bx; x++) {
          const v = typeof m === 'number' ? m : m(x, y, z);
          if (v >= 0) this.data[x + z * this.sx + y * this.sx * this.sz] = v;
        }
  }

  /** Walls only (no top/bottom). */
  shell(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number, t = 1) {
    this.box(x0, y0, z0, x1, y1, z0 + t - 1, m);
    this.box(x0, y0, z1 - t + 1, x1, y1, z1, m);
    this.box(x0, y0, z0, x0 + t - 1, y1, z1, m);
    this.box(x1 - t + 1, y0, z0, x1, y1, z1, m);
  }

  /** Vertical cylinder centred at (cx, cz). */
  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, m: number | ((x: number, y: number, z: number) => number), hollow = false) {
    const r2 = r * r;
    const ri2 = (r - 1.2) * (r - 1.2);
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 > r2) continue;
        if (hollow && d2 < ri2) continue;
        for (let y = y0; y <= y1; y++) {
          const v = typeof m === 'number' ? m : m(x, y, z);
          if (v >= 0) this.set(x, y, z, v);
        }
      }
  }

  /** Cylinder along X or Z axis. */
  hcylinder(axis: 'x' | 'z', a0: number, a1: number, cy: number, cc: number, r: number, m: number) {
    const r2 = r * r;
    for (let a = a0; a <= a1; a++)
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
        for (let c = Math.floor(cc - r); c <= Math.ceil(cc + r); c++) {
          if ((y - cy) ** 2 + (c - cc) ** 2 > r2) continue;
          if (axis === 'x') this.set(a, y, c, m);
          else this.set(c, y, a, m);
        }
  }

  sphere(cx: number, cy: number, cz: number, r: number, m: number, upperOnly = false) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      if (upperOnly && y < cy) continue;
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r2) this.set(x, y, z, m);
    }
  }

  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number, thick = 0) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0))) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const z = z0 + (z1 - z0) * t;
      if (thick <= 0) this.set(x, y, z, m);
      else this.box(Math.round(x - thick), Math.round(y - thick), Math.round(z - thick), Math.round(x + thick), Math.round(y + thick), Math.round(z + thick), m);
    }
  }

  replace(from: number, to: number) {
    for (let i = 0; i < this.data.length; i++) if (this.data[i] === from) this.data[i] = to;
  }

  /** Rotate around Y by quarter turns (0..3). */
  rotated(q: number): VoxModel {
    q = ((q % 4) + 4) % 4;
    if (q === 0) return this;
    const nx = q % 2 ? this.sz : this.sx;
    const nz = q % 2 ? this.sx : this.sz;
    const out = new VoxModel(nx, this.sy, nz);
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const m = this.data[x + z * this.sx + y * this.sx * this.sz];
          if (!m) continue;
          let tx: number, tz: number;
          if (q === 1) {
            tx = this.sz - 1 - z;
            tz = x;
          } else if (q === 2) {
            tx = this.sx - 1 - x;
            tz = this.sz - 1 - z;
          } else {
            tx = z;
            tz = this.sx - 1 - x;
          }
          out.data[tx + tz * nx + y * nx * nz] = m;
        }
    return out;
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] && this.data[i] !== FORCE_AIR) n++;
    return n;
  }

  /** Blit another model into this one at offset. */
  blit(o: VoxModel, ox: number, oy: number, oz: number) {
    for (let y = 0; y < o.sy; y++)
      for (let z = 0; z < o.sz; z++)
        for (let x = 0; x < o.sx; x++) {
          const m = o.data[x + z * o.sx + y * o.sx * o.sz];
          if (m) this.set(x + ox, y + oy, z + oz, m);
        }
  }
}
