import * as THREE from 'three';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import type { PickupType } from '../world/mapTypes';
import { VoxModel } from '../world/voxModel';

const mat = createVoxelMaterial({ localHash: true });

function pickupModel(type: PickupType): VoxModel {
  const m = new VoxModel(10, 8, 10);
  // pallet
  m.box(0, 0, 0, 9, 0, 9, (x) => (x % 3 === 0 ? M.WOOD_DOOR : M.CRATE));
  if (type === 'fuel') {
    // one big drum with rims, a yellow band and a bung on top
    m.cylinder(4.5, 4.5, 4, 1, 6, (_x, y) => (y === 1 || y === 6 ? M.METAL_DARK : y === 3 || y === 4 ? M.YELLOW_MARK : M.RED_MARK));
    m.cylinder(4.5, 4.5, 3.2, 7, 7, M.RED_MARK);
    m.box(4, 7, 4, 5, 7, 5, M.METAL_DARK);
  } else if (type === 'ammo') {
    // olive ammunition crate with lid seam, stencil band and rope handles, small box on top
    m.box(0, 1, 1, 9, 4, 8, M.OLIVE_DARK);
    m.box(0, 5, 1, 9, 5, 8, M.OLIVE_LIGHT);
    m.box(0, 3, 1, 9, 3, 1, M.YELLOW_MARK);
    m.box(0, 3, 8, 9, 3, 8, M.YELLOW_MARK);
    for (const x of [0, 9]) m.box(x, 2, 4, x, 2, 5, M.CANVAS_DARK);
    m.box(2, 6, 3, 6, 7, 6, M.OLIVE_DARK);
    m.box(2, 7, 4, 6, 7, 5, M.OLIVE_LIGHT);
    m.set(4, 6, 6, M.YELLOW_MARK);
  } else {
    // white repair kit with a green band and a wrench on the lid
    m.box(1, 1, 1, 8, 5, 8, M.PLASTER_WHITE);
    m.box(1, 3, 1, 8, 3, 8, M.LIGHT_GREEN);
    m.box(2, 6, 4, 7, 6, 5, M.METAL_LIGHT);
    m.box(2, 6, 3, 2, 6, 6, M.METAL_LIGHT);
    m.box(7, 6, 3, 7, 6, 6, M.METAL_LIGHT);
    m.set(2, 6, 4, 0);
    m.set(2, 6, 5, 0);
  }
  return m;
}

/** Supplies are one colour everywhere (HUD, map, markers); the label says which kind. */
const SUPPLY = '#ffd95a';
export const PICKUP_COLOR: Record<PickupType, string> = { fuel: SUPPLY, ammo: SUPPLY, repair: SUPPLY };
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
    this.obj = buildModelMesh(pickupModel(type), mat, [5, 0, 5], 0.5);
    this.obj.position.copy(pos);
    this.obj.rotation.y = Math.random() * Math.PI;
  }
}

/** A downed crew waiting for pickup: violet smoke + strobe. No figures are shown. */
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
    this.beacon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0xd9a8ff }));
    this.beacon.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
  }
  get done() {
    return this.crew <= 0;
  }
}
