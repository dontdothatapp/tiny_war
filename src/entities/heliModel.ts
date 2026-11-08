import * as THREE from 'three';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { VoxModel } from '../world/voxModel';

// Original two-seat attack helicopter, built at half-voxel resolution so it
// reads a little finer than the world. Nose points to -Z.

export const HELI_SCALE = 0.5;

function airframe(): VoxModel {
  const m = new VoxModel(26, 22, 66);
  const B = M.OLIVE_DARK;
  const B2 = M.METAL_OLIVE;
  const D = M.METAL_DARK;
  // lower fuselage
  m.box(9, 3, 6, 16, 10, 40, B);
  m.box(10, 2, 10, 15, 2, 36, B2);
  // nose taper + sensor turret
  m.box(10, 4, 2, 15, 9, 6, B);
  m.box(11, 5, 0, 14, 8, 2, D);
  m.box(11, 6, 0, 14, 7, 0, M.GLASS);
  // tandem canopy
  m.box(10, 10, 6, 15, 13, 24, M.GLASS);
  m.box(11, 14, 8, 14, 14, 22, M.GLASS);
  m.box(10, 10, 14, 15, 14, 14, B);
  m.box(10, 10, 6, 15, 10, 6, B);
  m.box(10, 10, 23, 15, 14, 24, B);
  // spine / engine hump
  m.box(10, 11, 24, 15, 15, 38, B);
  m.box(11, 16, 26, 14, 16, 34, B2);
  // engine nacelles
  m.box(5, 10, 22, 8, 14, 37, B2);
  m.box(17, 10, 22, 20, 14, 37, B2);
  m.box(5, 11, 37, 8, 13, 38, D);
  m.box(17, 11, 37, 20, 13, 38, D);
  m.box(6, 12, 21, 7, 13, 21, D);
  m.box(18, 12, 21, 19, 13, 21, D);
  // stub wings + pylons
  m.box(0, 8, 24, 25, 9, 30, B);
  m.box(2, 6, 25, 3, 7, 29, D);
  m.box(22, 6, 25, 23, 7, 29, D);
  m.box(6, 6, 25, 7, 7, 29, D);
  m.box(18, 6, 25, 19, 7, 29, D);
  // rocket pods
  m.hcylinder('z', 21, 33, 4.5, 2.5, 2.2, B2);
  m.hcylinder('z', 21, 33, 4.5, 22.5, 2.2, B2);
  m.hcylinder('z', 21, 21, 4.5, 2.5, 1.2, D);
  m.hcylinder('z', 21, 21, 4.5, 22.5, 1.2, D);
  // missile rails
  m.box(6, 4, 22, 7, 5, 31, M.STEEL);
  m.box(18, 4, 22, 19, 5, 31, M.STEEL);
  m.box(6, 4, 22, 7, 5, 22, M.RED_MARK);
  m.box(18, 4, 22, 19, 5, 22, M.RED_MARK);
  // tail boom
  m.box(11, 8, 40, 14, 11, 50, B);
  m.box(12, 9, 50, 13, 11, 60, B);
  // fin (swept)
  for (let y = 9; y <= 20; y++) {
    const z0 = 55 + Math.floor((y - 9) * 0.45);
    m.box(12, y, z0, 13, y, Math.min(65, z0 + 6), B);
  }
  // horizontal stabiliser
  m.box(6, 10, 57, 19, 10, 60, B);
  // landing gear
  m.box(5, 0, 17, 6, 2, 19, M.RUBBER);
  m.box(19, 0, 17, 20, 2, 19, M.RUBBER);
  m.line(6, 2, 18, 9, 5, 18, D);
  m.line(19, 2, 18, 16, 5, 18, D);
  m.box(12, 6, 59, 13, 8, 60, D);
  m.box(12, 5, 59, 13, 5, 60, M.RUBBER);
  // mast + nav lights
  m.box(12, 16, 26, 13, 18, 27, D);
  m.set(0, 9, 27, M.LIGHT_RED);
  m.set(25, 9, 27, M.LIGHT_GREEN);
  m.set(12, 21, 63, M.LIGHT_RED);
  return m;
}

function gunModel(): VoxModel {
  const m = new VoxModel(4, 4, 12);
  m.box(0, 0, 8, 3, 3, 11, M.METAL_DARK);
  m.box(1, 1, 0, 2, 2, 8, M.STEEL);
  return m;
}

export interface HeliVisual {
  root: THREE.Object3D;
  body: THREE.Object3D;
  rotor: THREE.Object3D;
  rotorBlur: THREE.Mesh;
  tailRotor: THREE.Object3D;
  gunYaw: THREE.Object3D;
  gunPitch: THREE.Object3D;
  material: THREE.MeshLambertMaterial;
  /** local muzzle / pod positions (world units, body frame) */
  podL: THREE.Vector3;
  podR: THREE.Vector3;
  rotorHeight: number;
}

export function buildHeliVisual(): HeliVisual {
  const s = HELI_SCALE;
  const material = createVoxelMaterial({ localHash: true });
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);
  // pivot near centre of mass (between cockpit and wings), skids at y=0
  const pivot: [number, number, number] = [13, 0, 26];
  const frame = buildModelMesh(airframe(), material, pivot, s);
  body.add(frame);
  // main rotor
  const rotorHeight = (19 - pivot[1]) * s;
  const rotor = new THREE.Object3D();
  rotor.position.set(0, rotorHeight, (26.5 - pivot[2]) * s);
  const bladeMat = new THREE.MeshLambertMaterial({ color: 0x2a2b26 });
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(14, 0.25, 1.1), bladeMat);
    blade.position.x = 7;
    const arm = new THREE.Object3D();
    arm.rotation.y = (i * Math.PI) / 2;
    arm.add(blade);
    blade.castShadow = true;
    rotor.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 1.4), bladeMat);
  rotor.add(hub);
  body.add(rotor);
  const blurMat = new THREE.MeshBasicMaterial({ color: 0x2a2b26, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide });
  const rotorBlur = new THREE.Mesh(new THREE.CircleGeometry(14, 40), blurMat);
  rotorBlur.rotation.x = -Math.PI / 2;
  rotorBlur.position.copy(rotor.position);
  rotorBlur.position.y += 0.1;
  body.add(rotorBlur);
  // tail rotor (on the right side of the fin)
  const tailRotor = new THREE.Object3D();
  tailRotor.position.set((14.5 - pivot[0]) * s, (17 - pivot[1]) * s, (60 - pivot[2]) * s);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5, 0.6), bladeMat);
    b.rotation.x = (i * Math.PI) / 2;
    tailRotor.add(b);
  }
  body.add(tailRotor);
  // chin gun
  const gunYaw = new THREE.Object3D();
  gunYaw.position.set(0, 1.0, (4 - pivot[2]) * s);
  const gunPitch = new THREE.Object3D();
  gunYaw.add(gunPitch);
  const gun = buildModelMesh(gunModel(), material, [2, 2, 10], s);
  gunPitch.add(gun);
  body.add(gunYaw);
  const podL = new THREE.Vector3((2.5 - pivot[0]) * s, 4.5 * s, (21 - pivot[2]) * s);
  const podR = new THREE.Vector3((22.5 - pivot[0]) * s, 4.5 * s, (21 - pivot[2]) * s);
  return { root, body, rotor, rotorBlur, tailRotor, gunYaw, gunPitch, material, podL, podR, rotorHeight };
}
