import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { voxelGlobals } from '../voxel/voxelMaterial';
import { ATMOSPHERES, Atmosphere } from './atmosphere';

export const SKY_COLOR = 0xe6cfa3;

/**
 * Final grade, in linear space before the sRGB conversion: tint, saturation,
 * contrast, vignette, a dust haze that closes in from the screen edges, a red
 * edge pulse when the hull is critical and a white flash for big blasts.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uVignette: { value: 0.3 },
    uHaze: { value: 0 },
    uHazeColor: { value: new THREE.Color(SKY_COLOR) },
    uDanger: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform float uHaze;
    uniform vec3 uHazeColor;
    uniform float uDanger;
    uniform float uFlash;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb * uTint;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = max((col - 0.18) * uContrast + 0.18, 0.0);
      float r = length((vUv - 0.5) * vec2(1.0, 0.86)) * 1.42;
      col = mix(col, uHazeColor, uHaze * smoothstep(0.22, 0.95, r));
      float v = smoothstep(0.38, 1.0, r);
      col *= 1.0 - v * uVignette;
      col = mix(col, vec3(0.85, 0.06, 0.03), v * uDanger);
      col += uFlash * vec3(1.0, 0.9, 0.75);
      gl_FragColor = vec4(col, src.a);
    }`,
};

/** Renderer, scene, lights, post-processing and the follow camera. */
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Nose searchlight for night sectors (the game aims it every frame). */
  readonly searchlight: THREE.SpotLight;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private grade: ShaderPass;
  atmosphere: Atmosphere = ATMOSPHERES.day;
  /** Unit vector towards the sun (shared with the particle shaders). */
  readonly sunDir = new THREE.Vector3(-0.5, 0.85, 0.35).normalize();
  pixelScale = 2; // 1 = native, 2/3 = chunky retro pixels
  private sunOffset = new THREE.Vector3();
  /** Half-width of the area the shadow map covers. */
  private shadowHalf = 200;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    // several passes render per frame; the game resets the counters itself
    this.renderer.info.autoReset = false;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 330, 620);

    this.camera = new THREE.PerspectiveCamera(32, 1, 5, 1400);

    this.hemi = new THREE.HemisphereLight(0xffe9c8, 0x9a7650, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -200;
    sc.right = 200;
    sc.top = 200;
    sc.bottom = -200;
    sc.near = 10;
    sc.far = 760;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.searchlight = new THREE.SpotLight(0xfff2d0, 0, 260, 0.34, 0.55, 0);
    this.searchlight.visible = false;
    this.scene.add(this.searchlight);
    this.scene.add(this.searchlight.target);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    this.applyAtmosphere(ATMOSPHERES.day);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Switch lighting, haze and grading to a time of day / weather. */
  applyAtmosphere(a: Atmosphere) {
    this.atmosphere = a;
    (this.scene.background as THREE.Color).setHex(a.sky);
    (this.scene.fog as THREE.Fog).color.setHex(a.sky);
    this.sun.color.setHex(a.sun);
    this.sun.intensity = a.sunIntensity;
    this.sunDir.set(...a.sunDir).normalize();
    this.sunOffset.copy(this.sunDir).multiplyScalar(this.shadowHalf * 1.6);
    this.hemi.color.setHex(a.hemiSky);
    this.hemi.groundColor.setHex(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    this.searchlight.visible = a.searchlight > 0;
    this.searchlight.intensity = 0;
    this.bloom.strength = a.bloom;
    const u = this.grade.uniforms;
    (u.uTint.value as THREE.Vector3).set(...a.tint);
    u.uContrast.value = a.contrast;
    u.uSaturation.value = a.saturation;
    u.uVignette.value = a.vignette;
    u.uHaze.value = a.haze;
    (u.uHazeColor.value as THREE.Color).setHex(a.sky);
    voxelGlobals.uCloud.value.x = a.cloud;
    voxelGlobals.uGlow.value = a.glow;
  }

  /**
   * Fog is measured from the camera's focus distance so zooming doesn't change the haze.
   * `clear` pushes it further back (the opening shot shows the whole board unfogged).
   */
  setFocusDistance(dist: number, clear = 0) {
    const fog = this.scene.fog as THREE.Fog;
    fog.near = dist + this.atmosphere.fogNear + clear;
    fog.far = dist + this.atmosphere.fogFar + clear * 4;
  }

  /** Camera clip planes (the opening shot needs to see much further than the game camera). */
  setDepthRange(near: number, far: number) {
    const cam = this.camera;
    if (cam.near === near && cam.far === far) return;
    cam.near = near;
    cam.far = far;
    cam.updateProjectionMatrix();
  }

  /** Size of the square around the focus that gets shadows (the game uses 200). */
  setShadowRange(half: number) {
    if (half === this.shadowHalf) return;
    this.shadowHalf = half;
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.far = half * 3.8;
    sc.updateProjectionMatrix();
    this.sunOffset.copy(this.sunDir).multiplyScalar(half * 1.6);
  }

  /** Red edge pulse (0..1) and white blast flash (0..1). */
  setScreenFx(danger: number, flash: number) {
    this.grade.uniforms.uDanger.value = danger;
    this.grade.uniforms.uFlash.value = flash;
  }

  setPixelScale(s: number) {
    this.pixelScale = s;
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pr = dpr / this.pixelScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Keep the shadow frustum centred on what the camera sees. */
  updateSun(focus: THREE.Vector3) {
    // snap to texel grid to avoid shimmering
    const texel = (this.shadowHalf * 2) / 2048;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.position.set(fx + this.sunOffset.x, focus.y + this.sunOffset.y, fz + this.sunOffset.z);
    this.sun.target.position.set(fx, focus.y, fz);
  }

  render() {
    this.renderer.info.reset();
    this.composer.render();
  }
}
