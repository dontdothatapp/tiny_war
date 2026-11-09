import { RNG, clamp, fbm, lerp, smoothstep, valueNoise } from '../core/rng';
import { M, MAT_B, MAT_G, MAT_R } from '../voxel/materials';
import { CS, Chunk, ChunkFiller, vidx } from '../voxel/world';
import type { BaseDef, BaseKind, FarpDef, MapData, ObjectiveRef, PickupSpawn, RescueSpawn, RoadSeg, Stamp, StructureDef, Team, TurretSpawn, TurretType } from './mapTypes';
import * as P from './prefabs';
import { FORCE_AIR, VoxModel } from './voxModel';

export const WORLD_HEIGHT = 64;
const OCC = 4; // occupancy grid cell size

const CODENAMES = ['KESTREL', 'VIPER', 'ANVIL', 'SCORPION', 'MIRAGE', 'COBALT', 'JACKAL', 'GRANITE', 'FALCON', 'TALON', 'EMBER', 'ONYX', 'SABLE', 'DUNE', 'RAPTOR', 'HAVOC', 'IRONSIDE', 'BASILISK'];
const KIND_LABEL: Record<BaseKind, string> = {
  radar: 'RADAR SITE',
  command: 'COMMAND BUNKER',
  sam: 'SAM BATTERY',
  depot: 'FUEL DEPOT',
  factory: 'ARMS FACTORY',
};

interface Site {
  x: number;
  z: number;
  r: number;
  h: number;
  kind: 'farp' | 'base' | 'town' | 'oasis' | 'rescue';
}

export function sectorSize(sector: number): number {
  return Math.min(2048, 1024 + (sector - 1) * 256);
}

/**
 * Builds a whole sector: heightmap, surface materials, roads and a list of
 * voxel stamps. Voxels are only rasterised per chunk on demand (fill()).
 */
export class MapGenerator implements ChunkFiller {
  readonly S: number;
  readonly rng: RNG;
  readonly heights: Uint8Array;
  readonly surface: Uint8Array;
  private hf: Float32Array;
  private rockMask: Uint8Array;
  private occ: Uint8Array;
  private bigOcc: Uint8Array;
  private occN: number;
  readonly stamps: Stamp[] = [];
  private buckets: number[][];
  private nb: number;
  readonly structures: StructureDef[] = [];
  readonly turrets: TurretSpawn[] = [];
  readonly pickups: PickupSpawn[] = [];
  readonly rescues: RescueSpawn[] = [];
  readonly bases: BaseDef[] = [];
  readonly roads: RoadSeg[] = [];
  farp!: FarpDef;
  private sites: Site[] = [];

  constructor(
    readonly seed: number,
    readonly sector: number,
  ) {
    this.S = sectorSize(sector);
    this.rng = new RNG(seed * 7919 + sector * 104729);
    const S = this.S;
    this.heights = new Uint8Array(S * S);
    this.surface = new Uint8Array(S * S);
    this.hf = new Float32Array(S * S);
    this.rockMask = new Uint8Array(S * S);
    this.occN = Math.ceil(S / OCC);
    this.occ = new Uint8Array(this.occN * this.occN);
    this.bigOcc = new Uint8Array(this.occN * this.occN);
    this.nb = Math.ceil(S / CS);
    this.buckets = Array.from({ length: this.nb * this.nb }, () => []);
  }

  generate(): MapData {
    this.baseTerrain();
    this.placeSites();
    this.buildRoads();
    this.finalizeHeights();
    this.populateFarp();
    for (const s of this.sites) {
      if (s.kind === 'base') this.populateBase(s);
      else if (s.kind === 'town') this.populateTown(s);
      else if (s.kind === 'oasis') this.populateOasis(s);
      else if (s.kind === 'rescue') this.populateRescue(s);
    }
    this.populateRoadside();
    this.scatter();
    const mm = this.buildMinimap();
    return {
      seed: this.seed,
      sector: this.sector,
      size: this.S,
      height: WORLD_HEIGHT,
      heights: this.heights,
      surface: this.surface,
      stamps: this.stamps,
      structures: this.structures,
      turrets: this.turrets,
      pickups: this.pickups,
      rescues: this.rescues,
      bases: this.bases,
      farp: this.farp,
      roads: this.roads,
      minimap: mm.img,
      minimapRes: mm.res,
    };
  }

  // ------------------------------------------------------------------ terrain

