import * as THREE from 'three';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import type { PickupType } from '../world/mapTypes';
import { VoxModel } from '../world/voxModel';

const mat = createVoxelMaterial({ localHash: true });

function pickupModel(type: PickupType): VoxModel {
  const m = new VoxModel(8, 6, 8);
  if (type === 'fuel') {
    for (const [x, z] of [
      [0, 0],
      [4, 0],
      [0, 4],
      [4, 4],
    ]) {
      m.cylinder(x + 1.5, z + 1.5, 1.7, 0, 4, M.RED_MARK);
      m.box(x + 1, 5, z + 1, x + 2, 5, z + 2, M.METAL_DARK);
    }
    m.box(0, 2, 0, 7, 2, 7, (x, _y, z) => (m.get(x, 2, z) ? M.YELLOW_MARK : -1));
  } else if (type === 'ammo') {
    m.box(0, 0, 1, 7, 3, 6, M.OLIVE_DARK);
    m.box(0, 4, 1, 7, 4, 6, M.METAL_OLIVE);
    m.box(1, 2, 1, 6, 2, 1, M.YELLOW_MARK);
    m.box(1, 2, 6, 6, 2, 6, M.YELLOW_MARK);
  } else {
    m.box(1, 0, 1, 6, 4, 6, M.PLASTER_WHITE);
    m.box(1, 2, 1, 6, 2, 6, M.LIGHT_GREEN);
    m.box(3, 5, 3, 4, 5, 4, M.LIGHT_GREEN);
  }
  return m;
}

export const PICKUP_COLOR: Record<PickupType, string> = { fuel: '#ff6a3a', ammo: '#e8d24a', repair: '#6bff8a' };
export const PICKUP_LABEL: Record<PickupType, string> = { fuel: 'FUEL', ammo: 'AMMO', repair: 'REPAIR' };

export class Pickup {
  readonly obj: THREE.Object3D;
  alive = true;
  winch = 0;
  /** height offset while being winched */
  lift = 0;
  constructor(
    readonly type: PickupType,
    readonly pos: THREE.Vector3,
  ) {
    this.obj = buildModelMesh(pickupModel(type), mat, [4, 0, 4], 0.5);
    this.obj.position.copy(pos);
    this.obj.rotation.y = Math.random() * Math.PI;
  }
}

/** A downed crew waiting for pickup: smoke flare + strobe. No figures are shown. */
export class RescueSite {
  readonly beacon: THREE.Mesh;
  crew: number;
  boarded = 0;
  boardT = 0;
  smokeT = 0;
  readonly total: number;
  constructor(
    readonly pos: THREE.Vector3,
    crew: number,
  ) {
    this.crew = crew;
    this.total = crew;
    this.beacon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0xff4020 }));
    this.beacon.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
  }
  get done() {
    return this.crew <= 0;
  }
}
