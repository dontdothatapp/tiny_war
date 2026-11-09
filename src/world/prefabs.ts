import { RNG, hash3, valueNoise } from '../core/rng';
import { M } from '../voxel/materials';
import { VoxModel } from './voxModel';

// Procedural voxel prefabs. All are original, generic designs built from
// primitives; every call takes an RNG so variations are reproducible.
// Detail conventions: light trim on edges/frames, darker base bands,
// two-tone camo via low-frequency noise, emissive voxels only for lights.

const WALL_MATS = [M.PLASTER, M.PLASTER_WHITE, M.PLASTER_TAN, M.MUD_BRICK, M.PLASTER];

/** Two-tone camouflage: repaint `from` voxels with `to` where noise is high. */
function camo(m: VoxModel, from: number[], to: number, seed: number, scale = 0.22, thr = 0.58) {
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!from.includes(v)) continue;
        if (valueNoise(x * scale + y * 0.13, z * scale - y * 0.11, seed) > thr) m.set(x, y, z, to);
      }
}

/** Alternate rows of two materials (sandbags, bricks). */
const rows = (a: number, b: number) => (_x: number, y: number, z: number) => ((y + (z >> 1)) % 2 ? a : b);

/** Turn a vehicle into a burnt-out hulk that still reads as the vehicle. */
function wreckify(m: VoxModel, rng: RNG) {
  const seed = rng.int(0, 9999);
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!v) continue;
        if (v === M.GLASS || v === M.LAMP || v === M.TENT) {
          // glass shatters, canvas burns away
          m.set(x, y, z, v !== M.TENT && rng.chance(0.3) ? M.SOOT : 0);
          continue;
        }
        if (v === M.CANVAS_DARK) {
          m.set(x, y, z, M.METAL_DARK); // bare tilt hoops
          continue;
        }
        if (v === M.RUBBER || v === M.TRACK) {
          m.set(x, y, z, rng.chance(0.35) ? 0 : M.SOOT);
          continue;
        }
        // panels missing near the top
        if (rng.chance(0.04 + (y / m.sy) * 0.12)) {
          m.set(x, y, z, 0);
          continue;
        }
        // scorched: soot and burnt metal, rust streaks, patches of surviving paint
        const n = valueNoise(x * 0.3, z * 0.3 + y * 0.2, seed);
        if (n < 0.18) m.set(x, y, z, M.SOOT);
        else if (n < 0.32) m.set(x, y, z, M.WRECK);
        else if (n < 0.45) m.set(x, y, z, M.METAL_DARK);
        else if (n < 0.68) m.set(x, y, z, v === M.METAL_DARK ? M.WRECK : v);
        else m.set(x, y, z, M.RUST);
      }
}

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
  const mil = !!o.military;
  const mat = o.mat ?? rng.pick(WALL_MATS);
  const storey = 6;
  const PAD = 2;
  const m = new VoxModel(w + PAD * 2, floors * storey + 10, d + PAD * 2);
  const X0 = PAD,
    Z0 = PAD,
    X1 = PAD + w - 1,
    Z1 = PAD + d - 1;

  // L-shape: carve a corner out of the footprint
  const lShape = rng.chance(0.35) && w > 14 && d > 12;
  const cutW = lShape ? rng.int(5, Math.floor(w / 2)) : 0;
  const cutD = lShape ? rng.int(4, Math.floor(d / 2)) : 0;
  const inFoot = (x: number, z: number) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1 && !(lShape && x > X1 - cutW && z < Z0 + cutD);
  const onEdge = (x: number, z: number) => inFoot(x, z) && (!inFoot(x - 1, z) || !inFoot(x + 1, z) || !inFoot(x, z - 1) || !inFoot(x, z + 1));
  const outward = (x: number, z: number): [number, number] => (!inFoot(x, z + 1) ? [0, 1] : !inFoot(x, z - 1) ? [0, -1] : !inFoot(x + 1, z) ? [1, 0] : [-1, 0]);

  const trim = mil ? M.CONCRETE_DARK : mat === M.MUD_BRICK ? M.PLASTER_TAN : M.TRIM;
  const base = mil ? M.CONCRETE_DARK : mat === M.MUD_BRICK ? M.SANDBAG_DARK : M.CONCRETE;
  const shutter = mil ? M.STEEL : rng.chance(0.55) ? rng.pick([M.SHUTTER_BLUE, M.SHUTTER_GREEN, M.WOOD_DOOR]) : 0;

  for (let f = 0; f < floors; f++) {
    const y0 = f * storey;
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        if (!inFoot(x, z)) continue;
        const edge = onEdge(x, z);
        // floor slab; upper slabs show as a light band between storeys
        m.set(x, y0, z, f === 0 ? M.CONCRETE : edge ? trim : mat);
        if (edge) for (let y = y0 + 1; y < y0 + storey; y++) m.set(x, y, z, f === 0 && y === 1 ? base : mat);
      }
    // windows with lintel, sill and shutters
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        if (!onEdge(x, z)) continue;
        const horiz = !inFoot(x, z - 1) || !inFoot(x, z + 1);
        const vert = !inFoot(x - 1, z) || !inFoot(x + 1, z);
        if (horiz && vert) continue; // corner
        const k = (horiz ? x - X0 : z - Z0) % 5;
        const [ox, oz] = outward(x, z);
        if (mil) {
          if (k === 2) {
            m.set(x, y0 + 3, z, M.WINDOW);
            m.set(x, y0 + 4, z, M.WINDOW);
          }
          continue;
        }
        if (k === 2 || k === 3) {
          m.set(x, y0 + 2, z, M.WINDOW);
          m.set(x, y0 + 3, z, M.WINDOW);
          m.set(x, y0 + 4, z, trim);
          m.set(x + ox, y0 + 1, z + oz, trim);
        } else if (shutter && (k === 1 || k === 4)) {
          m.set(x, y0 + 2, z, shutter);
          m.set(x, y0 + 3, z, shutter);
        }
      }
    // balcony on the south face
    if (f > 0 && !mil && rng.chance(0.55)) {
      const bx = X0 + 1 + rng.int(0, Math.max(0, Math.floor((w - 8) / 5))) * 5;
      for (let x = bx; x <= Math.min(X1 - 1, bx + 5); x++) {
        m.set(x, y0, Z1 + 1, trim);
        m.set(x, y0 + 1, Z1 + 1, x % 2 ? M.METAL_DARK : trim);
      }
      m.box(bx + 2, y0 + 1, Z1, bx + 3, y0 + 4, Z1, M.WINDOW);
      m.set(bx, y0 + 1, Z1 + 1, trim);
      m.set(Math.min(X1 - 1, bx + 5), y0 + 1, Z1 + 1, trim);
    }
  }
  // roof slab, parapet with light cap, drain spouts
  const roofY = floors * storey;
  const tallParapet = !mil && rng.chance(0.35);
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      if (!inFoot(x, z)) continue;
      m.set(x, roofY, z, mat);
      if (!onEdge(x, z)) continue;
      m.set(x, roofY + 1, z, tallParapet ? mat : trim);
      if (tallParapet && (x + z) % 3 !== 0) m.set(x, roofY + 2, z, trim);
      const [ox, oz] = outward(x, z);
      if ((x * 7 + z * 3) % 11 === 0) m.set(x + ox, roofY, z + oz, M.WOOD_DOOR);
    }
  // door with frame and step (south face)
  const doorX = rng.int(X0 + 2, Math.max(X0 + 2, X1 - 4));
  m.box(doorX - 1, 1, Z1, doorX + 2, 5, Z1, trim);
  m.box(doorX, 1, Z1, doorX + 1, 4, Z1, mil ? M.METAL_DARK : M.WOOD_DOOR);
  m.box(doorX - 1, 0, Z1 + 1, doorX + 2, 0, Z1 + 1, M.CONCRETE);
  if (mil) {
    // sandbag blast walls either side of the door
    m.box(doorX - 4, 0, Z1 + 1, doorX - 2, 1, Z1 + 2, rows(M.SANDBAG, M.SANDBAG_DARK));
    m.box(doorX + 3, 0, Z1 + 1, doorX + 5, 1, Z1 + 2, rows(M.SANDBAG, M.SANDBAG_DARK));
  } else if (rng.chance(0.55)) {
    // striped awning
    const cloth = rng.pick([M.CLOTH_RED, M.CLOTH_BLUE, M.SHUTTER_GREEN]);
    for (let x = doorX - 2; x <= doorX + 3; x++) {
      const c = x % 2 ? cloth : M.CLOTH_WHITE;
      m.set(x, 6, Z1 + 1, c);
      m.set(x, 5, Z1 + 2, c);
    }
  }
  // exterior stair to the first floor (east side)
  if (!mil && floors >= 2 && rng.chance(0.45) && !lShape) {
    const zs = Z0 + 1;
    for (let i = 0; i < storey; i++) {
      m.box(X1 + 1, i, zs + i, X1 + 2, i, zs + i, mat);
      m.set(X1 + 2, i + 1, zs + i, i % 2 ? M.METAL_DARK : trim);
    }
    m.box(X1 + 1, storey, zs + storey, X1 + 2, storey, zs + storey + 2, mat);
    m.box(X1, storey + 1, zs + storey + 1, X1, storey + 4, zs + storey + 2, M.WOOD_DOOR);
  }
  // roof clutter
  const occupied = new Set<number>();
  const free = (x0: number, z0: number, x1: number, z1: number) => {
    for (let z = z0 - 1; z <= z1 + 1; z++) for (let x = x0 - 1; x <= x1 + 1; x++) if (!inFoot(x, z) || onEdge(x, z) || occupied.has(x + z * 100)) return false;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) occupied.add(x + z * 100);
    return true;
  };
  const items = rng.int(2, 4);
  for (let i = 0; i < items * 3 && occupied.size < (w * d) / 3; i++) {
    const cx = rng.int(X0 + 2, X1 - 4);
    const cz = rng.int(Z0 + 2, Z1 - 4);
    const kind = mil ? rng.pick(['ac', 'antenna', 'net', 'sandbags']) : rng.pick(['tank', 'ac', 'dish', 'kiosk', 'laundry', 'solar', 'ac']);
    const y = roofY + 1;
    if (kind === 'tank' && free(cx, cz, cx + 2, cz + 2)) {
      for (const [lx, lz] of [
        [0, 0],
        [2, 0],
        [0, 2],
        [2, 2],
      ])
        m.set(cx + lx, y, cz + lz, M.STEEL);
      m.cylinder(cx + 1, cz + 1, 1.6, y + 1, y + 3, (_x, yy) => (yy === y + 3 ? M.METAL_DARK : M.WATER_TANK));
    } else if (kind === 'ac' && free(cx, cz, cx + 2, cz + 1)) {
      m.box(cx, y, cz, cx + 2, y + 1, cz + 1, M.AC_UNIT);
      m.set(cx + 1, y + 1, cz, M.METAL_DARK);
    } else if (kind === 'dish' && free(cx, cz, cx + 2, cz + 2)) {
      m.box(cx + 1, y, cz + 1, cx + 1, y + 1, cz + 1, M.STEEL);
      m.box(cx, y + 2, cz + 2, cx + 2, y + 2, cz + 2, M.DISH);
      m.box(cx, y + 3, cz + 1, cx + 2, y + 3, cz + 1, M.DISH);
      m.set(cx + 1, y + 2, cz, M.METAL_DARK);
    } else if (kind === 'kiosk' && free(cx, cz, cx + 3, cz + 3)) {
      m.box(cx, y, cz, cx + 3, y + 3, cz + 3, mat);
      m.box(cx, y + 4, cz, cx + 3, y + 4, cz + 3, trim);
      m.box(cx + 1, y, cz + 3, cx + 2, y + 2, cz + 3, M.WOOD_DOOR);
    } else if (kind === 'laundry' && free(cx, cz, cx + 4, cz)) {
      m.box(cx, y, cz, cx, y + 2, cz, M.STEEL);
      m.box(cx + 4, y, cz, cx + 4, y + 2, cz, M.STEEL);
      for (let x = cx + 1; x < cx + 4; x++) m.set(x, y + 1, cz, rng.pick([M.CLOTH_RED, M.CLOTH_BLUE, M.CLOTH_WHITE, M.SHUTTER_GREEN]));
    } else if (kind === 'solar' && free(cx, cz, cx + 2, cz + 2)) {
      m.box(cx, y, cz + 2, cx + 2, y, cz + 2, M.GLASS);
      m.box(cx, y + 1, cz + 1, cx + 2, y + 1, cz + 1, M.GLASS);
      m.hcylinder('x', cx, cx + 2, y + 2, cz, 0.7, M.PLASTER_WHITE);
    } else if (kind === 'antenna' && free(cx, cz, cx, cz)) {
      m.box(cx, y, cz, cx, y + 7, cz, M.STEEL);
      m.box(cx - 1, y + 5, cz, cx + 1, y + 5, cz, M.STEEL);
      m.set(cx, y + 8, cz, M.LIGHT_RED);
    } else if (kind === 'net' && free(cx, cz, cx + 4, cz + 3)) {
      for (let z = cz; z <= cz + 3; z++) for (let x = cx; x <= cx + 4; x++) if (rng.chance(0.8)) m.set(x, y + 2, z, M.CAMO);
      m.set(cx, y, cz, M.STEEL);
      m.set(cx, y + 1, cz, M.STEEL);
      m.set(cx + 4, y, cz + 3, M.STEEL);
      m.set(cx + 4, y + 1, cz + 3, M.STEEL);
    } else if (kind === 'sandbags' && free(cx, cz, cx + 3, cz + 3)) {
      m.shell(cx, y, cz, cx + 3, y + 1, cz + 3, M.SANDBAG);
      m.set(cx + 1, y + 1, cz + 3, 0);
    }
  }
  // dome with a trim ring and finial
  if (!mil && rng.chance(0.18) && w >= 12 && d >= 12) {
    const r = Math.min(w, d) * 0.25;
    const cx = X0 + (lShape ? (w - cutW) / 2 : w / 2) - 0.5;
    const cz = Z1 - Math.min(w, d) / 2 + 0.5;
    m.cylinder(cx, cz, r + 0.6, roofY + 1, roofY + 1, trim);
    m.sphere(cx, roofY + 2, cz, r, M.DOME, true);
    m.box(Math.round(cx), Math.round(roofY + 2 + r), Math.round(cz), Math.round(cx), Math.round(roofY + 3 + r), Math.round(cz), M.METAL_LIGHT);
  }
  return m;
}

