// Gamepad support via the standard Gamepad API mapping.
// Polled once per frame; tracks edges (hit), analog values with radial
// deadzones, controller family for button glyphs, and rumble.

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;
export type Btn = (typeof BTN)[keyof typeof BTN];

export type PadFamily = 'xbox' | 'playstation' | 'generic';
export type PadLayout = 'gunship' | 'pilot';

const GLYPHS: Record<PadFamily, Record<number, string>> = {
  xbox: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'LS', 11: 'RS' },
  playstation: { 0: '✕', 1: '○', 2: '□', 3: '△', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Create', 9: 'Options', 10: 'L3', 11: 'R3' },
  generic: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS' },
};

const STICK_DZ = 0.16;
const TRIGGER_DZ = 0.08;

export interface Stick {
  x: number;
  y: number;
  mag: number;
}

export class GamepadInput {
  connected = false;
  id = '';
  family: PadFamily = 'generic';
  /** performance.now() of the last meaningful input from the pad */
  lastActive = -Infinity;
  readonly L: Stick = { x: 0, y: 0, mag: 0 };
  readonly R: Stick = { x: 0, y: 0, mag: 0 };
  private values = new Float32Array(17);
  private down = new Uint8Array(17);
  private prev = new Uint8Array(17);
  private pad: Gamepad | null = null;
  private padIndex = -1;
  rumbleEnabled = true;
  onConnect: ((id: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor() {
    window.addEventListener('gamepadconnected', (e) => {
      if (this.padIndex < 0) this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if ((e as GamepadEvent).gamepad.index === this.padIndex) this.padIndex = -1;
    });
  }

  /** Read the current gamepad state. Call once per simulation step. */
  poll() {
    this.prev.set(this.down);
    let list: (Gamepad | null)[] = [];
    try {
      list = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    } catch {
      list = [];
    }
    let pad = this.padIndex >= 0 ? list[this.padIndex] ?? null : null;
    if (!pad || !pad.connected) {
      // prefer a pad with the standard mapping, else any connected pad
      pad = list.find((p) => p && p.connected && p.mapping === 'standard') ?? list.find((p) => p && p.connected) ?? null;
      this.padIndex = pad ? pad.index : -1;
    }
    const was = this.connected;
    this.pad = pad;
    this.connected = !!pad;
    if (!pad) {
      this.values.fill(0);
      this.down.fill(0);
      this.L.x = this.L.y = this.L.mag = this.R.x = this.R.y = this.R.mag = 0;
      if (was) this.onDisconnect?.();
      return;
    }
    if (!was || pad.id !== this.id) {
      this.id = pad.id;
      this.family = /054c|playstation|dualsense|dualshock/i.test(pad.id) ? 'playstation' : /xbox|045e|xinput/i.test(pad.id) ? 'xbox' : 'generic';
      this.onConnect?.(pad.id);
    }
    let active = false;
    for (let i = 0; i < 17; i++) {
      const b = pad.buttons[i];
      const v = b ? (typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : Number(b)) : 0;
      const isTrigger = i === BTN.LT || i === BTN.RT;
      const val = isTrigger ? (v < TRIGGER_DZ ? 0 : (v - TRIGGER_DZ) / (1 - TRIGGER_DZ)) : v;
      this.values[i] = val;
      this.down[i] = (isTrigger ? val > 0.3 : b?.pressed || val > 0.5) ? 1 : 0;
      if (this.down[i]) active = true;
    }
    this.readStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.L);
    this.readStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.R);
    if (this.L.mag > 0.25 || this.R.mag > 0.25) active = true;
    if (active) this.lastActive = performance.now();
  }

  private readStick(x: number, y: number, out: Stick) {
    const m = Math.hypot(x, y);
    if (m < STICK_DZ) {
      out.x = out.y = out.mag = 0;
      return;
    }
    const mag = Math.min(1, (Math.min(1, m) - STICK_DZ) / (1 - STICK_DZ));
    out.x = (x / m) * mag;
    out.y = (y / m) * mag;
    out.mag = mag;
  }

  pressed(b: Btn): boolean {
    return this.down[b] === 1;
  }
  hit(b: Btn): boolean {
    return this.down[b] === 1 && this.prev[b] === 0;
  }
  value(b: Btn): number {
    return this.values[b];
  }
  /** D-pad as -1/0/1 axis. */
  dpadX(): number {
    return this.down[BTN.RIGHT] - this.down[BTN.LEFT];
  }
  dpadY(): number {
    return this.down[BTN.DOWN] - this.down[BTN.UP];
  }

  glyph(b: Btn): string {
    return GLYPHS[this.family][b] ?? '?';
  }

  /** Dual-motor rumble; silently ignored where unsupported. */
  rumble(strong: number, weak: number, ms: number) {
    if (!this.rumbleEnabled || !this.pad) return;
    const p = this.pad as Gamepad & {
      vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> };
      hapticActuators?: { pulse?: (v: number, ms: number) => Promise<unknown> }[];
    };
    try {
      if (p.vibrationActuator?.playEffect) {
        p.vibrationActuator
          .playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })
          .catch(() => undefined);
      } else p.hapticActuators?.[0]?.pulse?.(Math.min(1, Math.max(strong, weak)), ms)?.catch(() => undefined);
    } catch {
      /* rumble unsupported */
    }
  }
}

/** Shape stick response: finer control near centre, full authority at the edge. */
export function expo(v: number, k = 1.5): number {
  return Math.sign(v) * Math.pow(Math.abs(v), k);
}

export function padHelp(p: GamepadInput, layout: PadLayout): string {
  const g = (b: Btn) => `<b>${p.glyph(b)}</b>`;
  if (layout === 'pilot')
    return `PILOT LAYOUT · ${g(BTN.LS)} collective ▴▾ / pedals ◂▸ · ${g(BTN.RS)} cyclic · ${g(BTN.RT)} cannon (gunner auto-aims) · ${g(BTN.LT)} rockets<br>${g(BTN.RB)} missile · ${g(BTN.LB)} flares · D-pad ▴▾ zoom · ${g(BTN.Y)} map · ${g(BTN.VIEW)} SAS · ${g(BTN.MENU)} pause`;
  return `GUNSHIP LAYOUT · ${g(BTN.LS)} cyclic · ${g(BTN.RS)} aim cannon · ${g(BTN.RT)} cannon · ${g(BTN.LT)} rockets · ${g(BTN.RB)}/${g(BTN.LB)} climb/descend<br>D-pad ◂▸ pedals, ▴▾ zoom · ${g(BTN.A)} missile · ${g(BTN.B)} flares · ${g(BTN.Y)} map · ${g(BTN.VIEW)} SAS · ${g(BTN.MENU)} pause`;
}