  private baseTerrain() {
    const S = this.S;
    const sd = this.seed + this.sector * 31;
    const dir = this.rng.range(0, Math.PI);
    const ca = Math.cos(dir),
      sa = Math.sin(dir);
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        // dunes: stretched noise across wind direction
        const u = (x * ca + z * sa) * 0.022;
        const v = (-x * sa + z * ca) * 0.006;
        const dune = Math.pow(fbm(u, v, sd, 3), 1.6) * 7;
        const big = fbm(x * 0.0035, z * 0.0035, sd + 17, 3) * 8;
        let h = 9 + dune + big;
        // mesas / rocky outcrops
        const mesa = fbm(x * 0.006, z * 0.006, sd + 51, 4);
        if (mesa > 0.64) {
          const t = smoothstep(0.64, 0.69, mesa);
          const terr = Math.floor((mesa - 0.64) * 160) % 4 === 0 ? 0 : 1;
          h += t * (10 + (mesa - 0.64) * 120) + terr * t;
          if (t > 0.3) this.rockMask[x + z * S] = 1;
        }
        this.hf[x + z * S] = h;
      }
  }

  private placeSites() {
    const S = this.S;
    const r = this.rng;
    const margin = 90;
    const far = (x: number, z: number, d: number) => this.sites.every((s) => Math.hypot(s.x - x, s.z - z) > d + s.r);
    const hAt = (x: number, z: number) => this.hf[Math.floor(x) + Math.floor(z) * S];

    // FARP near the south edge
    const fx = r.range(S * 0.2, S * 0.8);
    const fz = S - 110;
    this.sites.push({ x: fx, z: fz, r: 60, h: Math.round(hAt(fx, fz)), kind: 'farp' });

    const tryPlace = (kind: Site['kind'], rad: number, minDist: number, minFarp: number, tries = 400): Site | null => {
      for (let i = 0; i < tries; i++) {
        const x = r.range(margin + rad, S - margin - rad);
        const z = r.range(margin + rad, S - margin - rad);
        if (Math.hypot(x - fx, z - fz) < minFarp) continue;
        if (!far(x, z, minDist)) continue;
        const s: Site = { x, z, r: rad, h: Math.round(hAt(x, z)), kind };
        this.sites.push(s);
        return s;
      }
      return null;
    };

    const nBases = clamp(2 + this.sector, 3, 7);
    for (let i = 0; i < nBases; i++) tryPlace('base', r.range(52, 64), 110, 300 + i * 20);
    const nTowns = 2 + Math.floor(S / 512);
    for (let i = 0; i < nTowns; i++) tryPlace('town', r.range(55, 80), 70, 160);
    const nOasis = r.int(2, 4);
    for (let i = 0; i < nOasis; i++) tryPlace('oasis', r.range(22, 34), 40, 120);
    const nRescue = Math.min(5, 2 + Math.floor(this.sector / 2));
    for (let i = 0; i < nRescue; i++) tryPlace('rescue', 18, 50, 220);
    // keep flattened sites at a sane level
    for (const s of this.sites) s.h = clamp(s.h, 9, 22);
  }

  private buildRoads() {
    const r = this.rng;
    const S = this.S;
    const nodes = this.sites.filter((s) => s.kind === 'farp' || s.kind === 'town' || s.kind === 'base');
    // Prim's MST
    const inTree = [0];
    const edges: [Site, Site][] = [];
    while (inTree.length < nodes.length) {
      let best = Infinity,
        bi = -1,
        bj = -1;
      for (const i of inTree)
        for (let j = 0; j < nodes.length; j++) {
          if (inTree.includes(j)) continue;
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
          if (d < best) {
            best = d;
            bi = i;
            bj = j;
          }
        }
      inTree.push(bj);
      edges.push([nodes[bi], nodes[bj]]);
    }
    for (const [a, b] of edges) this.roads.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, w: 5 });
    // a highway crossing the whole map
    const t0 = r.range(0.2, 0.8),
      t1 = r.range(0.2, 0.8);
    if (r.chance(0.5)) this.roads.push({ ax: -10, az: S * t0, bx: S + 10, bz: S * t1, w: 6 });
    else this.roads.push({ ax: S * t0, az: -10, bx: S * t1, bz: S + 10, w: 6 });
  }

  private finalizeHeights() {
    const S = this.S;
    const hf = this.hf;
    // flatten sites
    for (const s of this.sites) {
      const blend = 30;
      const R = s.r + blend;
      for (let z = Math.max(0, Math.floor(s.z - R)); z < Math.min(S, s.z + R); z++)
        for (let x = Math.max(0, Math.floor(s.x - R)); x < Math.min(S, s.x + R); x++) {
          const d = Math.hypot(x - s.x, z - s.z);
          const t = 1 - smoothstep(s.r, R, d);
          const i = x + z * S;
          hf[i] = lerp(hf[i], s.h, t);
          if (t > 0.5) this.rockMask[i] = 0;
        }
    }
    // roads: smooth profile along each segment (no asphalt inside compounds)
    const compounds = this.sites.filter((q) => q.kind === 'base' || q.kind === 'farp');
    const inCompound = (x: number, z: number) => compounds.some((q) => Math.abs(x - q.x) < q.r * 0.85 && Math.abs(z - q.z) < q.r * 0.85);
    for (const rd of this.roads) {
      const len = Math.hypot(rd.bx - rd.ax, rd.bz - rd.az);
      const n = Math.max(2, Math.ceil(len / 6));
      const prof: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = clamp(rd.ax + (rd.bx - rd.ax) * t, 0, S - 1);
        const z = clamp(rd.az + (rd.bz - rd.az) * t, 0, S - 1);
        prof.push(hf[Math.floor(x) + Math.floor(z) * S]);
      }
      // heavy smoothing + cap (roads go around mesas by cutting through)
      for (let pass = 0; pass < 6; pass++)
        for (let i = 1; i < n; i++) prof[i] = (prof[i - 1] + prof[i] * 2 + prof[i + 1]) / 4;
      for (let i = 0; i <= n; i++) prof[i] = Math.min(prof[i], 20);
      const hw = rd.w;
      const blend = 10;
      const minX = Math.max(0, Math.floor(Math.min(rd.ax, rd.bx) - hw - blend));
      const maxX = Math.min(S - 1, Math.ceil(Math.max(rd.ax, rd.bx) + hw + blend));
      const minZ = Math.max(0, Math.floor(Math.min(rd.az, rd.bz) - hw - blend));
      const maxZ = Math.min(S - 1, Math.ceil(Math.max(rd.az, rd.bz) + hw + blend));
      const dx = rd.bx - rd.ax,
        dz = rd.bz - rd.az;
      const l2 = dx * dx + dz * dz;
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++) {
          const t = clamp(((x - rd.ax) * dx + (z - rd.az) * dz) / l2, 0, 1);
          const px = rd.ax + dx * t,
            pz = rd.az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d > hw + blend) continue;
          const fi = t * n;
          const i0 = Math.floor(fi);
          const ph = lerp(prof[i0], prof[Math.min(n, i0 + 1)], fi - i0);
          const i = x + z * S;
          if (inCompound(x, z)) continue;
          const w = 1 - smoothstep(hw, hw + blend, d);
          hf[i] = lerp(hf[i], ph, w);
          if (d <= hw + 0.5) {
            this.rockMask[i] = 0;
            const along = t * Math.sqrt(l2);
            let mat: number = M.ASPHALT;
            if (d > hw - 0.8) mat = M.ROAD_EDGE;
            else if (d < 0.7 && Math.floor(along / 5) % 2 === 0) mat = M.ROAD_LINE;
            // don't overwrite a centre line of another road with edge
            if (this.surface[i] !== M.ROAD_LINE || mat === M.ROAD_LINE) this.surface[i] = mat;
            this.occSet(x, z, 2);
          }
        }
    }
    // integer heights + surface
    const sd = this.seed + 999;
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        const i = x + z * S;
        this.heights[i] = clamp(Math.round(hf[i]), 3, WORLD_HEIGHT - 20);
        if (this.surface[i]) continue;
        if (this.rockMask[i]) this.surface[i] = M.ROCK;
        else {
          const patch = valueNoise(x * 0.03, z * 0.03, sd);
          this.surface[i] = patch > 0.68 ? M.SAND_DARK : M.SAND;
        }
      }
  }

  // ------------------------------------------------------------------ stamping

  private occSet(x: number, z: number, v: number) {
    const ox = Math.floor(x / OCC),
      oz = Math.floor(z / OCC);
    if (ox < 0 || oz < 0 || ox >= this.occN || oz >= this.occN) return;
    const i = ox + oz * this.occN;
    if (this.occ[i] < v) this.occ[i] = v;
  }

  /** 0 = free, 1 = object, 2 = road */
  private occFree(x0: number, z0: number, x1: number, z1: number, allowRoad = false): boolean {
    if (x0 < 4 || z0 < 4 || x1 >= this.S - 4 || z1 >= this.S - 4) return false;
    for (let z = Math.floor(z0 / OCC); z <= Math.floor(z1 / OCC); z++)
      for (let x = Math.floor(x0 / OCC); x <= Math.floor(x1 / OCC); x++) {
        const v = this.occ[x + z * this.occN];
        if (v === 1 || (v === 2 && !allowRoad)) return false;
      }
    return true;
  }

  groundAt(x: number, z: number): number {
    x = clamp(Math.floor(x), 0, this.S - 1);
    z = clamp(Math.floor(z), 0, this.S - 1);
    return this.heights[x + z * this.S];
  }

  private footprintHeights(x: number, z: number, sx: number, sz: number) {
    let mn = 999,
      mx = 0;
    for (let zz = z; zz < z + sz; zz += 2)
      for (let xx = x; xx < x + sx; xx += 2) {
        const h = this.groundAt(xx, zz);
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    return { mn, mx };
  }

  /** Stamp a model with its min corner at (x, y, z). Returns the stamp bbox. */
  stamp(m: VoxModel, x: number, y: number, z: number, mark = true) {
    x = Math.round(x);
    y = Math.round(y);
    z = Math.round(z);
    const st: Stamp = { x, y, z, sx: m.sx, sy: m.sy, sz: m.sz, data: m.data };
    const idx = this.stamps.length;
    this.stamps.push(st);
    const cx0 = Math.max(0, Math.floor(x / CS)),
      cx1 = Math.min(this.nb - 1, Math.floor((x + m.sx - 1) / CS));
    const cz0 = Math.max(0, Math.floor(z / CS)),
      cz1 = Math.min(this.nb - 1, Math.floor((z + m.sz - 1) / CS));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.buckets[cx + cz * this.nb].push(idx);
    if (mark) for (let zz = z; zz < z + m.sz; zz += OCC) for (let xx = x; xx < x + m.sx; xx += OCC) this.occSet(xx, zz, 1);
    if (mark) this.occSet(x + m.sx - 1, z + m.sz - 1, 1);
    // big footprints are drawn on the minimap
    if (mark && m.sx * m.sz >= 100 && m.sy > 2)
      for (let zz = z; zz < z + m.sz; zz += OCC)
        for (let xx = x; xx < x + m.sx; xx += OCC) {
          const ox = Math.floor(xx / OCC),
            oz = Math.floor(zz / OCC);
          if (ox >= 0 && oz >= 0 && ox < this.occN && oz < this.occN) this.bigOcc[ox + oz * this.occN] = 1;
        }
    return { x0: x, y0: y, z0: z, x1: x + m.sx - 1, y1: y + m.sy - 1, z1: z + m.sz - 1 };
  }

  /** Stamp centred at (cx, cz) on the ground, optionally on top of flat ground only. */
  placeCentered(m: VoxModel, cx: number, cz: number, opts: { maxSlope?: number; allowRoad?: boolean; sink?: number; force?: boolean } = {}) {
    const x = Math.round(cx - m.sx / 2);
    const z = Math.round(cz - m.sz / 2);
    if (!opts.force && !this.occFree(x, z, x + m.sx - 1, z + m.sz - 1, opts.allowRoad)) return null;
    const { mn, mx } = this.footprintHeights(x, z, m.sx, m.sz);
    if (opts.maxSlope !== undefined && mx - mn > opts.maxSlope) return null;
    const y = mn - (opts.sink ?? 0);
    return this.stamp(m, x, y, z);
  }

  addStructure(bb: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }, kind: string, label: string, team: Team, reward: number, opts: { explosive?: number; collapseAt?: number; baseId?: number } = {}): number {
    const id = this.structures.length;
    this.structures.push({
      id,
      kind,
      label,
      team,
      ...bb,
      reward,
      explosive: opts.explosive ?? 0,
      collapseAt: opts.collapseAt ?? 0.5,
      baseId: opts.baseId ?? -1,
    });
    return id;
  }

  private addTurret(type: TurretType, x: number, z: number, baseId: number, yOverride?: number): number {
    const y = yOverride ?? this.groundAt(x, z);
    this.turrets.push({ type, x, y, z, yaw: this.rng.range(0, Math.PI * 2), baseId });
    return this.turrets.length - 1;
  }

  // ------------------------------------------------------------------ chunk fill

  fill(chunk: Chunk, data: Uint8Array): void {
    const S = this.S;
    const ox = chunk.cx * CS,
      oy = chunk.cy * CS,
      oz = chunk.cz * CS;
    for (let lz = 0; lz < CS; lz++) {
      const z = oz + lz;
      if (z >= S) break;
      for (let lx = 0; lx < CS; lx++) {
        const x = ox + lx;
        if (x >= S) break;
        const i = x + z * S;
        const h = this.heights[i];
        if (oy >= h) continue;
        const surf = this.surface[i];
        const rocky = surf === M.ROCK;
        const top = Math.min(h, oy + CS);
        for (let y = oy; y < top; y++) {
          let m: number;
          if (y === 0) m = M.BEDROCK;
          else if (y === h - 1) m = surf;
          else if (rocky) m = y % 4 === 0 ? M.ROCK_DARK : M.ROCK;
          else if (y >= h - 4) m = surf === M.ASPHALT || surf === M.ROAD_LINE || surf === M.ROAD_EDGE || surf === M.PAD || surf === M.PAD_MARK ? M.ROCK_DARK : M.SAND;
          else m = M.SAND_DARK;
          data[vidx(lx, y - oy, lz)] = m;
        }
      }
    }
    // stamps
    const list = this.buckets[chunk.cx + chunk.cz * this.nb];
    if (!list) return;
    for (const si of list) {
      const st = this.stamps[si];
      const x0 = Math.max(st.x, ox),
        x1 = Math.min(st.x + st.sx, ox + CS);
      const y0 = Math.max(st.y, oy),
        y1 = Math.min(st.y + st.sy, oy + CS);
      const z0 = Math.max(st.z, oz),
        z1 = Math.min(st.z + st.sz, oz + CS);
      if (x0 >= x1 || y0 >= y1 || z0 >= z1) continue;
      for (let y = y0; y < y1; y++)
        for (let z = z0; z < z1; z++) {
          const srow = (z - st.z) * st.sx + (y - st.y) * st.sx * st.sz - st.x;
          for (let x = x0; x < x1; x++) {
            const m = st.data[srow + x];
            if (!m) continue;
            data[vidx(x - ox, y - oy, z - oz)] = m === FORCE_AIR ? 0 : m;
          }
        }
    }
  }

  // ------------------------------------------------------------------ content

  private flatPad(cx: number, cz: number, w: number, d: number, y: number, mat: number) {
    const m = new VoxModel(w, 1, d);
    m.box(0, 0, 0, w - 1, 0, d - 1, mat);
    // marked as occupied so scatter props (palms, poles) keep the apron clear
    this.stamp(m, cx - w / 2, y - 1, cz - d / 2, true);
  }

  private populateFarp() {
    const s = this.sites.find((q) => q.kind === 'farp')!;
    const r = this.rng;
    const y = s.h;
    // apron
    this.flatPad(s.x, s.z, 96, 64, y, M.PAD);
    // main pad (rearm/refuel)
    const pad = P.helipad(26);
    this.stamp(pad, s.x - 13, y - 1, s.z - 13);
    // extra pads
    this.stamp(P.helipad(20), s.x - 44, y - 1, s.z - 10);
    this.stamp(P.helipad(20, false), s.x + 26, y - 1, s.z - 10);
    // support stuff
    for (let i = 0; i < 3; i++) this.stamp(P.fuelBladder(), s.x - 40 + i * 12, y, s.z + 18);
    this.stamp(P.crateStack(r), s.x + 18, y, s.z + 18);
    this.stamp(P.crateStack(r), s.x + 28, y, s.z + 20);
    this.stamp(P.tent(r), s.x + 36, y, s.z + 16);
    this.stamp(P.tent(r).rotated(1), s.x - 50, y, s.z + 20);
    this.stamp(P.windsock(), s.x + 14, y, s.z - 18);
    for (let i = 0; i < 4; i++) {
      this.stamp(P.lightPost(), s.x - 20 + (i % 2) * 40, y, s.z - 20 + Math.floor(i / 2) * 40);
    }
    const sb = P.compoundWall(30, 3, M.SANDBAG, false);
    this.stamp(sb, s.x - 15, y, s.z + 30);
    this.stamp(P.vehicle(r, 'truck'), s.x + 4, y, s.z + 34);
    // friendly guard tower
    this.stamp(P.guardTower(), s.x + 44, y, s.z - 26);
    this.farp = { x: s.x, y, z: s.z, padX: s.x, padZ: s.z, padR: 13, spawnYaw: Math.PI / 2 };
    // a couple of supplies near home
    this.pickups.push({ type: 'fuel', x: s.x - 24, y, z: s.z - 26 });
    this.pickups.push({ type: 'ammo', x: s.x + 24, y, z: s.z - 26 });
  }

  private populateBase(s: Site) {
    const r = this.rng;
    const kinds: BaseKind[] = ['radar', 'command', 'sam', 'depot', 'factory'];
    const baseIndex = this.bases.length;
    // first bases are always one of each to guarantee variety
    const kind = baseIndex < kinds.length ? r.shuffle(kinds.slice()).find((k) => !this.bases.some((b) => b.kind === k))! : r.pick(kinds);
    const name = `${KIND_LABEL[kind]} ${r.pick(CODENAMES)}`;
    const base: BaseDef = { id: baseIndex, name, kind, x: s.x, z: s.z, r: s.r, objectives: [] };
    this.bases.push(base);
    const y = s.h;
    const half = Math.round(s.r * 0.85);
    const wallMat = r.chance(0.5) ? M.MUD_BRICK : M.CONCRETE;
    // perimeter wall with gate gaps
    const wallH = 5;
    const segs: [number, number, number, number][] = [];
    const gate = 16;
    for (const side of [0, 1, 2, 3]) {
      const gateAt = r.chance(0.7);
      const len = half * 2;
      const a = gateAt ? Math.floor(len / 2 - gate / 2) : len;
      const parts = gateAt ? [[0, a], [a + gate, len]] : [[0, len]];
      for (const [p0, p1] of parts) {
        if (p1 - p0 < 2) continue;
        if (side === 0) segs.push([s.x - half + p0, s.z - half, p1 - p0, 0]);
        if (side === 1) segs.push([s.x - half + p0, s.z + half, p1 - p0, 0]);
        if (side === 2) segs.push([s.x - half, s.z - half + p0, p1 - p0, 1]);
        if (side === 3) segs.push([s.x + half, s.z - half + p0, p1 - p0, 1]);
      }
    }
    for (const [x, z, len, rot] of segs) {
      const w = P.compoundWall(Math.round(len), wallH, wallMat);
      const m = rot ? w.rotated(1) : w;
      const bb = this.stamp(m, x, y, z);
      this.addStructure(bb, 'wall', 'Compound wall', 'enemy', 2, { baseId: base.id, collapseAt: 0.4 });
    }
    // corner towers (with MGs)
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      if (!r.chance(0.6)) continue;
      const armed = r.chance(0.25 + 0.15 * this.sector);
      const tx = s.x + dx * (half - 6),
        tz = s.z + dz * (half - 6);
      const t = P.guardTower();
      const bb = this.stamp(t, tx - 4, y, tz - 4);
      this.addStructure(bb, 'tower', 'Guard tower', 'enemy', 15, { baseId: base.id, collapseAt: 0.75 });
      if (armed) this.addTurret('mg', tx, tz, base.id, y + 16);
    }

    // centrepiece objective
    const objective = (bb: ReturnType<MapGenerator['stamp']>, label: string, reward: number, explosive = 0, collapseAt = 0.55) => {
      const id = this.addStructure(bb, kind, label, 'enemy', reward, { baseId: base.id, explosive, collapseAt });
      base.objectives.push({ kind: 'structure', index: id });
    };
    if (kind === 'radar') {
      const m = P.radarStation(r);
      objective(this.stamp(m, s.x - m.sx / 2, y, s.z - m.sz / 2), 'Radar station', 250, 0, 0.7);
    } else if (kind === 'command') {
      const m = P.bunker(r);
      objective(this.stamp(m, s.x - m.sx / 2, y, s.z - m.sz / 2), 'Command bunker', 250, 0, 0.7);
    } else if (kind === 'factory') {
      for (let i = 0; i < 2; i++) {
        const m = P.hangar(r);
        objective(this.stamp(m, s.x - 24 + i * 26, y, s.z - m.sz / 2), 'Factory hangar', 150, 0, 0.7);
      }
    } else if (kind === 'depot') {
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) {
        const m = P.fuelTank(r, true);
        const a = (i / n) * Math.PI * 2;
        const bb = this.stamp(m, s.x + Math.cos(a) * 18 - m.sx / 2, y, s.z + Math.sin(a) * 18 - m.sz / 2);
        objective(bb, 'Fuel tank', 80, 16, 0.88);
      }
    } else if (kind === 'sam') {
      const n = r.int(2, 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        const tx = s.x + Math.cos(a) * 20,
          tz = s.z + Math.sin(a) * 20;
        this.stamp(P.gunPit(7), tx - 8, y, tz - 8);
        const ti = this.addTurret('sam', tx, tz, base.id, y + 1);
        base.objectives.push({ kind: 'turret', index: ti });
      }
      const van = P.vehicle(r, 'truck');
      const bb = this.stamp(van, s.x - 10, y, s.z - 4);
      this.addStructure(bb, 'vehicle', 'Radar truck', 'enemy', 40, { baseId: base.id });
    }

    // supporting buildings
    const nb = r.int(2, 4);
    for (let i = 0; i < nb; i++) {
      for (let k = 0; k < 20; k++) {
        const m = P.house(r, { floors: r.int(1, 2), military: true, mat: r.chance(0.5) ? wallMat : M.CONCRETE }).rotated(r.int(0, 3));
        const px = s.x + r.range(-half + 14, half - 14);
        const pz = s.z + r.range(-half + 14, half - 14);
        if (Math.hypot(px - s.x, pz - s.z) < 26) continue;
        const bb = this.placeCentered(m, px, pz);
        if (bb) {
          const sid = this.addStructure(bb, 'barracks', 'Barracks', 'enemy', 30, { baseId: base.id, collapseAt: 0.65 });
          // supplies hidden inside some buildings
          if (r.chance(0.5)) this.pickups.push({ type: r.pick(['fuel', 'ammo', 'repair'] as const), x: (bb.x0 + bb.x1) / 2, y: bb.y0 + 1, z: (bb.z0 + bb.z1) / 2 });
          void sid;
          break;
        }
      }
    }
    // fuel tanks (small, explosive)
    const nt = r.int(1, 3);
    for (let i = 0; i < nt; i++) {
      const m = P.fuelTank(r, false);
      const bb = this.placeCentered(m, s.x + r.range(-half + 8, half - 8), s.z + r.range(-half + 8, half - 8));
      if (bb) this.addStructure(bb, 'fueltank', 'Fuel tank', 'enemy', 20, { explosive: 9, baseId: base.id, collapseAt: 0.88 });
    }
    // vehicles, some tanks are active
    const nv = r.int(2, 5);
    for (let i = 0; i < nv; i++) {
      const vk = r.pick(['tank', 'truck', 'apc', 'technical'] as const);
      const m = P.vehicle(r, vk).rotated(r.int(0, 3));
      const vx = s.x + r.range(-half + 8, half - 8),
        vz = s.z + r.range(-half + 8, half - 8);
      if (vk === 'tank' && r.chance(0.35 + 0.1 * this.sector)) {
        // active tank: turret entity on a hull stamp (hull is the vehicle minus the turret)
        if (this.occFree(vx - 10, vz - 10, vx + 10, vz + 10)) {
          this.addTurret('tank', vx, vz, base.id, this.groundAt(vx, vz));
          for (let zz = vz - 8; zz < vz + 8; zz += OCC) for (let xx = vx - 10; xx < vx + 10; xx += OCC) this.occSet(xx, zz, 1);
        }
        continue;
      }
      const bb = this.placeCentered(m, vx, vz);
      if (bb) this.addStructure(bb, 'vehicle', 'Vehicle', 'enemy', 15, { baseId: base.id, collapseAt: 0.6 });
    }
    // anti-air emplacements
    const nAA = clamp(1 + Math.floor(this.sector / 2) + r.int(0, 2), 2, 6);
    for (let i = 0; i < nAA; i++) {
      for (let k = 0; k < 20; k++) {
        const ax = s.x + r.range(-half + 10, half - 10),
          az = s.z + r.range(-half + 10, half - 10);
        if (Math.hypot(ax - s.x, az - s.z) < 20) continue;
        const pit = P.gunPit(5);
        const bb = this.placeCentered(pit, ax, az);
        if (!bb) continue;
        const type: TurretType = this.sector >= 2 && r.chance(0.35) ? 'flak' : r.chance(0.6) ? 'aaa' : 'mg';
        this.addTurret(type, ax, az, base.id, bb.y0 + 1);
        break;
      }
    }
    // clutter
    for (let i = 0; i < r.int(3, 7); i++) {
      const m = r.chance(0.5) ? P.crateStack(r) : P.barrels(r);
      this.placeCentered(m, s.x + r.range(-half + 6, half - 6), s.z + r.range(-half + 6, half - 6));
    }
    // outer SAM threat for later sectors
    if (this.sector >= 3 && kind !== 'sam' && r.chance(0.5)) {
      const a = r.range(0, Math.PI * 2);
      const tx = s.x + Math.cos(a) * (half + 16),
        tz = s.z + Math.sin(a) * (half + 16);
      const bb = this.placeCentered(P.gunPit(7), tx, tz);
      if (bb) this.addTurret('sam', tx, tz, base.id, bb.y0 + 1);
    }
  }

  private populateTown(s: Site) {
    const r = this.rng;
    const n = r.int(8, 18);
    let placed = 0;
    for (let i = 0; i < n * 6 && placed < n; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * s.r;
      const m = P.house(r).rotated(r.int(0, 3));
      const bb = this.placeCentered(m, s.x + Math.cos(a) * d, s.z + Math.sin(a) * d, { maxSlope: 3 });
      if (!bb) continue;
      placed++;
      this.addStructure(bb, 'house', 'Building', 'neutral', 0, { collapseAt: 0.65 });
      if (r.chance(0.2)) this.pickups.push({ type: r.pick(['fuel', 'ammo', 'repair'] as const), x: bb.x1 + 3, y: this.groundAt(bb.x1 + 3, bb.z1 + 3), z: bb.z1 + 3 });
    }
    // courtyard walls, palms, stalls, cars, water tower
    for (let i = 0; i < 10; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * s.r;
      this.placeCentered(P.palm(r), s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
    }
    for (let i = 0; i < 4; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * s.r * 0.7;
      this.placeCentered(P.marketStall(r).rotated(r.int(0, 3)), s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
    }
    for (let i = 0; i < r.int(2, 5); i++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * s.r;
      const bb = this.placeCentered(P.vehicle(r, 'car', r.chance(0.4)).rotated(r.int(0, 3)), s.x + Math.cos(a) * d, s.z + Math.sin(a) * d, { allowRoad: true });
      if (bb) this.addStructure(bb, 'car', 'Car', 'neutral', 0, { collapseAt: 0.5 });
    }
    if (r.chance(0.6)) {
      const bb = this.placeCentered(P.waterTower(r), s.x + r.range(-20, 20), s.z + r.range(-20, 20));
      if (bb) this.addStructure(bb, 'tower', 'Water tower', 'neutral', 0, { collapseAt: 0.7 });
    }
    for (let i = 0; i < 6; i++) {
      const m = r.chance(0.5) ? P.ruin(r) : P.crateStack(r);
      const a = r.range(0, Math.PI * 2);
      this.placeCentered(m.rotated(r.int(0, 3)), s.x + Math.cos(a) * s.r * r.range(0.8, 1.2), s.z + Math.sin(a) * s.r * r.range(0.8, 1.2));
    }
    // checkpoint / MG nest guarding some towns
    if (r.chance(0.5)) {
      const a = r.range(0, Math.PI * 2);
      const tx = s.x + Math.cos(a) * (s.r + 12),
        tz = s.z + Math.sin(a) * (s.r + 12);
      const bb = this.placeCentered(P.gunPit(4), tx, tz);
      if (bb) this.addTurret('mg', tx, tz, -1, bb.y0 + 1);
    }
  }

  private populateOasis(s: Site) {
    const r = this.rng;
    const y = s.h;
    // pond + grass
    const pr = s.r * 0.35;
    const m = new VoxModel(Math.ceil(s.r * 2) + 2, 1, Math.ceil(s.r * 2) + 2);
    const c = (m.sx - 1) / 2;
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        const d = Math.hypot(x - c, z - c) + valueNoise(x * 0.2, z * 0.2, this.seed) * 6 - 3;
        if (d < pr) m.set(x, 0, z, M.WATER);
        else if (d < s.r * 0.9) m.set(x, 0, z, M.GREEN_GRASS);
      }
    this.stamp(m, s.x - c, y - 1, s.z - c, false);
    for (let i = 0; i < 14; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(pr + 2, s.r);
      this.placeCentered(P.palm(r), s.x + Math.cos(a) * d, s.z + Math.sin(a) * d, { force: i < 4 });
    }
    for (let i = 0; i < 10; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(pr, s.r * 1.1);
      this.placeCentered(P.shrub(r), s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
    }
    if (r.chance(0.6)) this.pickups.push({ type: 'repair', x: s.x + pr + 4, y, z: s.z });
  }

  private populateRescue(s: Site) {
    const r = this.rng;
    const m = P.heliWreck(r).rotated(r.int(0, 3));
    const bb = this.placeCentered(m, s.x, s.z, { force: true });
    if (!bb) return;
    this.addStructure(bb, 'wreck', 'Downed helicopter', 'friendly', 0, { collapseAt: 0 });
    this.rescues.push({ x: s.x + 14, y: this.groundAt(s.x + 14, s.z + 6), z: s.z + 6, crew: r.int(2, 4) });
    // enemies guard some sites
    if (r.chance(0.6)) {
      const a = r.range(0, Math.PI * 2);
      const tx = s.x + Math.cos(a) * 40,
        tz = s.z + Math.sin(a) * 40;
      const bb2 = this.placeCentered(P.gunPit(4), tx, tz);
      if (bb2) this.addTurret(this.sector > 1 && r.chance(0.4) ? 'aaa' : 'mg', tx, tz, -1, bb2.y0 + 1);
    }
    for (let i = 0; i < 4; i++) this.placeCentered(P.shrub(r), s.x + r.range(-20, 20), s.z + r.range(-20, 20));
  }

  private populateRoadside() {
    const r = this.rng;
    for (const rd of this.roads) {
      const len = Math.hypot(rd.bx - rd.ax, rd.bz - rd.az);
      const ux = (rd.bx - rd.ax) / len,
        uz = (rd.bz - rd.az) / len;
      const nx = -uz,
        nz = ux;
      // power poles
      if (r.chance(0.5)) {
        for (let t = 40; t < len - 40; t += 34) {
          const px = rd.ax + ux * t + nx * (rd.w + 6);
          const pz = rd.az + uz * t + nz * (rd.w + 6);
          this.placeCentered(P.powerPole(), px, pz);
        }
      }
      // palms along road
      for (let t = 20; t < len - 20; t += r.range(18, 60)) {
        const side = r.chance(0.5) ? 1 : -1;
        const off = rd.w + r.range(8, 16);
        this.placeCentered(P.palm(r), rd.ax + ux * t + nx * off * side, rd.az + uz * t + nz * off * side);
      }
      // wrecks / checkpoints
      const nEv = Math.floor(len / 260);
      for (let i = 0; i < nEv; i++) {
        const t = r.range(60, len - 60);
        const px = rd.ax + ux * t,
          pz = rd.az + uz * t;
        if (this.sites.some((s) => Math.hypot(s.x - px, s.z - pz) < s.r + 40)) continue;
        if (r.chance(0.55)) {
          // checkpoint: sandbag walls + MG nest beside the road
          const off = rd.w + 10;
          const tx = px + nx * off,
            tz = pz + nz * off;
          const bb = this.placeCentered(P.gunPit(4), tx, tz);
          if (bb) this.addTurret(this.sector > 1 && r.chance(0.3) ? 'aaa' : 'mg', tx, tz, -1, bb.y0 + 1);
          const bb2 = this.placeCentered(P.vehicle(r, r.chance(0.5) ? 'technical' : 'truck').rotated(r.int(0, 3)), px - nx * (off - 2), pz - nz * (off - 2));
          if (bb2) this.addStructure(bb2, 'vehicle', 'Vehicle', 'enemy', 15, { collapseAt: 0.6 });
        } else {
          const m = P.vehicle(r, r.pick(['car', 'truck', 'tank'] as const), true).rotated(r.int(0, 3));
          this.placeCentered(m, px + nx * r.range(-3, 3), pz + nz * r.range(-3, 3), { allowRoad: true });
        }
      }
    }
  }

  private scatter() {
    const r = this.rng;
    const S = this.S;
    const area = (S / 256) ** 2;
    // shrubs
    for (let i = 0; i < 65 * area; i++) this.placeCentered(P.shrub(r), r.range(8, S - 8), r.range(8, S - 8));
    // rocks
    for (let i = 0; i < 18 * area; i++) this.placeCentered(P.rock(r), r.range(8, S - 8), r.range(8, S - 8), { sink: 1 });
    // lone palms
    for (let i = 0; i < 6 * area; i++) this.placeCentered(P.palm(r), r.range(8, S - 8), r.range(8, S - 8), { maxSlope: 4 });
    // ruins / wrecks out in the desert
    for (let i = 0; i < 2 * area; i++) {
      const m = r.chance(0.5) ? P.ruin(r) : P.vehicle(r, r.pick(['tank', 'truck', 'apc'] as const), true);
      this.placeCentered(m.rotated(r.int(0, 3)), r.range(40, S - 40), r.range(40, S - 40), { maxSlope: 4, sink: 1 });
    }
    // loose supply drops
    for (let i = 0; i < 1.2 * area; i++) {
      const x = r.range(60, S - 60),
        z = r.range(60, S - 60);
      if (!this.occFree(x - 4, z - 4, x + 4, z + 4)) continue;
      this.pickups.push({ type: r.pick(['fuel', 'fuel', 'ammo', 'repair'] as const), x, y: this.groundAt(x, z), z });
    }
  }

  // ------------------------------------------------------------------ minimap

  private buildMinimap() {
    const S = this.S;
    const res = 256;
    const step = S / res;
    const img = new Uint8ClampedArray(res * res * 4);
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const x = Math.floor((i + 0.5) * step),
          z = Math.floor((j + 0.5) * step);
        const k = x + z * S;
        const m = this.surface[k];
        const h = this.heights[k];
        const hx = this.heights[Math.min(S - 1, x + 2) + z * S];
        const shade = 0.75 + (h - 8) * 0.012 + (h - hx) * 0.05;
        let rr = MAT_R[m],
          gg = MAT_G[m],
          bb = MAT_B[m];
        if (this.bigOcc[Math.floor(x / OCC) + Math.floor(z / OCC) * this.occN]) {
          rr = 236;
          gg = 226;
          bb = 205;
        }
        const p = (i + j * res) * 4;
        img[p] = rr * shade;
        img[p + 1] = gg * shade;
        img[p + 2] = bb * shade;
        img[p + 3] = 255;
      }
    return { img, res };
  }
}

export type { ObjectiveRef };
