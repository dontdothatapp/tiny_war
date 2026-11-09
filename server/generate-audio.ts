// Generates the game's music and sound effects with ElevenLabs.
//
//   node --env-file=.env.local server/generate-audio.ts             # generate everything that's missing
//   node --env-file=.env.local server/generate-audio.ts cannon rocket  # (re)generate only these ids
//   node --env-file=.env.local server/generate-audio.ts --process   # redo the ffmpeg step only, no API calls
//   ... --budget=15000                                               # stop once this many credits are spent
//
// Raw downloads are kept in audio-src/ (gitignored), so the processing below can be
// re-tuned without spending credits again. Processed files go to public/audio/,
// which Vite serves next to the game. Needs ffmpeg on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { elevenlabs } from './elevenlabs.ts';

type Kind = 'music' | 'sfx' | 'loop';
interface Sound {
  id: string;
  kind: Kind;
  prompt: string;
  /** seconds */
  length: number;
  /** sfx only: 0..1, how literally to follow the prompt */
  influence?: number;
}

// Everything is 8-bit: the game should sound like an old console cartridge.
// Prompts describe genre and feel only; the music API rejects named artists or songs.
const STYLE = '8-bit retro video game sound effect, NES-style sound chip';
const LOOPABLE = 'Steady energy from start to finish with no intro, no fade-in, no fade-out and no ending, so it loops seamlessly.';

const MISSION =
  'Instrumental 8-bit chiptune rock anthem, as if a late-1960s Vietnam-era protest rock song were played on a 1980s NES sound chip. ' +
  'Driving, defiant and swaggering: a stomping mid-tempo 4/4 beat around 132 BPM, a gritty repeating square-wave guitar riff, ' +
  'a buzzy pulse-wave bass line that walks under it, noise-channel snare and hi-hats, and a punchy lead melody. ' +
  'Raw, rebellious, sweaty jungle-war energy for flying an attack helicopter into battle. No vocals. ';