export function ruin(rng: RNG): VoxModel {
  const m = house(rng, { floors: rng.int(1, 2) });
  const seed = rng.int(0, 9999);
  // knock out chunks, more at the top, in noisy patches
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!v) continue;
        if (v === M.WOOD_DOOR || v === M.SHUTTER_BLUE || v === M.SHUTTER_GREEN || v === M.CLOTH_RED || v === M.CLOTH_BLUE || v === M.CLOTH_WHITE) {
          m.set(x, y, z, 0);
          continue;
        }
        const n = valueNoise(x * 0.25, z * 0.25 + y * 0.15, seed);
        if (y > 1 && n + (y / m.sy) * 0.9 > 0.95) m.set(x, y, z, 0);
        else if (y > 0 && rng.chance(0.06)) m.set(x, y, z, 0);
        else if (n > 0.7 && y > 0) m.set(x, y, z, M.SOOT);
      }
  // rubble heaps along the walls
  for (let i = 0; i < 40; i++) {
    const x = rng.int(0, m.sx - 1),
      z = rng.int(0, m.sz - 1);
    if (m.get(x, 0, z)) continue;
    m.set(x, 0, z, M.RUBBLE);
    if (rng.chance(0.4)) m.set(x, 1, z, M.RUBBLE);
  }
  return m;
}

