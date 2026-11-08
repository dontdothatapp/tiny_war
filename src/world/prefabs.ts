import { RNG } from '../core/rng';
import { M } from '../voxel/materials';
import { VoxModel } from './voxModel';

// Procedural voxel prefabs. All are original, generic designs built from
// primitives; every call takes an RNG so variations are reproducible.

const WALL_MATS = [M.PLASTER, M.PLASTER_WHITE, M.PLASTER_TAN, M.MUD_BRICK, M.PLASTER];

// ---------------------------------------------------------------- buildings

export interface HouseOpts {
  w?: number;
  d?: number;
  floors?: number;
  mat?: number;
  military?: boolean;
}

export function house(rng: RNG, o: HouseOpts = {}): VoxModel {
  const w = o.w ?? rng.int(12, 22);
  const d = o.d ?? rng.int(10, 18);
  const floors = o.floors ?? rng.int(1, 3);
  const mat = o.mat ?? rng.pick(WALL_MATS);
  const storey = 6;
  const bodyH = floors * storey + 1;
  const extraTop = 7;
  const m = new VoxModel(w + 2, bodyH + extraTop, d + 2);
  const X0 = 1,
    Z0 = 1,
    X1 = w,
    Z1 = d;

  // L-shape: carve a corner out of the footprint
  const lShape = rng.chance(0.35) && w > 14 && d > 12;
  const cutW = lShape ? rng.int(5, Math.floor(w / 2)) : 0;
  const cutD = lShape ? rng.int(4, Math.floor(d / 2)) : 0;
  const inFoot = (x: number, z: number) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1 && !(lShape && x > X1 - cutW && z < Z0 + cutD);
  const onEdge = (x: number, z: number) => inFoot(x, z) && (!inFoot(x - 1, z) || !inFoot(x + 1, z) || !inFoot(x, z - 1) || !inFoot(x, z + 1));

  const trim = mat === M.MUD_BRICK ? M.PLASTER_TAN : M.CONCRETE;
  for (let f = 0; f < floors; f++) {
    const y0 = f * storey;
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        if (!inFoot(x, z)) continue;
        // floor slab
        m.set(x, y0, z, f === 0 ? M.CONCRETE : mat);
        if (onEdge(x, z)) {
          for (let y = y0 + 1; y < y0 + storey; y++) m.set(x, y, z, y === 1 && f === 0 ? trim : mat);
        }
      }
    // windows: walk the edges
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        if (!onEdge(x, z)) continue;
        // skip corners
        const horiz = !inFoot(x, z - 1) || !inFoot(x, z + 1);
        const vert = !inFoot(x - 1, z) || !inFoot(x + 1, z);
        if (horiz && vert) continue;
        const k = horiz ? x : z;
        if (k % 5 === 2 || k % 5 === 3) {
          m.set(x, y0 + 2, z, M.WINDOW);
          m.set(x, y0 + 3, z, M.WINDOW);
          if (k % 5 === 2 && rng.chance(0.15)) m.set(x, y0 + 4, z, M.WINDOW);
        }
      }
  }
  // roof slab + parapet
  const roofY = floors * storey;
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      if (!inFoot(x, z)) continue;
      m.set(x, roofY, z, mat);
      if (onEdge(x, z)) m.set(x, roofY + 1, z, mat);
    }
  // door (south face, z = Z1)
  const doorX = rng.int(X0 + 2, Math.max(X0 + 2, X1 - 4));
  m.box(doorX, 1, Z1, doorX + 1, 4, Z1, M.WOOD_DOOR);
  // awning over door
  if (rng.chance(0.5)) {
    const cloth = rng.pick([M.CLOTH_RED, M.CLOTH_BLUE, M.CLOTH_WHITE]);
    m.box(doorX - 2, 5, Z1 + 1, doorX + 3, 5, Z1 + 1, cloth);
  }
  // roof clutter
  const clutter = rng.int(1, 4);
  for (let i = 0; i < clutter; i++) {
    const cx = rng.int(X0 + 2, X1 - 3);
    const cz = rng.int(Z0 + 2, Z1 - 3);
    if (!inFoot(cx, cz) || !inFoot(cx + 2, cz + 2)) continue;
    const kind = rng.int(0, 3);
    if (kind === 0) {
      m.cylinder(cx + 1, cz + 1, 1.6, roofY + 1, roofY + 3, M.WATER_TANK);
    } else if (kind === 1) {
      m.box(cx, roofY + 1, cz, cx + 2, roofY + 2, cz + 1, M.AC_UNIT);
    } else if (kind === 2) {
      m.box(cx, roofY + 1, cz, cx + 1, roofY + 2, cz + 1, M.CRATE);
    } else {
      // stair hut
      m.box(cx, roofY + 1, cz, cx + 3, roofY + 4, cz + 3, mat);
      m.box(cx + 1, roofY + 1, cz + 3, cx + 2, roofY + 3, cz + 3, M.WOOD_DOOR);
    }
  }
  // dome
  if (!o.military && rng.chance(0.18) && w >= 12 && d >= 12) {
    const r = Math.min(w, d) * 0.25;
    const cx = X0 + (lShape ? (w - cutW) / 2 : w / 2);
    const cz = Z1 - Math.min(w, d) / 2 + 1;
    m.sphere(cx, roofY + 1, cz, r, M.DOME, true);
  }
  return m;
}