const SOUNDS: Sound[] = [
  // ---------------------------------------------------------------- music
  // An earlier take, music_mission_a (MISSION + LOOPABLE), lost the pick to the one
  // below. Its raw download is still in audio-src/; re-add the entry to ship it again.
  {
    id: 'music_mission_b',
    kind: 'music',
    length: 90,
    prompt: MISSION + 'This take is a little faster and angrier, with a call-and-response riff between the lead and the bass. ' + LOOPABLE,
  },
  {
    id: 'music_hangar',
    kind: 'music',
    length: 60,
    prompt:
      'Instrumental 8-bit chiptune on a 1980s NES sound chip: a calm but tense theme for a military helicopter hangar between missions in a Vietnam-era war game. ' +
      'Laid-back slow groove around 90 BPM, a twangy square-wave lead playing a bluesy late-1960s rock melody, soft pulse-wave bass, ' +
      'light noise-channel hi-hats. Moody and smoky, a breather before the next fight. No vocals. ' +
      LOOPABLE,
  },
  {
    id: 'jingle_sector_clear',
    kind: 'sfx',
    length: 5,
    influence: 0.6,
    prompt: '8-bit chiptune victory jingle on an NES sound chip: a short triumphant rock-and-roll fanfare with a driving pulse bass and noise drums, ending on a strong final chord',
  },
  {
    id: 'jingle_game_over',
    kind: 'sfx',
    length: 5,
    influence: 0.6,
    prompt: '8-bit chiptune game over jingle on an NES sound chip: a short sad bluesy melody that falls slowly and ends on a low held note',
  },

  // ---------------------------------------------------------------- your helicopter
  {
    id: 'rotor_loop',
    kind: 'loop',
    length: 3,
    influence: 0.6,
    prompt: `${STYLE}: helicopter rotor loop, a steady rhythmic low chopping wop-wop-wop made of crunchy noise bursts at a constant speed`,
  },
  {
    id: 'engine_loop',
    kind: 'loop',
    length: 3,
    influence: 0.6,
    prompt: `${STYLE}: helicopter turbine engine loop, a steady high buzzing square-wave whine at a constant pitch`,
  },
  {
    id: 'engine_start',
    kind: 'sfx',
    length: 3.5,
    influence: 0.5,
    prompt: `${STYLE}: helicopter engine starting up, a turbine whine rising in pitch from silence while the rotor chop speeds up`,
  },
  {
    id: 'heli_crash',
    kind: 'sfx',
    length: 2.5,
    influence: 0.5,
    prompt: `${STYLE}: helicopter going down, the engine sputtering and coughing, rotor chop slowing, a long falling-pitch whine`,
  },

  // ---------------------------------------------------------------- your weapons
  { id: 'cannon', kind: 'sfx', length: 0.5, influence: 0.7, prompt: `${STYLE}: one single short punchy autocannon shot, crunchy noise blast, one shot only` },
  { id: 'rocket', kind: 'sfx', length: 1, influence: 0.6, prompt: `${STYLE}: rocket launch, a whooshing hissing noise burst sweeping downward` },
  { id: 'missile', kind: 'sfx', length: 1.5, influence: 0.6, prompt: `${STYLE}: guided missile launch, a sharp ignition pop then a sustained rocket-motor hiss flying away` },
  { id: 'flare', kind: 'sfx', length: 0.6, influence: 0.6, prompt: `${STYLE}: flare countermeasure launch, a quick bright pop with a fizzing sparkle` },

  // ---------------------------------------------------------------- enemy fire
  { id: 'enemy_mg', kind: 'sfx', length: 0.5, influence: 0.7, prompt: `${STYLE}: one single short rattling machine gun shot, one shot only` },
  { id: 'enemy_flak', kind: 'sfx', length: 0.8, influence: 0.6, prompt: `${STYLE}: one heavy anti-aircraft flak cannon shot, a deep thumping boom with a crunchy tail` },
  { id: 'enemy_missile', kind: 'sfx', length: 1.5, influence: 0.6, prompt: `${STYLE}: surface-to-air missile launching from the ground, a deep whoosh and a roaring rocket hiss` },

  // ---------------------------------------------------------------- hits
  { id: 'explosion_small', kind: 'sfx', length: 1.2, influence: 0.6, prompt: `${STYLE}: small explosion, a crunchy noise burst with a quick decay` },
  { id: 'explosion_big', kind: 'sfx', length: 2.5, influence: 0.6, prompt: `${STYLE}: huge explosion, a long deep rumbling crunchy noise blast with crackling debris` },
  { id: 'impact', kind: 'sfx', length: 0.5, influence: 0.6, prompt: `${STYLE}: bullet impact, a tiny sharp ricochet tick hitting dirt and metal, very short` },
  { id: 'collapse', kind: 'sfx', length: 2, influence: 0.6, prompt: `${STYLE}: building collapse, bricks and rubble crumbling and tumbling down, low crunchy rumble` },
  { id: 'player_hit', kind: 'sfx', length: 0.5, influence: 0.6, prompt: `${STYLE}: player aircraft taking damage, a harsh metallic clank with a short descending buzz` },

  // ---------------------------------------------------------------- progress
  { id: 'pickup', kind: 'sfx', length: 0.8, influence: 0.7, prompt: `${STYLE}: item pickup, a cheerful quick rising two-note square-wave chime` },
  { id: 'winch', kind: 'sfx', length: 0.5, influence: 0.6, prompt: `${STYLE}: winch cable ratchet, a short mechanical clicking` },
  { id: 'crew_boarded', kind: 'sfx', length: 1, influence: 0.7, prompt: `${STYLE}: rescue success, a short friendly rising three-note arpeggio` },
  { id: 'credits_banked', kind: 'sfx', length: 1.2, influence: 0.7, prompt: `${STYLE}: cashing in coins, a rapid sparkling cascade of coin blips ending on a bright ding` },
  { id: 'level_up', kind: 'sfx', length: 1.8, influence: 0.7, prompt: `${STYLE}: level-up fanfare, a quick triumphant rising square-wave arpeggio ending on a bright held chord` },
  { id: 'base_destroyed', kind: 'sfx', length: 2, influence: 0.6, prompt: `${STYLE}: objective complete stinger, a short heroic military bugle call on square waves` },
];

const SRC_DIR = 'audio-src';
const OUT_DIR = 'public/audio';

/** Raw download from ElevenLabs. Loops come as WAV so no MP3 padding ends up in the seam. */
function rawPath(s: Sound): string {
  return `${SRC_DIR}/${s.id}.${s.kind === 'loop' ? 'wav' : 'mp3'}`;
}

/** File the game loads, inside public/audio/. */
function outName(s: Sound): string {
  return `${s.id}.${s.kind === 'loop' ? 'wav' : 'mp3'}`;
}

async function creditsUsed(): Promise<number> {
  return (await elevenlabs.user.subscription.get()).characterCount;
}

/** The audio, plus what the request cost if the response says (the account total updates late). */
async function download(s: Sound): Promise<{ audio: Buffer; cost: number | null }> {
  const req =
    s.kind === 'music'
      ? elevenlabs.music.compose({
          prompt: s.prompt,
          musicLengthMs: Math.round(s.length * 1000),
          modelId: 'music_v2_5',
          forceInstrumental: true,
          outputFormat: 'mp3_48000_192',
        })
      : elevenlabs.textToSoundEffects.convert({
          text: s.prompt,
          modelId: 'eleven_text_to_sound_v3',
          durationSeconds: s.length,
          promptInfluence: s.influence ?? 0.5,
          loop: s.kind === 'loop',
          outputFormat: s.kind === 'loop' ? 'wav_44100' : 'mp3_44100_192',
        });
  const { data, rawResponse } = await req.withRawResponse();
  const header = rawResponse.headers.get('character-cost') ?? rawResponse.headers.get('x-character-count');
  return { audio: Buffer.from(await new Response(data).arrayBuffer()), cost: header === null ? null : Number(header) };
}

