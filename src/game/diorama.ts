import * as THREE from 'three';
import { RNG, clamp, fbm, lerp, smoothstep } from '../core/rng';
import { M, MAT_B, MAT_G, MAT_NOISE, MAT_R, MAT_TERRAIN } from '../voxel/materials';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { CS_SHIFT } from '../voxel/world';
import type { MapData } from '../world/mapTypes';
import { FORCE_AIR } from '../world/voxModel';
import type { Atmosphere, AtmosphereId } from './atmosphere';

// The sector as a miniature: a slab of desert hanging in the air.
//
//  * slab     - layered cliff below the map edge and a ragged underside that
//               tapers inward, plus a few loose rocks drifting beside it
//  * clouds   - blocky clouds far below, so the edge has something to fall into
//  * far model- the whole map at a quarter of the resolution, for the opening
//               shot. Voxel chunks only exist around the helipad; the far model
//               covers every chunk column outside that disc and never overlaps it
//  * backdrop - the sky deepens below the horizon, so the void under the board
//               reads as air rather than as more haze
//  * floor    - a haze-coloured sheet inside the slab: where chunks have not
//               streamed in yet you see haze, never the void through the map

/** Colour the sky falls away to beneath the board. */
const ABYSS: Record<AtmosphereId, number> = {
  day: 0x8195a6,
  dusk: 0x6b5a7e,
  night: 0x2f3d68, // lighter than the night sky: moonlit haze, so the dark cliffs stand out against it
  storm: 0x94703f,
  dawn: 0x7e84a8,
};

/** Rock layers from the map floor downward: [thickness in voxels, colour]. */
const STRATA: [number, number][] = [
  [5, 0x8a6a48],
  [4, 0xa47c54],
  [7, 0x7c5c42],
  [3, 0x9c7652],
  [9, 0x6f523c],
  [4, 0x88654b],
  [11, 0x5f4735],
  [5, 0x765843],
  [14, 0x54402f],
  [6, 0x674b3b],
];
const STRATA_DEEP: [number, number][] = [
  [17, 0x574333],
  [7, 0x69503d],
];
const ROCK_NOISE = 40; // per-voxel brightness jitter, as a normalised byte

/** Collects axis-aligned quads in the vertex layout the voxel material expects. */
class QuadBuilder {
  private pos = new Float32Array(3 * 8192);
  private nrm = new Int8Array(3 * 8192);
  private col = new Uint8Array(3 * 8192);
  private noi = new Uint8Array(8192);
  private n = 0;

