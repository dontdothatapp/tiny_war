import { Game } from './game/game';

const app = document.getElementById('app')!;

if (new URLSearchParams(location.search).has('gallery')) {
  // developer model gallery (?gallery=aircraft|units|buildings|vehicles|nature|props)
  import('./dev/gallery').then((m) => m.runGallery(app));
} else {
  const game = new Game(app);
  game.boot();

  let last = performance.now();
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    game.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // handy for debugging / automated checks
  (window as unknown as { game: Game; __ready: boolean }).game = game;
  (window as unknown as { __ready: boolean }).__ready = true;
}