export function ruin(rng: RNG): VoxModel {
  const m = house(rng, { floors: rng.int(1, 2) });
  // knock off chunks
  for (let i = 0; i < m.data.length; i++) {
    if (!m.data[i]) continue;
    const y = Math.floor(i / (m.sx * m.sz));
    const p = 0.08 + (y / m.sy) * 0.7;
    if (rng.chance(p)) m.data[i] = 0;
  }
  m.replace(M.WOOD_DOOR, 0);
  return m;
}

export function hangar(rng: RNG): VoxModel {
  const len = rng.int(26, 34);
  const wid = rng.int(18, 22);
  const m = new VoxModel(wid + 2, 14, len + 2);
  const r = wid / 2;
  const cx = (wid + 1) / 2;
  // arched roof along Z
  for (let z = 1; z <= len; z++)
    for (let x = 1; x <= wid; x++) {
      const dx = (x - cx) / r;
      const hh = Math.sqrt(Math.max(0, 1 - dx * dx)) * 11 + 1;
      for (let y = 0; y <= hh; y++) {
        const edge = z === 1 || z === len || x === 1 || x === wid || y >= hh - 1;
        if (y === 0) m.set(x, y, z, M.CONCRETE);
        else if (edge) m.set(x, y, z, z % 4 === 0 && y >= hh - 1 ? M.METAL_OLIVE : M.METAL_TAN);
      }
    }
  // big door on south end
  m.box(Math.floor(cx - 5), 1, len, Math.ceil(cx + 5), 7, len, M.METAL_DARK);
  m.box(Math.floor(cx - 5), 8, len, Math.ceil(cx + 5), 8, len, M.RED_MARK);
  return m;
}

export function bunker(rng: RNG): VoxModel {
  const w = rng.int(18, 24);
  const d = rng.int(16, 20);
  const m = new VoxModel(w + 6, 16, d + 6);
  // sloped earth berm
  for (let i = 0; i < 3; i++) m.shell(i, 0, i, w + 5 - i, 3 - i, d + 5 - i, M.SANDBAG);
  m.box(3, 0, 3, w + 2, 6, d + 2, M.CONCRETE);
  m.box(4, 1, 4, w + 1, 5, d + 1, 0);
  m.box(3, 7, 3, w + 2, 7, d + 2, M.CONCRETE);
  // firing slits
  for (let x = 6; x < w; x += 4) {
    m.box(x, 4, 3, x + 1, 4, 3, M.WINDOW);
    m.box(x, 4, d + 2, x + 1, 4, d + 2, M.WINDOW);
  }
  // blast door
  m.box(Math.floor(w / 2), 1, d + 2, Math.floor(w / 2) + 3, 5, d + 2, M.METAL_DARK);
  // antennas
  for (let i = 0; i < 3; i++) {
    const ax = rng.int(5, w);
    const az = rng.int(5, d);
    const ah = rng.int(4, 8);
    m.box(ax, 8, az, ax, 8 + ah, az, M.STEEL);
    m.set(ax, 9 + ah, az, M.LIGHT_RED);
  }
  // camo net patch
  m.box(4, 8, 4, Math.floor(w / 2), 8, Math.floor(d / 2), M.CAMO);
  return m;
}