  private reserve() {
    if (this.n + 4 <= this.noi.length) return;
    const cap = this.noi.length * 2;
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos);
    this.pos = pos;
    const nrm = new Int8Array(cap * 3);
    nrm.set(this.nrm);
    this.nrm = nrm;
    const col = new Uint8Array(cap * 3);
    col.set(this.col);
    this.col = col;
    const noi = new Uint8Array(cap);
    noi.set(this.noi);
    this.noi = noi;
  }

  /**
   * A rectangle facing along `axis` (0 = x, 1 = y, 2 = z) in direction `sign`,
   * lying in the plane `at`. (u, v) are the two remaining axes in x, y, z order.
   */
  rect(axis: 0 | 1 | 2, sign: 1 | -1, at: number, u0: number, v0: number, u1: number, v1: number, color: number, noise: number, shade = 1) {
    this.reserve();
    const us = [u0, u1, u1, u0];
    const vs = [v0, v0, v1, v1];
    // corner order 0-1-2-3 faces +x, -y and +z; reverse it for the other three
    const flip = axis === 1 ? sign > 0 : sign < 0;
    const r = ((color >> 16) & 255) * shade;
    const g = ((color >> 8) & 255) * shade;
    const b = (color & 255) * shade;
    for (let k = 0; k < 4; k++) {
      const q = flip ? (4 - k) & 3 : k;
      const p = this.n * 3;
      if (axis === 0) {
        this.pos[p] = at;
        this.pos[p + 1] = us[q];
        this.pos[p + 2] = vs[q];
      } else if (axis === 1) {
        this.pos[p] = us[q];
        this.pos[p + 1] = at;
        this.pos[p + 2] = vs[q];
      } else {
        this.pos[p] = us[q];
        this.pos[p + 1] = vs[q];
        this.pos[p + 2] = at;
      }
      this.nrm[p] = axis === 0 ? sign * 127 : 0;
      this.nrm[p + 1] = axis === 1 ? sign * 127 : 0;
      this.nrm[p + 2] = axis === 2 ? sign * 127 : 0;
      this.col[p] = r;
      this.col[p + 1] = g;
      this.col[p + 2] = b;
      this.noi[this.n] = noise;
      this.n++;
    }
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, top: number, side: number, noise: number, shade = 1) {
    this.rect(1, 1, y1, x0, z0, x1, z1, top, noise, shade);
    this.rect(1, -1, y0, x0, z0, x1, z1, side, noise, shade * 0.6);
    this.rect(0, -1, x0, y0, z0, y1, z1, side, noise, shade);
    this.rect(0, 1, x1, y0, z0, y1, z1, side, noise, shade);
    this.rect(2, -1, z0, x0, y0, x1, y1, side, noise, shade);
    this.rect(2, 1, z1, x0, y0, x1, y1, side, noise, shade);
  }

  build(): THREE.BufferGeometry {
    const n = this.n;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, n * 3), 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    geo.setAttribute('aNoise', new THREE.BufferAttribute(this.noi.slice(0, n), 1, true));
    const quads = n >> 2;
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const i = q * 6;
      idx[i] = v;
      idx[i + 1] = v + 1;
      idx[i + 2] = v + 2;
      idx[i + 3] = v;
      idx[i + 4] = v + 2;
      idx[i + 5] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Layer boundaries by depth below the map floor. */
class Strata {
  readonly ends: number[] = [];
  readonly colors: number[] = [];

  constructor(scale: number, maxDepth: number) {
    let d = 0;
    const add = (t: number, c: number) => {
      d += Math.max(2, Math.round(t * scale));
      this.ends.push(d);
      this.colors.push(c);
    };
    for (const [t, c] of STRATA) add(t, c);
    for (let i = 0; d < maxDepth; i++) add(STRATA_DEEP[i % 2][0], STRATA_DEEP[i % 2][1]);
  }

  /** Index of the layer at a depth. */
  at(d: number): number {
    let i = 0;
    while (i < this.ends.length - 1 && this.ends[i] <= d) i++;
    return i;
  }
}

/** Depth of the slab at its rim and the extra depth of its belly, for a map size. */
function slabDepths(S: number) {
  return { rim: Math.round(S * 0.042), belly: S * 0.17 };
}

/**
 * The body of the board below y = 0: one column per cell, deeper towards the
 * middle, with a wall wherever a column hangs lower than its neighbour.
 */
