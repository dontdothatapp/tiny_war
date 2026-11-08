// Voxel material table. A voxel is a single byte: 0 = air, 1..255 = material id.
// Each material defines its colour, how hard it is to blow up, how much colour
// noise the shader adds per voxel, and a few behaviour flags.

export interface MaterialDef {
  name: string;
  color: number; // 0xRRGGBB
  /** Blast energy needed to remove one voxel. Infinity = indestructible. */
  hardness: number;
  /** Per-voxel brightness jitter applied in the shader (0..1). */
  noise: number;
  /** Ground material: counts as supported, ignored by structure integrity. */
  terrain?: boolean;
  /** Burns / emits fire when blasted. */
  flammable?: boolean;
  /** Chunks of debris glow (used by fuel). */
  explosive?: boolean;
  /** Rotor can chop through it with minor damage (foliage). */
  soft?: boolean;
  /** Emits light-ish colour (not lit by shadows). */
  emissive?: boolean;
}

export const M = {
  AIR: 0,
  BEDROCK: 1,
  SAND: 2,
  SAND_DARK: 3,
  ROCK: 4,
  ROCK_DARK: 5,
  ASPHALT: 6,
  ROAD_LINE: 7,
  SCORCH: 8,
  PLASTER: 9,
  PLASTER_WHITE: 10,
  PLASTER_TAN: 11,
  CONCRETE: 12,
  WINDOW: 13,
  WOOD_DOOR: 14,
  METAL_DARK: 15,
  METAL_OLIVE: 16,
  METAL_TAN: 17,
  PALM_TRUNK: 18,
  PALM_LEAF: 19,
  PALM_LEAF_DARK: 20,
  SHRUB: 21,
  CRATE: 22,
  FUEL_TANK: 23,
  SANDBAG: 24,
  RUBBER: 25,
  RED_MARK: 26,
  PAD: 27,
  PAD_MARK: 28,
  DISH: 29,
  CAMO: 30,
  RUBBLE: 31,
  DOME: 32,
  RUST: 33,
  GLASS: 34,
  AC_UNIT: 35,
  WATER_TANK: 36,
  CLOTH_RED: 37,
  CLOTH_BLUE: 38,
  CLOTH_WHITE: 39,
  GREEN_GRASS: 40,
  MUD_BRICK: 41,
  STEEL: 42,
  WRECK: 43,
  LIGHT_RED: 44,
  LIGHT_GREEN: 45,
  ROAD_EDGE: 46,
  OLIVE_DARK: 47,
  TENT: 48,
  CONCRETE_DARK: 49,
  WATER: 50,
  YELLOW_MARK: 51,
} as const;