export function radarStation(rng: RNG): VoxModel {
  const m = new VoxModel(26, 40, 26);
  // control building
  m.box(1, 0, 13, 14, 7, 24, M.CONCRETE);
  m.box(2, 1, 14, 13, 6, 23, 0);
  for (let x = 3; x < 13; x += 3) m.box(x, 4, 24, x + 1, 5, 24, M.WINDOW);
  m.box(6, 1, 24, 7, 4, 24, M.METAL_DARK);
  m.box(1, 8, 13, 14, 8, 24, M.CONCRETE_DARK);
  // lattice tower
  const tx = 18,
    tz = 9;
  for (let y = 0; y < 24; y++) {
    const s = Math.max(1, Math.round(4 - y / 7));
    m.set(tx - s, y, tz - s, M.STEEL);
    m.set(tx + s, y, tz - s, M.STEEL);
    m.set(tx - s, y, tz + s, M.STEEL);
    m.set(tx + s, y, tz + s, M.STEEL);
    if (y % 5 === 0) m.shell(tx - s, y, tz - s, tx + s, y, tz + s, M.STEEL);
    if (y % 5 === 2) {
      m.line(tx - s, y, tz - s, tx + s, y + 3, tz - s, M.STEEL);
      m.line(tx - s, y, tz + s, tx + s, y + 3, tz + s, M.STEEL);
    }
  }
  m.box(tx - 2, 24, tz - 2, tx + 2, 25, tz + 2, M.METAL_DARK);
  // dish: tilted disc
  const dr = 7.5;
  const tilt = 0.55 + rng.range(-0.1, 0.1);
  for (let a = -dr; a <= dr; a += 0.5)
    for (let b = -dr; b <= dr; b += 0.5) {
      const rr = a * a + b * b;
      if (rr > dr * dr) continue;
      const cup = rr / (dr * dr) * 2.2;
      const x = tx + a;
      const y = 32 + b * Math.cos(tilt) + cup * Math.sin(tilt);
      const z = tz + b * Math.sin(tilt) * -1 - cup * Math.cos(tilt) + 2;
      m.set(x, y, z, rr > (dr - 0.8) ** 2 ? M.METAL_DARK : M.DISH);
    }
  m.box(tx, 26, tz, tx, 31, tz, M.STEEL);
  m.set(tx, 33, tz - 3, M.LIGHT_RED);
  return m;
}

export function fuelTank(rng: RNG, big = true): VoxModel {
  const r = big ? rng.range(5, 6.5) : rng.range(2.5, 3.5);
  const h = big ? rng.int(7, 10) : rng.int(4, 6);
  const s = Math.ceil(r * 2) + 3;
  const m = new VoxModel(s, h + 3, s);
  const c = (s - 1) / 2;
  // hollow shell: a few good hits rupture it
  m.cylinder(c, c, r, 0, h, (_x, y) => (y === Math.floor(h * 0.6) ? M.RED_MARK : M.FUEL_TANK), true);
  m.cylinder(c, c, r - 0.5, 0, 0, M.FUEL_TANK);
  m.cylinder(c, c, r - 1, h + 1, h + 1, M.FUEL_TANK);
  if (big) {
    // ladder
    for (let y = 0; y <= h; y++) m.set(c, y, c + r + 1, M.STEEL);
  }
  return m;
}