export function hangar(rng: RNG): VoxModel {
  const len = rng.int(26, 34);
  const wid = rng.int(18, 22);
  const m = new VoxModel(wid + 4, 15, len + 4);
  const r = wid / 2;
  const cx = (wid + 3) / 2;
  const Z0 = 2,
    Z1 = len + 1;
  const hAt = (x: number) => {
    const dx = (x - cx) / r;
    return Math.sqrt(Math.max(0, 1 - dx * dx)) * 11 + 1;
  };
  for (let z = Z0; z <= Z1; z++)
    for (let x = 2; x <= wid + 1; x++) {
      const hh = hAt(x);
      // no floor slab: the ground is the floor (keeps the load-bearing mass in the walls)
      for (let y = 0; y <= hh; y++) {
        const shell = y >= hh - 1 || x === 2 || x === wid + 1;
        const endWall = z === Z0 || z === Z1;
        if (!shell && !endWall) continue;
        let v: number = M.METAL_TAN;
        if (shell && (z - Z0) % 4 === 0) v = M.TAN_DARK; // ribs
        if (shell && Math.abs(x - cx) <= 1 && (z - Z0) % 8 >= 2 && (z - Z0) % 8 <= 4 && y >= hh - 1) v = M.GLASS; // skylights
        if (endWall && !shell) v = M.METAL_TAN;
        m.set(x, y, z, v);
      }
    }
  // front: big sliding door with panel seams, hazard stripe and a header
  const dx0 = Math.floor(cx - 5),
    dx1 = Math.ceil(cx + 5);
  for (let x = dx0; x <= dx1; x++)
    for (let y = 1; y <= 8; y++) m.set(x, y, Z1, y === 1 ? ((x >> 1) % 2 ? M.YELLOW_MARK : M.METAL_DARK) : (x - dx0) % 3 === 0 ? M.METAL_LIGHT : M.METAL_DARK);
  m.box(dx0 - 1, 9, Z1, dx1 + 1, 9, Z1, M.RED_MARK);
  m.set(dx0 - 1, 9, Z1 + 1, M.LAMP);
  m.set(dx1 + 1, 9, Z1 + 1, M.LAMP);
  // personnel door + window on the front
  m.box(dx1 + 2, 1, Z1, dx1 + 2, 3, Z1, M.WOOD_DOOR);
  m.box(dx0 - 3, 3, Z1, dx0 - 2, 4, Z1, M.WINDOW);
  // back wall vents
  for (let y = 3; y <= 7; y += 2) m.box(Math.floor(cx - 2), y, Z0, Math.ceil(cx + 2), y, Z0, M.METAL_DARK);
  // buttress feet at the ribs
  for (let z = Z0; z <= Z1; z += 4) {
    m.box(1, 0, z, 1, 1, z, M.CONCRETE);
    m.box(wid + 2, 0, z, wid + 2, 1, z, M.CONCRETE);
  }
  return m;
}

export function bunker(rng: RNG): VoxModel {
  const w = rng.int(18, 24);
  const d = rng.int(16, 20);
  const m = new VoxModel(w + 6, 18, d + 6);
  const sb = rows(M.SANDBAG, M.SANDBAG_DARK);
  // sloped berm
  for (let i = 0; i < 3; i++) m.shell(i, 0, i, w + 5 - i, 3 - i, d + 5 - i, M.SANDBAG);
  m.box(0, 0, 0, w + 5, 3, d + 5, (x, y, z) => (m.get(x, y, z) ? sb(x, y, z) : -1));
  // stepped concrete block, hollow inside
  m.box(3, 0, 3, w + 2, 6, d + 2, M.CONCRETE);
  m.box(4, 1, 4, w + 1, 5, d + 1, 0);
  m.box(4, 7, 4, w + 1, 7, d + 1, M.CONCRETE);
  m.box(3, 6, 3, w + 2, 6, d + 2, (x, _y, z) => (x === 3 || z === 3 || x === w + 2 || z === d + 2 ? M.CONCRETE_DARK : -1));
  // firing slits with dark frames on all sides
  for (let x = 6; x < w; x += 4) {
    for (const z of [3, d + 2]) {
      m.box(x - 1, 3, z, x + 2, 5, z, M.CONCRETE_DARK);
      m.box(x, 4, z, x + 1, 4, z, M.WINDOW);
    }
  }
  for (let z = 7; z < d; z += 5)
    for (const x of [3, w + 2]) {
      m.box(x, 3, z - 1, x, 5, z + 1, M.CONCRETE_DARK);
      m.set(x, 4, z, M.WINDOW);
    }
  // recessed blast door with hazard stripes, berm cut away in front
  const doorX = Math.floor(w / 2);
  m.box(doorX - 1, 1, d + 2, doorX + 4, 6, d + 2, M.CONCRETE_DARK);
  m.box(doorX, 1, d + 2, doorX + 3, 5, d + 2, 0);
  m.box(doorX, 1, d + 1, doorX + 3, 5, d + 1, M.METAL_DARK);
  m.box(doorX + 1, 1, d + 1, doorX + 1, 5, d + 1, M.METAL_LIGHT);
  for (let y = 1; y <= 5; y++) {
    m.set(doorX - 1, y, d + 3, y % 2 ? M.YELLOW_MARK : M.METAL_DARK);
    m.set(doorX + 4, y, d + 3, y % 2 ? M.YELLOW_MARK : M.METAL_DARK);
  }
  m.box(doorX - 1, 0, d + 3, doorX + 4, 3, d + 5, 0);
  m.box(doorX, 0, d + 3, doorX + 3, 0, d + 5, M.CONCRETE_DARK);
  m.set(doorX + 1, 6, d + 3, M.LAMP);
  // roof: vents, antenna mast, whips, camo net
  for (let i = 0; i < 2; i++) {
    const vx = 6 + i * (w - 8),
      vz = 6;
    m.box(vx, 8, vz, vx + 1, 9, vz + 1, M.METAL_LIGHT);
    m.box(vx, 10, vz, vx + 1, 10, vz + 1, M.METAL_DARK);
  }
  const ax = w - 1,
    az = d - 1;
  m.box(ax, 8, az, ax, 16, az, M.STEEL);
  m.box(ax - 1, 12, az, ax + 1, 12, az, M.STEEL);
  m.box(ax, 14, az - 1, ax, 14, az + 1, M.STEEL);
  m.set(ax, 17, az, M.LIGHT_RED);
  for (let i = 0; i < 2; i++) m.box(8 + i * 3, 8, d - 2, 8 + i * 3, 11 + i, d - 2, M.METAL_DARK);
  for (let z = 5; z <= Math.floor(d / 2) + 2; z++)
    for (let x = 5; x <= Math.floor(w / 2) + 1; x++) if (rng.chance(0.82)) m.set(x, 9, z, rng.chance(0.3) ? M.SHRUB : M.CAMO);
  return m;
}

