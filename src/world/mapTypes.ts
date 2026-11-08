export type Team = 'enemy' | 'neutral' | 'friendly';
export type TurretType = 'mg' | 'aaa' | 'flak' | 'sam' | 'tank';
export type PickupType = 'fuel' | 'ammo' | 'repair';
export type BaseKind = 'radar' | 'command' | 'sam' | 'depot' | 'factory';

export interface Stamp {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  data: Uint8Array;
}

export interface StructureDef {
  id: number;
  kind: string;
  label: string;
  team: Team;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Credits on destruction. */
  reward: number;
  /** Blast radius of secondary explosion when destroyed (0 = none). */
  explosive: number;
  /** Remaining integrity fraction at which the structure fails and collapses. */
  collapseAt: number;
  baseId: number;
}

export interface TurretSpawn {
  type: TurretType;
  x: number;
  y: number;
  z: number;
  yaw: number;
  baseId: number;
}

export interface PickupSpawn {
  type: PickupType;
  x: number;
  y: number;
  z: number;
}

export interface RescueSpawn {
  x: number;
  y: number;
  z: number;
  crew: number;
}

export interface ObjectiveRef {
  kind: 'structure' | 'turret';
  index: number;
}

export interface BaseDef {
  id: number;
  name: string;
  kind: BaseKind;
  x: number;
  z: number;
  r: number;
  objectives: ObjectiveRef[];
}

export interface FarpDef {
  x: number;
  y: number;
  z: number;
  /** Rearm/refuel zone centre + radius. */
  padX: number;
  padZ: number;
  padR: number;
  spawnYaw: number;
}

export interface RoadSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  w: number;
}

export interface MapData {
  seed: number;
  sector: number;
  size: number;
  height: number;
  heights: Uint8Array;
  surface: Uint8Array;
  stamps: Stamp[];
  structures: StructureDef[];
  turrets: TurretSpawn[];
  pickups: PickupSpawn[];
  rescues: RescueSpawn[];
  bases: BaseDef[];
  farp: FarpDef;
  roads: RoadSeg[];
  /** RGBA minimap image (size/MINIMAP_DIV square). */
  minimap: Uint8ClampedArray;
  minimapRes: number;
}