export function guardTower(): VoxModel {
  const m = new VoxModel(9, 22, 9);
  for (let y = 0; y < 15; y++) {
    m.set(1, y, 1, M.STEEL);
    m.set(7, y, 1, M.STEEL);
    m.set(1, y, 7, M.STEEL);
    m.set(7, y, 7, M.STEEL);
    if (y % 5 === 3) {
      m.line(1, y, 1, 7, y + 4, 1, M.STEEL);
      m.line(1, y, 7, 7, y + 4, 7, M.STEEL);
      m.line(1, y, 1, 1, y + 4, 7, M.STEEL);
      m.line(7, y, 1, 7, y + 4, 7, M.STEEL);
    }
  }
  m.box(0, 15, 0, 8, 15, 8, M.CRATE);
  m.shell(0, 16, 0, 8, 17, 8, M.SANDBAG);
  m.box(1, 21, 1, 7, 21, 7, M.METAL_TAN);
  m.set(1, 18, 1, M.STEEL);
  m.box(1, 18, 1, 1, 20, 1, M.STEEL);
  m.box(7, 18, 1, 7, 20, 1, M.STEEL);
  m.box(1, 18, 7, 1, 20, 7, M.STEEL);
  m.box(7, 18, 7, 7, 20, 7, M.STEEL);
  return m;
}

export function waterTower(rng: RNG): VoxModel {
  const m = new VoxModel(11, 26, 11);
  for (let y = 0; y < 16; y++) {
    m.set(2, y, 2, M.STEEL);
    m.set(8, y, 2, M.STEEL);
    m.set(2, y, 8, M.STEEL);
    m.set(8, y, 8, M.STEEL);
  }
  m.line(2, 4, 2, 8, 10, 8, M.STEEL);
  m.line(8, 4, 2, 2, 10, 8, M.STEEL);
  m.cylinder(5, 5, 5, 16, 22, rng.chance(0.5) ? M.PLASTER_WHITE : M.WATER_TANK);
  m.cylinder(5, 5, 3, 23, 23, M.METAL_DARK);
  return m;
}

export function compoundWall(len: number, h: number, mat: number, crenel = true): VoxModel {
  const m = new VoxModel(len, h + 1, 2);
  m.box(0, 0, 0, len - 1, h - 1, 1, mat);
  if (crenel) for (let x = 0; x < len; x += 3) m.box(x, h, 0, x, h, 1, mat);
  return m;
}

export function sandbagRing(r: number, h = 3): VoxModel {
  const s = Math.ceil(r * 2) + 3;
  const m = new VoxModel(s, h, s);
  const c = (s - 1) / 2;
  m.cylinder(c, c, r, 0, h - 1, M.SANDBAG, true);
  return m;
}

export function gunPit(r = 5): VoxModel {
  const s = Math.ceil(r * 2) + 3;
  const m = new VoxModel(s, 4, s);
  const c = (s - 1) / 2;
  m.cylinder(c, c, r - 0.5, 0, 0, M.CONCRETE);
  m.cylinder(c, c, r, 1, 2, M.SANDBAG, true);
  // entrance gap
  m.box(Math.floor(c) - 1, 1, s - 3, Math.floor(c) + 1, 2, s - 1, 0);
  return m;
}

// ---------------------------------------------------------------- nature

export function palm(rng: RNG): VoxModel {
  const h = rng.int(11, 17);
  const m = new VoxModel(19, h + 6, 19);
  const lean = rng.range(-1, 1);
  const leanZ = rng.range(-1, 1);
  let tx = 9,
    tz = 9;
  for (let y = 0; y < h; y++) {
    const t = y / h;
    tx = 9 + lean * t * t * 3;
    tz = 9 + leanZ * t * t * 3;
    m.set(tx, y, tz, M.PALM_TRUNK);
    if (y < 2) {
      m.set(tx + 1, y, tz, M.PALM_TRUNK);
      m.set(tx, y, tz + 1, M.PALM_TRUNK);
    }
  }
  const fronds = rng.int(6, 8);
  const top = h;
  m.box(Math.round(tx) - 1, top - 1, Math.round(tz) - 1, Math.round(tx) + 1, top, Math.round(tz) + 1, M.PALM_LEAF_DARK);
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = rng.range(6, 8.5);
    for (let s = 0; s <= len; s += 0.5) {
      const x = tx + Math.cos(a) * s;
      const z = tz + Math.sin(a) * s;
      const y = top + 1.5 * Math.sin((s / len) * Math.PI * 0.8) - (s / len) * (s / len) * 4;
      const mat = s > len * 0.6 || i % 2 ? M.PALM_LEAF : M.PALM_LEAF_DARK;
      m.set(x, y, z, mat);
      // leaf width
      if (s > 1 && s < len - 1) {
        m.set(x - Math.sin(a) * 0.9, y - 0.4, z + Math.cos(a) * 0.9, mat);
        m.set(x + Math.sin(a) * 0.9, y - 0.4, z - Math.cos(a) * 0.9, mat);
      }
    }
  }
  return m;
}