function buildSlab(S: number, seed: number): THREE.BufferGeometry {
  const c = S <= 1024 ? 8 : 16;
  const n = S / c;
  const { rim, belly } = slabDepths(S);
  const s = 768 / S; // noise is laid out in board-relative units
  const full = rim + belly;
  const strata = new Strata(Math.max(1, S / 900), full * 2.6);
  const depth = new Int16Array(n * n);
  const jitter = new Int8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * c;
      const z = (j + 0.5) * c;
      const edge = Math.min(x, z, S - x, S - z);
      const prof = 1 - Math.pow(1 - clamp(edge / (S * 0.2), 0, 1), 2.2);
      const broad = fbm(x * s * 0.02, z * s * 0.02, seed + 7, 3);
      const fine = fbm(x * s * 0.075, z * s * 0.075, seed + 19, 2);
      let d = rim * (0.8 + 0.45 * fine) + belly * prof * (0.7 + 0.6 * broad);
      // hanging spikes
      if (fine > 0.62) d += (fine - 0.62) * belly * 1.4 * (0.3 + prof);
      depth[i + j * n] = Math.max(4, Math.round(d / 2) * 2);
      jitter[i + j * n] = Math.round((fbm(x * s * 0.03, z * s * 0.03, seed + 33, 2) - 0.5) * 12);
    }

  const qb = new QuadBuilder();
  const shadeAt = (d: number) => lerp(1, 0.64, smoothstep(0, full, d));
  const wall = (axis: 0 | 2, sign: 1 | -1, at: number, a0: number, a1: number, top: number, bot: number, jit: number) => {
    let d = top;
    while (d < bot) {
      const b = strata.at(d + jit);
      let d1 = Math.min(bot, strata.ends[b] - jit);
      if (d1 <= d) d1 = bot;
      const shade = shadeAt((d + d1) / 2);
      if (axis === 0) qb.rect(0, sign, at, -d1, a0, -d, a1, strata.colors[b], ROCK_NOISE, shade);
      else qb.rect(2, sign, at, a0, -d1, a1, -d, strata.colors[b], ROCK_NOISE, shade);
      d = d1;
    }
  };
  const depthAt = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? 0 : depth[i + j * n]);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      const d = depth[k];
      const jit = jitter[k];
      const x0 = i * c,
        x1 = x0 + c,
        z0 = j * c,
        z1 = z0 + c;
      qb.rect(1, -1, -d, x0, z0, x1, z1, strata.colors[strata.at(d + jit)], ROCK_NOISE, shadeAt(d) * 0.6);
      let nd = depthAt(i - 1, j);
      if (d > nd) wall(0, -1, x0, z0, z1, nd, d, jit);
      nd = depthAt(i + 1, j);
      if (d > nd) wall(0, 1, x1, z0, z1, nd, d, jit);
      nd = depthAt(i, j - 1);
      if (d > nd) wall(2, -1, z0, x0, x1, nd, d, jit);
      nd = depthAt(i, j + 1);
      if (d > nd) wall(2, 1, z1, x0, x1, nd, d, jit);
    }
  return qb.build();
}

/** Loose rocks hanging beside and below the rim, in a few groups that bob separately. */
function buildRocks(S: number, seed: number, groups: number): THREE.BufferGeometry[] {
  const rng = new RNG(seed * 13 + 5);
  const { rim, belly } = slabDepths(S);
  const strata = new Strata(Math.max(1, S / 900), rim + belly);
  const builders = Array.from({ length: groups }, () => new QuadBuilder());
  const count = Math.round(12 + S / 80);
  const snap = (v: number) => Math.round(v / 2) * 2;
  for (let r = 0; r < count; r++) {
    const qb = builders[r % groups];
    const side = rng.int(0, 3);
    const along = rng.range(0.04, 0.96) * S;
    const out = rng.range(-0.015, 0.085) * S;
    const cx = side === 2 ? -out : side === 3 ? S + out : along;
    const cz = side === 0 ? S + out : side === 1 ? -out : along;
    const cy = -(rim * 0.5 + rng.range(0.04, 0.62) * belly);
    const size = rng.range(0.011, 0.034) * S;
    const sandy = rng.chance(0.35);
    // an upside-down stack: widest on top, narrowing below, like a crumb of the slab
    let w = size,
      d = size * rng.range(0.6, 1.1),
      y = cy,
      ox = 0,
      oz = 0;
    const layers = rng.int(2, 4);
    for (let l = 0; l < layers; l++) {
      const h = Math.max(2, size * rng.range(0.28, 0.5));
      const col = strata.colors[strata.at(-y + l * 6)];
      const top = l === 0 && sandy ? 0xd9b27a : col;
      qb.box(snap(cx + ox - w / 2), snap(y - h), snap(cz + oz - d / 2), snap(cx + ox + w / 2), snap(y), snap(cz + oz + d / 2), top, col, ROCK_NOISE, 0.92 - l * 0.1);
      y -= h;
      ox += rng.range(-0.18, 0.18) * w;
      oz += rng.range(-0.18, 0.18) * d;
      w *= rng.range(0.5, 0.72);
      d *= rng.range(0.5, 0.72);
      if (w < 3 || d < 3) break;
    }
  }
  return builders.map((b) => b.build());
}