export function radarStation(rng: RNG): VoxModel {
  const m = new VoxModel(28, 44, 28);
  // control building: window band, door, roof parapet, AC units
  m.box(1, 0, 14, 14, 7, 25, M.CONCRETE);
  m.box(2, 1, 15, 13, 6, 24, 0);
  m.box(1, 0, 14, 14, 0, 25, M.CONCRETE_DARK);
  for (let x = 2; x <= 13; x++) m.set(x, 4, 25, (x - 2) % 3 === 2 ? M.CONCRETE_DARK : M.GLASS);
  for (let x = 2; x <= 13; x++) m.set(x, 5, 25, (x - 2) % 3 === 2 ? M.CONCRETE_DARK : M.GLASS);
  for (let z = 16; z <= 23; z++) m.set(1, 4, z, (z - 16) % 3 === 2 ? M.CONCRETE_DARK : M.GLASS);
  m.box(10, 1, 25, 11, 3, 25, M.METAL_DARK);
  m.box(9, 0, 26, 12, 0, 26, M.CONCRETE_DARK);
  m.box(1, 8, 14, 14, 8, 25, M.CONCRETE_DARK);
  m.shell(1, 9, 14, 14, 9, 25, M.TRIM);
  m.box(3, 9, 17, 5, 10, 18, M.AC_UNIT);
  m.set(4, 10, 17, M.METAL_DARK);
  m.box(8, 9, 20, 8, 13, 20, M.STEEL);
  m.set(8, 14, 20, M.LIGHT_RED);
  // generator set
  m.box(2, 0, 9, 6, 2, 11, M.METAL_OLIVE);
  m.box(2, 3, 10, 2, 4, 10, M.METAL_DARK);
  m.box(4, 1, 11, 5, 1, 11, M.YELLOW_MARK);
  // lattice tower with X-bracing on every face
  const tx = 19,
    tz = 9;
  const half = (y: number) => 4 - (y / 24) * 2.2;
  for (let y = 0; y <= 24; y++) {
    const s = Math.round(half(y));
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      m.set(tx + sx * s, y, tz + sz * s, M.STEEL);
    if (y % 6 === 0) m.shell(tx - s, y, tz - s, tx + s, y, tz + s, M.STEEL);
  }
  for (let y0 = 0; y0 < 24; y0 += 6) {
    const s0 = Math.round(half(y0)),
      s1 = Math.round(half(y0 + 6));
    for (const sgn of [-1, 1]) {
      m.line(tx - s0, y0, tz + sgn * s0, tx + s1, y0 + 6, tz + sgn * s1, M.STEEL);
      m.line(tx + s0, y0, tz + sgn * s0, tx - s1, y0 + 6, tz + sgn * s1, M.STEEL);
      m.line(tx + sgn * s0, y0, tz - s0, tx + sgn * s1, y0 + 6, tz + s1, M.STEEL);
      m.line(tx + sgn * s0, y0, tz + s0, tx + sgn * s1, y0 + 6, tz - s1, M.STEEL);
    }
  }
  // platform with railing
  m.box(tx - 3, 25, tz - 3, tx + 3, 25, tz + 3, M.METAL_DARK);
  for (let i = -3; i <= 3; i += 2) {
    m.set(tx + i, 26, tz - 3, M.STEEL);
    m.set(tx + i, 26, tz + 3, M.STEEL);
    m.set(tx - 3, 26, tz + i, M.STEEL);
    m.set(tx + 3, 26, tz + i, M.STEEL);
  }
  m.box(tx - 1, 26, tz - 1, tx + 1, 28, tz + 1, M.METAL_LIGHT);
  // parabolic dish facing south, tilted up, with back ribs and a feed horn
  const R = 8;
  const D = 2.6;
  const tilt = 0.6 + rng.range(-0.08, 0.08);
  const c = { x: tx, y: 35, z: tz + 1 };
  const n = { x: 0, y: Math.sin(tilt), z: Math.cos(tilt) }; // dish axis (concave side)
  const e2 = { x: 0, y: n.z, z: -n.y };
  const put = (u: number, v: number, off: number, mat: number) => {
    const depth = ((u * u + v * v) / (R * R)) * D + off;
    m.set(c.x + u, c.y + e2.y * v + n.y * depth, c.z + e2.z * v + n.z * depth, mat);
  };
  for (let u = -R; u <= R; u += 0.35)
    for (let v = -R; v <= R; v += 0.35) {
      const rr = u * u + v * v;
      if (rr > R * R) continue;
      const rim = rr > (R - 0.8) ** 2;
      put(u, v, 0, rim ? M.METAL_LIGHT : M.DISH);
      put(u, v, -0.6, rim ? M.METAL_LIGHT : M.DISH);
    }
  for (let a = 0; a < 8; a++) {
    const ca = Math.cos((a / 8) * Math.PI * 2),
      sa = Math.sin((a / 8) * Math.PI * 2);
    for (let t = 0; t <= R; t += 0.4) put(ca * t, sa * t, -1.2, M.METAL_DARK);
  }
  const focal = { x: c.x, y: c.y + n.y * (D + 5), z: c.z + n.z * (D + 5) };
  for (const [u, v] of [
    [0, R - 0.5],
    [R * 0.85, -R * 0.45],
    [-R * 0.85, -R * 0.45],
  ]) {
    const depth = D;
    m.line(c.x + u, c.y + e2.y * v + n.y * depth, c.z + e2.z * v + n.z * depth, focal.x, focal.y, focal.z, M.STEEL);
  }
  m.box(Math.round(focal.x), Math.round(focal.y), Math.round(focal.z), Math.round(focal.x), Math.round(focal.y) + 1, Math.round(focal.z), M.METAL_DARK);
  m.set(focal.x, focal.y + 2, focal.z, M.LIGHT_RED);
  m.box(tx, 29, tz, tx, 33, tz + 1, M.STEEL);
  return m;
}

export function fuelTank(rng: RNG, big = true): VoxModel {
  if (!big) {
    // horizontal storage tank on saddles
    const len = rng.int(9, 12);
    const r = rng.range(2.4, 3);
    const s = Math.ceil(r * 2) + 2;
    const m = new VoxModel(len + 2, s + 2, s + 2);
    const cy = r + 1.4,
      cz = (s + 1) / 2;
    m.hcylinder('x', 1, len, cy, cz, r, M.FUEL_TANK);
    m.hcylinder('x', 2, len - 1, cy, cz, r - 1, 0);
    m.hcylinder('x', Math.floor(len / 2), Math.floor(len / 2), cy, cz, r + 0.2, M.RED_MARK);
    for (const x of [2, len - 1]) m.box(x, 0, Math.floor(cz - r + 1), x, 1, Math.ceil(cz + r - 1), M.CONCRETE);
    m.box(len - 3, Math.ceil(cy + r), Math.floor(cz), len - 2, Math.ceil(cy + r), Math.floor(cz), M.METAL_DARK);
    for (let y = 0; y <= Math.ceil(cy + r); y += 1) m.set(len + 1, y, Math.floor(cz), y % 2 ? M.STEEL : M.METAL_LIGHT);
    m.box(1, 2, Math.floor(cz), 1, 2, Math.floor(cz), M.YELLOW_MARK);
    return m;
  }
  const r = rng.range(5, 6.5);
  const h = rng.int(7, 10);
  const s = Math.ceil(r * 2) + 7;
  const m = new VoxModel(s, h + 6, s);
  const c = (s - 1) / 2;
  m.cylinder(c, c, r + 1, 0, 0, M.CONCRETE, true); // footing ring
  // hollow shell (a few good hits rupture it), band near the top
  const band = Math.round(h * 0.75);
  m.cylinder(c, c, r, 1, h, (_x, y) => (y === band ? M.RED_MARK : y === band + 1 ? M.PLASTER_WHITE : M.FUEL_TANK), true);
  m.cylinder(c, c, r - 0.5, 1, 1, M.FUEL_TANK);
  // shallow domed roof with a handrail ring
  m.cylinder(c, c, r - 0.4, h + 1, h + 1, M.FUEL_TANK);
  m.cylinder(c, c, r - 2, h + 2, h + 2, M.METAL_LIGHT);
  m.cylinder(c, c, 1.2, h + 3, h + 3, M.METAL_DARK);
  for (let a = 0; a < 24; a += 2) {
    const ang = (a / 24) * Math.PI * 2;
    m.set(c + Math.cos(ang) * (r - 0.6), h + 2, c + Math.sin(ang) * (r - 0.6), M.STEEL);
  }
  // spiral stair up the side
  const a0 = rng.range(0, Math.PI * 2);
  for (let i = 0; i <= h * 2; i++) {
    const t = i / (h * 2);
    const ang = a0 + t * Math.PI * 1.1;
    const y = 1 + Math.round(t * h);
    m.set(c + Math.cos(ang) * (r + 1), y, c + Math.sin(ang) * (r + 1), M.STEEL);
    if (i % 2 === 0) m.set(c + Math.cos(ang) * (r + 1.9), y + 1, c + Math.sin(ang) * (r + 1.9), M.METAL_DARK);
  }
  // pipe + valve, hazard placard
  for (let x = Math.round(c + r); x < s; x++) m.set(x, 2, c, M.METAL_LIGHT);
  m.set(s - 2, 3, c, M.RED_MARK);
  m.set(c, Math.round(h * 0.45), c + r, M.YELLOW_MARK);
  m.set(c, Math.round(h * 0.45) + 1, c + r, M.YELLOW_MARK);
  return m;
}

