// Keyboard + mouse state. Keys are tracked by KeyboardEvent.code so layouts
// don't matter (WASD stays WASD on AZERTY).

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  /** normalised device coords */
  ndcX = 0;
  ndcY = 0;
  lmb = false;
  rmb = false;
  mmb = false;
  wheel = 0;
  private mPressed = new Set<number>();
  /** performance.now() of the last keyboard / mouse input (for device switching) */
  lastUsed = -Infinity;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.lastUsed = performance.now();
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.lmb = this.rmb = this.mmb = false;
    });
    el.addEventListener('mousemove', (e) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 3) this.lastUsed = performance.now();
      this.move(e);
    });
    el.addEventListener('mousedown', (e) => {
      this.lastUsed = performance.now();
      this.move(e);
      if (e.button === 0) this.lmb = true;
      if (e.button === 1) {
        this.mmb = true;
        e.preventDefault();
      }
      if (e.button === 2) this.rmb = true;
      this.mPressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 1) this.mmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        this.lastUsed = performance.now();
        e.preventDefault();
      },
      { passive: false },
    );
  }

  private move(e: MouseEvent) {
    const r = this.el.getBoundingClientRect();
    this.mouseX = e.clientX - r.left;
    this.mouseY = e.clientY - r.top;
    this.ndcX = (this.mouseX / r.width) * 2 - 1;
    this.ndcY = -(this.mouseY / r.height) * 2 + 1;
  }

  key(code: string): boolean {
    return this.down.has(code);
  }
  any(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }
  hit(code: string): boolean {
    return this.pressed.has(code);
  }
  mouseHit(button: number): boolean {
    return this.mPressed.has(button);
  }
  axis(neg: string[], pos: string[]): number {
    return (this.any(...pos) ? 1 : 0) - (this.any(...neg) ? 1 : 0);
  }
  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mPressed.clear();
    this.wheel = 0;
  }
}
