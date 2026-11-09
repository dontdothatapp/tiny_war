import { HeliStats, PerkDef, Perks, SaveData, UPGRADES, UpgradeDef, level, levelCap, shopItems, upgradeCost } from '../game/progression';

// Title, briefing, debrief, hangar and pause screens as DOM overlays.

export interface BriefingInfo {
  sector: number;
  seed: number;
  size: number;
  objectives: string[];
  rescues: number;
  threats: string[];
  wind: string;
}

export interface DebriefInfo {
  title: string;
  subtitle: string;
  lines: [string, string][];
  good: boolean;
}

export interface PadStatus {
  connected: boolean;
  name: string;
  rumble: boolean;
  /** mapping summary with this controller's button labels */
  help: string;
}

const keyOf = (b: Element | null) => (b ? b.getAttribute('data-a') ?? b.getAttribute('data-u') : null);

export class Menus {
  readonly root: HTMLElement;
  private screen: HTMLElement | null = null;
  private focusEl: HTMLButtonElement | null = null;
  private lastKey: string | null = null;
  private backAction: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'menu-root';
    container.appendChild(this.root);
  }

  get open() {
    return this.screen !== null;
  }

  hide() {
    this.root.innerHTML = '';
    this.root.style.display = 'none';
    this.screen = null;
    this.focusEl = null;
    this.backAction = null;
  }

  private show(html: string, cls = '', back: (() => void) | null = null): HTMLElement {
    const sameScreen = this.screen?.className === 'menu ' + cls;
    this.root.innerHTML = '';
    this.root.style.display = 'flex';
    const s = document.createElement('div');
    s.className = 'menu ' + cls;
    s.innerHTML = html;
    this.root.appendChild(s);
    this.screen = s;
    this.backAction = back;
    // keep the controller focus on the same control when a screen re-renders (e.g. after a toggle or purchase)
    const restore = sameScreen && this.lastKey ? (s.querySelector(`[data-a="${this.lastKey}"],[data-u="${this.lastKey}"]`) as HTMLButtonElement | null) : null;
    this.setFocus(restore && !restore.disabled ? restore : (s.querySelector('button.b-primary') as HTMLButtonElement | null) ?? this.buttons()[0] ?? null);
    return s;
  }

  // ---------------------------------------------------------------- controller navigation

  private buttons(): HTMLButtonElement[] {
    return this.screen ? (Array.from(this.screen.querySelectorAll('button')) as HTMLButtonElement[]).filter((b) => !b.disabled) : [];
  }

  private setFocus(b: HTMLButtonElement | null) {
    this.focusEl?.classList.remove('focus');
    this.focusEl = b;
    if (b) {
      b.classList.add('focus');
      this.lastKey = keyOf(b);
      b.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Move focus to the nearest enabled button in a direction (spatial navigation). */
  nav(dx: number, dy: number) {
    const list = this.buttons();
    if (!list.length) return;
    const cur = this.focusEl && list.includes(this.focusEl) ? this.focusEl : null;
    if (!cur) {
      this.setFocus(list[0]);
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2,
      ay = a.top + a.height / 2;
    // Pass 1: controls in the same row (horizontal moves) or column (vertical moves).
    // Pass 2: anything in that direction, weighted toward staying in line.
    let best: HTMLButtonElement | null = null;
    for (const pass of [1, 2]) {
      let bestScore = Infinity;
      for (const b of list) {
        if (b === cur) continue;
        const r = b.getBoundingClientRect();
        const bx = r.left + r.width / 2,
          by = r.top + r.height / 2;
        const along = dx ? (bx - ax) * dx : (by - ay) * dy;
        if (along <= 4) continue;
        const overlap = dx ? r.top < a.bottom - 2 && r.bottom > a.top + 2 : r.left < a.right - 2 && r.right > a.left + 2;
        if (pass === 1 && !overlap) continue;
        const across = dx ? Math.abs(by - ay) : Math.abs(bx - ax);
        const score = pass === 1 ? along + across * 0.1 : along + across * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (best) break;
    }
    if (best) this.setFocus(best);
  }

  activate() {
    this.focusEl?.click();
  }

  back() {
    this.backAction?.();
  }

  private on(sel: string, fn: () => void) {
    const e = this.screen?.querySelector(sel) as HTMLElement | null;
    if (e)
      e.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
  }

  title(
    save: SaveData,
    pad: PadStatus,
    h: { newRun: () => void; hangar: () => void; music: () => void; toggleAssist: () => void; pixel: () => void; rumble: () => void },
  ) {
    this.show(
      `<div class="logo">TINY<span>WAR</span></div>
       <div class="sub">voxel rotor-wing roguelike · tech demo</div>
       <div class="btns">
         <button class="b-primary" data-a="new">START RUN</button>
         <button data-a="hangar">HANGAR <small>${save.credits} CR</small></button>
       </div>
       <div class="settings">
         <button data-a="assist">ASSISTS: ${save.settings.assists ? 'ON (SAS)' : 'OFF (FULL SIM)'}</button>
         <button data-a="pixel">PIXEL SIZE: ${['HD', 'x2', 'x3'][save.settings.pixelScale - 1]}</button>
         <button data-a="rumble">VIBRATION: ${pad.rumble ? 'ON' : 'OFF'}</button>
         <button data-a="music">MUSIC: ${save.settings.music ? 'ON' : 'OFF'}</button>
       </div>
       <div class="controls">
         <div><b>FLY</b> W/S cyclic fwd/back · A/D cyclic left/right · Q/E pedals (yaw) · SPACE/SHIFT collective up/down</div>
         <div><b>FIGHT</b> weapons fire straight ahead and auto-range onto the first target in front of the nose · LMB cannon · RMB rockets · F missile · X flares</div>
         <div><b>CONTROLLER</b> ${pad.connected ? `<span class="pad-name">${pad.name}</span> · ${pad.help}` : 'plug in any gamepad and press a button · left stick flies, right stick turns, triggers fire'}</div>
         <div><b>LOGISTICS</b> hover low over crates or land next to them · land at downed crews to board them · land on the FARP pad to refuel, rearm, bank credits</div>
         <div><b>PROGRESS</b> earn XP in flight: every level offers 1 of 3 upgrades for this run · spend credits in the hangar shop for permanent upgrades</div>
         <div class="dim">Best sector reached: ${save.bestSector} · Runs flown: ${save.runs} · Crew rescued: ${save.rescuedTotal}</div>
       </div>`,
      'title',
    );
    this.on('[data-a=new]', h.newRun);
    this.on('[data-a=hangar]', h.hangar);
    this.on('[data-a=assist]', h.toggleAssist);
    this.on('[data-a=pixel]', h.pixel);
    this.on('[data-a=rumble]', h.rumble);
    this.on('[data-a=music]', h.music);
  }

  briefing(b: BriefingInfo, onLaunch: () => void) {
    this.show(
      `<div class="h">SECTOR ${b.sector} BRIEFING</div>
       <div class="dim">Theatre ${b.size}×${b.size} · seed ${b.seed} · wind ${b.wind}</div>
       <div class="cols">
        <div><div class="t">PRIMARY</div>${b.objectives.map((o) => `<div>□ ${o}</div>`).join('')}</div>
        <div><div class="t">SECONDARY</div><div>□ Rescue ${b.rescues} downed crews (red smoke)</div><div>□ Winch supply crates</div>
        <div class="t" style="margin-top:12px">THREATS</div>${b.threats.map((t) => `<div>▲ ${t}</div>`).join('')}</div>
       </div>
       <div class="dim">Credits are carried until you land on the FARP pad. Lose the aircraft and you lose what you carry.</div>
       <div class="btns"><button class="b-primary" data-a="go">LAUNCH ▸</button></div>`,
      'briefing',
    );
    this.on('[data-a=go]', onLaunch);
  }

  debrief(d: DebriefInfo, onContinue: () => void) {
    this.show(
      `<div class="h ${d.good ? 'good' : 'bad'}">${d.title}</div>
       <div class="dim">${d.subtitle}</div>
       <table>${d.lines.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
       <div class="btns"><button class="b-primary" data-a="go">CONTINUE ▸</button></div>`,
      'debrief',
    );
    this.on('[data-a=go]', onContinue);
  }

  /** Permanent upgrades. Only items unlocked by the best sector reached are shown. */
  hangar(save: SaveData, stats: HeliStats, nextLabel: string, h: { buy: (d: UpgradeDef) => void; launch: () => void; back?: () => void }) {
    const { open, next, nextSector } = shopItems(save);
    const card = (u: UpgradeDef) => {
      const lv = level(save, u.id);
      const cap = levelCap(u, save.bestSector);
      const cost = upgradeCost(u, lv);
      const pips = Array.from({ length: u.max }, (_, i) => `<i class="${i < lv ? 'on' : i < cap ? '' : 'lock'}"></i>`).join('');
      let btn: string;
      if (lv >= u.max) btn = `<button disabled>MAX</button>`;
      else if (lv >= cap) btn = `<button disabled>NEXT LEVEL AT SECTOR ${u.unlock + lv}</button>`;
      else btn = `<button data-u="${u.id}" ${save.credits < cost ? 'class="poor"' : ''}>BUY · ${cost} CR</button>`;
      return `<div class="up"><div><b>${u.name}</b><div class="dim">${u.desc}</div></div><div class="pips">${pips}</div>${btn}</div>`;
    };
    const teaser = next.length ? `<div class="teaser">🔒 Reach sector ${nextSector} to unlock: ${next.map((u) => u.name).join(' · ')}</div>` : '';
    this.show(
      `<div class="h">HANGAR SHOP <span class="cr">${save.credits} CR</span></div>
       <div class="dim">Permanent upgrades, kept between runs. New items arrive as you reach deeper sectors.</div>
       <div class="shop-grid">${open.map(card).join('')}</div>
       ${teaser}
       <div class="stats">FUEL ${Math.round(stats.maxFuel)} · ARMOR ${stats.maxHp} · T/W ${stats.twr.toFixed(2)} · GUN ${stats.gunAmmo} · RKT ${stats.rockets}${stats.missiles ? ` · MSL ${stats.missiles}` : ''}${stats.flares ? ` · FLR ${stats.flares}` : ''} · SEATS ${stats.cabin}</div>
       <div class="btns">${h.back ? '<button data-a="back">◂ BACK</button>' : ''}<button class="b-primary" data-a="go">${nextLabel}</button></div>`,
      'hangar',
      h.back ?? null,
    );
    for (const u of UPGRADES) this.on(`[data-u=${u.id}]`, () => h.buy(u));
    this.on('[data-a=go]', h.launch);
    if (h.back) this.on('[data-a=back]', h.back);
  }

  /** Level-up: pick 1 of 3 perks for this run. */
  levelUp(levelNo: number, perks: Perks, choices: PerkDef[], pick: (p: PerkDef) => void) {
    const cards = choices
      .map((p, i) => {
        const have = perks[p.id] ?? 0;
        const pips = Array.from({ length: p.max }, (_, k) => `<i class="${k < have ? 'on' : k === have ? 'new' : ''}"></i>`).join('');
        return `<button class="perk" data-a="perk${i}"><span class="tag">${p.tag}</span><b>${p.name}</b><span class="desc">${p.desc}</span><span class="pips">${pips}</span><span class="key">${i + 1}</span></button>`;
      })
      .join('');
    this.show(
      `<div class="h good">LEVEL ${levelNo}</div>
       <div class="dim">Choose one upgrade for this run.</div>
       <div class="perks">${cards}</div>`,
      'levelup',
    );
    choices.forEach((p, i) => this.on(`[data-a=perk${i}]`, () => pick(p)));
  }

  pause(pad: PadStatus, h: { resume: () => void; abort: () => void }) {
    this.show(
      `<div class="h">PAUSED</div>
       <div class="btns"><button class="b-primary" data-a="r">RESUME</button><button data-a="q">ABANDON RUN</button></div>
       ${pad.connected ? `<div class="dim pad-help">${pad.help}</div>` : ''}`,
      'pause',
      h.resume,
    );
    this.on('[data-a=r]', h.resume);
    this.on('[data-a=q]', h.abort);
  }

  loading(text: string) {
    this.show(`<div class="h">${text}</div><div class="dim blink">generating voxels…</div>`, 'loading');
  }
}
