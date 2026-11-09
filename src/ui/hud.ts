import * as THREE from 'three';

// DOM HUD in a green-phosphor terminal style + a 2D overlay canvas for
// the fire-control reticle, lock boxes and off-screen markers.

export interface HudObjective {
  text: string;
  done: boolean;
  active?: boolean;
}

export interface HudData {
  hp: number;
  maxHp: number;
  fuel: number;
  maxFuel: number;
  gun: number;
  rockets: number;
  missiles: number;
  maxMissiles: number;
  flares: number;
  maxFlares: number;
  crew: number;
  cabin: number;
  alt: number;
  speed: number;
  vs: number;
  torque: number;
  rpm: number;
  heading: number;
  assists: boolean;
  mass: number;
  windDir: number;
  windSpeed: number;
  credits: number;
  pending: number;
  sector: number;
  warnings: string[];
  objectives: HudObjective[];
}

export interface RadarBlip {
  x: number;
  z: number;
  color: string;
  size?: number;
  shape?: 'dot' | 'square' | 'diamond' | 'ring';
}

export const KEYBOARD_HELP = `W/S cyclic fwd/back · A/D cyclic left/right · Q/E turn · SPACE/SHIFT climb/descend<br>LMB cannon · RMB rockets (both fire straight ahead) · F missile · X flares · H assists · M map · P pixels · ESC pause`;

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
  private statusEl: HTMLElement;
  private flightEl: HTMLElement;
  private warnEl: HTMLElement;
  private msgEl: HTMLElement;
  private radar: HTMLCanvasElement;
  private rctx: CanvasRenderingContext2D;
  private mapEl: HTMLElement;
  private mapCanvas: HTMLCanvasElement;
  private mapImg: HTMLCanvasElement | null = null;
  private damageEl: HTMLElement;
  private helpEl: HTMLElement;
  private sweep = 0;
  mapOpen = false;

  constructor(container: HTMLElement) {
    this.root = el('div', 'hud', container);
    this.overlay = el('canvas', 'hud-overlay', this.root) as HTMLCanvasElement;
    this.ctx2d = this.overlay.getContext('2d')!;
    this.damageEl = el('div', 'hud-damage', this.root);
    this.objEl = el('div', 'hud-panel hud-obj', this.root);
    const rw = el('div', 'hud-panel hud-radar', this.root);
    this.radar = el('canvas', '', rw) as HTMLCanvasElement;
    this.radar.width = this.radar.height = 180;
    this.rctx = this.radar.getContext('2d')!;
    this.statusEl = el('div', 'hud-panel hud-status', this.root);
    this.flightEl = el('div', 'hud-panel hud-flight', this.root);
    this.warnEl = el('div', 'hud-warn', this.root);
    this.msgEl = el('div', 'hud-msgs', this.root);
    this.helpEl = el('div', 'hud-help', this.root, KEYBOARD_HELP);
    this.mapEl = el('div', 'hud-map', this.root);
    this.mapCanvas = el('canvas', '', this.mapEl) as HTMLCanvasElement;
    this.mapCanvas.width = this.mapCanvas.height = 640;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  resize() {
    this.overlay.width = this.root.clientWidth || window.innerWidth;
    this.overlay.height = this.root.clientHeight || window.innerHeight;
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
    const bar = (v: number, max: number, w = 14) => {
      const n = Math.max(0, Math.min(w, Math.round((v / max) * w)));
      return '█'.repeat(n) + '░'.repeat(w - n);
    };
    const hpPct = d.hp / d.maxHp;
    const fuelPct = d.fuel / d.maxFuel;
    this.objEl.innerHTML =
      `<div class="t">SECTOR ${d.sector} · OBJECTIVES</div>` +
      d.objectives.map((o) => `<div class="${o.done ? 'done' : o.active ? 'active' : ''}">${o.done ? '■' : '□'} ${o.text}</div>`).join('');
    this.statusEl.innerHTML = `
      <div class="row"><span>ARMOR</span><span class="${hpPct < 0.3 ? 'crit' : ''}">${bar(d.hp, d.maxHp)}</span><span>${Math.ceil(d.hp)}</span></div>
      <div class="row"><span>FUEL&nbsp;</span><span class="${fuelPct < 0.2 ? 'crit' : ''}">${bar(d.fuel, d.maxFuel)}</span><span>${Math.ceil((d.fuel / d.maxFuel) * 100)}%</span></div>
      <div class="row w"><span>GUN ${String(d.gun).padStart(4, ' ')}</span><span>RKT ${String(d.rockets).padStart(2, ' ')}</span>${d.maxMissiles ? `<span>MSL ${d.missiles}</span>` : ''}${d.maxFlares ? `<span>FLR ${d.flares}</span>` : ''}</div>
      <div class="row w"><span>CREW ${d.crew}/${d.cabin}</span><span>WT ${Math.round(d.mass)}</span><span>CR ${d.credits}${d.pending ? ` <b>+${d.pending}</b>` : ''}</span></div>`;
    const hdg = Math.round((((-d.heading * 180) / Math.PI) % 360 + 360) % 360);
    const windArrow = '↑↗→↘↓↙←↖'[Math.round((((d.windDir / (Math.PI * 2)) % 1) + 1) * 8) % 8];
    this.flightEl.innerHTML = `
      <div class="row"><span>ALT</span><span>${Math.round(d.alt)}</span><span>SPD</span><span>${Math.round(d.speed * 1.8)}</span></div>
      <div class="row"><span>V/S</span><span class="${d.vs < -12 ? 'crit' : ''}">${d.vs >= 0 ? '+' : ''}${d.vs.toFixed(0)}</span><span>HDG</span><span>${String(hdg).padStart(3, '0')}</span></div>
      <div class="row"><span>TRQ</span><span class="${d.torque > 0.98 ? 'crit' : ''}">${Math.round(d.torque * 100)}%</span><span>NR</span><span>${Math.round(d.rpm * 100)}%</span></div>
      <div class="row"><span>SAS</span><span class="${d.assists ? '' : 'crit'}">${d.assists ? 'ON' : 'OFF'}</span><span>WND</span><span>${windArrow}${Math.round(d.windSpeed * 1.8)}</span></div>`;
    // '~' prefix = informational (green), everything else is a red warning
    this.warnEl.innerHTML = d.warnings.map((w) => (w.startsWith('~') ? `<div class="info">${w.slice(1)}</div>` : `<div>${w}</div>`)).join('');
  }

  drawRadar(cx: number, cz: number, heading: number, range: number, blips: RadarBlip[], dt: number) {
    const c = this.rctx;
    const W = this.radar.width;
    const R = W / 2 - 6;
    this.sweep = (this.sweep + dt * 2.2) % (Math.PI * 2);
    c.clearRect(0, 0, W, W);
    c.fillStyle = 'rgba(8,22,10,0.82)';
    c.fillRect(0, 0, W, W);
    c.strokeStyle = 'rgba(120,255,140,0.35)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(W / 2, W / 2, R, 0, Math.PI * 2);
    c.arc(W / 2, W / 2, R * 0.5, 0, Math.PI * 2);
    c.moveTo(W / 2 - R, W / 2);
    c.lineTo(W / 2 + R, W / 2);
    c.moveTo(W / 2, W / 2 - R);
    c.lineTo(W / 2, W / 2 + R);
    c.stroke();
    // sweep
    const g = c.createConicGradient ? c.createConicGradient(this.sweep, W / 2, W / 2) : null;
    if (g) {
      g.addColorStop(0, 'rgba(120,255,140,0.35)');
      g.addColorStop(0.12, 'rgba(120,255,140,0)');
      g.addColorStop(1, 'rgba(120,255,140,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(W / 2, W / 2, R, 0, Math.PI * 2);
      c.fill();
    }
    for (const b of blips) {
      const dx = (b.x - cx) / range,
        dz = (b.z - cz) / range;
      const d = Math.hypot(dx, dz);
      let px = dx,
        pz = dz;
      if (d > 1) {
        if (b.shape !== 'diamond' && b.shape !== 'ring') continue;
        px /= d;
        pz /= d;
      }
      const x = W / 2 + px * R,
        y = W / 2 + pz * R;
      c.fillStyle = b.color;
      c.strokeStyle = b.color;
      const s = b.size ?? 3;
      if (b.shape === 'square') c.fillRect(x - s, y - s, s * 2, s * 2);
      else if (b.shape === 'diamond') {
        c.beginPath();
        c.moveTo(x, y - s - 1);
        c.lineTo(x + s + 1, y);
        c.lineTo(x, y + s + 1);
        c.lineTo(x - s - 1, y);
        c.closePath();
        c.fill();
      } else if (b.shape === 'ring') {
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, s + 1, 0, Math.PI * 2);
        c.stroke();
      } else {
        c.beginPath();
        c.arc(x, y, s * 0.8, 0, Math.PI * 2);
        c.fill();
      }
    }
    // own ship
    c.save();
    c.translate(W / 2, W / 2);
    c.rotate(-heading);
    c.fillStyle = '#b8ffbf';
    c.beginPath();
    c.moveTo(0, -7);
    c.lineTo(4, 5);
    c.lineTo(0, 3);
    c.lineTo(-4, 5);
    c.closePath();
    c.fill();
    c.restore();
  }

  drawMap(size: number, heli: { x: number; z: number; heading: number }, blips: RadarBlip[]) {
    if (!this.mapOpen || !this.mapImg) return;
    const c = this.mapCanvas.getContext('2d')!;
    const W = this.mapCanvas.width;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapImg, 0, 0, W, W);
    c.fillStyle = 'rgba(10,30,12,0.25)';
    c.fillRect(0, 0, W, W);
    const k = W / size;
    for (const b of blips) {
      const x = b.x * k,
        y = b.z * k;
      c.fillStyle = b.color;
      c.strokeStyle = b.color;
      const s = (b.size ?? 3) + 1;
      if (b.shape === 'square') c.fillRect(x - s, y - s, s * 2, s * 2);
      else if (b.shape === 'ring') {
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, s + 3, 0, Math.PI * 2);
        c.stroke();
      } else if (b.shape === 'diamond') {
        c.beginPath();
        c.moveTo(x, y - s - 2);
        c.lineTo(x + s + 2, y);
        c.lineTo(x, y + s + 2);
        c.lineTo(x - s - 2, y);
        c.closePath();
        c.fill();
      } else {
        c.beginPath();
        c.arc(x, y, s, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.save();
    c.translate(heli.x * k, heli.z * k);
    c.rotate(-heli.heading);
    c.fillStyle = '#d8ffd8';
    c.strokeStyle = '#0a1a0a';
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

  /** Marker clamped to the screen edge with a label. */
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
    const off = px < m || px > W - m || py < m || py > H - m || behind;
    px = Math.max(m, Math.min(W - m, px));
    py = Math.max(m, Math.min(H - m, py));
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
