// Time of day and weather. Each sector flies under one of these, so a run
// moves through midday, dusk, night, a sandstorm and dawn. A theme sets the
// lighting and grading, and nudges the rules a little (how far the enemy sees,
// how hard the wind blows, how far your radar reaches).

export type AtmosphereId = 'day' | 'dusk' | 'night' | 'storm' | 'dawn';

export interface Atmosphere {
  id: AtmosphereId;
  /** Shown in the briefing. */
  name: string;
  /** One line on what the conditions change (empty = nothing). */
  note: string;
  /** Haze / background colour. */
  sky: number;
  /** Fog start and end, measured from the camera's focus distance. */
  fogNear: number;
  fogFar: number;
  sun: number;
  sunIntensity: number;
  /** Direction towards the sun (normalised on use). */
  sunDir: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Colour grade: multiply, contrast, saturation, vignette strength. */
  tint: [number, number, number];
  contrast: number;
  saturation: number;
  vignette: number;
  bloom: number;
  /** Strength of the drifting cloud shadows (0 = clear sky). */
  cloud: number;
  /** Brightness of lamp and nav-light voxels. */
  glow: number;
  /** Brightness of lit (non-glowing) particles such as smoke and dust. */
  particleLight: [number, number, number];
  /** Radial dust haze around the edge of the screen (0..1). */
  haze: number;
  /** Blowing dust motes per second. */
  dust: number;
  /** Nose searchlight brightness (0 = off). */
  searchlight: number;
  /** Multiplier on how far enemy gunners can pick you up. */
  sight: number;
  /** Multiplier on wind speed. */
  wind: number;
  /** Multiplier on your radar range. */
  radar: number;
}

export const ATMOSPHERES: Record<AtmosphereId, Atmosphere> = {
  day: {
    id: 'day',
    name: 'MIDDAY · CLEAR',
    note: '',
    sky: 0xe6cfa3,
    fogNear: 45,
    fogFar: 335,
    sun: 0xfff0d8,
    sunIntensity: 2.1,
    sunDir: [-0.5, 0.85, 0.35],
    hemiSky: 0xffe9c8,
    hemiGround: 0x9a7650,
    hemiIntensity: 0.85,
    tint: [1, 1, 1],
    contrast: 1.07,
    saturation: 1.1,
    vignette: 0.3,
    bloom: 0.5,
    cloud: 0.2,
    glow: 0.6,
    particleLight: [1, 1, 1],
    haze: 0,
    dust: 3,
    searchlight: 0,
    sight: 1,
    wind: 1,
    radar: 1,
  },
  dusk: {
    id: 'dusk',
    name: 'DUSK · LOW SUN',
    note: 'Long shadows. Flak bursts and tracers are easy to read.',
    sky: 0xe2ab7c,
    fogNear: 40,
    fogFar: 320,
    sun: 0xffb47a,
    sunIntensity: 2.9,
    sunDir: [-0.74, 0.56, 0.38],
    hemiSky: 0xf6c8a8,
    hemiGround: 0x86625a,
    hemiIntensity: 0.95,
    tint: [1.03, 0.98, 0.93],
    contrast: 1.06,
    saturation: 1.12,
    vignette: 0.36,
    bloom: 0.7,
    cloud: 0.18,
    glow: 1.3,
    particleLight: [1, 0.82, 0.68],
    haze: 0,
    dust: 3,
    searchlight: 0,
    sight: 1,
    wind: 1,
    radar: 1,
  },
  night: {
    id: 'night',
    name: 'NIGHT · HALF MOON',
    note: 'Enemy gunners pick you up 25% later. Your searchlight shows the ground ahead.',
    sky: 0x1b2440,
    fogNear: 20,
    fogFar: 300,
    sun: 0xa9bcff,
    sunIntensity: 1.7,
    sunDir: [0.42, 0.8, -0.42],
    hemiSky: 0x7686c4,
    hemiGround: 0x2c2c40,
    hemiIntensity: 1.0,
    tint: [0.86, 0.96, 1.18],
    contrast: 1.12,
    saturation: 0.86,
    vignette: 0.46,
    bloom: 0.95,
    cloud: 0.12,
    glow: 2.2,
    particleLight: [0.3, 0.34, 0.5],
    haze: 0,
    dust: 1,
    searchlight: 1,
    sight: 0.75,
    wind: 1,
    radar: 1,
  },
  storm: {
    id: 'storm',
    name: 'SANDSTORM',
    note: 'Strong wind. Nobody sees far: enemy sight and your radar are cut by a third.',
    sky: 0xcaa064,
    fogNear: 0,
    fogFar: 255,
    sun: 0xffd9a0,
    sunIntensity: 1.25,
    sunDir: [-0.4, 0.85, 0.3],
    hemiSky: 0xecc88c,
    hemiGround: 0xa07a50,
    hemiIntensity: 1.15,
    tint: [1.05, 0.96, 0.82],
    contrast: 1.05,
    saturation: 0.85,
    vignette: 0.3,
    bloom: 0.45,
    cloud: 0,
    glow: 0.9,
    particleLight: [0.95, 0.88, 0.72],
    haze: 0.62,
    dust: 70,
    searchlight: 0,
    sight: 0.66,
    wind: 2.6,
    radar: 0.66,
  },
  dawn: {
    id: 'dawn',
    name: 'DAWN · GROUND MIST',
    note: 'Low sun and light mist.',
    sky: 0xdcb9b4,
    fogNear: 30,
    fogFar: 320,
    sun: 0xffd2b4,
    sunIntensity: 2.8,
    sunDir: [0.72, 0.58, 0.36],
    hemiSky: 0xe6d6e6,
    hemiGround: 0x86685e,
    hemiIntensity: 0.7,
    tint: [1.02, 0.98, 1.0],
    contrast: 1.08,
    saturation: 1.02,
    vignette: 0.32,
    bloom: 0.62,
    cloud: 0.2,
    glow: 1.2,
    particleLight: [1, 0.9, 0.88],
    haze: 0.06,
    dust: 2,
    searchlight: 0,
    sight: 1,
    wind: 1,
    radar: 1,
  },
};

const ORDER: AtmosphereId[] = ['day', 'dusk', 'night', 'storm', 'dawn'];

/** Conditions for a sector. `?sky=night` (or dusk, storm, dawn, day) forces one. */
export function atmosphereFor(sector: number): Atmosphere {
  const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('sky') : null;
  if (forced && forced in ATMOSPHERES) return ATMOSPHERES[forced as AtmosphereId];
  return ATMOSPHERES[ORDER[(Math.max(1, sector) - 1) % ORDER.length]];
}