/** What stands on the side of a column of the far model. */
function sideMaterial(m: number, step: number): number {
  if (!MAT_TERRAIN[m] || step <= 1) return m;
  if (m === M.ROCK || m === M.ROCK_DARK) return M.ROCK;
  if (m === M.SAND || m === M.SAND_DARK || m === M.GREEN_GRASS || m === M.WATER || m === M.SCORCH) return M.SAND;
  return M.ROCK_DARK; // roads and pads sit on a dark base
}

const matColor = (m: number) => (MAT_R[m] << 16) | (MAT_G[m] << 8) | MAT_B[m];

/** Foliage that hangs in the air on a thin trunk: drawn as a floating tile, not a pillar down to the ground. */
const CANOPY = new Set<number>([M.PALM_LEAF, M.PALM_LEAF_DARK, M.PALM_DEAD, M.COCONUT, M.FRUIT_ORANGE, M.FRUIT_GREEN]);

/**
 * The map as blocky columns, one per 4 (or 8) voxels: terrain height from the
 * heightmap, with whatever a prefab puts on top sampled at the column centre.
 * Columns inside chunk columns for which `isReal` is true are left out.
 */
function buildFarModel(map: MapData, isReal: (cx: number, cz: number) => boolean): THREE.BufferGeometry {
  const S = map.size;
  const c = S <= 1024 ? 4 : 8;
  const n = S / c;
  const half = c >> 1;
  const { heights, surface } = map;
  const topH = new Uint8Array(n * n);
  const topM = new Uint8Array(n * n);
  const capTop = new Uint8Array(n * n);
  const capBot = new Uint8Array(n * n);
  const capM = new Uint8Array(n * n);
  const skip = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      if (isReal((i * c) >> CS_SHIFT, (j * c) >> CS_SHIFT)) {
        skip[k] = 1;
        continue;
      }
      // the tallest voxel column in the cell, so nothing shows through at the seam with real chunks
      let h = 0;
      for (let dz = 0; dz < c; dz++) {
        const row = (j * c + dz) * S + i * c;
        for (let dx = 0; dx < c; dx++) if (heights[row + dx] > h) h = heights[row + dx];
      }
      topH[k] = h;
      topM[k] = surface[i * c + half + (j * c + half) * S];
    }
  for (const st of map.stamps) {
    const i0 = Math.max(0, Math.ceil((st.x - half) / c));
    const i1 = Math.min(n - 1, Math.floor((st.x + st.sx - 1 - half) / c));
    const j0 = Math.max(0, Math.ceil((st.z - half) / c));
    const j1 = Math.min(n - 1, Math.floor((st.z + st.sz - 1 - half) / c));
    const layer = st.sx * st.sz;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = i + j * n;
        if (skip[k]) continue;
        const col = i * c + half - st.x + (j * c + half - st.z) * st.sx;
        for (let y = st.sy - 1; y >= 0; y--) {
          const m = st.data[col + y * layer];
          if (m === 0 || m === FORCE_AIR) continue;
          const top = Math.min(255, st.y + y + 1);
          if (CANOPY.has(m)) {
            let yb = y;
            while (yb > 0 && st.data[col + (yb - 1) * layer] !== 0 && st.data[col + (yb - 1) * layer] !== FORCE_AIR) yb--;
            if (st.y + yb > topH[k] + 1) {
              if (top > capTop[k]) {
                capTop[k] = top;
                capBot[k] = st.y + yb;
                capM[k] = m;
              }
              break;
            }
          }
          if (top > topH[k]) {
            topH[k] = top;
            topM[k] = m;
          }
          break;
        }
      }
  }

  const qb = new QuadBuilder();
  // tops, merged along each row
  for (let j = 0; j < n; j++) {
    let i = 0;
    while (i < n) {
      const k = i + j * n;
      if (skip[k]) {
        i++;
        continue;
      }
      const h = topH[k];
      const m = topM[k];
      let e = i + 1;
      while (e < n && !skip[e + j * n] && topH[e + j * n] === h && topM[e + j * n] === m) e++;
      qb.rect(1, 1, h, i * c, j * c, e * c, (j + 1) * c, matColor(m), MAT_NOISE[m]);
      i = e;
    }
  }
  // sides: -1 = off the board, 0 = a real chunk column (always walled off), else the neighbour's top
  const neighbour = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? -1 : skip[i + j * n] ? 0 : topH[i + j * n]);
  const side = (axis: 0 | 2, sign: 1 | -1, at: number, a0: number, a1: number, y0: number, y1: number, m: number) => {
    if (axis === 0) qb.rect(0, sign, at, y0, a0, y1, a1, matColor(m), MAT_NOISE[m]);
    else qb.rect(2, sign, at, a0, y0, a1, y1, matColor(m), MAT_NOISE[m]);
  };
  const face = (axis: 0 | 2, sign: 1 | -1, at: number, a0: number, a1: number, h: number, m: number, hn: number) => {
    if (hn < 0) {
      // the cut edge of the board, layered like the voxel terrain
      const rocky = m === M.ROCK || m === M.ROCK_DARK;
      const mid = Math.max(1, h - 4);
      side(axis, sign, at, a0, a1, 0, 1, M.BEDROCK);
      if (mid > 1) side(axis, sign, at, a0, a1, 1, mid, rocky ? M.ROCK : M.SAND_DARK);
      if (h > mid) side(axis, sign, at, a0, a1, mid, h, sideMaterial(m, 2));
    } else if (h > hn) side(axis, sign, at, a0, a1, hn, h, sideMaterial(m, h - hn));
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      if (skip[k]) continue;
      const h = topH[k];
      const m = topM[k];
      const x0 = i * c,
        x1 = x0 + c,
        z0 = j * c,
        z1 = z0 + c;
      face(0, -1, x0, z0, z1, h, m, neighbour(i - 1, j));
      face(0, 1, x1, z0, z1, h, m, neighbour(i + 1, j));
      face(2, -1, z0, x0, x1, h, m, neighbour(i, j - 1));
      face(2, 1, z1, x0, x1, h, m, neighbour(i, j + 1));
      if (capTop[k] > h) qb.box(x0, capBot[k], z0, x1, capTop[k], z1, matColor(capM[k]), matColor(capM[k]), MAT_NOISE[capM[k]]);
    }
  return qb.build();
}

