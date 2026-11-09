import * as THREE from 'three';

// Voxel-cube particle system for smoke, fire, sparks, dust and flashes.
// One InstancedMesh, per-instance colour/alpha/emissive, fake directional
// lighting in the shader so smoke cubes read as 3D blocks.

export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  /** start / end colours (0xRRGGBB) */
  c0: number;
  c1?: number;
  a0?: number;
  a1?: number;
  /** 0 = lit, 1 = glowing */
  emissive?: number;
  /** Fraction of velocity lost per second. */
  drag?: number;
  /** Vertical acceleration (negative = gravity, positive = buoyant). */
  grav?: number;
  spin?: number;
}

const VERT = /* glsl */ `
attribute vec3 iColor;
attribute vec2 iParams; // alpha, emissive
varying vec3 vColor;
varying vec2 vParams;
varying vec3 vNormalW;
varying float vFogDepth;
void main() {
  vColor = iColor;
  vParams = iParams;
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(instanceMatrix) * normal);
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLight;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
varying vec3 vColor;
varying vec2 vParams;
varying vec3 vNormalW;
varying float vFogDepth;
void main() {
  float l = 0.55 + 0.45 * max(dot(vNormalW, uSunDir), 0.0) + 0.15 * vNormalW.y;
  // glowing particles are pushed above 1.0 so the bloom pass picks them up
  vec3 c = mix(vColor * l * uLight, vColor * 2.1, vParams.y);
  float f = smoothstep(fogNear, fogFar, vFogDepth);
  c = mix(c, fogColor, f * (1.0 - vParams.y * 0.5));
  gl_FragColor = vec4(c, vParams.x);
  #include <colorspace_fragment>
}
`;

export class ParticleSystem {
  readonly mesh: THREE.InstancedMesh;
  private cap: number;
  private n = 0;
  private P: Float32Array; // x y z vx vy vz
  private L: Float32Array; // life, maxLife, size0, size1, a0, a1, emissive, drag, grav, rot, spin, rot2
  private C: Float32Array; // r0 g0 b0 r1 g1 b1
  private colorAttr: THREE.InstancedBufferAttribute;
  private paramAttr: THREE.InstancedBufferAttribute;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private tmpC = new THREE.Color();

  constructor(cap: number, sunDir: THREE.Vector3, fog: THREE.Fog, additive = false) {
    this.cap = cap;
    this.P = new Float32Array(cap * 6);
    this.L = new Float32Array(cap * 12);
    this.C = new Float32Array(cap * 6);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.paramAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iColor', this.colorAttr);
    geo.setAttribute('iParams', this.paramAttr);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uSunDir: { value: sunDir.clone().normalize() },
        uLight: { value: new THREE.Vector3(1, 1, 1) },
        fogColor: { value: fog.color },
        fogNear: { value: fog.near },
        fogFar: { value: fog.far },
      },
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  get count() {
    return this.n;
  }

  /** Brightness of lit particles (smoke goes dark at night; glowing ones are unaffected). */
  setLight(r: number, g: number, b: number) {
    ((this.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value as THREE.Vector3).set(r, g, b);
  }

  setFog(near: number, far: number) {
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.fogNear.value = near;
    u.fogFar.value = far;
  }

  spawn(p: ParticleSpawn) {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap); // overwrite a random one
    const P = this.P,
      L = this.L,
      C = this.C;
    const o = i * 6;
    P[o] = p.x;
    P[o + 1] = p.y;
    P[o + 2] = p.z;
    P[o + 3] = p.vx ?? 0;
    P[o + 4] = p.vy ?? 0;
    P[o + 5] = p.vz ?? 0;
    const l = i * 12;
    L[l] = 0;
    L[l + 1] = p.life;
    L[l + 2] = p.size0;
    L[l + 3] = p.size1;
    L[l + 4] = p.a0 ?? 1;
    L[l + 5] = p.a1 ?? 0;
    L[l + 6] = p.emissive ?? 0;
    L[l + 7] = p.drag ?? 0;
    L[l + 8] = p.grav ?? 0;
    L[l + 9] = Math.random() * Math.PI;
    L[l + 10] = (p.spin ?? 1) * (Math.random() - 0.5) * 3;
    L[l + 11] = Math.random() * Math.PI;
    this.tmpC.setHex(p.c0);
    C[o] = this.tmpC.r;
    C[o + 1] = this.tmpC.g;
    C[o + 2] = this.tmpC.b;
    this.tmpC.setHex(p.c1 ?? p.c0);
    C[o + 3] = this.tmpC.r;
    C[o + 4] = this.tmpC.g;
    C[o + 5] = this.tmpC.b;
  }

  update(dt: number) {
    const P = this.P,
      L = this.L,
      C = this.C;
    const col = this.colorAttr.array as Float32Array;
    const par = this.paramAttr.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const l = i * 12;
      L[l] += dt;
      if (L[l] >= L[l + 1]) {
        // swap-remove
        const last = --this.n;
        if (i !== last) {
          P.copyWithin(i * 6, last * 6, last * 6 + 6);
          L.copyWithin(l, last * 12, last * 12 + 12);
          C.copyWithin(i * 6, last * 6, last * 6 + 6);
        }
        continue;
      }
      const o = i * 6;
      const drag = Math.max(0, 1 - L[l + 7] * dt);
      P[o + 3] *= drag;
      P[o + 4] = P[o + 4] * drag + L[l + 8] * dt;
      P[o + 5] *= drag;
      P[o] += P[o + 3] * dt;
      P[o + 1] += P[o + 4] * dt;
      P[o + 2] += P[o + 5] * dt;
      L[l + 9] += L[l + 10] * dt;
      const t = L[l] / L[l + 1];
      const size = L[l + 2] + (L[l + 3] - L[l + 2]) * t;
      this.e.set(L[l + 9], L[l + 11], L[l + 9] * 0.7);
      this.q.setFromEuler(this.e);
      this.v.set(P[o], P[o + 1], P[o + 2]);
      this.s.set(size, size, size);
      this.m4.compose(this.v, this.q, this.s);
      this.m4.toArray(this.mesh.instanceMatrix.array, i * 16);
      const ci = i * 3;
      col[ci] = C[o] + (C[o + 3] - C[o]) * t;
      col[ci + 1] = C[o + 1] + (C[o + 4] - C[o + 1]) * t;
      col[ci + 2] = C[o + 2] + (C[o + 5] - C[o + 2]) * t;
      par[i * 2] = L[l + 4] + (L[l + 5] - L[l + 4]) * t;
      par[i * 2 + 1] = L[l + 6] * (1 - t * 0.6);
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.paramAttr.needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}
