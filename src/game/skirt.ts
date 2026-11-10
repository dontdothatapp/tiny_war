import * as THREE from 'three';
import { M, MAT_B, MAT_G, MAT_NOISE, MAT_R } from '../voxel/materials';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { EDGE_LEVEL } from '../world/generator';
import type { MapData } from '../world/mapTypes';

/** How far the open desert runs past the sector border: beyond the fog from anywhere you can fly. */
const REACH = 900;
const material = createVoxelMaterial();

/** Parameters where the segment a→b enters and leaves the square [0, S]², or null if it misses it. */
function clip(ax: number, az: number, bx: number, bz: number, S: number): [number, number] | null {
  let t0 = 0,
    t1 = 1;
  const dx = bx - ax,
    dz = bz - az;
  for (const [p, q] of [
    [-dx, ax],
    [dx, S - ax],
    [-dz, az],
    [dz, S - az],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * The open desert around the sector. The voxel world stops at the border; this
 * is a flat apron at the level the terrain eases down to there, in the same
 * dithered sand, with the highway and the river carried on across it. It has
 * no collision: the aircraft is turned back before it gets there.
 */
export function buildSkirt(map: MapData): THREE.Mesh {
  const S = map.size;
  const E = REACH;
  const pos: number[] = [];
  const col: number[] = [];
  const noise: number[] = [];
  const idx: number[] = [];
  const quad = (pts: [number, number][], y: number, mat: number) => {
    const b = pos.length / 3;
    for (const [x, z] of pts) {
      pos.push(x, y, z);
      col.push(MAT_R[mat], MAT_G[mat], MAT_B[mat]);
      noise.push(MAT_NOISE[mat]);
    }
    // wind it to face up whichever way the corners were listed
    const [a, c, d] = [pts[0], pts[1], pts[2]];
    const up = (c[1] - a[1]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[1] - a[1]) > 0;
    if (up) idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  const y = EDGE_LEVEL;
  quad([[-E, -E], [-E, 0], [S + E, 0], [S + E, -E]], y, M.SAND);
  quad([[-E, S], [-E, S + E], [S + E, S + E], [S + E, S]], y, M.SAND);
  quad([[-E, 0], [-E, S], [0, S], [0, 0]], y, M.SAND);
  quad([[S, 0], [S, S], [S + E, S], [S + E, 0]], y, M.SAND);

  /** Carry a road or river on from the border point (px, pz) in the unit direction (dx, dz). */
  const strip = (px: number, pz: number, dx: number, dz: number, half: number, yy: number, mat: number) => {
    // the near end lies along the border, so it meets the map without a gap
    const acrossZ = px < 0.5 || px > S - 0.5;
    const k = half / Math.max(0.25, Math.abs(acrossZ ? dx : dz));
    const near: [number, number][] = acrossZ
      ? [
          [px, pz - k],
          [px, pz + k],
        ]
      : [
          [px - k, pz],
          [px + k, pz],
        ];
    const nx = -dz,
      nz = dx;
    const far = (n: [number, number]): [number, number] => {
      const side = Math.sign((n[0] - px) * nx + (n[1] - pz) * nz) || 1;
      return [px + dx * E + nx * half * side, pz + dz * E + nz * half * side];
    };
    quad([near[0], near[1], far(near[1]), far(near[0])], yy, mat);
  };
  /** Strips for both ends of a line that runs through the sector and out of it. */
  const carry = (ax: number, az: number, bx: number, bz: number, ends: 'a' | 'b' | 'both', draw: (px: number, pz: number, dx: number, dz: number) => void) => {
    const t = clip(ax, az, bx, bz, S);
    if (!t) return;
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len,
      uz = (bz - az) / len;
    if (ends !== 'b' && t[0] > 0) draw(ax + (bx - ax) * t[0], az + (bz - az) * t[0], -ux, -uz);
    if (ends !== 'a' && t[1] < 1) draw(ax + (bx - ax) * t[1], az + (bz - az) * t[1], ux, uz);
  };
  for (const rd of map.roads) carry(rd.ax, rd.az, rd.bx, rd.bz, 'both', (px, pz, dx, dz) => strip(px, pz, dx, dz, rd.w + 0.5, y + 0.03, M.ASPHALT));
  const rv = map.river;
  const water = (px: number, pz: number, dx: number, dz: number) => {
    strip(px, pz, dx, dz, 10, y + 0.01, M.GREEN_GRASS);
    strip(px, pz, dx, dz, 4, y + 0.02, M.WATER);
  };
  const inside = (p: { x: number; z: number }) => p.x >= 0 && p.x <= S && p.z >= 0 && p.z <= S;
  for (let i = 0; i < rv.length - 1; i++) {
    if (!inside(rv[i]) && inside(rv[i + 1])) {
      carry(rv[i].x, rv[i].z, rv[i + 1].x, rv[i + 1].z, 'a', water);
      break;
    }
  }
  for (let i = rv.length - 1; i > 0; i--) {
    if (!inside(rv[i]) && inside(rv[i - 1])) {
      carry(rv[i - 1].x, rv[i - 1].z, rv[i].x, rv[i].z, 'b', water);
      break;
    }
  }

  const n = pos.length / 3;
  const normal = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) normal[i * 3 + 1] = 127;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true));
  geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  geo.setAttribute('aNoise', new THREE.BufferAttribute(new Uint8Array(noise), 1, true));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'skirt';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