export function guardTower(): VoxModel {
  const m = new VoxModel(9, 24, 9);
  // splayed legs with footings and X-bracing
  for (let y = 0; y < 15; y++) {
    const o = y < 5 ? 0 : 1;
    for (const [x, z] of [
      [o, o],
      [8 - o, o],
      [o, 8 - o],
      [8 - o, 8 - o],
    ])
      m.set(x, y, z, M.STEEL);
  }
  for (const [x, z] of [
    [0, 0],
    [8, 0],
    [0, 8],
    [8, 8],
  ])
    m.set(x, 0, z, M.CONCRETE);
  for (const y0 of [2, 8]) {
    m.line(1, y0, 1, 7, y0 + 5, 1, M.STEEL);
    m.line(7, y0, 1, 1, y0 + 5, 1, M.STEEL);
    m.line(1, y0, 7, 1, y0 + 5, 1, M.STEEL);
    m.line(7, y0, 7, 7, y0 + 5, 1, M.STEEL);
  }
  // ladder on the south face
  for (let y = 0; y < 15; y++) {
    m.set(3, y, 8, M.METAL_DARK);
    m.set(5, y, 8, M.METAL_DARK);
    if (y % 2 === 0) m.set(4, y, 8, M.METAL_DARK);
  }
  // plank platform, sandbag wall with a gap at the ladder
  m.box(0, 15, 0, 8, 15, 8, (x, _y, z) => ((x + z) % 2 ? M.CRATE : M.WOOD_DOOR));
  m.shell(0, 16, 0, 8, 17, 8, M.SANDBAG);
  m.box(0, 16, 0, 8, 17, 8, (x, y, z) => (m.get(x, y, z) ? rows(M.SANDBAG, M.SANDBAG_DARK)(x, y, z + x) : -1));
  m.box(4, 16, 8, 4, 17, 8, 0);
  // posts and corrugated roof with overhang
  for (const [x, z] of [
    [0, 0],
    [8, 0],
    [0, 8],
    [8, 8],
  ])
    m.box(x, 18, z, x, 20, z, M.STEEL);
  m.box(0, 21, 0, 8, 21, 8, (x) => (x % 2 ? M.METAL_TAN : M.TAN_DARK));
  m.box(2, 22, 2, 6, 22, 6, M.METAL_TAN);
  // searchlight
  m.set(7, 18, 7, M.METAL_LIGHT);
  m.set(7, 18, 8, M.LAMP);
  return m;
}

export function waterTower(rng: RNG): VoxModel {
  const m = new VoxModel(13, 30, 13);
  for (let y = 0; y < 17; y++) {
    const o = y < 8 ? 2 : 3;
    for (const [x, z] of [
      [o, o],
      [12 - o, o],
      [o, 12 - o],
      [12 - o, 12 - o],
    ])
      m.set(x, y, z, M.STEEL);
  }
  for (const y0 of [3, 10]) {
    m.line(2, y0, 2, 10, y0 + 6, 2, M.STEEL);
    m.line(10, y0, 2, 2, y0 + 6, 2, M.STEEL);
    m.line(2, y0, 10, 10, y0 + 6, 10, M.STEEL);
    m.line(10, y0, 10, 2, y0 + 6, 10, M.STEEL);
  }
  const col = rng.chance(0.5) ? M.PLASTER_WHITE : M.WATER_TANK;
  m.cylinder(6, 6, 5.2, 17, 17, M.METAL_DARK);
  m.cylinder(6, 6, 5, 18, 23, (_x, y) => (y === 21 ? M.SHUTTER_BLUE : col));
  m.cylinder(6, 6, 4, 24, 24, col);
  m.cylinder(6, 6, 2.5, 25, 25, col);
  m.box(6, 26, 6, 6, 27, 6, M.METAL_LIGHT);
  for (let y = 0; y <= 23; y++) m.set(6, y, 12, y % 2 ? M.METAL_DARK : M.STEEL);
  return m;
}

export function compoundWall(len: number, h: number, mat: number, crenel = true): VoxModel {
  const m = new VoxModel(len, h + 2, 2);
  const base = mat === M.MUD_BRICK ? M.SANDBAG_DARK : M.CONCRETE_DARK;
  const cap = mat === M.MUD_BRICK ? M.PLASTER_TAN : M.CONCRETE;
  m.box(0, 0, 0, len - 1, h - 1, 1, (x, y) => (y === 0 ? base : y === h - 1 ? cap : mat));
  // pillars every 8 with caps
  for (let x = 0; x < len; x += 8) {
    m.box(x, 0, 0, x, h, 1, mat);
    m.box(x, h + 1, 0, x, h + 1, 1, cap);
  }
  if (crenel) for (let x = 2; x < len; x += 4) m.box(x, h, 0, Math.min(len - 1, x + 1), h, 1, cap);
  return m;
}

export function sandbagRing(r: number, h = 3): VoxModel {
  const s = Math.ceil(r * 2) + 3;
  const m = new VoxModel(s, h, s);
  const c = (s - 1) / 2;
  m.cylinder(c, c, r, 0, h - 1, (x, y, z) => rows(M.SANDBAG, M.SANDBAG_DARK)(x, y, z + x), true);
  return m;
}

export function gunPit(r = 5): VoxModel {
  const s = Math.ceil(r * 2) + 3;
  const m = new VoxModel(s, 4, s);
  const c = (s - 1) / 2;
  m.cylinder(c, c, r - 0.5, 0, 0, M.CONCRETE);
  m.cylinder(c, c, r + 0.6, 0, 0, (x, y, z) => (m.get(x, y, z) ? -1 : M.SANDBAG_DARK));
  m.cylinder(c, c, r, 1, 2, (x, y, z) => rows(M.SANDBAG, M.SANDBAG_DARK)(x, y, z + x), true);
  // entrance gap
  m.box(Math.floor(c) - 1, 1, s - 3, Math.floor(c) + 1, 2, s - 1, 0);
  // ammo boxes against the wall
  m.box(1 + Math.floor(r * 0.3), 1, Math.floor(c) - 1, 2 + Math.floor(r * 0.3), 1, Math.floor(c), M.OLIVE_DARK);
  m.set(1 + Math.floor(r * 0.3), 1, Math.floor(c), M.YELLOW_MARK);
  return m;
}

// ---------------------------------------------------------------- nature

export function palm(rng: RNG): VoxModel {
  const h = rng.int(11, 17);
  const m = new VoxModel(23, h + 8, 23);
  const lean = rng.range(-1, 1);
  const leanZ = rng.range(-1, 1);
  let tx = 11,
    tz = 11;
  // ringed trunk with a flared base
  for (let y = 0; y < h; y++) {
    const t = y / h;
    tx = 11 + lean * t * t * 3;
    tz = 11 + leanZ * t * t * 3;
    m.set(tx, y, tz, y % 3 === 0 ? M.PALM_RING : M.PALM_TRUNK);
    if (y < 2) {
      m.set(tx + 1, y, tz, M.PALM_TRUNK);
      m.set(tx - 1, y, tz, M.PALM_TRUNK);
      m.set(tx, y, tz + 1, M.PALM_TRUNK);
      m.set(tx, y, tz - 1, M.PALM_TRUNK);
    }
  }
  const top = h;
  m.box(Math.round(tx) - 1, top - 1, Math.round(tz) - 1, Math.round(tx) + 1, top, Math.round(tz) + 1, M.PALM_LEAF_DARK);
  // coconuts tucked under the crown
  for (let i = 0; i < rng.int(2, 5); i++) {
    const a = rng.range(0, Math.PI * 2);
    m.set(tx + Math.cos(a) * 1.3, top - 2, tz + Math.sin(a) * 1.3, M.COCONUT);
  }
  // fronds: a rachis with tapering leaflets either side; an old one hangs down
  const fronds = rng.int(8, 11);
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const dead = i === 0 && rng.chance(0.7);
    const len = dead ? rng.range(3.5, 5) : rng.range(7.5, 10.5);
    const rise = dead ? -1.2 : rng.range(0.35, 0.85);
    const droop = dead ? 0.3 : rng.range(0.75, 1.2);
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const leaf = dead ? M.PALM_DEAD : i % 2 ? M.PALM_LEAF : M.PALM_LEAF_DARK;
    for (let s = 0.5; s <= len; s += 0.5) {
      const t = s / len;
      const x = tx + ca * s;
      const z = tz + sa * s;
      const y = top + 1 + len * (rise * t - droop * t * t);
      m.set(x, y, z, dead ? M.PALM_DEAD : M.PALM_LEAF_DARK);
      // leaflets alternate sides along the rachis, sweeping back and down
      if (s < 1.5 || s % 1 !== 0) continue;
      const side = s % 2 ? 1 : -1;
      const ll = Math.round((1 - t) * 2 + 0.6);
      for (let k = 1; k <= ll; k++) m.set(x - sa * side * k - ca * k * 0.35, y - k * 0.65, z + ca * side * k - sa * k * 0.35, leaf);
    }
  }
  return m;
}