export function shrub(rng: RNG): VoxModel {
  const m = new VoxModel(5, 3, 5);
  const n = rng.int(3, 8);
  for (let i = 0; i < n; i++) {
    const x = rng.int(1, 3),
      z = rng.int(1, 3),
      y = rng.int(0, 1);
    m.set(x, y, z, M.SHRUB);
    if (rng.chance(0.4)) m.set(x, y + 1, z, M.SHRUB);
  }
  m.set(2, 0, 2, M.SHRUB);
  return m;
}

export function rock(rng: RNG): VoxModel {
  const r = rng.range(1.5, 4);
  const s = Math.ceil(r * 2) + 2;
  const m = new VoxModel(s, Math.ceil(r) + 2, s);
  const c = (s - 1) / 2;
  for (let i = 0; i < 4; i++) {
    m.sphere(c + rng.range(-1, 1), rng.range(0, 1), c + rng.range(-1, 1), r * rng.range(0.6, 1), rng.chance(0.5) ? M.ROCK : M.ROCK_DARK);
  }
  return m;
}

// ---------------------------------------------------------------- props

export function crateStack(rng: RNG): VoxModel {
  const m = new VoxModel(9, 7, 9);
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const x = rng.int(0, 5),
      z = rng.int(0, 5);
    let y = 0;
    while (y < 6 && m.get(x + 1, y, z + 1)) y += 3;
    const mat = rng.chance(0.3) ? M.OLIVE_DARK : M.CRATE;
    m.box(x, y, z, x + 2, y + 2, z + 2, mat);
    m.box(x + 1, y + 1, z, x + 1, y + 1, z + 2, M.METAL_DARK);
  }
  return m;
}

export function barrels(rng: RNG): VoxModel {
  const m = new VoxModel(7, 3, 7);
  const n = rng.int(2, 6);
  for (let i = 0; i < n; i++) {
    const x = rng.int(0, 5),
      z = rng.int(0, 5);
    const mat = rng.pick([M.RED_MARK, M.OLIVE_DARK, M.RUST, M.METAL_DARK]);
    m.box(x, 0, z, x + 1, 1, z + 1, mat);
  }
  return m;
}

export function tent(rng: RNG): VoxModel {
  const w = rng.int(8, 11);
  const l = rng.int(10, 14);
  const m = new VoxModel(w, 6, l);
  const c = (w - 1) / 2;
  for (let z = 0; z < l; z++)
    for (let x = 0; x < w; x++) {
      const hh = Math.round(5 - Math.abs(x - c) * (5 / (c + 0.5)));
      m.set(x, Math.max(0, hh), z, M.TENT);
      if (z === 0 || z === l - 1) for (let y = 0; y < hh; y++) m.set(x, y, z, M.TENT);
    }
  m.box(Math.floor(c), 0, l - 1, Math.ceil(c), 2, l - 1, M.METAL_DARK);
  return m;
}

export function powerPole(): VoxModel {
  const m = new VoxModel(7, 16, 1);
  m.box(3, 0, 0, 3, 15, 0, M.PALM_TRUNK);
  m.box(0, 13, 0, 6, 13, 0, M.PALM_TRUNK);
  m.set(0, 14, 0, M.CONCRETE);
  m.set(6, 14, 0, M.CONCRETE);
  return m;
}

