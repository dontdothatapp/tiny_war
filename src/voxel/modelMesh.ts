import * as THREE from 'three';
import { VoxModel } from '../world/voxModel';
import { greedyMesh, meshDataToGeometry, padModel } from './mesher';

/**
 * Mesh a VoxModel. Returns an Object3D whose origin is at `pivot` (in model
 * voxel coords). Mesher positions are Uint8, so the pivot offset lives on a
 * child transform rather than in the vertex data.
 */
export function buildModelMesh(m: VoxModel, material: THREE.Material, pivot: [number, number, number], scale = 1, shadows = true): THREE.Object3D {
  const outer = new THREE.Object3D();
  const md = greedyMesh(padModel(m.data, m.sx, m.sy, m.sz), m.sx, m.sy, m.sz);
  if (!md) return outer;
  const mesh = new THREE.Mesh(meshDataToGeometry(md), material);
  mesh.position.set(-pivot[0] * scale, -pivot[1] * scale, -pivot[2] * scale);
  mesh.scale.setScalar(scale);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  outer.add(mesh);
  return outer;
}

export function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