export function shrub(rng: RNG): VoxModel {
  const r = rng.range(1.8, 3);
  const s = Math.ceil(r * 2) + 2;
  const m = new VoxModel(s, Math.ceil(r) + 2, s);
  const c = (s - 1) / 2;
  const dry = rng.chance(0.3);
  for (let y = 0; y <= Math.ceil(r); y++)
    for (let z = 0; z < s; z++)
      for (let x = 0; x < s; x++) {
        const d = Math.hypot(x - c, (y + 0.3) * 1.2, z - c);
        if (d > r + rng.range(-0.3, 0.5)) continue;
        if (rng.chance(0.08)) continue;
        m.set(x, y, z, dry ? (rng.chance(0.7) ? M.PALM_DEAD : M.SHRUB) : rng.chance(0.75) ? M.SHRUB : M.PALM_LEAF);
      }
  // a few twigs poking out
  for (let i = 0; i < 3; i++) m.set(c + rng.int(-2, 2), Math.ceil(r) + 1, c + rng.int(-2, 2), dry ? M.PALM_TRUNK : M.SHRUB);
  m.set(c, 0, c, M.PALM_TRUNK);
  return m;
}

export function rock(rng: RNG): VoxModel {
  const r = rng.range(1.5, 4);
  const s = Math.ceil(r * 2.4) + 2;
  const m = new VoxModel(s, Math.ceil(r * 1.2) + 2, s);
  const c = (s - 1) / 2;
  const sq = rng.range(0.55, 0.8); // squashed: desert rocks are flat-topped
  for (let i = 0; i < 4; i++) {
    const ox = c + rng.range(-1.2, 1.2),
      oz = c + rng.range(-1.2, 1.2);
    const rr = r * rng.range(0.6, 1);
    for (let y = 0; y < m.sy; y++)
      for (let z = 0; z < s; z++)
        for (let x = 0; x < s; x++) {
          if (Math.hypot(x - ox, y / sq, z - oz) > rr) continue;
          // strata bands
          m.set(x, y, z, (y + Math.floor(hash3(x >> 2, 0, z >> 2) * 2)) % 3 === 0 ? M.ROCK_DARK : M.ROCK);
        }
  }
  // a crack
  if (r > 2.5) {
    const cx = Math.round(c);
    for (let y = 1; y < m.sy; y++) m.set(cx, y, Math.round(c + rng.range(-1, 1)), 0);
  }
  return m;
}

// ---------------------------------------------------------------- props

export function crateStack(rng: RNG): VoxModel {
  const m = new VoxModel(9, 7, 9);
  // pallet
  m.box(0, 0, 0, 5, 0, 5, (x) => (x % 2 ? M.WOOD_DOOR : M.CRATE));
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const x = rng.int(0, 5),
      z = rng.int(0, 5);
    let y = 1;
    while (y < 5 && m.get(x + 1, y, z + 1)) y += 3;
    if (y > 4) continue;
    const mil = rng.chance(0.35);
    const body = mil ? M.OLIVE_DARK : M.CRATE;
    const edge = mil ? M.OLIVE_LIGHT : M.WOOD_DOOR;
    m.box(x, y, z, x + 2, y + 2, z + 2, (xx, yy, zz) => {
      const ex = xx === x || xx === x + 2,
        ey = yy === y || yy === y + 2,
        ez = zz === z || zz === z + 2;
      return (ex && ey) || (ey && ez) || (ex && ez) ? edge : body;
    });
    if (mil) m.set(x + 1, y + 1, z + 2, M.YELLOW_MARK);
  }
  return m;
}

export function barrels(rng: RNG): VoxModel {
  const m = new VoxModel(9, 4, 9);
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const x = rng.int(1, 6),
      z = rng.int(1, 6);
    const col = rng.pick([M.RED_MARK, M.OLIVE_DARK, M.RUST, M.SHUTTER_BLUE, M.METAL_TAN]);
    if (m.get(x, 0, z)) continue;
    if (rng.chance(0.25)) {
      // lying on its side
      m.box(x - 1, 0, z, x + 1, 0, z, col);
      m.set(x - 1, 0, z, M.METAL_DARK);
      continue;
    }
    m.box(x, 0, z, x + 1, 2, z + 1, (_x, y) => (y === 1 ? M.METAL_DARK : col));
    m.set(x, 3, z, M.METAL_DARK);
  }
  return m;
}

export function tent(rng: RNG): VoxModel {
  const w = rng.int(9, 11) | 1;
  const l = rng.int(10, 14);
  const m = new VoxModel(w + 4, 8, l + 2);
  const c = (w - 1) / 2 + 2;
  for (let z = 1; z <= l; z++)
    for (let x = 2; x < w + 2; x++) {
      const hh = Math.round(5 - Math.abs(x - c) * (5 / ((w - 1) / 2 + 0.5)));
      const ridge = Math.abs(x - c) < 0.6;
      m.set(x, Math.max(0, hh), z, ridge ? M.CANVAS_DARK : z % 4 === 0 ? M.CANVAS_DARK : M.TENT);
      if (z === 1 || z === l) for (let y = 0; y < hh; y++) m.set(x, y, z, M.TENT);
    }
  // door flap, poles above the ridge, guy lines to pegs
  m.box(Math.floor(c) - 1, 0, l, Math.ceil(c) + 1, 2, l, M.CANVAS_DARK);
  m.box(Math.floor(c), 0, l, Math.ceil(c), 2, l, 0);
  for (const z of [0, l + 1]) m.box(Math.round(c), 0, z, Math.round(c), 6, z, M.WOOD_DOOR);
  for (const [x, z] of [
    [0, 2],
    [w + 3, 2],
    [0, l - 1],
    [w + 3, l - 1],
  ]) {
    m.line(x, 0, z, x < c ? 2 : w + 1, 2, z, M.CANVAS_DARK);
  }
  return m;
}

export function powerPole(): VoxModel {
  const m = new VoxModel(7, 17, 3);
  m.box(3, 0, 1, 3, 15, 1, M.PALM_TRUNK);
  m.box(0, 13, 1, 6, 13, 1, M.PALM_TRUNK);
  m.line(3, 11, 1, 1, 13, 1, M.PALM_TRUNK);
  for (const x of [0, 2, 4, 6]) m.set(x, 14, 1, M.PLASTER_WHITE);
  // pole-top transformer
  m.box(3, 9, 2, 3, 11, 2, M.METAL_LIGHT);
  m.set(3, 12, 2, M.METAL_DARK);
  return m;
}

export function marketStall(rng: RNG): VoxModel {
  const m = new VoxModel(8, 7, 7);
  const cloth = rng.pick([M.CLOTH_RED, M.CLOTH_BLUE, M.SHUTTER_GREEN]);
  for (const [x, z] of [
    [0, 0],
    [7, 0],
    [0, 6],
    [7, 6],
  ])
    m.box(x, 0, z, x, z ? 4 : 5, z, M.PALM_TRUNK);
  // striped, sloped canopy with a valance
  for (let z = 0; z < 7; z++) for (let x = 0; x < 8; x++) m.set(x, 6 - Math.floor(z / 3), z, x % 2 ? cloth : M.CLOTH_WHITE);
  for (let x = 0; x < 8; x++) m.set(x, 4, 6, x % 2 ? cloth : M.CLOTH_WHITE);
  // counter with produce and sacks
  m.box(1, 0, 1, 6, 1, 2, M.CRATE);
  for (let x = 1; x <= 6; x++) m.set(x, 2, 1 + (x % 2), rng.pick([M.FRUIT_ORANGE, M.FRUIT_GREEN, M.RED_MARK, M.FRUIT_ORANGE]));
  m.box(1, 0, 4, 2, 1, 5, M.SANDBAG);
  m.set(6, 0, 4, M.SANDBAG_DARK);
  return m;
}