export function marketStall(rng: RNG): VoxModel {
  const m = new VoxModel(7, 6, 6);
  const cloth = rng.pick([M.CLOTH_RED, M.CLOTH_BLUE, M.CLOTH_WHITE]);
  m.box(0, 0, 0, 0, 4, 0, M.PALM_TRUNK);
  m.box(6, 0, 0, 6, 4, 0, M.PALM_TRUNK);
  m.box(0, 0, 5, 0, 3, 5, M.PALM_TRUNK);
  m.box(6, 0, 5, 6, 3, 5, M.PALM_TRUNK);
  for (let z = 0; z < 6; z++) m.box(0, 5 - Math.floor(z / 3), z, 6, 5 - Math.floor(z / 3), z, cloth);
  m.box(1, 0, 1, 5, 1, 2, M.CRATE);
  return m;
}

// ---------------------------------------------------------------- vehicles

export type VehicleKind = 'tank' | 'truck' | 'technical' | 'car' | 'apc';

/** Vehicles are built facing +X. */
export function vehicle(rng: RNG, kind: VehicleKind, wrecked = false): VoxModel {
  let m: VoxModel;
  const camo = rng.pick([M.METAL_TAN, M.METAL_OLIVE]);
  if (kind === 'tank') {
    m = new VoxModel(22, 8, 11);
    m.box(1, 0, 0, 15, 2, 2, M.RUBBER);
    m.box(1, 0, 8, 15, 2, 10, M.RUBBER);
    m.box(0, 2, 0, 16, 4, 10, camo);
    m.box(15, 3, 1, 16, 3, 9, M.OLIVE_DARK);
    m.box(4, 5, 2, 11, 6, 8, camo);
    m.box(5, 7, 3, 9, 7, 7, M.OLIVE_DARK);
    m.box(12, 6, 5, 21, 6, 5, M.METAL_DARK);
  } else if (kind === 'apc') {
    m = new VoxModel(18, 7, 10);
    for (let x = 2; x < 16; x += 4) {
      m.box(x, 0, 0, x + 1, 2, 0, M.RUBBER);
      m.box(x, 0, 9, x + 1, 2, 9, M.RUBBER);
    }
    m.box(0, 1, 1, 17, 4, 8, camo);
    m.box(14, 4, 1, 17, 5, 8, camo);
    m.box(6, 5, 3, 9, 6, 6, M.OLIVE_DARK);
    m.box(10, 6, 4, 14, 6, 4, M.METAL_DARK);
  } else if (kind === 'truck') {
    m = new VoxModel(20, 9, 9);
    m.box(1, 0, 0, 3, 2, 0, M.RUBBER);
    m.box(1, 0, 8, 3, 2, 8, M.RUBBER);
    m.box(9, 0, 0, 11, 2, 0, M.RUBBER);
    m.box(9, 0, 8, 11, 2, 8, M.RUBBER);
    m.box(15, 0, 0, 17, 2, 0, M.RUBBER);
    m.box(15, 0, 8, 17, 2, 8, M.RUBBER);
    m.box(0, 1, 1, 19, 2, 7, M.METAL_DARK);
    m.box(14, 3, 1, 19, 6, 7, camo);
    m.box(18, 5, 2, 19, 5, 6, M.GLASS);
    m.box(0, 3, 1, 13, 7, 7, M.TENT);
    m.box(1, 3, 2, 12, 6, 6, 0);
  } else if (kind === 'technical') {
    m = new VoxModel(14, 7, 7);
    m.box(1, 0, 0, 2, 1, 0, M.RUBBER);
    m.box(1, 0, 6, 2, 1, 6, M.RUBBER);
    m.box(10, 0, 0, 11, 1, 0, M.RUBBER);
    m.box(10, 0, 6, 11, 1, 6, M.RUBBER);
    m.box(0, 1, 1, 13, 2, 5, M.PLASTER_WHITE);
    m.box(7, 3, 1, 11, 4, 5, M.PLASTER_WHITE);
    m.box(11, 4, 2, 11, 4, 4, M.GLASS);
    m.box(3, 3, 3, 3, 5, 3, M.METAL_DARK);
    m.box(3, 5, 3, 7, 5, 3, M.METAL_DARK);
  } else {
    m = new VoxModel(12, 5, 6);
    const body = rng.pick([M.PLASTER_WHITE, M.CLOTH_RED, M.CLOTH_BLUE, M.METAL_TAN, M.AC_UNIT]);
    m.box(1, 0, 0, 2, 1, 0, M.RUBBER);
    m.box(1, 0, 5, 2, 1, 5, M.RUBBER);
    m.box(9, 0, 0, 10, 1, 0, M.RUBBER);
    m.box(9, 0, 5, 10, 1, 5, M.RUBBER);
    m.box(0, 1, 1, 11, 2, 4, body);
    m.box(3, 3, 1, 8, 4, 4, body);
    m.box(8, 3, 1, 8, 3, 4, M.GLASS);
    m.box(3, 3, 1, 3, 3, 4, M.GLASS);
  }
  if (wrecked) {
    for (let i = 0; i < m.data.length; i++) {
      const v = m.data[i];
      if (!v) continue;
      if (rng.chance(0.18)) m.data[i] = 0;
      else if (v !== M.RUBBER) m.data[i] = rng.chance(0.6) ? M.WRECK : M.RUST;
    }
  }
  return m;
}

