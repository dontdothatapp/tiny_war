import * as THREE from 'three';
import { MAT_B, MAT_G, MAT_NOISE, MAT_R } from './materials';
import { CS, CS_MASK, CS_SHIFT, VoxelWorld, vidx } from './world';

// Greedy mesher with per-vertex ambient occlusion.
// Works on a padded volume (1 voxel border on every side) so it can be used for
// world chunks (border = neighbour chunks) and for standalone voxel models.

const AO_CURVE = [0.6, 0.74, 0.87, 1.0];
const MAX_QUADS = 120000;

// Scratch output buffers, reused between calls (meshing is single threaded).
const sPos = new Uint8Array(MAX_QUADS * 4 * 3);
const sNrm = new Int8Array(MAX_QUADS * 4 * 3);
const sCol = new Uint8Array(MAX_QUADS * 4 * 3);
const sNoi = new Uint8Array(MAX_QUADS * 4);
const sIdx = new Uint32Array(MAX_QUADS * 6);
let mask = new Int32Array(64 * 64);

export interface MeshData {
  position: Uint8Array;
  normal: Int8Array;
  color: Uint8Array;
  noise: Uint8Array;
  index: Uint16Array | Uint32Array;
  quads: number;
}

/**
 * @param vol padded volume, index = x + z*px + y*px*pz with px = dx+2 ...
 */
export function greedyMesh(vol: Uint8Array, dx: number, dy: number, dz: number): MeshData | null {
  const px = dx + 2;
  const pz = dz + 2;
  const dims = [dx, dy, dz];
  const stride = [1, px * pz, px]; // axis 0=x,1=y,2=z
  let quads = 0;
  let vtx = 0;

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u];
    const dv = dims[v];
    const sd = stride[d];
    const su = stride[u];
    const sv = stride[v];
    if (mask.length < du * dv) mask = new Int32Array(du * dv);

    for (let side = 1; side >= -1; side -= 2) {
      const off = side * sd;
      for (let i = 0; i < dims[d]; i++) {
        // ---- build mask
        let n = 0;
        for (let b = 0; b < dv; b++) {
          let p = (i + 1) * sd + (b + 1) * sv + su; // padded index of (a=0, b, i)
          for (let a = 0; a < du; a++, p += su, n++) {
            const m = vol[p];
            if (m === 0 || vol[p + off] !== 0) {
              mask[n] = 0;
              continue;
            }
            const q = p + off;
            const s_u0 = vol[q - su] !== 0 ? 1 : 0;
            const s_u1 = vol[q + su] !== 0 ? 1 : 0;
            const s_v0 = vol[q - sv] !== 0 ? 1 : 0;
            const s_v1 = vol[q + sv] !== 0 ? 1 : 0;
            const c00 = vol[q - su - sv] !== 0 ? 1 : 0;
            const c10 = vol[q + su - sv] !== 0 ? 1 : 0;
            const c11 = vol[q + su + sv] !== 0 ? 1 : 0;
            const c01 = vol[q - su + sv] !== 0 ? 1 : 0;
            const ao0 = s_u0 && s_v0 ? 0 : 3 - (s_u0 + s_v0 + c00);
            const ao1 = s_u1 && s_v0 ? 0 : 3 - (s_u1 + s_v0 + c10);
            const ao2 = s_u1 && s_v1 ? 0 : 3 - (s_u1 + s_v1 + c11);
            const ao3 = s_u0 && s_v1 ? 0 : 3 - (s_u0 + s_v1 + c01);
            mask[n] = m | (ao0 << 8) | (ao1 << 10) | (ao2 << 12) | (ao3 << 14) | (1 << 20);
          }
        }
        // ---- greedy merge
        n = 0;
        for (let b = 0; b < dv; b++) {
          for (let a = 0; a < du; ) {
            const key = mask[n];
            if (key === 0) {
              a++;
              n++;
              continue;
            }
            const ao0 = (key >> 8) & 3;
            const ao1 = (key >> 10) & 3;
            const ao2 = (key >> 12) & 3;
            const ao3 = (key >> 14) & 3;
            const uniform = ao0 === ao1 && ao1 === ao2 && ao2 === ao3;
            let w = 1;
            let h = 1;
            if (uniform) {
              while (a + w < du && mask[n + w] === key) w++;
              outer: for (; b + h < dv; h++) {
                const row = n + h * du;
                for (let k = 0; k < w; k++) if (mask[row + k] !== key) break outer;
              }
            }
            // emit quad
            if (quads >= MAX_QUADS) return finalize(quads, vtx);
            const m = key & 255;
            const plane = i + (side > 0 ? 1 : 0);
            const cr = MAT_R[m],
              cg = MAT_G[m],
              cb = MAT_B[m];
            const noi = MAT_NOISE[m];
            const aos = [ao0, ao1, ao2, ao3];
            const cu = [a, a + w, a + w, a];
            const cv = [b, b, b + h, b + h];
            for (let k = 0; k < 4; k++) {
              const pv = vtx * 3;
              const coord = [0, 0, 0];
              coord[d] = plane;
              coord[u] = cu[k];
              coord[v] = cv[k];
              sPos[pv] = coord[0];
              sPos[pv + 1] = coord[1];
              sPos[pv + 2] = coord[2];
              sNrm[pv] = d === 0 ? side * 127 : 0;
              sNrm[pv + 1] = d === 1 ? side * 127 : 0;
              sNrm[pv + 2] = d === 2 ? side * 127 : 0;
              const f = AO_CURVE[aos[k]];
              sCol[pv] = cr * f;
              sCol[pv + 1] = cg * f;
              sCol[pv + 2] = cb * f;
              sNoi[vtx] = noi;
              vtx++;
            }
            const base = vtx - 4;
            const ii = quads * 6;
            const flip = ao0 + ao2 < ao1 + ao3;
            if (side > 0) {
              if (!flip) {
                sIdx[ii] = base;
                sIdx[ii + 1] = base + 1;
                sIdx[ii + 2] = base + 2;
                sIdx[ii + 3] = base;
                sIdx[ii + 4] = base + 2;
                sIdx[ii + 5] = base + 3;
              } else {
                sIdx[ii] = base;
                sIdx[ii + 1] = base + 1;
                sIdx[ii + 2] = base + 3;
                sIdx[ii + 3] = base + 1;
                sIdx[ii + 4] = base + 2;
                sIdx[ii + 5] = base + 3;
              }
            } else {
              if (!flip) {
                sIdx[ii] = base;
                sIdx[ii + 1] = base + 2;
                sIdx[ii + 2] = base + 1;
                sIdx[ii + 3] = base;
                sIdx[ii + 4] = base + 3;
                sIdx[ii + 5] = base + 2;
              } else {
                sIdx[ii] = base;
                sIdx[ii + 1] = base + 3;
                sIdx[ii + 2] = base + 1;
                sIdx[ii + 3] = base + 1;
                sIdx[ii + 4] = base + 3;
                sIdx[ii + 5] = base + 2;
              }
            }
            quads++;
            // clear consumed mask cells
            for (let hh = 0; hh < h; hh++) {
              const row = n + hh * du;
              for (let k = 0; k < w; k++) mask[row + k] = 0;
            }
            a += w;
            n += w;
          }
        }
      }
    }
  }
  return finalize(quads, vtx);
}

