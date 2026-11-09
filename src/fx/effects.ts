import * as THREE from 'three';
import { ParticleSystem } from './particles';

interface Fire {
  x: number;
  y: number;
  z: number;
  life: number;
  size: number;
  t: number;
  smokeT: number;
  black: boolean;
}

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  r0: number;
  r1: number;
}

/**
 * Explosion visuals (fireball cubes, smoke, sparks, shockwave rings, flash
 * lights) and persistent fires / smoke columns on wrecks.
 */
export class Effects {
  private fires: Fire[] = [];
  private lights: THREE.PointLight[] = [];
  private lightLife: number[] = [];
  private lightMax: number[] = [];
  private rings: Ring[] = [];

  constructor(
    scene: THREE.Object3D,
    private smoke: ParticleSystem,
    private glow: ParticleSystem,
  ) {
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 60, 1.6);
      scene.add(l);
      this.lights.push(l);
      this.lightLife.push(0);
      this.lightMax.push(1);
    }
    // shockwave rings: flat, additive, bright enough to bloom
    const ringGeo = new THREE.RingGeometry(0.84, 1, 40);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.8, 1.25), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.rings.push({ mesh, t: 1, life: 1, r0: 1, r1: 1 });
    }
  }

  /** Expanding ring on the ground under a blast. */
  shockwave(x: number, y: number, z: number, r: number) {
    let best = this.rings[0];
    for (const g of this.rings) if (g.life - g.t < best.life - best.t) best = g;
    best.t = 0;
    best.life = 0.3 + r * 0.025;
    best.r0 = r * 0.5;
    best.r1 = r * 3.6 + 2;
    best.mesh.position.set(x, y + 0.8, z);
    best.mesh.visible = true;
  }

  flash(x: number, y: number, z: number, intensity: number, range: number) {
    let best = 0;
    for (let i = 1; i < this.lights.length; i++) if (this.lightLife[i] < this.lightLife[best]) best = i;
    const l = this.lights[best];
    l.position.set(x, y + 3, z);
    l.distance = range;
    l.intensity = intensity;
    this.lightLife[best] = 0.25;
    this.lightMax[best] = intensity;
  }

  explosion(x: number, y: number, z: number, r: number, airburst = false) {
    const s = this.smoke,
      g = this.glow;
    const n = Math.min(40, 6 + Math.floor(r * 4));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const sp = (4 + Math.random() * 10) * (r / 3);
      const sq = Math.sqrt(1 - u * u);
      g.spawn({
        x: x + (Math.random() - 0.5) * r * 0.4,
        y: y + Math.random() * r * 0.3,
        z: z + (Math.random() - 0.5) * r * 0.4,
        vx: Math.cos(a) * sq * sp,
        vy: Math.abs(u) * sp * (airburst ? 1 : 1.3),
        vz: Math.sin(a) * sq * sp,
        life: 0.25 + Math.random() * 0.35 + r * 0.03,
        size0: 1 + r * 0.5,
        size1: 0.3,
        c0: Math.random() < 0.5 ? 0xfff0a0 : 0xffb040,
        c1: 0xc03010,
        emissive: 1,
        drag: 4,
        grav: 4,
        a0: 1,
        a1: 0.6,
      });
    }
    const ns = Math.min(30, 4 + Math.floor(r * 3));
    for (let i = 0; i < ns; i++) {
      s.spawn({
        x: x + (Math.random() - 0.5) * r,
        y: y + Math.random() * r * 0.5,
        z: z + (Math.random() - 0.5) * r,
        vx: (Math.random() - 0.5) * r * 2.5,
        vy: 2 + Math.random() * r * 1.4,
        vz: (Math.random() - 0.5) * r * 2.5,
        life: 1.6 + Math.random() * 2 + r * 0.15,
        size0: r * 0.6,
        size1: r * 1.5 + 2,
        c0: airburst ? 0x2a2622 : 0x45403a,
        c1: airburst ? 0x5a554e : 0x8a8276,
        a0: 0.92,
        a1: 0,
        drag: 1.4,
        grav: 2.5,
        spin: 0.4,
      });
    }
    // sparks
    for (let i = 0; i < Math.min(24, r * 5); i++) {
      g.spawn({
        x,
        y: y + 0.5,
        z,
        vx: (Math.random() - 0.5) * 50,
        vy: Math.random() * 40,
        vz: (Math.random() - 0.5) * 50,
        life: 0.4 + Math.random() * 0.5,
        size0: 0.45,
        size1: 0.1,
        c0: 0xffe8a0,
        c1: 0xff7020,
        emissive: 1,
        grav: -40,
      });
    }
    // white-hot core that collapses in a few frames
    g.spawn({ x, y: y + r * 0.2, z, life: 0.11 + r * 0.008, size0: r * 1.5 + 1, size1: r * 0.4, c0: 0xfffbe0, c1: 0xffc060, emissive: 1, a0: 1, a1: 0.5, spin: 0 });
    if (!airburst) {
      this.shockwave(x, y, z, r);
      // dust kicked out along the ground
      if (r >= 2.5) {
        const nd = Math.min(18, Math.floor(r * 3));
        for (let i = 0; i < nd; i++) {
          const a = (i / nd) * Math.PI * 2 + Math.random() * 0.4;
          const sp = (9 + Math.random() * 8) * (r / 3);
          s.spawn({ x: x + Math.cos(a) * r * 0.6, y: y + 0.4, z: z + Math.sin(a) * r * 0.6, vx: Math.cos(a) * sp, vy: 0.6 + Math.random() * 1.5, vz: Math.sin(a) * sp, life: 0.9 + Math.random() * 0.9, size0: 1.2, size1: 3 + r * 0.7, c0: 0xcfb086, c1: 0xdcc6a0, a0: 0.6, a1: 0, drag: 2.6, grav: 0.4, spin: 0.3 });
        }
      }
    }
    this.flash(x, y, z, 30 + r * 25, 20 + r * 8);
  }

  impactPuff(x: number, y: number, z: number, color = 0xcbb08a) {
    for (let i = 0; i < 3; i++)
      this.smoke.spawn({
        x,
        y,
        z,
        vx: (Math.random() - 0.5) * 6,
        vy: 2 + Math.random() * 4,
        vz: (Math.random() - 0.5) * 6,
        life: 0.6 + Math.random() * 0.5,
        size0: 0.6,
        size1: 2.2,
        c0: color,
        a0: 0.8,
        a1: 0,
        drag: 2,
      });
    this.glow.spawn({ x, y, z, life: 0.06, size0: 1.6, size1: 0.5, c0: 0xfff0b0, emissive: 1 });
  }

  muzzle(x: number, y: number, z: number, big = false) {
    this.glow.spawn({ x, y, z, life: 0.05, size0: big ? 2.4 : 1.4, size1: 0.6, c0: 0xfff2b0, c1: 0xffa040, emissive: 1 });
  }

  /** Persistent fire with smoke column. */
  addFire(x: number, y: number, z: number, size: number, life: number, black = true) {
    if (this.fires.length > 48) this.fires.shift();
    this.fires.push({ x, y, z, life, size, t: 0, smokeT: 0, black });
  }

  /** Coloured signal smoke (rescue beacons). */
  signalSmoke(x: number, y: number, z: number, color: number) {
    this.smoke.spawn({
      x: x + (Math.random() - 0.5),
      y,
      z: z + (Math.random() - 0.5),
      vx: 1.5 + Math.random(),
      vy: 4 + Math.random() * 2,
      vz: (Math.random() - 0.5) * 1.5,
      life: 4 + Math.random() * 2,
      size0: 1,
      size1: 6,
      c0: color,
      c1: 0xd8b0a0,
      a0: 0.85,
      a1: 0,
      drag: 0.4,
      grav: 0.8,
    });
  }

  dust(x: number, y: number, z: number, strength: number) {
    const a = Math.random() * Math.PI * 2;
    const sp = 10 + Math.random() * 10;
    this.smoke.spawn({
      x: x + Math.cos(a) * 4,
      y: y + 0.5,
      z: z + Math.sin(a) * 4,
      vx: Math.cos(a) * sp,
      vy: 1 + Math.random() * 2,
      vz: Math.sin(a) * sp,
      life: 1 + Math.random(),
      size0: 1,
      size1: 4 + strength * 3,
      c0: 0xd8b98a,
      c1: 0xe0caa4,
      a0: 0.55 * strength,
      a1: 0,
      drag: 1.8,
      grav: 0.5,
    });
  }

  update(dt: number) {
    for (const g of this.rings) {
      if (!g.mesh.visible) continue;
      g.t += dt;
      const k = g.t / g.life;
      if (k >= 1) {
        g.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - k) * (1 - k);
      g.mesh.scale.setScalar(g.r0 + (g.r1 - g.r0) * e);
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - k, 1.6) * 0.55;
    }
    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightLife[i] > 0) {
        this.lightLife[i] -= dt;
        this.lights[i].intensity = Math.max(0, (this.lightLife[i] / 0.25) * this.lightMax[i]);
      } else this.lights[i].intensity = 0;
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.fires.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, f.life / 4);
      f.t -= dt;
      if (f.t <= 0) {
        f.t = 0.05 / Math.max(0.3, f.size * 0.5);
        this.glow.spawn({
          x: f.x + (Math.random() - 0.5) * f.size,
          y: f.y + Math.random() * 0.5,
          z: f.z + (Math.random() - 0.5) * f.size,
          vx: (Math.random() - 0.5) * 2,
          vy: 3 + Math.random() * 4 * f.size,
          vz: (Math.random() - 0.5) * 2,
          life: 0.4 + Math.random() * 0.4,
          size0: (0.8 + Math.random() * f.size * 0.5) * fade,
          size1: 0.2,
          c0: Math.random() < 0.4 ? 0xffe070 : 0xff8a20,
          c1: 0xb02000,
          emissive: 1,
          drag: 1,
        });
      }
      f.smokeT -= dt;
      if (f.smokeT <= 0) {
        f.smokeT = 0.12 / Math.max(0.4, f.size * 0.4);
        this.smoke.spawn({
          x: f.x + (Math.random() - 0.5) * f.size,
          y: f.y + 1 + f.size * 0.5,
          z: f.z + (Math.random() - 0.5) * f.size,
          vx: 2 + Math.random() * 2,
          vy: 5 + Math.random() * 3,
          vz: (Math.random() - 0.5) * 2,
          life: 3 + Math.random() * 3,
          size0: 1 + f.size * 0.6,
          size1: 4 + f.size * 2.2,
          c0: f.black ? 0x26221f : 0x8a8478,
          c1: f.black ? 0x5d5750 : 0xb0a898,
          a0: 0.8 * fade,
          a1: 0,
          drag: 0.6,
          grav: 1.5,
          spin: 0.3,
        });
      }
    }
  }

  clear() {
    this.fires.length = 0;
    for (const g of this.rings) g.mesh.visible = false;
  }
}
