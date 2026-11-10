// Letterbox bars and the sector title shown over the opening shot.

export class TitleCard {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private capEl: HTMLElement;
  private hintEl: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'intro';
    this.root.innerHTML = `<div class="bar top"></div><div class="bar bot"></div>
      <div class="card"><div class="n"></div><div class="s"></div></div>
      <div class="cap"></div><div class="hint"></div>`;
    container.appendChild(this.root);
    this.titleEl = this.root.querySelector('.n')!;
    this.subEl = this.root.querySelector('.s')!;
    this.capEl = this.root.querySelector('.cap')!;
    this.hintEl = this.root.querySelector('.hint')!;
  }

  /** `caption` and `hint` sit in the bottom bar, left and right. */
  show(title: string, sub: string, caption: string, hint: string) {
    this.titleEl.textContent = title;
    this.subEl.textContent = sub;
    this.capEl.textContent = caption;
    this.hintEl.textContent = hint;
    this.root.classList.remove('quiet');
    this.root.classList.add('on');
  }

  /** Fade the text out; the bars stay until hide(). */
  quiet() {
    this.root.classList.add('quiet');
  }

  hide() {
    this.root.classList.remove('on', 'quiet');
  }
}
