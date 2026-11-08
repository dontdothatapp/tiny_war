import { HeliStats, SaveData, UPGRADES, UpgradeDef, level, levelCap, upgradeCost } from '../game/progression';

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

export class Menus {
  readonly root: HTMLElement;
  private screen: HTMLElement | null = null;

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
  }

  private show(html: string, cls = ''): HTMLElement {
    this.root.innerHTML = '';
    this.root.style.display = 'flex';
    const s = document.createElement('div');
    s.className = 'menu ' + cls;
    s.innerHTML = html;
    this.root.appendChild(s);
    this.screen = s;
    return s;
  }

  private on(sel: string, fn: () => void) {
    const e = this.screen?.querySelector(sel) as HTMLElement | null;
    if (e)
      e.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
  }

  title(save: SaveData, h: { newRun: () => void; hangar: () => void; toggleAssist: () => void; pixel: () => void }) {
    this.show(
      `<div class="logo">TINY<span>WAR</span></div>
       <div class="sub">voxel rotor-wing roguelike · tech demo</div>
       <div class="btns">
         <button class="b-primary" data-a="new">START RUN</button>
         <button data-a="hangar">HANGAR <small>${save.credits} CR</small></button>
         <button data-a="assist">FLIGHT ASSISTS: ${save.settings.assists ? 'ON (SAS)' : 'OFF (FULL SIM)'}</button>
         <button data-a="pixel">PIXEL SIZE: ${['HD', 'x2', 'x3'][save.settings.pixelScale - 1]}</button>
       </div>
       <div class="controls">
         <div><b>FLY</b> W/S cyclic fwd/back · A/D cyclic left/right · Q/E pedals (yaw) · SPACE/SHIFT collective up/down</div>
         <div><b>FIGHT</b> mouse aims chin gun · LMB cannon · RMB rockets (fly the ◇ pipper onto target) · F missile · X flares</div>
         <div><b>LOGISTICS</b> hover low over crates to winch · land at downed crews to board them · land on the FARP pad to refuel, rearm, bank credits</div>
         <div class="dim">Best sector reached: ${save.bestSector} · Runs flown: ${save.runs} · Crew rescued: ${save.rescuedTotal}</div>
       </div>`,
      'title',
    );
    this.on('[data-a=new]', h.newRun);
    this.on('[data-a=hangar]', h.hangar);
    this.on('[data-a=assist]', h.toggleAssist);
    this.on('[data-a=pixel]', h.pixel);
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

  hangar(save: SaveData, stats: HeliStats, nextLabel: string, h: { buy: (d: UpgradeDef) => void; launch: () => void; back?: () => void }) {
    const groups = ['Airframe', 'Weapons', 'Systems'] as const;
    const rows = (g: string) =>
      UPGRADES.filter((u) => u.group === g)
        .map((u) => {
          const lv = level(save, u.id);
          const cap = levelCap(u, save.bestSector);
          const cost = upgradeCost(u, lv);
          const pips = Array.from({ length: u.max }, (_, i) => `<i class="${i < lv ? 'on' : i < cap ? '' : 'lock'}"></i>`).join('');
          let btn: string;
          if (lv >= u.max) btn = `<button disabled>MAX</button>`;
          else if (lv >= cap) btn = `<button disabled>SECTOR ${u.unlock + lv}</button>`;
          else btn = `<button data-u="${u.id}" ${save.credits < cost ? 'class="poor"' : ''}>${cost} CR</button>`;
          return `<div class="up"><div><b>${u.name}</b><div class="dim">${u.desc}</div></div><div class="pips">${pips}</div>${btn}</div>`;
        })
        .join('');
    this.show(
      `<div class="h">HANGAR <span class="cr">${save.credits} CR</span></div>
       <div class="dim">Upgrades are permanent. Reaching deeper sectors raises upgrade caps and unlocks new systems.</div>
       <div class="hangar-cols">${groups.map((g) => `<div><div class="t">${g.toUpperCase()}</div>${rows(g)}</div>`).join('')}</div>
       <div class="stats">FUEL ${Math.round(stats.maxFuel)} · ARMOR ${stats.maxHp} · T/W ${stats.twr.toFixed(2)} · TILT ${Math.round((stats.maxTilt * 180) / Math.PI)}° · GUN ${stats.gunAmmo} · RKT ${stats.rockets} · MSL ${stats.missiles} · FLR ${stats.flares} · SEATS ${stats.cabin}</div>
       <div class="btns">${h.back ? '<button data-a="back">◂ BACK</button>' : ''}<button class="b-primary" data-a="go">${nextLabel}</button></div>`,
      'hangar',
    );
    for (const u of UPGRADES) this.on(`[data-u=${u.id}]`, () => h.buy(u));
    this.on('[data-a=go]', h.launch);
    if (h.back) this.on('[data-a=back]', h.back);
  }

  pause(h: { resume: () => void; abort: () => void }) {
    this.show(
      `<div class="h">PAUSED</div>
       <div class="btns"><button class="b-primary" data-a="r">RESUME</button><button data-a="q">ABANDON RUN</button></div>`,
      'pause',
    );
    this.on('[data-a=r]', h.resume);
    this.on('[data-a=q]', h.abort);
  }

  loading(text: string) {
    this.show(`<div class="h">${text}</div><div class="dim blink">generating voxels…</div>`, 'loading');
  }
}
