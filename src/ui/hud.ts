import * as THREE from 'three';

// DOM HUD in a green-phosphor terminal style + a 2D overlay canvas for
// the fire-control reticle, lock boxes and off-screen markers.
//
// Layout: objectives top-left, minimap top-right, and one dashboard at the
// bottom centre: armor and fuel, the weapons in big numerals, speed and height.
//
// Colour is the legend, and it means the same on the HUD, the minimap, the full
// map and the markers in the world: red is hostile, cyan is home, violet is a
// crew to pick up, yellow is supplies. Things to do are drawn as areas; dots are
// only enemies the radar has actually picked up.

export const HUD_COLORS = {
  home: '#6fd3ff',
  hostile: '#ff5a4a',
  convoy: '#ff9a3a',
  rescue: '#d79bff',
  supply: '#ffd95a',
  neutral: '#e6dcc0',
};

/** Flak and SAM radars can't hold a target flying lower than about this (voxels above ground). */
const RADAR_FLOOR = 12;
/** Minimap edge length in CSS pixels. */
const MINI = 216;
/** The full map is drawn in a square of this many design pixels, scaled to the canvas. */
const FULL = 760;
const FONT = '"VT323", monospace';

export interface HudObjective {
  text: string;
  done: boolean;
  active?: boolean;
  /** picks the marker colour (default: target) */
  kind?: 'target' | 'rescue' | 'convoy' | 'home';
}

export interface HudData {
  hp: number;
  maxHp: number;
  fuel: number;
  maxFuel: number;
  gun: number;
  maxGun: number;
  rockets: number;
  maxRockets: number;
  missiles: number;
  maxMissiles: number;
  flares: number;
  maxFlares: number;
  /** height above the ground, and the most there is room for under the ceiling */
  alt: number;
  maxAlt: number;
  speed: number;
  heading: number;
  assists: boolean;
  windDir: number;
  windSpeed: number;
  credits: number;
  pending: number;
  level: number;
  xp: number;
  xpNext: number;
  sector: number;
  /** credit multiplier from the kill streak (1 = no streak) and how much of its timer is left (0..1) */
  streak: number;
  streakLeft: number;
  warnings: string[];
  objectives: HudObjective[];
  /** where the aircraft is: a place name and/or a grid square */
  place: string;
  /** key or button prompt under each weapon */
  keys: { gun: string; rockets: string; missiles: string; flares: string };
}

/** An area on the map: somewhere to go, not a thing to shoot. */
export interface MapZone {
  kind: 'home' | 'objective' | 'rescue' | 'town';
  x: number;
  z: number;
  r: number;
  label: string;
  /** progress, e.g. "1/3" */
  sub?: string;
  done?: boolean;
}

/** An enemy the radar has picked up. */
export interface MapUnit {
  kind: 'gun' | 'sam' | 'air' | 'vehicle';
  x: number;
  z: number;
}

export interface MapView {
  size: number;
  heli: { x: number; z: number; heading: number };
  /** radar range: half the width of the minimap window, and the ring on the full map */
  range: number;
  zones: MapZone[];
  units: MapUnit[];
  supplies: { type: 'fuel' | 'ammo' | 'repair'; x: number; z: number }[];
  /** what is left of the convoy's drive, while it is rolling */
  route: { ax: number; az: number; bx: number; bz: number } | null;
}

export const KEYBOARD_HELP = `W/S cyclic fwd/back · A/D cyclic left/right · Q/E turn · SPACE/SHIFT climb/descend<br>LMB cannon · RMB rockets (both fire straight ahead) · F missile · X flares · H assists · M map · P pixels · ESC pause`;

const LEGEND = `
  <div class="t">TACTICAL MAP</div>
  <div class="r"><i class="sym home">H</i><div><b>FARP</b><span>Home pad. Land to rearm, refuel, repair and bank credits.</span></div></div>
  <div class="r"><i class="sym obj"></i><div><b>OBJECTIVE AREA</b><span>Destroy the named target inside it.</span></div></div>
  <div class="r"><i class="sym rescue">+</i><div><b>CREW DOWN</b><span>Land beside the violet smoke.</span></div></div>
  <div class="r"><i class="sym supply"></i><div><b>SUPPLIES</b><span>F fuel · A ammo · R repair. Hover low over the crate.</span></div></div>
  <div class="r"><i class="sym enemy"></i><div><b>ENEMY</b><span>Only what your radar has picked up. ◆ SAM · ▲ gunship.</span></div></div>
  <div class="r"><i class="sym convoy"></i><div><b>CONVOY</b><span>Its route shows once it rolls.</span></div></div>
  <div class="r"><i class="sym self"></i><div><b>YOU</b><span>The ring is your radar range.</span></div></div>
  <div class="dim">North is up, as on screen.</div>`;