// ---------------------------------------------------------------- vehicles

export type VehicleKind = 'tank' | 'truck' | 'technical' | 'car' | 'apc';

/** Pair of wheels: tyre with a hub on the outer face. */
function wheels(m: VoxModel, x: number, w: number, zs: number[], h = 2) {
  for (const z of zs) {
    m.box(x, 0, z, x + w - 1, h, z, M.RUBBER);
    m.set(x + Math.floor(w / 2), Math.floor(h / 2), z, M.METAL_LIGHT);
  }
}

export interface TankParts {
  hull: VoxModel;
  turret: VoxModel;
  barrel: VoxModel;
  /** turret ring centre in hull coords (x, top y, z) */
  ring: [number, number, number];
}

/** Main battle tank, built facing +X: hull (with tracks), turret, barrel. */
export function tankParts(rng: RNG, color?: number): TankParts {
  const camoC = color ?? rng.pick([M.METAL_TAN, M.METAL_OLIVE]);
  const alt = camoC === M.METAL_TAN ? M.TAN_DARK : M.OLIVE_DARK;
  const seed = rng.int(0, 9999);
  // hull: 20 long, 13 wide, tracks on both sides
  const hull = new VoxModel(20, 6, 13);
  for (const z0 of [0, 10]) {
    hull.box(1, 0, z0, 18, 2, z0 + 2, M.TRACK);
    for (let x = 3; x <= 16; x += 3) {
      hull.set(x, 1, z0, M.METAL_DARK);
      hull.set(x, 1, z0 + 2, M.METAL_DARK);
    }
    hull.box(0, 3, z0, 19, 3, z0 + 2, camoC); // fenders
    hull.box(2, 4, z0 === 0 ? 0 : 12, 6, 4, z0 === 0 ? 0 : 12, M.CANVAS_DARK); // side stowage
  }
  hull.box(0, 1, 3, 19, 4, 9, camoC);
  hull.box(18, 4, 3, 19, 4, 9, 0); // sloped glacis
  hull.box(19, 3, 3, 19, 3, 9, alt);
  hull.set(19, 3, 3, M.LAMP);
  hull.set(19, 3, 9, M.LAMP);
  for (let x = 1; x <= 4; x++) if (x % 2) hull.box(x, 4, 4, x, 4, 8, M.METAL_DARK); // engine grille
  hull.set(0, 3, 5, M.RED_MARK);
  camo(hull, [camoC], alt, seed);
  // turret: faceted, mantlet, cupola, smoke dischargers, rear bustle rack
  const turret = new VoxModel(11, 4, 9);
  turret.box(1, 0, 0, 9, 2, 8, camoC);
  for (const [x, z] of [
    [1, 0],
    [9, 0],
    [1, 8],
    [9, 8],
  ])
    turret.set(x, 2, z, 0);
  turret.box(10, 0, 3, 10, 2, 5, alt);
  turret.box(0, 1, 1, 0, 1, 7, M.CANVAS_DARK);
  turret.box(3, 3, 1, 4, 3, 2, M.OLIVE_DARK);
  turret.set(3, 3, 2, M.METAL_DARK);
  turret.box(6, 3, 5, 6, 3, 6, M.METAL_DARK);
  turret.set(8, 2, 0, M.METAL_DARK);
  turret.set(8, 2, 8, M.METAL_DARK);
  camo(turret, [camoC], alt, seed + 1);
  // barrel with bore evacuator and muzzle brake
  const barrel = new VoxModel(11, 3, 3);
  barrel.box(0, 1, 1, 10, 1, 1, M.METAL_DARK);
  barrel.box(4, 0, 1, 5, 2, 1, alt);
  barrel.box(4, 1, 0, 5, 1, 2, alt);
  barrel.box(9, 0, 1, 10, 2, 1, M.METAL_DARK);
  return { hull, turret, barrel, ring: [9, 5, 6] };
}

/** Vehicles are built facing +X. */
export function vehicle(rng: RNG, kind: VehicleKind, wrecked = false): VoxModel {
  let m: VoxModel;
  const camoC = rng.pick([M.METAL_TAN, M.METAL_OLIVE]);
  const alt = camoC === M.METAL_TAN ? M.TAN_DARK : M.OLIVE_DARK;
  if (kind === 'tank') {
    const p = tankParts(rng, camoC);
    m = new VoxModel(30, 10, 13);
    m.blit(p.hull, 0, 0, 0);
    m.blit(p.turret, 4, 5, 2);
    m.blit(p.barrel, 15, 5, 5);
    // antenna
    m.box(6, 9, 3, 6, 9, 3, M.STEEL);
  } else if (kind === 'apc') {
    m = new VoxModel(21, 9, 11);
    for (const x of [2, 6, 11, 15]) wheels(m, x, 2, [0, 10], 2);
    m.box(0, 2, 1, 20, 5, 9, camoC);
    m.box(19, 5, 1, 20, 5, 9, 0);
    m.box(20, 4, 1, 20, 4, 9, 0); // wedge nose
    m.box(1, 3, 0, 18, 3, 0, alt);
    m.box(1, 3, 10, 18, 3, 10, alt);
    m.set(20, 3, 2, M.LAMP);
    m.set(20, 3, 8, M.LAMP);
    m.set(18, 5, 3, M.GLASS);
    m.set(18, 5, 7, M.GLASS);
    // small turret with autocannon
    m.box(9, 6, 3, 13, 7, 7, alt);
    m.box(14, 7, 5, 19, 7, 5, M.METAL_DARK);
    m.set(10, 8, 4, M.METAL_DARK);
    // rear door + hatches
    m.box(0, 3, 4, 0, 4, 6, M.METAL_DARK);
    m.box(3, 6, 2, 4, 6, 3, M.METAL_DARK);
    m.box(3, 6, 7, 4, 6, 8, M.METAL_DARK);
    m.box(4, 6, 9, 4, 8, 9, M.STEEL);
    camo(m, [camoC], alt, rng.int(0, 9999));
  } else if (kind === 'truck') {
    m = new VoxModel(22, 10, 9);
    wheels(m, 1, 3, [0, 8], 2);
    wheels(m, 5, 3, [0, 8], 2);
    wheels(m, 16, 3, [0, 8], 2);
    m.box(0, 1, 1, 20, 2, 7, M.METAL_DARK);
    // cab + hood + grille + bumper
    m.box(14, 2, 1, 17, 7, 7, camoC);
    m.box(18, 2, 1, 20, 4, 7, camoC);
    m.box(17, 5, 2, 17, 6, 6, M.GLASS);
    m.box(15, 5, 1, 16, 6, 1, M.GLASS);
    m.box(15, 5, 7, 16, 6, 7, M.GLASS);
    m.box(21, 2, 2, 21, 3, 6, M.METAL_DARK);
    m.set(21, 3, 1, M.LAMP);
    m.set(21, 3, 7, M.LAMP);
    m.box(21, 1, 1, 21, 1, 7, M.METAL_LIGHT);
    m.box(18, 5, 1, 20, 5, 7, alt);
    // cargo bed with a ribbed canvas tilt, open at the back
    m.box(0, 2, 1, 13, 2, 7, M.WOOD_DOOR);
    for (let x = 0; x <= 13; x++)
      for (let z = 1; z <= 7; z++) {
        const top = z === 1 || z === 7 ? 6 : 7;
        const v = x % 3 === 0 ? M.CANVAS_DARK : M.TENT;
        if (z === 1 || z === 7) m.box(x, 3, z, x, top, z, v);
        else m.set(x, top, z, v);
        if (x === 13) m.box(x, 3, z, x, top, z, M.TENT);
      }
    m.box(9, 1, 0, 12, 1, 0, M.METAL_LIGHT); // fuel tank
    m.set(0, 2, 1, M.RED_MARK);
    m.set(0, 2, 7, M.RED_MARK);
  } else if (kind === 'technical') {
    const paint = rng.pick([M.PLASTER_WHITE, M.METAL_TAN, M.AC_UNIT, M.SHUTTER_BLUE]);
    m = new VoxModel(16, 8, 7);
    wheels(m, 2, 2, [0, 6], 1);
    wheels(m, 11, 2, [0, 6], 1);
    m.box(0, 1, 1, 15, 2, 5, paint);
    m.box(12, 3, 1, 15, 3, 5, paint);
    m.box(15, 2, 2, 15, 2, 4, M.METAL_DARK);
    m.set(15, 2, 1, M.LAMP);
    m.set(15, 2, 5, M.LAMP);
    m.box(15, 1, 1, 15, 1, 5, M.METAL_LIGHT);
    m.box(8, 3, 1, 11, 5, 5, paint);
    m.box(11, 4, 2, 11, 4, 4, M.GLASS);
    m.box(9, 4, 1, 10, 4, 1, M.GLASS);
    m.box(9, 4, 5, 10, 4, 5, M.GLASS);
    // bed walls + pintle gun with shield
    m.box(0, 3, 1, 7, 3, 1, paint);
    m.box(0, 3, 5, 7, 3, 5, paint);
    m.box(0, 3, 1, 0, 3, 5, paint);
    m.box(4, 3, 3, 4, 5, 3, M.METAL_DARK);
    m.box(4, 6, 3, 9, 6, 3, M.METAL_DARK);
    m.box(5, 5, 2, 5, 6, 4, M.OLIVE_DARK);
    m.set(3, 4, 4, M.OLIVE_DARK);
    m.set(0, 2, 1, M.RED_MARK);
    m.set(0, 2, 5, M.RED_MARK);
  } else {
    const paint = rng.pick([M.PLASTER_WHITE, M.CLOTH_RED, M.CLOTH_BLUE, M.METAL_TAN, M.AC_UNIT, M.SHUTTER_GREEN]);
    m = new VoxModel(13, 6, 6);
    wheels(m, 1, 2, [0, 5], 1);
    wheels(m, 9, 2, [0, 5], 1);
    m.box(0, 1, 1, 12, 2, 4, paint);
    m.box(0, 1, 1, 0, 1, 4, M.METAL_LIGHT);
    m.box(12, 1, 1, 12, 1, 4, M.METAL_LIGHT);
    m.set(12, 2, 1, M.LAMP);
    m.set(12, 2, 4, M.LAMP);
    m.set(0, 2, 1, M.RED_MARK);
    m.set(0, 2, 4, M.RED_MARK);
    // cabin: pillars, glass all round, roof
    m.box(3, 3, 1, 8, 4, 4, paint);
    m.box(4, 3, 1, 7, 3, 1, M.GLASS);
    m.box(4, 3, 4, 7, 3, 4, M.GLASS);
    m.box(8, 3, 2, 8, 3, 3, M.GLASS);
    m.box(3, 3, 2, 3, 3, 3, M.GLASS);
    if (rng.chance(0.3)) m.box(4, 5, 2, 7, 5, 3, M.METAL_DARK); // roof rack
  }
  if (wrecked) wreckify(m, rng);
  return m;
}

