import * as THREE from 'three';

// Lambert material + voxel-specific tweaks:
//  * per-voxel brightness hash (the "dithered sand" look, keeps greedy meshing cheap)
//  * emissive flag for light voxels (noise attribute == 1)
//  * optional damage tint (for models) via uniform

const HASH = /* glsl */ `
varying vec3 vVoxWPos;
varying vec3 vVoxWNrm;
varying float vVoxNoise;
float voxHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
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
${opts.localHash ? 'vVoxWPos = position;' : 'vVoxWPos = (modelMatrix * vec4(position, 1.0)).xyz;'}
vVoxWNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uFlash;
${HASH}`,
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
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.95, 0.85), uFlash);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if (vVoxNoise > 0.99) totalEmissiveRadiance += diffuseColor.rgb * 0.9;
totalEmissiveRadiance += diffuseColor.rgb * uFlash * 0.6;`,
      );
  };
  // Separate program cache key for local/world hash variants.
  mat.customProgramCacheKey = () => `voxel_${opts.localHash ? 'l' : 'w'}`;
  return mat;
}
