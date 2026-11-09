// Developer sound board: open the game with ?sounds to hear every generated
// sound (public/audio/, made by server/generate-audio.ts) and compare takes.

export async function runSoundBoard(app: HTMLElement) {
  const base = import.meta.env.BASE_URL;
  document.title = 'Tiny War · sounds';
  app.style.cssText = 'overflow:auto;padding:24px 16px;font:14px/1.4 monospace;color:#e8e2c8;background:#1d1c16;height:100%;box-sizing:border-box';
  let manifest: Record<string, string> = {};
  try {
    manifest = await (await fetch(`${base}audio/manifest.json`)).json();
  } catch {
    app.textContent = 'No public/audio/manifest.json: run server/generate-audio.ts first.';
    return;
  }
  const rows = Object.entries(manifest)
    .map(
      ([id, file]) => `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:6px 0;border-bottom:1px solid #3a382c">
        <b style="min-width:200px">${id}</b>
        <audio controls preload="none" src="${base}audio/${file}" style="height:32px;max-width:100%"></audio>
      </div>`,
    )
    .join('');
  app.innerHTML = `<h1 style="font-size:20px;margin:0 0 4px">TINY WAR · SOUND BOARD</h1>
    <p style="margin:0 0 16px;opacity:.7">${Object.keys(manifest).length} sounds.</p>
    ${rows}`;
}