const el = (tag: string, cls: string, parent: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

export class Hud {
  readonly root: HTMLElement;
  readonly overlay: HTMLCanvasElement;
  readonly ctx2d: CanvasRenderingContext2D;
  private objEl: HTMLElement;
  private dashEl: HTMLElement;
  private capEl: HTMLElement;
  private warnEl: HTMLElement;
  private msgEl: HTMLElement;
  private mini: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private mapEl: HTMLElement;
  private mapCanvas: HTMLCanvasElement;
  private mapImg: HTMLCanvasElement | null = null;
  private damageEl: HTMLElement;
  private helpEl: HTMLElement;
  private streakEl: HTMLElement;
  private floaters: { p: THREE.Vector3; text: string; color: string; t: number }[] = [];
  /** where the dashboard sits on the overlay (markers keep clear of it) */
  private dashBox = { x0: 0, x1: 0, y0: Infinity };
  mapOpen = false;

  constructor(container: HTMLElement) {
    this.root = el('div', 'hud', container);
    this.overlay = el('canvas', 'hud-overlay', this.root) as HTMLCanvasElement;
    this.ctx2d = this.overlay.getContext('2d')!;
    this.damageEl = el('div', 'hud-damage', this.root);
    this.objEl = el('div', 'hud-panel hud-obj', this.root);
    const mw = el('div', 'hud-panel hud-mini', this.root);
    this.mini = el('canvas', '', mw) as HTMLCanvasElement;
    this.mctx = this.mini.getContext('2d')!;
    this.capEl = el('div', 'cap', mw);
    this.dashEl = el('div', 'hud-panel hud-dash', this.root);
    this.warnEl = el('div', 'hud-warn', this.root);
    this.streakEl = el('div', 'hud-streak', this.root);
    this.msgEl = el('div', 'hud-msgs', this.root);
    this.helpEl = el('div', 'hud-help', this.root, KEYBOARD_HELP);
    this.mapEl = el('div', 'hud-map', this.root);
    this.mapCanvas = el('canvas', '', this.mapEl) as HTMLCanvasElement;
    el('div', 'map-legend', this.mapEl, LEGEND);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  resize() {
    this.overlay.width = this.root.clientWidth || window.innerWidth;
    this.overlay.height = this.root.clientHeight || window.innerHeight;
    this.mini.width = this.mini.height = Math.round(MINI * Math.min(window.devicePixelRatio || 1, 2));
  }

  setMap(img: Uint8ClampedArray, res: number) {
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const id = new ImageData(new Uint8ClampedArray(img), res, res);
    c.getContext('2d')!.putImageData(id, 0, 0);
    this.mapImg = c;
  }

  toggleMap(v = !this.mapOpen) {
    this.mapOpen = v;
    this.mapEl.style.display = v ? 'flex' : 'none';
  }

  showHelp(v: boolean) {
    this.helpEl.style.opacity = v ? '1' : '0';
  }

  /** Swap the controls cheat-sheet (keyboard vs controller). */
  setHelp(html: string) {
    if (this.helpEl.innerHTML !== html) this.helpEl.innerHTML = html;
  }

  damageFlash(amount: number) {
    this.damageEl.style.transition = 'none';
    this.damageEl.style.opacity = String(Math.min(0.6, 0.15 + amount / 40));
    requestAnimationFrame(() => {
      this.damageEl.style.transition = 'opacity 0.5s';
      this.damageEl.style.opacity = '0';
    });
  }

  message(text: string, color = '#9dff9a', ms = 3200) {
    const m = el('div', 'hud-msg', this.msgEl, text);
    m.style.color = color;
    setTimeout(() => m.classList.add('fade'), ms);
    setTimeout(() => m.remove(), ms + 700);
    while (this.msgEl.children.length > 5) this.msgEl.firstElementChild?.remove();
  }

  update(d: HudData) {
    const pct = (v: number, max: number) => Math.max(0, Math.min(100, (v / Math.max(1e-6, max)) * 100)).toFixed(1);
    const bar = (v: number, max: number, cls = '') => `<span class="bar ${cls}"><i style="width:${pct(v, max)}%"></i></span>`;
    const hpPct = d.hp / d.maxHp;
    const fuelPct = d.fuel / d.maxFuel;
    this.objEl.innerHTML =
      `<div class="t">SECTOR ${d.sector} · OBJECTIVES</div>` +
      d.objectives.map((o) => `<div class="o ${o.kind ?? 'target'}${o.done ? ' done' : o.active ? ' active' : ''}"><i></i><span>${o.text}</span></div>`).join('') +
      `<div class="cr">CREDITS ${d.credits}${d.pending ? ` <b>+${d.pending}</b> <span>carried · bank at the FARP</span>` : ''}</div>`;
    // a weapon turns amber when it runs low and red when it is empty
    const slot = (label: string, n: number, lowAt: number, key: string) =>
      `<div class="slot${n <= 0 ? ' out' : n <= lowAt ? ' low' : ''}"><span class="l">${label}</span><b>${n}</b><span class="k">${key}</span></div>`;
    const under = d.alt > 0.5 && d.alt < RADAR_FLOOR;
    this.dashEl.innerHTML = `
      <div class="xp"><span>LV ${d.level}</span>${bar(d.xp, d.xpNext, 'xp')}${d.assists ? '' : '<span class="sas">SAS OFF</span>'}</div>
      <div class="cols">
        <div class="vit">
          <div class="g"><span class="l">ARMOR</span>${bar(d.hp, d.maxHp, hpPct < 0.3 ? 'crit' : '')}<span class="n">${Math.ceil(d.hp)}</span></div>
          <div class="g"><span class="l">FUEL</span>${bar(d.fuel, d.maxFuel, fuelPct < 0.2 ? 'crit' : '')}<span class="n">${Math.ceil(fuelPct * 100)}%</span></div>
        </div>
        <div class="grp">
          ${slot('CANNON', d.gun, d.maxGun * 0.2, d.keys.gun)}
          ${slot('ROCKETS', d.rockets, 3, d.keys.rockets)}
          ${d.maxMissiles ? slot('MISSILES', d.missiles, 1, d.keys.missiles) : ''}
          ${d.maxFlares ? slot('FLARES', d.flares, 2, d.keys.flares) : ''}
        </div>
        <div class="grp">
          <div class="slot"><span class="l">SPEED</span><b>${Math.round(d.speed * 1.8)}</b><span class="k">KM/H</span></div>
          <div class="slot${under ? ' under' : ''}"><span class="l">HEIGHT</span><b>${Math.round(d.alt * 0.5)}</b><span class="alt"><i style="width:${pct(d.alt, d.maxAlt)}%"></i><u style="left:${pct(RADAR_FLOOR, d.maxAlt)}%"></u></span><span class="k">${under ? 'UNDER RADAR' : 'METRES'}</span></div>
        </div>
      </div>`;
    const box = this.dashEl.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    if (box.width > 0) this.dashBox = { x0: box.left - root.left, x1: box.right - root.left, y0: box.top - root.top };
    const hdg = Math.round((((-d.heading * 180) / Math.PI) % 360 + 360) % 360);
    const windArrow = '↑↗→↘↓↙←↖'[Math.round((((d.windDir / (Math.PI * 2)) % 1) + 1) * 8) % 8];
    this.capEl.innerHTML = `<span>${d.place}</span><span>${String(hdg).padStart(3, '0')}° · WIND ${windArrow}${Math.round(d.windSpeed * 1.8)}</span>`;
    // '~' prefix = informational (green), everything else is a red warning
    this.warnEl.innerHTML = d.warnings.map((w) => (w.startsWith('~') ? `<div class="info">${w.slice(1)}</div>` : `<div>${w}</div>`)).join('');
    this.streakEl.style.display = d.streak > 1 ? '' : 'none';
    if (d.streak > 1) this.streakEl.innerHTML = `STREAK <b>×${d.streak.toFixed(1)}</b><span class="bar"><i style="width:${(d.streakLeft * 100).toFixed(0)}%"></i></span>`;
  }

  // ---------------------------------------------------------------- maps

  /** The minimap, and the full tactical map while it is open. */
  drawMaps(v: MapView) {
    this.drawMini(v);
    if (this.mapOpen) this.drawFull(v);
  }

  /** North-up window on the map around the aircraft, one radar range to each side. */
  private drawMini(v: MapView) {
    const c = this.mctx;
    const W = MINI;
    const dpr = this.mini.width / W;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = v.range;
    const k = W / (2 * R);
    const hx = v.heli.x,
      hz = v.heli.z;
    // open desert beyond the sector
    c.fillStyle = '#a98f66';
    c.fillRect(0, 0, W, W);
    if (this.mapImg) {
      const res = this.mapImg.width;
      const s = res / v.size;
      const u0 = (hx - R) * s,
        v0 = (hz - R) * s,
        span = 2 * R * s;
      const cu0 = Math.max(0, u0),
        cv0 = Math.max(0, v0),
        cu1 = Math.min(res, u0 + span),
        cv1 = Math.min(res, v0 + span);
      if (cu1 > cu0 && cv1 > cv0) {
        c.imageSmoothingEnabled = false;
        c.drawImage(this.mapImg, cu0, cv0, cu1 - cu0, cv1 - cv0, ((cu0 - u0) / span) * W, ((cv0 - v0) / span) * W, ((cu1 - cu0) / span) * W, ((cv1 - cv0) / span) * W);
      }
    }
    c.fillStyle = 'rgba(8,22,10,0.32)';
    c.fillRect(0, 0, W, W);
    const px = (x: number) => (x - hx) * k + W / 2,
      py = (z: number) => (z - hz) * k + W / 2;
    this.drawGrid(c, v.size, px, py, W, false);
    this.drawMarks(c, v, px, py, k, W, false);
    // pointers on the rim for the places that are out of the window
    for (const z of v.zones) {
      if (z.kind === 'town' || z.done) continue;
      const dx = z.x - hx,
        dz = z.z - hz;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if (m <= R) continue;
      const f = (W / 2 - 11) / m;
      const x = W / 2 + dx * f,
        y = W / 2 + dz * f;
      const col = z.kind === 'home' ? HUD_COLORS.home : z.kind === 'rescue' ? HUD_COLORS.rescue : HUD_COLORS.hostile;
      if (z.kind === 'home') {
        c.fillStyle = col;
        c.beginPath();
        c.arc(x, y, 8.5, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#06202c';
        c.font = `16px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('H', x, y + 1);
      } else {
        c.save();
        c.translate(x, y);
        c.rotate(Math.atan2(dz, dx));
        c.fillStyle = '#0a1a0a';
        c.beginPath();
        c.moveTo(10, 0);
        c.lineTo(-6, -8);
        c.lineTo(-6, 8);
        c.closePath();
        c.fill();
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(7.5, 0);
        c.lineTo(-4.5, -6);
        c.lineTo(-4.5, 6);
        c.closePath();
        c.fill();
        c.restore();
      }
    }
    this.drawSelf(c, W / 2, W / 2, v.heli.heading, 1);
  }

  private drawFull(v: MapView) {
    if (!this.mapImg) return;
    const cv = this.mapCanvas;
    // match the canvas to its on-screen size so labels stay sharp
    const want = Math.round((cv.clientWidth || 640) * Math.min(window.devicePixelRatio || 1, 2));
    if (cv.width !== want) cv.width = cv.height = want;
    const c = cv.getContext('2d')!;
    const W = FULL;
    c.setTransform(want / W, 0, 0, want / W, 0, 0);
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapImg, 0, 0, W, W);
    c.fillStyle = 'rgba(8,22,10,0.3)';
    c.fillRect(0, 0, W, W);
    const k = W / v.size;
    const px = (x: number) => x * k,
      py = (z: number) => z * k;
    this.drawGrid(c, v.size, px, py, W, true);
    this.drawMarks(c, v, px, py, k, W, true);
    // radar range
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 1;
    c.setLineDash([3, 5]);
    c.beginPath();
    c.arc(px(v.heli.x), py(v.heli.z), v.range * k, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    this.drawSelf(c, px(v.heli.x), py(v.heli.z), v.heli.heading, 1.3);
  }

  /** Grid squares A-H by 1-8 (the squares scroll under the minimap as you fly). */
  private drawGrid(c: CanvasRenderingContext2D, size: number, px: (x: number) => number, py: (z: number) => number, W: number, labels: boolean) {
    c.strokeStyle = 'rgba(157,255,154,0.14)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(px((i * size) / 8)) + 0.5,
        y = Math.round(py((i * size) / 8)) + 0.5;
      if (x >= 0 && x <= W + 1) {
        c.moveTo(x, Math.max(0, py(0)));
        c.lineTo(x, Math.min(W, py(size)));
      }
      if (y >= 0 && y <= W + 1) {
        c.moveTo(Math.max(0, px(0)), y);
        c.lineTo(Math.min(W, px(size)), y);
      }
    }
    c.stroke();
    if (!labels) return;
    c.fillStyle = 'rgba(157,255,154,0.55)';
    c.font = `15px ${FONT}`;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      c.fillText('ABCDEFGH'[i], px((i * size) / 8) + 5, 3);
      if (i > 0) c.fillText(String(i + 1), 5, py((i * size) / 8) + 3);
    }
  }

  private mapLabel(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, boxed: boolean, W: number) {
    c.font = `${size}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const w = c.measureText(text).width;
    // keep the label inside the map
    x = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x));
    y = Math.max(size + 2, y);
    if (boxed) {
      c.fillStyle = 'rgba(6,14,8,0.8)';
      c.fillRect(x - w / 2 - 4, y - size + 1, w + 8, size + 3);
    } else {
      c.fillStyle = 'rgba(6,14,8,0.85)';
      c.fillText(text, x + 1, y + 1);
    }
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  /** Areas, supplies and radar contacts, shared by the minimap and the full map. */
  private drawMarks(c: CanvasRenderingContext2D, v: MapView, px: (x: number) => number, py: (z: number) => number, k: number, W: number, full: boolean) {
    const vis = (x: number, y: number, m: number) => x > -m && y > -m && x < W + m && y < W + m;
    if (v.route) {
      c.strokeStyle = HUD_COLORS.convoy;
      c.lineWidth = full ? 2 : 1.5;
      c.setLineDash([7, 5]);
      c.beginPath();
      c.moveTo(px(v.route.ax), py(v.route.az));
      c.lineTo(px(v.route.bx), py(v.route.bz));
      c.stroke();
      c.setLineDash([]);
    }
    for (const z of v.zones) {
      const x = px(z.x),
        y = py(z.z);
      if (z.kind === 'town') {
        // on the minimap a name shows only once the town is well inside the window, so names don't pile up on the rim
        if (full ? vis(x, y, 0) : vis(x, y - z.r * k * 0.75, -26)) this.mapLabel(c, z.label, x, y - z.r * k * 0.75 - 3, HUD_COLORS.neutral, full ? 16 : 14, false, W);
        continue;
      }
      const col = z.done ? 'rgba(196,204,186,0.6)' : z.kind === 'home' ? HUD_COLORS.home : z.kind === 'rescue' ? HUD_COLORS.rescue : HUD_COLORS.hostile;
      const r = Math.max(z.r * k * (z.kind === 'objective' ? 1.2 : 1), full ? 12 : 8);
      if (!vis(x, y, r + 40)) continue;
      if (z.kind === 'objective' && !z.done) {
        // hatched: the area to hit
        c.save();
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.clip();
        c.fillStyle = 'rgba(255,90,74,0.13)';
        c.fillRect(x - r, y - r, r * 2, r * 2);
        c.strokeStyle = 'rgba(255,90,74,0.45)';
        c.lineWidth = 1;
        c.beginPath();
        for (let o = -r * 2; o <= r * 2; o += 6) {
          c.moveTo(x + o - r, y + r);
          c.lineTo(x + o + r, y - r);
        }
        c.stroke();
        c.restore();
      } else if (z.kind === 'home') {
        c.fillStyle = 'rgba(6,24,34,0.6)';
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.setLineDash(z.kind === 'home' ? [] : [5, 4]);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = col;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      if (z.kind === 'home') {
        c.font = `${Math.round(Math.min(26, Math.max(15, r * 1.3)))}px ${FONT}`;
        c.fillText('H', x, y + 1);
      } else if (z.kind === 'rescue') {
        c.fillRect(x - 5, y - 1.5, 10, 3);
        c.fillRect(x - 1.5, y - 5, 3, 10);
      } else if (z.done) {
        c.font = `${full ? 20 : 16}px ${FONT}`;
        c.fillText('×', x, y);
      }
      const text = full ? (z.kind === 'home' ? 'FARP · HOME' : z.done ? `${z.label} · DOWN` : z.sub ? `${z.label} ${z.sub}` : z.label) : z.kind === 'home' ? 'FARP' : z.kind === 'objective' ? z.label.split(' ').slice(-1)[0] : '';
      if (text) this.mapLabel(c, text, x, y - r - 6, col, full ? 17 : 14, true, W);
    }
    for (const s of v.supplies) {
      const x = px(s.x),
        y = py(s.z);
      if (!vis(x, y, 8)) continue;
      const q = full ? 6 : 3.5;
      c.fillStyle = '#191405';
      c.fillRect(x - q - 1, y - q - 1, q * 2 + 2, q * 2 + 2);
      c.fillStyle = HUD_COLORS.supply;
      c.fillRect(x - q, y - q, q * 2, q * 2);
      if (full) {
        c.fillStyle = '#191405';
        c.font = `15px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(s.type === 'fuel' ? 'F' : s.type === 'ammo' ? 'A' : 'R', x, y + 1);
      }
    }
    for (const u of v.units) {
      const x = px(u.x),
        y = py(u.z);
      if (!vis(x, y, 6)) continue;
      const q = full ? 4 : 3.2;
      const shape = () => {
        c.beginPath();
        if (u.kind === 'sam') {
          c.moveTo(x, y - q - 1.5);
          c.lineTo(x + q + 1.5, y);
          c.lineTo(x, y + q + 1.5);
          c.lineTo(x - q - 1.5, y);
        } else if (u.kind === 'air') {
          c.moveTo(x, y - q - 2);
          c.lineTo(x + q + 2, y + q + 1);
          c.lineTo(x - q - 2, y + q + 1);
        } else if (u.kind === 'vehicle') c.rect(x - q + 0.5, y - q + 0.5, q * 2 - 1, q * 2 - 1);
        else c.arc(x, y, q - 0.5, 0, Math.PI * 2);
        c.closePath();
      };
      shape();
      c.lineWidth = 2.5;
      c.strokeStyle = '#1c0705';
      c.stroke();
      c.fillStyle = u.kind === 'vehicle' ? HUD_COLORS.convoy : HUD_COLORS.hostile;
      c.fill();
    }
  }

  private drawSelf(c: CanvasRenderingContext2D, x: number, y: number, heading: number, s: number) {
    c.save();
    c.translate(x, y);
    c.rotate(-heading);
    c.scale(s, s);
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#0a1a0a';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6, 7);
    c.lineTo(0, 4);
    c.lineTo(-6, 7);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  // ---------------------------------------------------------------- overlay

  clearOverlay() {
    this.ctx2d.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  project(p: THREE.Vector3, cam: THREE.Camera, out: { x: number; y: number; behind: boolean }) {
    const v = p.clone().project(cam);
    out.x = (v.x * 0.5 + 0.5) * this.overlay.width;
    out.y = (-v.y * 0.5 + 0.5) * this.overlay.height;
    out.behind = v.z > 1;
    return out;
  }

  crosshair(x: number, y: number, color = '#9dff9a', size = 9) {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x - size, y);
    c.lineTo(x - 3, y);
    c.moveTo(x + 3, y);
    c.lineTo(x + size, y);
    c.moveTo(x, y - size);
    c.lineTo(x, y - 3);
    c.moveTo(x, y + 3);
    c.lineTo(x, y + size);
    c.stroke();
  }

  pipper(x: number, y: number, color = '#ffe46a') {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y - 9);
    c.lineTo(x + 9, y);
    c.lineTo(x, y + 9);
    c.lineTo(x - 9, y);
    c.closePath();
    c.stroke();
    c.fillStyle = color;
    c.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  bracket(x: number, y: number, s: number, color: string, label?: string) {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 2;
    const k = s * 0.35;
    c.beginPath();
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      c.moveTo(x + sx * s, y + sy * (s - k));
      c.lineTo(x + sx * s, y + sy * s);
      c.lineTo(x + sx * (s - k), y + sy * s);
    }
    c.stroke();
    if (label) {
      c.fillStyle = color;
      c.font = '14px "VT323", monospace';
      c.fillText(label, x + s + 4, y - s + 10);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, dash = false) {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.setLineDash(dash ? [4, 4] : []);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.setLineDash([]);
  }

  /** Marker clamped to the screen edge with a label. Along the bottom it rides above the dashboard. */
  edgeMarker(x: number, y: number, color: string, label: string, behind: boolean) {
    const c = this.ctx2d;
    const W = this.overlay.width,
      H = this.overlay.height;
    const m = 30;
    let px = x,
      py = y;
    if (behind) {
      px = W - px;
      py = H - m;
    }
    const d = this.dashBox;
    const overDash = px > d.x0 - 40 && px < d.x1 + 40;
    const bottom = overDash ? d.y0 - 34 : H - m;
    const off = px < m || px > W - m || py < m || py > bottom || behind;
    px = Math.max(m, Math.min(W - m, px));
    py = Math.max(m, Math.min(bottom, py));
    c.fillStyle = color;
    c.font = '15px "VT323", monospace';
    if (off) {
      const cx = W / 2,
        cy = H / 2;
      const a = Math.atan2(py - cy, px - cx);
      c.save();
      c.translate(px, py);
      c.rotate(a);
      c.beginPath();
      c.moveTo(10, 0);
      c.lineTo(-6, -7);
      c.lineTo(-6, 7);
      c.closePath();
      c.fill();
      c.restore();
      c.fillText(label, px - c.measureText(label).width / 2, py + (py > H / 2 ? -14 : 22));
    } else {
      c.beginPath();
      c.moveTo(px, py - 14);
      c.lineTo(px + 6, py - 22);
      c.lineTo(px - 6, py - 22);
      c.closePath();
      c.fill();
      c.fillText(label, px - c.measureText(label).width / 2, py - 26);
    }
  }

  /** Small health bar (under a target bracket). */
  healthBar(x: number, y: number, w: number, frac: number, color: string) {
    const c = this.ctx2d;
    c.fillStyle = 'rgba(8,16,9,0.75)';
    c.fillRect(x - w / 2 - 1, y - 1, w + 2, 6);
    c.fillStyle = color;
    c.fillRect(x - w / 2, y, Math.max(0, Math.min(1, frac)) * w, 4);
  }

  /** Red arc around the aircraft pointing at where a hit came from. */
  hitArc(x: number, y: number, angle: number, alpha: number) {
    const c = this.ctx2d;
    c.strokeStyle = `rgba(255,70,50,${(alpha * 0.85).toFixed(3)})`;
    c.lineWidth = 5;
    c.beginPath();
    c.arc(x, y, 78, angle - 0.32, angle + 0.32);
    c.stroke();
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 86, angle - 0.2, angle + 0.2);
    c.stroke();
  }

  /** Floating text that rises from a world position (kill rewards). */
  floater(p: THREE.Vector3, text: string, color: string) {
    if (this.floaters.length > 12) this.floaters.shift();
    this.floaters.push({ p: p.clone(), text, color, t: 0 });
  }

  drawFloaters(cam: THREE.Camera, dt: number) {
    const c = this.ctx2d;
    const sp = { x: 0, y: 0, behind: false };
    c.font = '24px "VT323", monospace';
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      if (f.t > 1.5) {
        this.floaters.splice(i, 1);
        continue;
      }
      this.project(f.p, cam, sp);
      if (sp.behind) continue;
      const k = f.t / 1.5;
      const x = sp.x - c.measureText(f.text).width / 2,
        y = sp.y - 18 - (1 - (1 - k) * (1 - k)) * 46;
      c.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      c.fillStyle = 'rgba(0,0,0,0.8)';
      c.fillText(f.text, x + 2, y + 2);
      c.fillStyle = f.color;
      c.fillText(f.text, x, y);
    }
    c.globalAlpha = 1;
  }

  clearFloaters() {
    this.floaters.length = 0;
  }

  ring(x: number, y: number, r: number, color: string) {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
  }

  progressRing(x: number, y: number, t: number, color: string) {
    const c = this.ctx2d;
    c.strokeStyle = color;
    c.lineWidth = 3;
    c.beginPath();
    c.arc(x, y, 18, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
    c.stroke();
  }
}