function finalize(quads: number, vtx: number): MeshData | null {
  if (quads === 0) return null;
  const index = vtx > 65535 ? sIdx.slice(0, quads * 6) : Uint16Array.from(sIdx.subarray(0, quads * 6));
  return {
    position: sPos.slice(0, vtx * 3),
    normal: sNrm.slice(0, vtx * 3),
    color: sCol.slice(0, vtx * 3),
    noise: sNoi.slice(0, vtx),
    index,
    quads,
  };
}

export function meshDataToGeometry(md: MeshData, geo = new THREE.BufferGeometry()): THREE.BufferGeometry {
  geo.setAttribute('position', new THREE.BufferAttribute(md.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(md.normal, 3, true));
  geo.setAttribute('color', new THREE.BufferAttribute(md.color, 3, true));
  geo.setAttribute('aNoise', new THREE.BufferAttribute(md.noise, 1, true));
  geo.setIndex(new THREE.BufferAttribute(md.index, 1));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// World chunk padding

const PAD = CS + 2;
const padded = new Uint8Array(PAD * PAD * PAD);

export function buildPaddedChunk(world: VoxelWorld, cx: number, cy: number, cz: number): Uint8Array {
  const chunk = world.chunkAt(cx, cy, cz)!;
  const data = world.ensure(chunk);
  padded.fill(0);
  const ox = cx * CS;
  const oy = cy * CS;
  const oz = cz * CS;
  // core
  if (data) {
    for (let y = 0; y < CS; y++)
      for (let z = 0; z < CS; z++) {
        const src = vidx(0, y, z);
        const dst = 1 + (z + 1) * PAD + (y + 1) * PAD * PAD;
        padded.set(data.subarray(src, src + CS), dst);
      }
  }
  // shell: read through world (generates neighbours on demand)
  for (let y = -1; y <= CS; y++)
    for (let z = -1; z <= CS; z++) {
      const edgeYZ = y === -1 || y === CS || z === -1 || z === CS;
      const rowBase = (z + 1) * PAD + (y + 1) * PAD * PAD;
      if (edgeYZ) {
        for (let x = -1; x <= CS; x++) padded[rowBase + x + 1] = world.get(ox + x, oy + y, oz + z);
      } else {
        padded[rowBase] = world.get(ox - 1, oy + y, oz + z);
        padded[rowBase + CS + 1] = world.get(ox + CS, oy + y, oz + z);
      }
    }
  return padded;
}

/** Copy a dense model (index x + z*sx + y*sx*sz) into a padded volume. */
export function padModel(data: Uint8Array, sx: number, sy: number, sz: number): Uint8Array {
  const px = sx + 2;
  const pz = sz + 2;
  const out = new Uint8Array(px * (sy + 2) * pz);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const m = data[x + z * sx + y * sx * sz];
        if (m) out[x + 1 + (z + 1) * px + (y + 1) * px * pz] = m;
      }
  return out;
}

export { CS_MASK, CS_SHIFT };
