// Progression has two layers:
//  - Level-ups (per run): XP from kills/objectives/rescues; each level pauses
//    the game and offers 1 of 3 random perks. Perks reset when the run ends.
//  - Shop (permanent): credits buy hangar upgrades. Items appear gradually as
//    you reach deeper sectors, and each new sector raises their level caps.
// Saved in localStorage.

export type UpgradeId = 'engine' | 'fuel' | 'armor' | 'gunAmmo' | 'gunDmg' | 'gunRof' | 'rockets' | 'rocketDmg' | 'missiles' | 'flares' | 'cabin' | 'radar';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  desc: string;
  max: number;
  /** Sector you must reach before the item appears in the shop. */
  unlock: number;
  base: number;
}

/** Ordered by unlock sector: 4 items at the start, a few more per sector. */
export const UPGRADES: UpgradeDef[] = [
  { id: 'engine', name: 'Turboshaft', desc: 'More engine power: climb rate, lift margin and top speed.', max: 4, unlock: 1, base: 160 },
  { id: 'armor', name: 'Armor plating', desc: '+25 hull integrity per level.', max: 5, unlock: 1, base: 130 },
  { id: 'fuel', name: 'Aux fuel tanks', desc: '+20% fuel capacity per level.', max: 4, unlock: 1, base: 110 },
  { id: 'rockets', name: 'Rocket pods', desc: '+6 rockets per level.', max: 4, unlock: 1, base: 120 },
  { id: 'missiles', name: 'Guided missiles', desc: 'Lock-on missiles (keep the nose on a target, press F / A). +2 per level.', max: 4, unlock: 2, base: 220 },
  { id: 'gunAmmo', name: 'Ammo bay', desc: '+120 cannon rounds per level.', max: 4, unlock: 2, base: 80 },
  { id: 'cabin', name: 'Cabin space', desc: '+2 rescue seats per level.', max: 3, unlock: 2, base: 100 },
  { id: 'gunDmg', name: '30mm HEDP', desc: 'Bigger cannon round blast and damage.', max: 3, unlock: 3, base: 150 },
  { id: 'flares', name: 'Countermeasures', desc: 'Flares decoy SAMs (X / B). +4 per level.', max: 3, unlock: 3, base: 150 },
  { id: 'rocketDmg', name: 'Thermobaric warheads', desc: 'Larger rocket blast radius and power.', max: 3, unlock: 3, base: 180 },
  { id: 'gunRof', name: 'Feed system', desc: 'Higher cannon rate of fire.', max: 3, unlock: 4, base: 140 },
  { id: 'radar', name: 'Radar suite', desc: 'Longer radar range on the scope.', max: 3, unlock: 4, base: 160 },
];

// ---------------------------------------------------------------- run perks (level-ups)

export type PerkId = 'hull' | 'plates' | 'regen' | 'fuelTanks' | 'turbo' | 'feed' | 'heRounds' | 'racks' | 'thermo' | 'gunner' | 'hellfire' | 'flarePods' | 'salvage';

export interface PerkDef {
  id: PerkId;
  name: string;
  desc: string;
  max: number;
  tag: 'DEFENCE' | 'FLIGHT' | 'CANNON' | 'ROCKETS' | 'SYSTEMS';
}

export const PERKS: PerkDef[] = [
  { id: 'hull', name: 'Reinforced hull', desc: '+25 max armor, and patches 25 right away.', max: 4, tag: 'DEFENCE' },
  { id: 'plates', name: 'Ceramic plates', desc: 'Take 12% less damage from everything.', max: 3, tag: 'DEFENCE' },
  { id: 'regen', name: 'Damage control', desc: 'The crew repairs 0.6 armor per second in flight.', max: 3, tag: 'DEFENCE' },
  { id: 'fuelTanks', name: 'Ferry tanks', desc: '+25% fuel capacity, topped up now.', max: 3, tag: 'FLIGHT' },
  { id: 'turbo', name: 'Overboost', desc: 'More engine power: faster climb and cruise.', max: 3, tag: 'FLIGHT' },
  { id: 'feed', name: 'Linked feed', desc: '+25% cannon rate of fire.', max: 3, tag: 'CANNON' },
  { id: 'heRounds', name: 'HE rounds', desc: 'Bigger cannon blasts that chew through walls.', max: 3, tag: 'CANNON' },
  { id: 'racks', name: 'Extra racks', desc: '+6 rockets, loaded now.', max: 3, tag: 'ROCKETS' },
  { id: 'thermo', name: 'Thermobaric', desc: 'Bigger, harder-hitting rocket blasts.', max: 3, tag: 'ROCKETS' },
  { id: 'gunner', name: 'Veteran gunner', desc: 'Wider target cone and faster missile lock.', max: 2, tag: 'SYSTEMS' },
  { id: 'hellfire', name: 'Hellfire pair', desc: '+2 guided missiles (fits a launcher if you have none).', max: 3, tag: 'SYSTEMS' },
  { id: 'flarePods', name: 'Flare pods', desc: '+4 flares (fits a dispenser if you have none).', max: 3, tag: 'SYSTEMS' },
  { id: 'salvage', name: 'Salvage rights', desc: '+25% credits from everything you destroy.', max: 3, tag: 'SYSTEMS' },
];