// ---------------------------------------------------------------- FARP / special

export function helipad(size = 24, mark = true): VoxModel {
  const m = new VoxModel(size, 1, size);
  m.box(0, 0, 0, size - 1, 0, size - 1, M.PAD);
  // dashed border
  m.shell(0, 0, 0, size - 1, 0, size - 1, M.YELLOW_MARK);
  for (let i = 0; i < size; i += 4) {
    m.set(i, 0, 0, M.PAD_MARK);
    m.set(i, 0, size - 1, M.PAD_MARK);
    m.set(0, 0, i, M.PAD_MARK);
    m.set(size - 1, 0, i, M.PAD_MARK);
  }
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
  const m = new VoxModel(11, 3, 7);
  m.box(0, 0, 1, 9, 1, 5, M.RUBBER);
  m.box(1, 0, 0, 8, 1, 6, M.RUBBER);
  m.box(1, 2, 2, 8, 2, 4, M.RUBBER);
  for (let x = 2; x <= 7; x += 5) m.box(x, 2, 1, x, 2, 5, M.TRACK); // seams
  m.box(10, 0, 3, 10, 0, 3, M.METAL_DARK); // hose coupling
  m.set(10, 1, 3, M.YELLOW_MARK);
  m.set(5, 2, 3, M.YELLOW_MARK);
  return m;
}

export function windsock(): VoxModel {
  const m = new VoxModel(9, 11, 3);
  m.box(0, 0, 1, 0, 9, 1, M.STEEL);
  m.set(0, 10, 1, M.LIGHT_RED);
  m.box(1, 9, 1, 1, 9, 1, M.STEEL);
  // tapered sock, red/white bands, sagging slightly
  for (let x = 1; x < 9; x++) {
    const c = Math.floor((x - 1) / 2) % 2 ? M.CLOTH_WHITE : M.CLOTH_RED;
    const y = 8 - Math.floor(x / 4);
    m.set(x, y, 1, c);
    if (x < 5) {
      m.set(x, y - 1, 1, c);
      m.set(x, y, 0, c);
      m.set(x, y, 2, c);
    }
  }
  return m;
}

export function lightPost(): VoxModel {
  const m = new VoxModel(3, 7, 3);
  m.set(1, 0, 1, M.CONCRETE);
  m.box(1, 1, 1, 1, 5, 1, M.STEEL);
  m.set(1, 6, 1, M.LIGHT_GREEN);
  return m;
}

/** Downed friendly helicopter, the rescue marker. */
export function heliWreck(rng: RNG): VoxModel {
  const m = new VoxModel(32, 10, 18);
  const B = M.OLIVE_DARK;
  // fuselage on its side-ish, nose to +X
  m.box(9, 0, 6, 21, 4, 11, B);
  m.box(10, 5, 7, 19, 5, 10, B);
  m.box(22, 0, 7, 24, 3, 10, B);
  m.box(25, 1, 8, 25, 2, 9, M.METAL_DARK);
  // shattered canopy
  m.box(17, 4, 7, 22, 5, 10, M.GLASS);
  for (let i = 0; i < 6; i++) m.set(rng.int(17, 22), rng.int(4, 5), rng.int(7, 10), M.SOOT);
  // engine housings + exhaust soot
  m.box(11, 5, 5, 16, 6, 6, M.METAL_OLIVE);
  m.box(11, 5, 11, 16, 6, 12, M.METAL_OLIVE);
  m.box(10, 5, 5, 10, 6, 6, M.SOOT);
  // one stub wing with a rocket pod, the other snapped
  m.box(13, 3, 1, 16, 3, 5, B);
  m.hcylinder('x', 12, 17, 2, 2, 1, M.METAL_OLIVE);
  m.box(13, 3, 12, 14, 3, 13, B);
  // snapped tail boom lying at an angle, with its fin
  m.line(8, 2, 9, 1, 1, 14, B, 0.6);
  m.box(0, 1, 13, 1, 6, 15, B);
  m.box(0, 2, 12, 1, 2, 16, B);
  // rotor blades: one bent over, one in the sand
  m.line(13, 7, 8, 24, 6, 2, M.METAL_DARK);
  m.line(12, 7, 9, 6, 8, 2, M.METAL_DARK);
  m.line(16, 1, 13, 27, 0, 16, M.METAL_DARK);
  m.box(13, 6, 8, 14, 7, 9, M.METAL_LIGHT); // rotor head
  // skid
  m.box(10, 0, 4, 20, 0, 4, M.METAL_DARK);
  camo(m, [B], M.HELI_DARK, rng.int(0, 9999), 0.3, 0.55);
  for (let i = 0; i < m.data.length; i++) if (m.data[i] && rng.chance(0.12)) m.data[i] = rng.chance(0.5) ? M.SOOT : M.WRECK;
  return m;
}