const defs: Record<number, MaterialDef> = {
  [M.BEDROCK]: { name: 'bedrock', color: 0x8a6a48, hardness: Infinity, noise: 0.1, terrain: true },
  [M.SAND]: { name: 'sand', color: 0xd9b27a, hardness: 1.2, noise: 0.14, terrain: true },
  [M.SAND_DARK]: { name: 'sand_dark', color: 0xc99d64, hardness: 1.4, noise: 0.14, terrain: true },
  [M.ROCK]: { name: 'rock', color: 0xb08660, hardness: 6, noise: 0.16, terrain: true },
  [M.ROCK_DARK]: { name: 'rock_dark', color: 0x93694a, hardness: 7, noise: 0.16, terrain: true },
  [M.ASPHALT]: { name: 'asphalt', color: 0x5b5753, hardness: 3, noise: 0.1, terrain: true },
  [M.ROAD_LINE]: { name: 'road_line', color: 0xe8e2cf, hardness: 3, noise: 0.05, terrain: true },
  [M.ROAD_EDGE]: { name: 'road_edge', color: 0x7a6f62, hardness: 3, noise: 0.12, terrain: true },
  [M.SCORCH]: { name: 'scorch', color: 0x4a3c30, hardness: 1.5, noise: 0.2, terrain: true },
  [M.PLASTER]: { name: 'plaster', color: 0xd8c7a6, hardness: 2.2, noise: 0.08 },
  [M.PLASTER_WHITE]: { name: 'plaster_white', color: 0xe8e0cf, hardness: 2.2, noise: 0.06 },
  [M.PLASTER_TAN]: { name: 'plaster_tan', color: 0xc9a77d, hardness: 2.2, noise: 0.08 },
  [M.MUD_BRICK]: { name: 'mud_brick', color: 0xb98f63, hardness: 1.8, noise: 0.14 },
  [M.CONCRETE]: { name: 'concrete', color: 0xa8a49c, hardness: 4.5, noise: 0.08 },
  [M.CONCRETE_DARK]: { name: 'concrete_dark', color: 0x7d7a74, hardness: 5, noise: 0.08 },
  [M.WINDOW]: { name: 'window', color: 0x2c2a2a, hardness: 1, noise: 0.05 },
  [M.GLASS]: { name: 'glass', color: 0x6d8a92, hardness: 0.6, noise: 0.05 },
  [M.WOOD_DOOR]: { name: 'wood_door', color: 0x6b4a2e, hardness: 1.2, noise: 0.1, flammable: true },
  [M.METAL_DARK]: { name: 'metal_dark', color: 0x3f403d, hardness: 5, noise: 0.06 },
  [M.METAL_OLIVE]: { name: 'metal_olive', color: 0x6b6b3e, hardness: 5, noise: 0.07 },
  [M.OLIVE_DARK]: { name: 'olive_dark', color: 0x4d4f2c, hardness: 5, noise: 0.07 },
  [M.METAL_TAN]: { name: 'metal_tan', color: 0xa38c5e, hardness: 4, noise: 0.07 },
  [M.STEEL]: { name: 'steel', color: 0x8d9093, hardness: 8, noise: 0.05 },
  [M.PALM_TRUNK]: { name: 'palm_trunk', color: 0x7a5a38, hardness: 1.0, noise: 0.15, flammable: true },
  [M.PALM_LEAF]: { name: 'palm_leaf', color: 0x5d7a2c, hardness: 0.3, noise: 0.18, flammable: true, soft: true },
  [M.PALM_LEAF_DARK]: { name: 'palm_leaf_dark', color: 0x435c22, hardness: 0.3, noise: 0.18, flammable: true, soft: true },
  [M.SHRUB]: { name: 'shrub', color: 0x7d8a45, hardness: 0.3, noise: 0.2, flammable: true, soft: true },
  [M.GREEN_GRASS]: { name: 'grass', color: 0x8a9a4a, hardness: 0.6, noise: 0.2, terrain: true },
  [M.CRATE]: { name: 'crate', color: 0x8f7446, hardness: 1.2, noise: 0.12, flammable: true },
  [M.FUEL_TANK]: { name: 'fuel_tank', color: 0xb9b2a0, hardness: 2.5, noise: 0.05, explosive: true },
  [M.SANDBAG]: { name: 'sandbag', color: 0xb59c6c, hardness: 2.5, noise: 0.15 },
  [M.RUBBER]: { name: 'rubber', color: 0x262524, hardness: 2, noise: 0.05 },
  [M.RED_MARK]: { name: 'red_mark', color: 0xa23a2a, hardness: 3, noise: 0.06 },
  [M.PAD]: { name: 'pad', color: 0x8e8b84, hardness: 6, noise: 0.06, terrain: true },
  [M.PAD_MARK]: { name: 'pad_mark', color: 0xe7e3d6, hardness: 6, noise: 0.03, terrain: true },
  [M.YELLOW_MARK]: { name: 'yellow_mark', color: 0xd9b23a, hardness: 6, noise: 0.03, terrain: true },
  [M.DISH]: { name: 'dish', color: 0xc9cbc6, hardness: 3, noise: 0.04 },
  [M.CAMO]: { name: 'camo', color: 0x7b7550, hardness: 0.5, noise: 0.25, flammable: true, soft: true },
  [M.RUBBLE]: { name: 'rubble', color: 0x9c8b72, hardness: 1.5, noise: 0.25 },
  [M.DOME]: { name: 'dome', color: 0xeae6dc, hardness: 2.5, noise: 0.04 },
  [M.RUST]: { name: 'rust', color: 0x7e4a2c, hardness: 3, noise: 0.15 },
  [M.AC_UNIT]: { name: 'ac_unit', color: 0xbdbab0, hardness: 1.5, noise: 0.05 },
  [M.WATER_TANK]: { name: 'water_tank', color: 0x3d4a52, hardness: 1.5, noise: 0.05 },
  [M.CLOTH_RED]: { name: 'cloth_red', color: 0x9e3b2f, hardness: 0.4, noise: 0.1, flammable: true, soft: true },
  [M.CLOTH_BLUE]: { name: 'cloth_blue', color: 0x3c5a7a, hardness: 0.4, noise: 0.1, flammable: true, soft: true },
  [M.CLOTH_WHITE]: { name: 'cloth_white', color: 0xd9d3c3, hardness: 0.4, noise: 0.1, flammable: true, soft: true },
  [M.WRECK]: { name: 'wreck', color: 0x2e2a26, hardness: 3, noise: 0.25 },
  [M.LIGHT_RED]: { name: 'light_red', color: 0xff3b2a, hardness: 1, noise: 0, emissive: true },
  [M.LIGHT_GREEN]: { name: 'light_green', color: 0x6bff6b, hardness: 1, noise: 0, emissive: true },
  [M.TENT]: { name: 'tent', color: 0x8c8456, hardness: 0.6, noise: 0.12, flammable: true, soft: true },
  [M.WATER]: { name: 'water', color: 0x4f7f86, hardness: 1, noise: 0.05, terrain: true },
};

export const MATERIALS: MaterialDef[] = [];
for (let i = 0; i < 256; i++) {
  MATERIALS[i] = defs[i] ?? { name: 'air', color: 0xff00ff, hardness: 0, noise: 0 };
}

// Pre-split RGB (0..255) tables for the mesher.
export const MAT_R = new Uint8Array(256);
export const MAT_G = new Uint8Array(256);
export const MAT_B = new Uint8Array(256);
export const MAT_NOISE = new Uint8Array(256);
export const MAT_TERRAIN = new Uint8Array(256);
export const MAT_SOFT = new Uint8Array(256);
export const MAT_HARD = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const d = MATERIALS[i];
  MAT_R[i] = (d.color >> 16) & 255;
  MAT_G[i] = (d.color >> 8) & 255;
  MAT_B[i] = d.color & 255;
  MAT_NOISE[i] = Math.round(Math.min(1, d.noise) * 255);
  MAT_TERRAIN[i] = d.terrain ? 1 : 0;
  MAT_SOFT[i] = d.soft ? 1 : 0;
  MAT_HARD[i] = d.hardness;
}
// Emissive materials get noise byte 255 as a flag (handled in shader as "unlit").
for (let i = 0; i < 256; i++) if (MATERIALS[i].emissive) MAT_NOISE[i] = 255;