// ---------------------------------------------------------------- FARP / special

export function helipad(size = 24, mark = true): VoxModel {
  const m = new VoxModel(size, 1, size);
  m.box(0, 0, 0, size - 1, 0, size - 1, M.PAD);
  // border
  m.shell(0, 0, 0, size - 1, 0, size - 1, M.YELLOW_MARK);
  if (mark) {
    const c = size / 2;
    const s = Math.floor(size * 0.22);
    m.box(Math.floor(c - s), 0, Math.floor(c - s * 1.3), Math.floor(c - s) + 1, 0, Math.ceil(c + s * 1.3), M.PAD_MARK);
    m.box(Math.ceil(c + s) - 1, 0, Math.floor(c - s * 1.3), Math.ceil(c + s), 0, Math.ceil(c + s * 1.3), M.PAD_MARK);
    m.box(Math.floor(c - s), 0, Math.floor(c) - 1, Math.ceil(c + s), 0, Math.floor(c), M.PAD_MARK);
  }
  return m;
}

export function fuelBladder(): VoxModel {
  const m = new VoxModel(10, 3, 6);
  m.box(0, 0, 0, 9, 1, 5, M.RUBBER);
  m.box(1, 2, 1, 8, 2, 4, M.RUBBER);
  m.set(9, 2, 2, M.YELLOW_MARK);
  return m;
}

export function windsock(): VoxModel {
  const m = new VoxModel(6, 10, 1);
  m.box(0, 0, 0, 0, 9, 0, M.STEEL);
  for (let x = 1; x < 6; x++) m.set(x, 8 - Math.floor(x / 3), 0, x % 2 ? M.CLOTH_RED : M.CLOTH_WHITE);
  return m;
}

export function lightPost(): VoxModel {
  const m = new VoxModel(1, 6, 1);
  m.box(0, 0, 0, 0, 4, 0, M.STEEL);
  m.set(0, 5, 0, M.LIGHT_GREEN);
  return m;
}

/** Downed friendly helicopter, the rescue marker. */
export function heliWreck(rng: RNG): VoxModel {
  const m = new VoxModel(30, 8, 16);
  const body = M.OLIVE_DARK;
  m.box(8, 0, 5, 20, 5, 10, body);
  m.box(17, 1, 6, 21, 4, 9, M.GLASS);
  m.box(9, 6, 7, 13, 6, 8, M.METAL_DARK);
  // broken tail boom, bent
  m.line(8, 3, 7, 1, 2, 11, body, 0.6);
  m.box(0, 2, 11, 1, 6, 12, body);
  // blades scattered
  m.line(10, 7, 2, 26, 7, 4, M.METAL_DARK);
  m.line(14, 1, 12, 24, 0, 15, M.METAL_DARK);
  for (let i = 0; i < m.data.length; i++) if (m.data[i] && rng.chance(0.25)) m.data[i] = M.WRECK;
  return m;
}