/** Retries rate-limited requests (429) with a growing pause. */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 429 || attempt >= 6) throw e;
      const wait = 5 * attempt;
      console.log(`  ${what}: rate limited, retrying in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

/** Runs ffmpeg and returns its log (stderr), where volumedetect writes its results. */
function ffmpeg(args: string[]): string {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-800)}`);
  return r.stderr;
}

function levels(file: string): { peak: number; mean: number; seconds: number } {
  const log = ffmpeg(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const num = (re: RegExp) => Number(re.exec(log)?.[1] ?? NaN);
  const [h, m, s] = (/Duration: (\d+):(\d+):([\d.]+)/.exec(log) ?? [, 0, 0, 0]).slice(1).map(Number);
  return { peak: num(/max_volume: (-?[\d.]+) dB/), mean: num(/mean_volume: (-?[\d.]+) dB/), seconds: h * 3600 + m * 60 + s };
}

// Cut silence off the start, and (reversed) off the end.
const TRIM = 'silenceremove=start_periods=1:start_threshold=-50dB';
const TRIM_BOTH = `${TRIM},areverse,${TRIM},areverse`;

/** Turns a raw download into the file the game loads. */
function finish(s: Sound) {
  const src = rawPath(s);
  const out = `${OUT_DIR}/${outName(s)}`;
  if (s.kind === 'music') {
    // trim both ends and even out loudness; the game crossfades the loop seam itself
    ffmpeg(['-i', src, '-af', `${TRIM_BOTH},loudnorm=I=-16:TP=-1.5:LRA=11`, '-ar', '44100', '-ac', '2', '-b:a', '128k', out]);
  } else if (s.kind === 'loop') {
    // keep the seam intact: no trimming, just bring the peak to -1 dB
    const gain = -1 - levels(src).peak;
    ffmpeg(['-i', src, '-af', `volume=${gain.toFixed(2)}dB`, '-ac', '1', '-ar', '32000', '-c:a', 'pcm_s16le', out]);
  } else {
    // one-shots: trim so they fire instantly, mono, peak at -1 dB
    const tmp = `${SRC_DIR}/${s.id}.trimmed.wav`;
    ffmpeg(['-i', src, '-af', TRIM_BOTH, '-ac', '1', tmp]);
    const gain = -1 - levels(tmp).peak;
    ffmpeg(['-i', tmp, '-af', `volume=${gain.toFixed(2)}dB`, '-ar', '44100', '-b:a', '96k', out]);
    rmSync(tmp);
  }
  const l = levels(out);
  console.log(`  ${outName(s).padEnd(26)} ${l.seconds.toFixed(2).padStart(6)} s   peak ${l.peak} dB   mean ${l.mean} dB`);
}

/** id -> file name, for every sound that has been made. The game reads this. */
function writeManifest() {
  const files: Record<string, string> = {};
  for (const s of SOUNDS) if (existsSync(`${OUT_DIR}/${outName(s)}`)) files[s.id] = outName(s);
  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(files, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const processOnly = argv.includes('--process');
  const budget = Number(argv.find((a) => a.startsWith('--budget='))?.split('=')[1] ?? Infinity);
  const ids = argv.filter((a) => !a.startsWith('--'));
  const unknown = ids.filter((id) => !SOUNDS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown sound ids: ${unknown.join(', ')}`);
  mkdirSync(SRC_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const picked = ids.length ? SOUNDS.filter((s) => ids.includes(s.id)) : SOUNDS;
  let failed = 0;

  if (!processOnly) {
    // with ids: regenerate those; without: only what hasn't been downloaded yet
    const todo = ids.length ? picked : picked.filter((s) => !existsSync(rawPath(s)));
    const start = await withRetry('balance', creditsUsed);
    let spent = 0;
    for (const s of todo) {
      if (spent >= budget) {
        console.log(`Stopping: ${spent} credits spent, budget is ${budget}.`);
        break;
      }
      const t0 = Date.now();
      try {
        const { audio, cost } = await withRetry(s.id, () => download(s));
        writeFileSync(rawPath(s), audio);
        spent += cost ?? 0;
        console.log(`${s.id}: ${cost ?? '?'} credits, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        finish(s);
      } catch (e) {
        failed++;
        const err = e as { message?: string; body?: unknown };
        console.error(`${s.id}: FAILED ${err.message ?? e}${err.body ? `\n  ${JSON.stringify(err.body).slice(0, 600)}` : ''}`);
      }
    }
    // the account total can lag behind by a while, so this may read low
    console.log(`Account balance moved by ${(await withRetry('balance', creditsUsed)) - start} credits so far.`);
  } else {
    for (const s of picked) if (existsSync(rawPath(s))) finish(s);
  }
  writeManifest();
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
