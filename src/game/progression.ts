// Meta progression: persistent credits + upgrade levels, gated by the best
// sector the player has reached. Saved in localStorage.

export type UpgradeId = 'engine' | 'fuel' | 'armor' | 'gunAmmo' | 'gunDmg' | 'gunRof' | 'rockets' | 'rocketDmg' | 'missiles' | 'flares' | 'cabin' | 'winch' | 'radar';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  desc: string;
  max: number;
  /** Sector you must have reached before level 1 can be bought. */
  unlock: number;
  base: number;
  group: 'Airframe' | 'Weapons' | 'Systems';
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'engine', name: 'Turboshaft', desc: 'More engine power: climb rate, lift margin and top speed.', max: 4, unlock: 1, base: 160, group: 'Airframe' },
  { id: 'fuel', name: 'Aux fuel tanks', desc: '+20% fuel capacity per level (adds weight when full).', max: 4, unlock: 1, base: 110, group: 'Airframe' },
  { id: 'armor', name: 'Armor plating', desc: '+25 hull integrity per level.', max: 5, unlock: 1, base: 130, group: 'Airframe' },
  { id: 'gunAmmo', name: 'Ammo bay', desc: '+120 cannon rounds per level.', max: 4, unlock: 1, base: 80, group: 'Weapons' },
  { id: 'gunDmg', name: '30mm HEDP', desc: 'Bigger cannon round blast and damage.', max: 3, unlock: 1, base: 150, group: 'Weapons' },
  { id: 'gunRof', name: 'Feed system', desc: 'Higher cannon rate of fire.', max: 3, unlock: 2, base: 140, group: 'Weapons' },
  { id: 'rockets', name: 'Rocket pods', desc: '+6 rockets per level.', max: 4, unlock: 1, base: 120, group: 'Weapons' },
  { id: 'rocketDmg', name: 'Thermobaric warheads', desc: 'Larger rocket blast radius and power.', max: 3, unlock: 2, base: 180, group: 'Weapons' },
  { id: 'missiles', name: 'Guided missiles', desc: 'Lock-on missiles (hover cursor over a target, press F). +2 per level.', max: 4, unlock: 2, base: 220, group: 'Weapons' },
  { id: 'flares', name: 'Countermeasures', desc: 'Flares decoy SAMs (X). +4 per level.', max: 3, unlock: 2, base: 150, group: 'Systems' },
  { id: 'cabin', name: 'Cabin space', desc: '+2 rescue seats per level.', max: 3, unlock: 1, base: 100, group: 'Systems' },
  { id: 'winch', name: 'Fast winch', desc: 'Faster cargo winching.', max: 2, unlock: 1, base: 90, group: 'Systems' },
  { id: 'radar', name: 'Radar suite', desc: 'Longer radar range on the scope.', max: 3, unlock: 3, base: 160, group: 'Systems' },
];

export interface SaveData {
  version: number;
  credits: number;
  levels: Partial<Record<UpgradeId, number>>;
  bestSector: number;
  runs: number;
  rescuedTotal: number;
  settings: { pixelScale: number; assists: boolean; volume: number };
}

const KEY = 'tinywar.save.v1';

export function defaultSave(): SaveData {
  return { version: 1, credits: 0, levels: {}, bestSector: 1, runs: 0, rescuedTotal: 0, settings: { pixelScale: 2, assists: true, volume: 0.7 } };
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
  winchTime: number;
  radarRange: number;
}

export function computeStats(s: SaveData): HeliStats {
  const L = (id: UpgradeId) => level(s, id);
  return {
    maxFuel: 100 * (1 + 0.2 * L('fuel')),
    maxHp: 100 + 25 * L('armor'),
    twr: 1.42 + 0.09 * L('engine'),
    maxTilt: ((22 + 3 * L('engine')) * Math.PI) / 180,
    gunAmmo: 300 + 120 * L('gunAmmo'),
    gunRadius: 1.5 + 0.3 * L('gunDmg'),
    gunPower: 3.2 + 0.9 * L('gunDmg'),
    gunRof: 9 + 3 * L('gunRof'),
    rockets: 14 + 6 * L('rockets'),
    rocketRadius: 3.8 + 0.8 * L('rocketDmg'),
    rocketPower: 9 + 2.2 * L('rocketDmg'),
    missiles: L('missiles') ? 2 + 2 * L('missiles') : 0,
    flares: L('flares') ? 4 + 4 * L('flares') : 0,
    cabin: 4 + 2 * L('cabin'),
    winchTime: 1.5 - 0.45 * L('winch'),
    radarRange: 320 + 130 * L('radar'),
  };
}
