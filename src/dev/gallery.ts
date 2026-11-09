import * as THREE from 'three';
import { RNG } from '../core/rng';
import { buildHeliVisual } from '../entities/heliModel';
import { buildScoutVisual } from '../entities/mobiles';
import { Pickup } from '../entities/pickups';
import { Turret } from '../entities/turret';
import { SceneRig } from '../game/scene';
import { buildModelMesh } from '../voxel/modelMesh';
import { createVoxelMaterial } from '../voxel/voxelMaterial';
import type { TurretType } from '../world/mapTypes';
import * as P from '../world/prefabs';
import { VoxModel } from '../world/voxModel';

// Developer model gallery: open the game with ?gallery=<set> to review every
// model under the game's lighting. Sets: aircraft, units, buildings, vehicles,
// nature, props. Add &angle=low for a lower camera, &pixels=1|2|3, &zoom=0.5,
// &only=<index> for a single model.

interface Item {
  label: string;
  obj: THREE.Object3D;
  /** footprint (world units) used for layout */
  w: number;
  d: number;
}

const worldMat = createVoxelMaterial();

function vox(label: string, m: VoxModel): Item {
  const obj = buildModelMesh(m, worldMat, [0, 0, 0], 1);
  // centre on the cell while keeping integer voxel alignment for the shader noise
  const holder = new THREE.Object3D();
  obj.position.set(-Math.floor(m.sx / 2), 0, -Math.floor(m.sz / 2));
  holder.add(obj);
  return { label, obj: holder, w: m.sx, d: m.sz };
}

function buildSet(set: string, seed: number): Item[] {
  const r = () => new RNG(seed++);
  const items: Item[] = [];
  if (set === 'aircraft') {
    const h = buildHeliVisual();
    h.rotorBlur.visible = false;
    items.push({ label: 'attack helicopter', obj: h.root, w: 30, d: 34 });
    const h2 = buildHeliVisual();
    h2.root.rotation.y = Math.PI * 0.75;
    h2.rotorBlur.visible = false;
    items.push({ label: 'attack helicopter (3/4)', obj: h2.root, w: 30, d: 34 });
    for (const yaw of [0, Math.PI * 0.75]) {
      const sc = buildScoutVisual(createVoxelMaterial({ localHash: true }));
      sc.root.rotation.y = yaw;
      sc.blur.visible = false;
      items.push({ label: yaw ? 'enemy gunship (3/4)' : 'enemy gunship', obj: sc.root, w: 22, d: 26 });
    }
    items.push(vox('downed helicopter', P.heliWreck(r())));
  } else if (set === 'units') {
    for (const t of ['mg', 'aaa', 'flak', 'sam', 'tank'] as TurretType[]) {
      const g = new THREE.Object3D();
      const pit = t === 'tank' ? null : P.gunPit(t === 'sam' ? 7 : t === 'mg' ? 4 : 5);
      if (pit) {
        const pm = buildModelMesh(pit, worldMat, [0, 0, 0], 1);
        pm.position.set(-Math.floor(pit.sx / 2), 0, -Math.floor(pit.sz / 2));
        g.add(pm);
      }
      const tu = new Turret(t, new THREE.Vector3(0, pit ? 1 : 0, 0), 0.6, -1, 0);
      tu.pitch = t === 'sam' ? 0.5 : t === 'tank' ? 0.05 : 0.35;
      tu.sync();
      g.add(tu.root);
      items.push({ label: t.toUpperCase(), obj: g, w: 20, d: 20 });
    }
    for (const k of ['fuel', 'ammo', 'repair'] as const) {
      const p = new Pickup(k, new THREE.Vector3());
      items.push({ label: `pickup: ${k}`, obj: p.obj, w: 8, d: 8 });
    }
  } else if (set === 'buildings') {
    items.push(vox('house 1F', P.house(r(), { floors: 1 })));
    items.push(vox('house 2F', P.house(r(), { floors: 2 })));
    items.push(vox('house 3F', P.house(r(), { floors: 3, w: 18, d: 14 })));
    items.push(vox('house (dome)', P.house(new RNG(7), { floors: 2, w: 18, d: 16 })));
    items.push(vox('barracks', P.house(r(), { floors: 2, military: true })));
    items.push(vox('ruin', P.ruin(r())));
    items.push(vox('hangar', P.hangar(r())));
    items.push(vox('bunker', P.bunker(r())));
    items.push(vox('radar station', P.radarStation(r())));
    items.push(vox('fuel tank', P.fuelTank(r(), true)));
    items.push(vox('fuel tank (small)', P.fuelTank(r(), false)));
    items.push(vox('guard tower', P.guardTower()));
    items.push(vox('water tower', P.waterTower(r())));
  } else if (set === 'vehicles') {
    for (const k of ['tank', 'apc', 'truck', 'technical', 'car'] as P.VehicleKind[]) items.push(vox(k, P.vehicle(r(), k)));
    items.push(vox('car', P.vehicle(r(), 'car')));
    for (const k of ['tank', 'truck', 'car'] as P.VehicleKind[]) items.push(vox(`${k} (wreck)`, P.vehicle(r(), k, true)));
  } else if (set === 'nature') {
    for (let i = 0; i < 4; i++) items.push(vox('palm', P.palm(r())));
    for (let i = 0; i < 3; i++) items.push(vox('shrub', P.shrub(r())));
    for (let i = 0; i < 3; i++) items.push(vox('rock', P.rock(r())));
  } else {
    items.push(vox('crates', P.crateStack(r())));
    items.push(vox('barrels', P.barrels(r())));
    items.push(vox('tent', P.tent(r())));
    items.push(vox('power pole', P.powerPole()));
    items.push(vox('market stall', P.marketStall(r())));
    items.push(vox('fuel bladder', P.fuelBladder()));
    items.push(vox('windsock', P.windsock()));
    items.push(vox('light post', P.lightPost()));
    items.push(vox('compound wall', P.compoundWall(16, 5, 41)));
    items.push(vox('gun pit', P.gunPit(5)));
    items.push(vox('helipad', P.helipad(20)));
  }
  return items;
}

