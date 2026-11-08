import * as THREE from 'three';

export const SKY_COLOR = 0xe6cfa3;

/** Renderer, scene, lights and the follow camera. */
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  pixelScale = 2; // 1 = native, 2/3 = chunky retro pixels
  private sunOffset = new THREE.Vector3(-90, 150, 60);

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
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
    sc.far = 500;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setPixelScale(s: number) {
    this.pixelScale = s;
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr / this.pixelScale);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Keep the shadow frustum centred on what the camera sees. */
  updateSun(focus: THREE.Vector3) {
    // snap to texel grid to avoid shimmering
    const texel = 400 / 2048;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.position.set(fx + this.sunOffset.x, focus.y + this.sunOffset.y, fz + this.sunOffset.z);
    this.sun.target.position.set(fx, focus.y, fz);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
