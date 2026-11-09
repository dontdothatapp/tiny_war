import * as THREE from 'three';
import { M } from '../voxel/materials';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import { valueNoise } from '../core/rng';
import { VoxModel } from '../world/voxModel';

// Original two-seat attack helicopter, built at half-voxel resolution so it
// reads a little finer than the world. Nose points to -Z.

export const HELI_SCALE = 0.5;

function airframe(): VoxModel {
  const m = new VoxModel(26, 24, 66);
  const B = M.OLIVE_DARK;
  const B2 = M.METAL_OLIVE;
  const D = M.METAL_DARK;
  // ---- landing gear: main wheels on struts, tail wheel
  for (const [x0, sx] of [
    [3, 9],
    [21, 16],
  ]) {
    m.box(x0, 0, 17, x0 + 1, 2, 19, M.RUBBER);
    m.set(x0 === 3 ? x0 : x0 + 1, 1, 18, M.METAL_LIGHT);
    m.line(x0 === 3 ? x0 + 1 : x0, 2, 18, sx, 5, 18, D);
    m.line(x0 === 3 ? x0 + 1 : x0, 2, 18, sx, 5, 22, D);
  }
  m.box(12, 4, 59, 13, 6, 59, D);
  m.box(12, 3, 58, 13, 4, 60, M.RUBBER);
  // ---- lower fuselage with rounded belly
  m.box(9, 3, 8, 16, 9, 40, B);
  for (let z = 8; z <= 40; z++) {
    m.set(9, 3, z, 0);
    m.set(16, 3, z, 0);
  }
  m.box(10, 2, 12, 15, 2, 34, B2);
  // avionics cheeks (give the fuselage its width)
  m.box(8, 4, 15, 17, 9, 31, B);
  for (let z = 15; z <= 31; z++) for (const x of [8, 17]) for (const y of [4, 9]) m.set(x, y, z, 0);
  // ---- nose taper + chin sensor turret
  m.box(10, 4, 3, 15, 9, 7, B);
  m.box(11, 5, 1, 14, 8, 2, B);
  m.box(10, 4, 0, 15, 7, 2, D);
  m.box(11, 3, 1, 14, 3, 2, D);
  m.set(11, 6, 0, M.GLASS);
  m.set(14, 6, 0, M.GLASS);
  m.set(12, 5, 0, M.METAL_LIGHT);
  // ---- stepped tandem canopy with frame bars
  m.box(10, 10, 6, 15, 12, 14, M.GLASS);
  m.box(11, 13, 7, 14, 13, 14, M.GLASS);
  m.box(10, 10, 15, 15, 14, 23, M.GLASS);
  m.box(11, 15, 16, 14, 15, 23, M.GLASS);
  for (const z of [6, 10, 14]) m.box(10, 10, z, 15, z === 14 ? 14 : 13, z, B);
  for (const z of [15, 19, 23]) m.box(10, 10, z, 15, 15, z, B);
  m.box(12, 13, 6, 13, 13, 14, B);
  m.box(12, 15, 15, 13, 15, 23, B);
  m.box(10, 10, 6, 15, 10, 23, B); // sill line
  // ---- spine / transmission fairing, mast
  m.box(10, 10, 24, 15, 15, 38, B);
  m.box(11, 16, 25, 14, 16, 35, B2);
  m.box(12, 16, 26, 13, 18, 27, D);
  // ---- engine nacelles: intake rings, exhaust suppressors with soot
  for (const [x0, x1, ex] of [
    [5, 8, 3],
    [17, 20, 22],
  ]) {
    m.box(x0, 10, 22, x1, 14, 37, B2);
    for (let z = 22; z <= 37; z++) for (const x of [x0, x1]) for (const y of [10, 14]) m.set(x, y, z, 0);
    m.box(x0 + 1, 11, 22, x1 - 1, 13, 22, D);
    m.box(x0 + 1, 12, 21, x1 - 1, 12, 21, D);
    m.box(Math.min(ex, x0), 11, 38, Math.max(ex, x1), 13, 39, D);
    m.box(Math.min(ex, x0), 11, 40, Math.max(ex, x1), 12, 40, M.SOOT);
    m.box(x0, 15, 28, x1, 15, 31, B); // cowling vents
    m.box(x0 + 1, 15, 29, x1 - 1, 15, 30, D);
  }
  // ---- stub wings with pylons, rocket pods outboard, missiles inboard
  m.box(0, 8, 25, 25, 9, 30, B);
  for (const x of [0, 1, 24, 25]) {
    m.set(x, 8, 25, 0);
    m.set(x, 8, 30, 0);
  }
  m.box(0, 7, 26, 0, 9, 29, D);
  m.box(25, 7, 26, 25, 9, 29, D);
  m.set(0, 9, 27, M.LIGHT_RED);
  m.set(25, 9, 27, M.LIGHT_GREEN);
  for (const x of [2, 23]) m.box(x, 6, 25, x, 7, 29, D);
  for (const x of [6, 19]) m.box(x, 6, 24, x + 1, 7, 30, D);
  for (const cx of [2.5, 22.5]) {
    m.hcylinder('z', 21, 33, 4.5, cx, 2.1, B2);
    m.hcylinder('z', 20, 20, 4.5, cx, 2.1, D);
    m.hcylinder('z', 34, 34, 4.5, cx, 1.4, D);
    for (const [ox, oy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [0, 0],
    ])
      m.set(cx + ox, 4.5 + oy, 20, M.SOOT);
  }
  for (const x of [6, 7, 18, 19]) {
    m.box(x, 4, 22, x, 5, 30, M.OLIVE_LIGHT);
    m.set(x, 4, 21, D);
    m.set(x, 5, 21, D);
    m.set(x, 3, 30, D);
  }
  // ---- tail boom (tapered) with dorsal ridge and ID markings
  m.box(11, 8, 40, 14, 12, 48, B);
  m.box(12, 9, 49, 13, 11, 61, B);
  m.box(12, 13, 40, 13, 13, 52, B2);
  for (const x of [11, 14]) {
    m.set(x, 10, 44, M.PLASTER_WHITE);
    m.set(x, 11, 44, M.PLASTER_WHITE);
    m.set(x, 10, 46, M.PLASTER_WHITE);
    m.set(x, 11, 46, M.PLASTER_WHITE);
  }
  // swept fin, tail-rotor gearbox, stabiliser
  for (let y = 9; y <= 21; y++) {
    const z0 = 55 + Math.floor((y - 9) * 0.45);
    m.box(12, y, z0, 13, y, Math.min(65, z0 + 6 - Math.floor((y - 9) / 5)), B);
  }
  m.box(14, 16, 59, 14, 18, 61, D);
  m.box(6, 10, 57, 19, 10, 60, B);
  m.box(6, 10, 57, 6, 11, 60, B2);
  m.box(19, 10, 57, 19, 11, 60, B2);
  // ---- lights and antennas
  m.set(12, 22, 63, M.LIGHT_RED);
  m.set(12, 17, 35, M.LIGHT_RED);
  m.box(13, 16, 37, 13, 18, 37, D);
  m.box(10, 2, 30, 10, 2, 33, D);
  // ---- two-tone camouflage
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        if (m.get(x, y, z) !== B) continue;
        if (valueNoise(x * 0.11 + y * 0.07, z * 0.11 - y * 0.05, 4242) > 0.6) m.set(x, y, z, M.HELI_DARK);
      }
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
  const tipMat = new THREE.MeshLambertMaterial({ color: 0xd9b23a });
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(13, 0.25, 1.1), bladeMat);
    blade.position.x = 7;
    const tip = new THREE.Mesh(new THREE.BoxGeometry(1, 0.27, 1.1), tipMat);
    tip.position.x = 14;
    const arm = new THREE.Object3D();
    arm.rotation.y = (i * Math.PI) / 2;
    arm.add(blade, tip);
    blade.castShadow = true;
    rotor.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 1.8), bladeMat);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshLambertMaterial({ color: 0x6b6b3e }));
  cap.position.y = 0.7;
  rotor.add(hub, cap);
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