export type Perks = Partial<Record<PerkId, number>>;

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return Math.round(100 * Math.pow(1.45, level - 1));
}

/** Three distinct perks that aren't maxed out yet. */
export function rollPerks(perks: Perks, rnd: () => number = Math.random): PerkDef[] {
  const pool = PERKS.filter((p) => (perks[p.id] ?? 0) < p.max);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

// ---------------------------------------------------------------- save

export interface SaveData {
  version: number;
  credits: number;
  levels: Partial<Record<UpgradeId, number>>;
  bestSector: number;
  runs: number;
  rescuedTotal: number;
  settings: { pixelScale: number; assists: boolean; volume: number; rumble: boolean; music: boolean };
}

const KEY = 'tinywar.save.v1';

export function defaultSave(): SaveData {
  return { version: 1, credits: 0, levels: {}, bestSector: 1, runs: 0, rescuedTotal: 0, settings: { pixelScale: 2, assists: true, volume: 0.7, rumble: true, music: true } };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as SaveData;
    return { ...defaultSave(), ...d, settings: { ...defaultSave().settings, ...(d.settings ?? {}) } };
  } catch {
    return defaultSave();
  }
}

export function writeSave(s: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: progress lives for this session only */
  }
}

export function level(s: SaveData, id: UpgradeId): number {
  return s.levels[id] ?? 0;
}

export function upgradeCost(def: UpgradeDef, lvl: number): number {
  return Math.round(def.base * Math.pow(1.6, lvl));
}

/** Highest level purchasable given progress: each new sector raises caps. */
export function levelCap(def: UpgradeDef, bestSector: number): number {
  if (bestSector < def.unlock) return 0;
  return Math.min(def.max, 1 + (bestSector - def.unlock));
}

/** Shop items currently on offer, and the next batch still locked. */
export function shopItems(s: SaveData): { open: UpgradeDef[]; next: UpgradeDef[]; nextSector: number } {
  const open = UPGRADES.filter((u) => u.unlock <= s.bestSector);
  const nextSector = Math.min(...UPGRADES.filter((u) => u.unlock > s.bestSector).map((u) => u.unlock), Infinity);
  const next = UPGRADES.filter((u) => u.unlock === nextSector);
  return { open, next, nextSector };
}

// ---------------------------------------------------------------- derived stats

export interface HeliStats {
  maxFuel: number;
  maxHp: number;
  twr: number;
  maxTilt: number;
  gunAmmo: number;
  gunRadius: number;
  gunPower: number;
  gunRof: number;
  rockets: number;
  rocketRadius: number;
  rocketPower: number;
  missiles: number;
  flares: number;
  cabin: number;
  radarRange: number;
  /** multiplier on incoming damage */
  damageMul: number;
  /** armor repaired per second in flight */
  regen: number;
  /** multiplier on credits earned */
  creditMul: number;
  /** multiplier on the gunner's target cones */
  coneMul: number;
  /** seconds to lock a missile */
  lockTime: number;
}

export function computeStats(s: SaveData, perks: Perks = {}): HeliStats {
  const L = (id: UpgradeId) => level(s, id);
  const P = (id: PerkId) => perks[id] ?? 0;
  const missiles = (L('missiles') ? 2 + 2 * L('missiles') : 0) + 2 * P('hellfire');
  const flares = (L('flares') ? 4 + 4 * L('flares') : 0) + 4 * P('flarePods');
  return {
    maxFuel: 100 * (1 + 0.2 * L('fuel')) * (1 + 0.25 * P('fuelTanks')),
    maxHp: 100 + 25 * L('armor') + 25 * P('hull'),
    twr: 1.42 + 0.09 * L('engine') + 0.07 * P('turbo'),
    maxTilt: ((25 + 3 * L('engine') + 2 * P('turbo')) * Math.PI) / 180,
    gunAmmo: 300 + 120 * L('gunAmmo'),
    gunRadius: 1.5 + 0.3 * L('gunDmg') + 0.3 * P('heRounds'),
    gunPower: 3.2 + 0.9 * L('gunDmg') + 0.8 * P('heRounds'),
    gunRof: (9 + 3 * L('gunRof')) * (1 + 0.25 * P('feed')),
    rockets: 14 + 6 * L('rockets') + 6 * P('racks'),
    rocketRadius: 3.8 + 0.8 * L('rocketDmg') + 0.7 * P('thermo'),
    rocketPower: 9 + 2.2 * L('rocketDmg') + 2 * P('thermo'),
    missiles,
    flares,
    cabin: 4 + 2 * L('cabin'),
    radarRange: 320 + 130 * L('radar'),
    damageMul: Math.pow(0.88, P('plates')),
    regen: 0.6 * P('regen'),
    creditMul: 1 + 0.25 * P('salvage'),
    coneMul: 1 + 0.25 * P('gunner'),
    lockTime: 0.6 * Math.pow(0.7, P('gunner')),
  };
}
