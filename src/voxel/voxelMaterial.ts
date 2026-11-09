import * as THREE from 'three';

// Lambert material + voxel-specific tweaks:
//  * per-voxel brightness hash (the "dithered sand" look, keeps greedy meshing cheap)
//  * emissive flag for light voxels (noise attribute == 1)
//  * optional damage tint (for models) via uniform
//  * cloud shadows drifting over everything, with a dithered voxel-sized edge

/**
 * Uniforms shared by every voxel material.
 *  uTime  - seconds, advanced by the game
 *  uCloud - x: shadow strength (0 = clear sky), y: noise scale, z/w: drift per second (world units)
 */
export const voxelGlobals = {
  uTime: { value: 0 },
  uCloud: { value: new THREE.Vector4(0.2, 0.0075, 5, 2.2) },
  /** brightness of light voxels (lamps, nav lights); raised at night so they bloom */
  uGlow: { value: 0.6 },
};

const HASH = /* glsl */ `
varying vec3 vVoxWPos;
varying vec3 vVoxWNrm;
varying float vVoxNoise;
varying vec2 vVoxCloudXZ;
float voxHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
`;

const CLOUDS = /* glsl */ `
uniform float uTime;
uniform vec4 uCloud;
float cloudHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float cloudNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), f.x), mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

export interface VoxelMaterialOptions {
  /** Use model-space position for the hash (for moving models). */
  localHash?: boolean;
  transparent?: boolean;
  opacity?: number;
}

export function createVoxelMaterial(opts: VoxelMaterialOptions = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (opts.transparent) {
    mat.transparent = true;
    mat.opacity = opts.opacity ?? 1;
  }
  const flash = { value: 0 };
  mat.userData.flash = flash;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlash = flash;
    shader.uniforms.uTime = voxelGlobals.uTime;
    shader.uniforms.uCloud = voxelGlobals.uCloud;
    shader.uniforms.uGlow = voxelGlobals.uGlow;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aNoise;
${HASH}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vVoxNoise = aNoise;
vec3 voxWorld = (modelMatrix * vec4(position, 1.0)).xyz;
${opts.localHash ? 'vVoxWPos = position;' : 'vVoxWPos = voxWorld;'}
vVoxCloudXZ = voxWorld.xz;
vVoxWNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uFlash;
uniform float uGlow;
${HASH}
${CLOUDS}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  diffuseColor.rgb = pow(diffuseColor.rgb, vec3(2.2)); // vertex colours are authored in sRGB
  vec3 cell = floor(vVoxWPos - vVoxWNrm * 0.5 + 0.001);
  float h = voxHash(cell);
  float amt = vVoxNoise > 0.99 ? 0.0 : vVoxNoise;
  diffuseColor.rgb *= 1.0 + (h - 0.5) * 2.0 * amt;
  // subtle large-scale variation so wide flat areas don't look tiled
  float h2 = voxHash(floor(cell / 7.0) + 13.0);
  diffuseColor.rgb *= 1.0 + (h2 - 0.5) * 0.06 * step(0.001, amt);
  // cloud shadows: two octaves of drifting noise, edge dithered per voxel
  if (uCloud.x > 0.0 && vVoxNoise <= 0.99) {
    vec2 cp = (floor(vVoxCloudXZ) + uCloud.zw * uTime) * uCloud.y;
    float cn = cloudNoise(cp) * 0.65 + cloudNoise(cp * 2.7 + 11.0) * 0.35;
    float shade = smoothstep(0.5, 0.58, cn + (h - 0.5) * 0.045);
    diffuseColor.rgb *= 1.0 - uCloud.x * shade;
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.95, 0.85), uFlash);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if (vVoxNoise > 0.99) totalEmissiveRadiance += diffuseColor.rgb * uGlow;
totalEmissiveRadiance += diffuseColor.rgb * uFlash * 0.6;`,
      );
  };
  // Separate program cache key for local/world hash variants.
  mat.customProgramCacheKey = () => `voxel_${opts.localHash ? 'l' : 'w'}`;
  return mat;
}
