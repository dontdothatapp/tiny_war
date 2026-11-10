import { RNG, clamp, fbm, lerp, smoothstep, valueNoise } from '../core/rng';
import { M, MAT_B, MAT_G, MAT_R } from '../voxel/materials';
import { CS, Chunk, ChunkFiller, vidx } from '../voxel/world';
import type { BaseDef, BaseKind, FarpDef, MapData, ObjectiveRef, PickupSpawn, PickupType, PlaceDef, RescueSpawn, RoadSeg, Stamp, StructureDef, Team, TurretSpawn, TurretType } from './mapTypes';
import * as P from './prefabs';
import { FORCE_AIR, VoxModel } from './voxModel';

export const WORLD_HEIGHT = 64;
const OCC = 4; // occupancy grid cell size
/** Highest natural ground (mesa tops). The plains sit at about 10-20. */
const MAX_GROUND = 34;
/** The terrain eases down to this level along the sector border, where the open-desert skirt takes over. */
export const EDGE_LEVEL = 10;
const EDGE_FADE = 64;
/** Nothing hostile (emplacements, checkpoints, guarded sites) is generated this close to the FARP. */
export const SAFE_RADIUS = 260;
/** Supplies keep at least this far from each other, and from the FARP (which rearms you anyway). */
const SUPPLY_GAP = 150;
const SUPPLY_FARP_GAP = 190;
const PLACE_NAMES = ['AL-QASR', 'TARIF', 'UMM SAHAB', 'BIR HAKIM', 'SIDRA', 'KHARGA', 'ZAHRA', 'MAZRA', 'QARA', 'RAS AL-AIN', 'DARB', 'HAMRA', 'WADI NUR', 'SABKHA', 'TELL ASWAD', 'JABAL', 'NAKHL', 'MARSA', 'AIN DALLA', 'BAHARIYA'];

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
  // a first theatre of 1024, growing by 128 a sector
  return Math.min(2048, 896 + sector * 128);
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
  /** what the map draws over the ground in each occupancy cell: 1 = building, 2 = tree */
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
  readonly places: PlaceDef[] = [];
  farp!: FarpDef;
  private sites: Site[] = [];
  /** river course with the half-width of the water at each point */
  private river: { x: number; z: number; w: number }[] = [];

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
    this.planRiver();
    this.buildRoads();
    this.finalizeHeights();
    this.paintFields();
    this.populateFarp();
    for (const s of this.sites) {
      if (s.kind === 'base') this.populateBase(s);
      else if (s.kind === 'town') this.populateTown(s);
      else if (s.kind === 'oasis') this.populateOasis(s);
      else if (s.kind === 'rescue') this.populateRescue(s);
    }
    this.populateRoadside();
    this.scatter();
    this.placeSupplies();
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
      places: this.places,
      river: this.river.map((p) => ({ x: p.x, z: p.z })),
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
        const dune = Math.pow(fbm(u, v, sd, 3), 1.6) * 6;
        const big = fbm(x * 0.0035, z * 0.0035, sd + 17, 3) * 6;
        let h = 9 + dune + big;
        // mesas / rocky outcrops: low enough to hop over, high enough to hide behind
        const mesa = fbm(x * 0.006, z * 0.006, sd + 51, 4);
        let rock = false;
        if (mesa > 0.64) {
          const t = smoothstep(0.64, 0.69, mesa);
          const terr = Math.floor((mesa - 0.64) * 160) % 4 === 0 ? 0 : 1;
          h += t * (7 + (mesa - 0.64) * 70) + terr * t;
          rock = t > 0.3;
        }
        // ease down to a flat border so the land runs on into the open desert around the sector
        const e = Math.min(x, z, S - 1 - x, S - 1 - z);
        if (e < EDGE_FADE) {
          const k = smoothstep(0, EDGE_FADE, e);
          h = lerp(EDGE_LEVEL, h, k);
          if (k < 0.7) rock = false;
        }
        if (rock) this.rockMask[x + z * S] = 1;
        this.hf[x + z * S] = h;
      }
  }

  private placeSites() {
    const S = this.S;
    const r = this.rng;
    const margin = 130;
    const far = (x: number, z: number, d: number) => this.sites.every((s) => Math.hypot(s.x - x, s.z - z) > d + s.r);
    const hAt = (x: number, z: number) => this.hf[Math.floor(x) + Math.floor(z) * S];

    // FARP in the south, well inside the border
    const fx = r.range(S * 0.28, S * 0.72);
    const fz = S - 230;
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

    // Distances from the FARP (centre to centre). The sortie starts with a flight out: nothing
    // to shoot at or pick up is in sight of the pad, and the first objective is a real trip away.
    const baseMin = Math.max(400, S * 0.4);
    const rescueMin = Math.max(320, S * 0.32);
    // 1 base in sector 1, then +1 every two sectors (max 5)
    const nBases = Math.min(5, 1 + Math.floor(this.sector / 2));
    for (let i = 0; i < nBases; i++) tryPlace('base', r.range(52, 64), 110, baseMin + i * 20);
    const nTowns = 2 + Math.floor(S / 512);
    for (let i = 0; i < nTowns; i++) tryPlace('town', r.range(55, 80), 70, SAFE_RADIUS + 40);
    const nOasis = r.int(2, 4) + Math.floor(S / 1024);
    for (let i = 0; i < nOasis; i++) tryPlace('oasis', r.range(22, 34), 40, 190);
    const nRescue = Math.min(4, 1 + Math.floor((this.sector - 1) / 2));
    for (let i = 0; i < nRescue; i++) tryPlace('rescue', 18, 50, rescueMin);
    // keep flattened sites at a sane level
    for (const s of this.sites) s.h = clamp(s.h, 9, 16);
    // towns get names (shown on the map)
    const names = r.shuffle(PLACE_NAMES.slice());
    for (const s of this.sites) if (s.kind === 'town') this.places.push({ name: names[this.places.length % names.length], kind: 'town', x: s.x, z: s.z, r: s.r });
  }

  private farpDist(x: number, z: number): number {
    const f = this.sites[0];
    return Math.hypot(x - f.x, z - f.z);
  }

  /**
   * A river (a wadi with water in it) from one edge of the sector to the other. Out of a
   * few random courses it takes the one that stays furthest from the compounds; a sector
   * where none fits, or one in five anyway, is dry.
   */
  private planRiver() {
    const S = this.S;
    const r = this.rng;
    if (!r.chance(0.8)) return;
    const compounds = this.sites.filter((s) => s.kind === 'farp' || s.kind === 'base' || s.kind === 'rescue');
    let best: { x: number; z: number; w: number }[] | null = null;
    let bestClear = -Infinity;
    for (let k = 0; k < 24; k++) {
      const eastWest = r.chance(0.6);
      // an east-west river stays in the northern two thirds (the FARP is in the south)
      const a0 = eastWest ? r.range(0.16, 0.62) : r.range(0.15, 0.85);
      const a1 = eastWest ? r.range(0.16, 0.62) : r.range(0.15, 0.85);
      const amp = r.range(50, 120);
      const ph = r.range(0, 100);
      const n = Math.ceil((S + 80) / 36);
      const pts: { x: number; z: number; w: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const along = -40 + (S + 80) * t;
        const across = S * lerp(a0, a1, t) + (fbm(t * 5 + ph, k * 7.3, this.seed + 77, 3) - 0.5) * 2 * amp;
        const w = 3 + valueNoise(i * 0.35, ph, this.seed + 78) * 2.5;
        pts.push(eastWest ? { x: along, z: across, w } : { x: across, z: along, w });
      }
      let clear = Infinity;
      for (const s of compounds) for (const p of pts) clear = Math.min(clear, Math.hypot(p.x - s.x, p.z - s.z) - s.r);
      if (clear > bestClear) {
        bestClear = clear;
        best = pts;
      }
      if (clear > 70) break;
    }
    if (best && bestClear > 45) this.river = best;
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
    // a highway crossing the whole map, out of sight of the FARP (the convoy drives it)
    const farp = this.sites[0];
    for (let k = 0; k < 30; k++) {
      const t0 = r.range(0.2, 0.8),
        t1 = r.range(0.2, 0.8);
      const hw: RoadSeg = r.chance(0.5) ? { ax: -10, az: S * t0, bx: S + 10, bz: S * t1, w: 6 } : { ax: S * t0, az: -10, bx: S * t1, bz: S + 10, w: 6 };
      if (k < 29 && segDist(farp.x, farp.z, hw.ax, hw.az, hw.bx, hw.bz) < SAFE_RADIUS) continue;
      this.roads.push(hw);
      break;
    }
  }

  /**
   * Cut the river into the height field: a shallow bed of water with green banks. Every
   * cell takes its shape from the nearest point of the course, so bends join cleanly.
   */
  private carveRiver() {
    const pts = this.river;
    if (pts.length < 2) return;
    const S = this.S;
    const hf = this.hf;
    // water level along the course: the smoothed terrain, kept down on the plain (it cuts a gorge through high ground)
    const prof = pts.map((p) => hf[clamp(Math.floor(p.x), 0, S - 1) + clamp(Math.floor(p.z), 0, S - 1) * S]);
    for (let pass = 0; pass < 10; pass++) for (let i = 1; i < prof.length - 1; i++) prof[i] = (prof[i - 1] + prof[i] * 2 + prof[i + 1]) / 4;
    // two voxels deep, shallowing to nothing at the border, where it runs out flush onto the open desert
    const depth = pts.map((p) => 2 * smoothstep(0, 60, Math.min(p.x, p.z, S - p.x, S - p.z)));
    for (let i = 0; i < prof.length; i++) prof[i] = Math.min(prof[i], 15) - depth[i];
    const reach = 26;
    const near = new Map<number, { d: number; level: number; w: number; depth: number }>();
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1];
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach)),
        maxX = Math.min(S - 1, Math.ceil(Math.max(a.x, b.x) + reach));
      const minZ = Math.max(0, Math.floor(Math.min(a.z, b.z) - reach)),
        maxZ = Math.min(S - 1, Math.ceil(Math.max(a.z, b.z) + reach));
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++) {
          const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
          if (d > reach) continue;
          const i = x + z * S;
          const cur = near.get(i);
          if (!cur || d < cur.d) near.set(i, { d, level: lerp(prof[k], prof[k + 1], t), w: lerp(a.w, b.w, t), depth: lerp(depth[k], depth[k + 1], t) });
        }
    }
    const compounds = this.sites.filter((q) => q.kind === 'farp' || q.kind === 'base' || q.kind === 'rescue');
    for (const [i, c] of near) {
      const x = i % S,
        z = (i - x) / S;
      if (c.d > c.w + 20) continue;
      if (compounds.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + 10)) continue;
      // bed at the water level, banks rising back to the plain, then blending into the land
      const bank = c.level + c.depth * smoothstep(c.w, c.w + 9, c.d);
      hf[i] = lerp(hf[i], bank, 1 - smoothstep(c.w + 8, c.w + 20, c.d));
      if (c.d <= c.w) {
        this.surface[i] = M.WATER;
        this.rockMask[i] = 0;
        this.occSet(x, z, 3);
      } else if (c.d <= c.w + 4 + valueNoise(x * 0.15, z * 0.15, this.seed + 5) * 5) {
        this.surface[i] = M.GREEN_GRASS;
        this.rockMask[i] = 0;
      }
    }
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
    this.carveRiver();
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
      for (let i = 0; i <= n; i++) prof[i] = Math.min(prof[i], 18);
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
        this.heights[i] = clamp(Math.round(hf[i]), 3, MAX_GROUND);
        if (this.surface[i]) continue;
        if (this.rockMask[i]) this.surface[i] = M.ROCK;
        else {
          // dark patches thin out towards the border, which is plain sand like the desert beyond it
          const e = Math.min(x, z, S - 1 - x, S - 1 - z);
          const patch = valueNoise(x * 0.03, z * 0.03, sd) - (1 - smoothstep(0, 70, e)) * 0.4;
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

  /** 0 = free, 1 = object, 2 = road, 3 = water */
  private occFree(x0: number, z0: number, x1: number, z1: number, allowRoad = false): boolean {
    if (x0 < 4 || z0 < 4 || x1 >= this.S - 4 || z1 >= this.S - 4) return false;
    for (let z = Math.floor(z0 / OCC); z <= Math.floor(z1 / OCC); z++)
      for (let x = Math.floor(x0 / OCC); x <= Math.floor(x1 / OCC); x++) {
        const v = this.occ[x + z * this.occN];
        if (v === 1 || v === 3 || (v === 2 && !allowRoad)) return false;
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
    // big footprints are drawn on the map: buildings as blocks, palms as a dot, rocks not at all
    if (mark && m.sx * m.sz >= 100 && m.sy > 2) {
      let tree = false,
        built = false;
      for (let i = 0; i < m.data.length && !tree; i++) {
        const v = m.data[i];
        if (v === M.PALM_LEAF || v === M.PALM_LEAF_DARK || v === M.PALM_DEAD) tree = true;
        else if (v && v !== FORCE_AIR && v !== M.ROCK && v !== M.ROCK_DARK && v !== M.SHRUB) built = true;
      }
      if (tree) {
        const ox = Math.floor((x + m.sx / 2) / OCC),
          oz = Math.floor((z + m.sz / 2) / OCC);
        if (ox >= 0 && oz >= 0 && ox < this.occN && oz < this.occN && !this.bigOcc[ox + oz * this.occN]) this.bigOcc[ox + oz * this.occN] = 2;
      } else if (built)
        for (let zz = z; zz < z + m.sz; zz += OCC)
          for (let xx = x; xx < x + m.sx; xx += OCC) {
            const ox = Math.floor(xx / OCC),
              oz = Math.floor(zz / OCC);
            if (ox >= 0 && oz >= 0 && ox < this.occN && oz < this.occN) this.bigOcc[ox + oz * this.occN] = 1;
          }
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
  }

  private populateBase(s: Site) {
    const r = this.rng;
    // no SAM battery in the very first sector
    const kinds: BaseKind[] = this.sector === 1 ? ['radar', 'command', 'depot', 'factory'] : ['radar', 'command', 'sam', 'depot', 'factory'];
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
    let cache = false;
    for (let i = 0; i < nb; i++) {
      for (let k = 0; k < 20; k++) {
        const m = P.house(r, { floors: r.int(1, 2), military: true, mat: r.chance(0.5) ? wallMat : M.CONCRETE }).rotated(r.int(0, 3));
        const px = s.x + r.range(-half + 14, half - 14);
        const pz = s.z + r.range(-half + 14, half - 14);
        if (Math.hypot(px - s.x, pz - s.z) < 26) continue;
        const bb = this.placeCentered(m, px, pz);
        if (bb) {
          const sid = this.addStructure(bb, 'barracks', 'Barracks', 'enemy', 30, { baseId: base.id, collapseAt: 0.65 });
          // one supply cache hidden inside a building (reachable once the walls are gone)
          if (!cache && r.chance(0.6)) cache = this.tryPickup((bb.x0 + bb.x1) / 2, (bb.z0 + bb.z1) / 2, { y: bb.y0 + 1, gap: 100 });
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
    let cache = false;
    for (let i = 0; i < n * 6 && placed < n; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * s.r;
      const m = P.house(r).rotated(r.int(0, 3));
      const bb = this.placeCentered(m, s.x + Math.cos(a) * d, s.z + Math.sin(a) * d, { maxSlope: 3 });
      if (!bb) continue;
      placed++;
      this.addStructure(bb, 'house', 'Building', 'neutral', 0, { collapseAt: 0.65 });
      // a town has one supply cache at most, beside one of its buildings
      if (!cache && r.chance(0.3)) cache = this.tryPickup(bb.x1 + 3, bb.z1 + 3);
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
      const bb = this.farpDist(tx, tz) > SAFE_RADIUS ? this.placeCentered(P.gunPit(4), tx, tz) : null;
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
    if (r.chance(0.6)) this.tryPickup(s.x + pr + 4, s.z, { type: 'repair', y });
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
        if (r.chance(0.55) && this.farpDist(px, pz) > SAFE_RADIUS) {
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
    // shrubs grow in belts (low-frequency noise) instead of an even sprinkle
    for (let i = 0; i < 130 * area; i++) {
      const x = r.range(8, S - 8),
        z = r.range(8, S - 8);
      if (r.next() > 0.12 + smoothstep(0.42, 0.7, fbm(x * 0.007, z * 0.007, this.seed + 91, 2))) continue;
      this.placeCentered(P.shrub(r), x, z);
    }
    // palms and scrub along the river banks
    for (let k = 0; k < this.river.length - 1; k++) {
      const a = this.river[k],
        b = this.river[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const nx = -(b.z - a.z) / len,
        nz = (b.x - a.x) / len;
      for (let t = r.range(0, 8); t < len; t += r.range(6, 16)) {
        const side = r.chance(0.5) ? 1 : -1;
        const off = (lerp(a.w, b.w, t / len) + r.range(3, 13)) * side;
        const px = a.x + ((b.x - a.x) * t) / len + nx * off,
          pz = a.z + ((b.z - a.z) * t) / len + nz * off;
        this.placeCentered(r.chance(0.4) ? P.palm(r) : P.shrub(r), px, pz, { maxSlope: 4 });
      }
    }
    // rocks
    for (let i = 0; i < 18 * area; i++) this.placeCentered(P.rock(r), r.range(8, S - 8), r.range(8, S - 8), { sink: 1 });
    // lone palms
    for (let i = 0; i < 6 * area; i++) this.placeCentered(P.palm(r), r.range(8, S - 8), r.range(8, S - 8), { maxSlope: 4 });
    // ruins / wrecks out in the desert
    for (let i = 0; i < 2 * area; i++) {
      const m = r.chance(0.5) ? P.ruin(r) : P.vehicle(r, r.pick(['tank', 'truck', 'apc'] as const), true);
      this.placeCentered(m.rotated(r.int(0, 3)), r.range(40, S - 40), r.range(40, S - 40), { maxSlope: 4, sink: 1 });
    }
  }

  // ------------------------------------------------------------------ farmland

  /** Irrigated plots around the towns and along the river: crop rows painted on flat, empty ground. */
  private paintFields() {
    const r = this.rng;
    const S = this.S;
    const compounds = this.sites.filter((q) => q.kind === 'farp' || q.kind === 'base' || q.kind === 'rescue');
    const plot = (cx: number, cz: number): boolean => {
      const w = r.int(14, 30),
        d = r.int(12, 24);
      const x0 = Math.round(cx - w / 2),
        z0 = Math.round(cz - d / 2);
      if (!this.occFree(x0 - 2, z0 - 2, x0 + w + 1, z0 + d + 1)) return false;
      if (compounds.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r + 40)) return false;
      let mn = 999,
        mx = 0;
      for (let z = z0; z < z0 + d; z++)
        for (let x = x0; x < x0 + w; x++) {
          const i = x + z * S;
          const m = this.surface[i];
          if (m !== M.SAND && m !== M.SAND_DARK) return false;
          const h = this.heights[i];
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
      if (mx - mn > 2) return false;
      const kind = r.int(0, 2);
      const rowsX = r.chance(0.5);
      for (let z = z0; z < z0 + d; z++)
        for (let x = x0; x < x0 + w; x++) {
          const edge = x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + d - 1;
          const furrow = (rowsX ? x : z) % 3 === 0;
          let m: number;
          if (edge) m = M.FIELD_SOIL;
          else if (kind === 0) m = furrow ? M.FIELD_SOIL : M.FIELD_GREEN;
          else if (kind === 1) m = furrow ? M.FIELD_SOIL : M.FIELD_DARK;
          else m = furrow ? M.SAND_DARK : M.FIELD_SOIL;
          this.surface[x + z * S] = m;
        }
      // keep buildings and props off the crops
      for (let z = z0; z < z0 + d; z += OCC) for (let x = x0; x < x0 + w; x += OCC) this.occSet(x, z, 1);
      this.occSet(x0 + w - 1, z0 + d - 1, 1);
      return true;
    };
    for (const s of this.sites) {
      if (s.kind !== 'town') continue;
      const n = r.int(4, 8);
      for (let i = 0, done = 0; i < n * 5 && done < n; i++) {
        const a = r.range(0, Math.PI * 2);
        const d = s.r * r.range(1.0, 1.7);
        if (plot(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d)) done++;
      }
    }
    for (let k = 1; k < this.river.length - 1; k++) {
      if (!r.chance(0.45)) continue;
      const a = this.river[k],
        b = this.river[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const side = r.chance(0.5) ? 1 : -1;
      const off = (a.w + r.range(22, 40)) * side;
      plot(a.x - ((b.z - a.z) / len) * off, a.z + ((b.x - a.x) / len) * off);
    }
  }

  // ------------------------------------------------------------------ supplies

  /**
   * Add a supply crate, unless it would crowd another one or sit on the FARP's doorstep.
   * With no type given it deals the rarest one so far, avoiding the type of any crate nearby.
   */
  private tryPickup(x: number, z: number, o: { type?: PickupType; y?: number; gap?: number } = {}): boolean {
    const gap = o.gap ?? SUPPLY_GAP;
    if (this.farpDist(x, z) < SUPPLY_FARP_GAP) return false;
    if (this.pickups.some((p) => Math.hypot(p.x - x, p.z - z) < gap)) return false;
    let type = o.type;
    if (!type) {
      const count: Record<PickupType, number> = { fuel: 0, ammo: 0, repair: 0 };
      for (const p of this.pickups) count[p.type] += Math.hypot(p.x - x, p.z - z) < 320 ? 100 : 1;
      const order = this.rng.shuffle<PickupType>(['fuel', 'ammo', 'repair']);
      order.sort((a, b) => count[a] - count[b]);
      type = order[0];
    }
    this.pickups.push({ type, x, y: o.y ?? this.groundAt(x, z), z });
    return true;
  }

  /**
   * Loose supply drops top the sector up to a fixed number of crates. The sector is split
   * into a grid and each cell gets one at most, so they spread out instead of bunching.
   */
  private placeSupplies() {
    const r = this.rng;
    const S = this.S;
    const want = Math.round(6 + S / 200);
    const g = Math.max(2, Math.ceil(Math.sqrt(want * 1.6)));
    const cell = (S - 160) / g;
    const cells: [number, number][] = [];
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) cells.push([i, j]);
    r.shuffle(cells);
    const bases = this.sites.filter((s) => s.kind === 'base');
    for (const [i, j] of cells) {
      if (this.pickups.length >= want) break;
      for (let k = 0; k < 8; k++) {
        const x = 80 + (i + r.range(0.15, 0.85)) * cell,
          z = 80 + (j + r.range(0.15, 0.85)) * cell;
        if (bases.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + 24)) continue;
        if (!this.occFree(x - 5, z - 5, x + 5, z + 5)) continue;
        const { mn, mx } = this.footprintHeights(Math.floor(x) - 3, Math.floor(z) - 3, 7, 7);
        if (mx - mn > 2) continue;
        if (this.tryPickup(x, z)) break;
      }
    }
  }

  // ------------------------------------------------------------------ minimap

  private buildMinimap() {
    const S = this.S;
    const res = Math.min(512, S / 2);
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
        const big = this.bigOcc[Math.floor(x / OCC) + Math.floor(z / OCC) * this.occN];
        if (big === 1) {
          rr = 236;
          gg = 226;
          bb = 205;
        } else if (big === 2) {
          rr = 92;
          gg = 122;
          bb = 52;
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

/** Distance from a point to a segment. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax,
    dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export type { ObjectiveRef };
