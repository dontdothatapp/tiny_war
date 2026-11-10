import * as THREE from 'three';
import { clamp, lerp } from '../core/rng';

// Camera work for the start of a sector: an establishing shot of the whole
// board from a low corner angle (behind the briefing, and for a beat after
// LAUNCH), then a dive that ends exactly on the game camera.

/** An orbit camera: looks at `focus` from `dist` away, `pitch` above the horizon, `yaw` around it (0 = from the south). */
export interface CamPose {
  focus: THREE.Vector3;
  dist: number;
  pitch: number;
  yaw: number;
}

export const newPose = (): CamPose => ({ focus: new THREE.Vector3(), dist: 1, pitch: 0, yaw: 0 });

/** Pitch of the game camera (~56 degrees). */
export const PLAY_PITCH = 0.98;
/** Seconds the establishing shot is held after LAUNCH. */
export const INTRO_HOLD = 0.8;
/** Seconds the dive takes. */
export const INTRO_DIVE = 4.0;
/** How much faster the intro runs once the player asks to skip it. */
export const INTRO_SKIP_RATE = 8;

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * The whole board in frame, seen corner-on from the sunlit side so two cliff
 * faces show, swaying a little so the miniature never sits still.
 */
export function establishingPose(size: number, cam: THREE.PerspectiveCamera, sunX: number, time: number, out: CamPose): CamPose {
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  const tanH = tanV * cam.aspect;
  // far enough for the board's diagonal to fit across, and its depth to fit top to bottom
  out.dist = size * Math.max(0.98 / tanH, 0.54 / tanV);
  out.pitch = 0.5 + Math.sin(time * 0.21) * 0.015;
  out.yaw = (sunX >= 0 ? 1 : -1) * 0.62 + Math.sin(time * 0.17) * 0.09;
  // aim below the surface so the thickness of the slab sits in the middle of the frame
  out.focus.set(size / 2, -size * 0.07, size / 2);
  return out;
}

/**
 * From the establishing shot `a` to the game camera `b`, u = 0..1. The camera
 * settles over the helipad first and closes the distance last; distance is
 * blended in log space so the zoom feels even all the way down.
 */
export function divePose(a: CamPose, b: CamPose, u: number, out: CamPose): CamPose {
  const zoom = smoother(u);
  const pan = smoother(clamp(u / 0.7, 0, 1));
  const turn = smoother(clamp((u - 0.08) / 0.92, 0, 1));
  out.dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), zoom));
  out.pitch = lerp(a.pitch, b.pitch, turn);
  out.yaw = lerp(a.yaw, b.yaw, turn);
  out.focus.lerpVectors(a.focus, b.focus, pan);
  return out;
}

/** 1 at the establishing distance, 0 at the game camera's, even in zoom steps. */
export function farness(dist: number, farDist: number, playDist: number): number {
  if (farDist <= playDist) return 0;
  return clamp(Math.log(dist / playDist) / Math.log(farDist / playDist), 0, 1);
}