export function runGallery(container: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const set = q.get('gallery') || 'buildings';
  const rig = new SceneRig(container);
  rig.setPixelScale(Number(q.get('pixels') || 1));
  (rig.scene.fog as THREE.Fog).far = 5000;
  (rig.scene.fog as THREE.Fog).near = 4000;
  let items = buildSet(set, Number(q.get('seed') || 11));
  // &only=<index> shows a single model close up
  if (q.has('only')) items = [items[Number(q.get('only'))]];
  // grid layout
  const cols = Math.ceil(Math.sqrt(items.length * 1.6));
  const cell = Math.max(...items.map((i) => Math.max(i.w, i.d))) + 8;
  const rows = Math.ceil(items.length / cols);
  const labels: { el: HTMLElement; obj: THREE.Object3D }[] = [];
  items.forEach((it, i) => {
    const cx = (i % cols) * cell - ((cols - 1) * cell) / 2;
    const cz = Math.floor(i / cols) * cell - ((rows - 1) * cell) / 2;
    it.obj.position.x += Math.round(cx);
    it.obj.position.z += Math.round(cz);
    rig.scene.add(it.obj);
    const el = document.createElement('div');
    el.textContent = it.label;
    el.style.cssText = 'position:absolute;color:#1d1a12;font:14px monospace;background:rgba(255,240,210,.75);padding:1px 5px;border-radius:3px;pointer-events:none;transform:translate(-50%,0)';
    container.appendChild(el);
    labels.push({ el, obj: it.obj });
  });
  // sand ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(cols * cell + 80, rows * cell + 80), new THREE.MeshLambertMaterial({ color: new THREE.Color(0xd9b27a) }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  rig.scene.add(ground);
  // camera: same pitch as the game (or lower), framed to fit
  const pitch = q.get('angle') === 'low' ? 0.55 : 0.98;
  const span = Math.max(cols, rows * 1.3) * cell;
  const dist = Math.max(60, span * 1.05) * Number(q.get('zoom') || 1);
  const cam = rig.camera;
  cam.far = 5000;
  cam.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist);
  cam.lookAt(0, 4, 0);
  cam.updateProjectionMatrix();
  const sc = rig.sun.shadow.camera;
  sc.left = sc.bottom = -span;
  sc.right = sc.top = span;
  sc.updateProjectionMatrix();
  rig.updateSun(new THREE.Vector3(0, 0, 0));
  const v = new THREE.Vector3();
  const frame = () => {
    rig.render();
    for (const l of labels) {
      v.copy(l.obj.position).project(cam);
      l.el.style.left = `${(v.x * 0.5 + 0.5) * container.clientWidth}px`;
      l.el.style.top = `${(-v.y * 0.5 + 0.5) * container.clientHeight + 8}px`;
    }
    requestAnimationFrame(frame);
  };
  frame();
  (window as unknown as { __ready: boolean }).__ready = true;
}