/** Blocky clouds: a wide field far below the board and a ring of wisps near its rim. */
function buildClouds(S: number, seed: number): THREE.InstancedMesh {
  const rng = new RNG(seed * 29 + 11);
  const g = S / 96; // clouds are made of big voxels
  const snap = (v: number) => Math.max(g, Math.round(v / g) * g);
  const parts: number[] = []; // x, y, z, sx, sy, sz
  const cloud = (x: number, y: number, z: number, w: number, lobes: number) => {
    const turned = rng.chance(0.5);
    const put = (dx: number, dy: number, dz: number, sx: number, sy: number, sz: number) => {
      if (turned) parts.push(x + dz, y + dy, z + dx, snap(sz), snap(sy), snap(sx));
      else parts.push(x + dx, y + dy, z + dz, snap(sx), snap(sy), snap(sz));
    };
    put(0, 0, 0, w, w * 0.16, w * 0.6);
    for (let l = 0; l < lobes; l++) {
      const up = l % 2 === 0;
      const lw = w * rng.range(0.34, 0.56);
      put(rng.range(-0.34, 0.34) * w, (up ? 0.15 : -0.02) * w, rng.range(-0.2, 0.2) * w, lw, w * rng.range(0.12, 0.2), lw * rng.range(0.6, 0.9));
    }
  };
  // the field: denser close to the board, thinning out with distance
  for (let i = 0; i < 64; i++) {
    const r = S * lerp(0.75, 4.6, Math.pow(rng.next(), 0.8));
    const a = rng.range(0, Math.PI * 2);
    cloud(S / 2 + Math.cos(a) * r, -S * rng.range(0.3, 0.62), S / 2 + Math.sin(a) * r, S * rng.range(0.1, 0.3), rng.int(3, 6));
  }
  // wisps hugging the rim, so there is always something below the edge in play
  for (let i = 0; i < 24; i++) {
    const side = rng.int(0, 3);
    const along = rng.range(-0.15, 1.15) * S;
    const out = rng.range(0.07, 0.5) * S;
    const x = side === 2 ? -out : side === 3 ? S + out : along;
    const z = side === 0 ? S + out : side === 1 ? -out : along;
    cloud(x, -S * rng.range(0.07, 0.26), z, S * rng.range(0.045, 0.11), rng.int(2, 3));
  }
  const count = parts.length / 6;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), count);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const p = i * 6;
    m4.makeScale(parts[p + 3], parts[p + 4], parts[p + 5]);
    m4.setPosition(parts[p], parts[p + 1], parts[p + 2]);
    mesh.setMatrixAt(i, m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function buildBackdrop(atmo: Atmosphere): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: new THREE.Color(atmo.sky) },
      uDeep: { value: new THREE.Color(ABYSS[atmo.id]) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        // rotate with the camera but never move: always drawn at the far plane
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSky;
      uniform vec3 uDeep;
      varying vec3 vDir;
      void main() {
        float down = -normalize(vDir).y;
        gl_FragColor = vec4(mix(uSky, uDeep, smoothstep(0.02, 0.8, down)), 1.0);
      }`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

export class Diorama {
  readonly group = new THREE.Group();
  private material = createVoxelMaterial();
  private rockMaterial = createVoxelMaterial({ localHash: true });
  private farModel: THREE.Mesh | null;
  private rocks: THREE.Mesh[] = [];
  private clouds: THREE.InstancedMesh;
  private driftVel = new THREE.Vector3();
  private maxDrift: number;
  private t = 0;
  private far = -1;

  /**
   * @param wind surface wind; the clouds drift with it
   * @param isReal chunk columns that are drawn as voxel chunks during the far view
   */
  constructor(map: MapData, atmo: Atmosphere, wind: THREE.Vector3, isReal: (cx: number, cz: number) => boolean) {
    const S = map.size;
    this.group.name = 'diorama';

    const slab = new THREE.Mesh(buildSlab(S, map.seed), this.material);
    this.fix(slab);
    this.group.add(slab);

    buildRocks(S, map.seed, 3).forEach((geo) => {
      const m = new THREE.Mesh(geo, this.rockMaterial);
      this.rocks.push(m);
      this.group.add(m);
    });

    this.clouds = buildClouds(S, map.seed);
    this.group.add(this.clouds);
    this.driftVel.copy(wind).setY(0);
    this.driftVel.setLength(clamp(wind.length() * 0.8, 2, 10));
    this.maxDrift = S * 2.5;

    const farModel = new THREE.Mesh(buildFarModel(map, isReal), this.material);
    farModel.castShadow = true;
    farModel.receiveShadow = true;
    this.fix(farModel);
    this.group.add(farModel);
    this.farModel = farModel;

    this.group.add(buildBackdrop(atmo));

    // sits inside the bedrock layer, under the lowest ground
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ color: atmo.sky, fog: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(S / 2, 1, S / 2);
    this.fix(floor);
    this.group.add(floor);
    this.setFar(0);
  }

  private fix(m: THREE.Mesh) {
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }

  /** 1 = the opening shot of the whole board, 0 = the normal game camera (the far model is put away). */
  setFar(k: number) {
    if (k === this.far) return;
    this.far = k;
    if (this.farModel) this.farModel.visible = k > 0;
  }

  /** Free the far model. A sector that has been flown in never shows the opening shot again. */
  dropFarModel() {
    if (!this.farModel) return;
    this.group.remove(this.farModel);
    this.farModel.geometry.dispose();
    this.farModel = null;
  }

  update(dt: number) {
    this.t += dt;
    this.rocks.forEach((r, i) => (r.position.y = Math.sin(this.t * (0.35 + i * 0.07) + i * 2.1) * 2.5));
    if (this.clouds.position.length() < this.maxDrift) this.clouds.position.addScaledVector(this.driftVel, dt);
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      if (m.material !== this.material && m.material !== this.rockMaterial) (m.material as THREE.Material).dispose();
    });
    this.material.dispose();
    this.rockMaterial.dispose();
    this.clouds.dispose();
  }
}
