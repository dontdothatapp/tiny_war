// Game sound. Music and most effects are 8-bit samples generated with ElevenLabs
// (server/generate-audio.ts writes them to public/audio/ with a manifest.json).
// Until a sample has loaded, or if it is missing, the procedural WebAudio version
// plays instead: rotor "wop-wop" is amplitude-modulated filtered noise driven by
// rotor RPM, turbine is a detuned saw pair, weapons/explosions are shaped noise
// bursts. Alarms and menu beeps stay procedural (they're already square-wave beeps).
// Positional sounds get distance attenuation + pan either way.

/** Samples the game plays. Ids match server/generate-audio.ts. */
const SAMPLE_IDS = [
  'rotor_loop',
  'engine_loop',
  'engine_start',
  'heli_crash',
  'cannon',
  'rocket',
  'missile',
  'flare',
  'enemy_mg',
  'enemy_flak',
  'enemy_missile',
  'explosion_small',
  'explosion_big',
  'impact',
  'collapse',
  'player_hit',
  'pickup',
  'winch',
  'crew_boarded',
  'credits_banked',
  'level_up',
  'base_destroyed',
  'jingle_sector_clear',
  'jingle_game_over',
] as const;
type SampleId = (typeof SAMPLE_IDS)[number];

export type MusicId = 'mission' | 'hangar';
/** Which generated track plays for each piece of music. */
const MUSIC_TRACKS: Record<MusicId, string> = { mission: 'music_mission_b', hangar: 'music_hangar' };

const MUSIC_LEVEL = 0.32;
/** Overlap between the end of one pass of a music track and the start of the next. */
const MUSIC_CROSSFADE = 2.5;
/** Cap on one-shot samples playing at once (cannon + enemy fire + explosions pile up fast). */
const MAX_VOICES = 40;

interface MusicPlayback {
  id: MusicId;
  gain: GainNode;
  sources: AudioBufferSourceNode[];
  timer: number;
}

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private rotorGain!: GainNode;
  private rotorLfo!: OscillatorNode;
  private rotorLfoGain!: GainNode;
  private rotorFilter!: BiquadFilterNode;
  private turbGain!: GainNode;
  private turbOsc!: OscillatorNode;
  private turbOsc2!: OscillatorNode;
  private windGain!: GainNode;
  private alarmT = 0;
  volume = 0.7;
  private listenerX = 0;
  private listenerZ = 0;
  private last: Record<string, number> = {};

  // samples
  private files = new Map<string, Promise<ArrayBuffer>>();
  private decoding = new Set<string>();
  private buffers = new Map<string, AudioBuffer>();
  private voices = 0;
  private sampleRotor: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private sampleEngine: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  // music
  private musicBus!: GainNode;
  private musicDuck!: GainNode;
  private musicWant: MusicId | null = null;
  private musicOn = true;
  private musicNow: MusicPlayback | null = null;

  constructor() {
    void this.fetchSamples();
  }

  /** Download the generated files straight away; they're decoded once audio is allowed to start. */
  private async fetchSamples() {
    const base = import.meta.env.BASE_URL;
    let manifest: Record<string, string>;
    try {
      const r = await fetch(`${base}audio/manifest.json`);
      if (!r.ok) return;
      manifest = await r.json();
    } catch {
      return; // no generated audio: procedural sound only
    }
    const wanted = new Set<string>([...SAMPLE_IDS, ...Object.values(MUSIC_TRACKS)]);
    for (const [id, file] of Object.entries(manifest)) {
      if (!wanted.has(id)) continue;
      const p = fetch(`${base}audio/${file}`).then((r) => {
        if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      p.catch(() => {}); // a missing file just means that sound stays procedural
      this.files.set(id, p);
    }
    this.decodeSamples();
  }

  private decodeSamples() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [id, file] of this.files) {
      if (this.decoding.has(id)) continue;
      this.decoding.add(id);
      file
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => {
          this.buffers.set(id, buf);
          this.onSampleReady(id);
        })
        .catch((e) => console.warn('[audio] could not load', id, e));
    }
  }

  private onSampleReady(id: string) {
    if (id === 'rotor_loop' || id === 'engine_loop') this.startLoops();
    if (Object.values(MUSIC_TRACKS).includes(id)) this.syncMusic();
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = MUSIC_LEVEL;
    this.musicDuck = ctx.createGain();
    this.musicBus.connect(this.musicDuck).connect(this.master);
    // noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      // slightly brown noise
      b = (b + (Math.random() * 2 - 1) * 0.08) * 0.985;
      d[i] = b * 3 + (Math.random() * 2 - 1) * 0.25;
    }
    // rotor loop
    const rn = ctx.createBufferSource();
    rn.buffer = this.noiseBuf;
    rn.loop = true;
    this.rotorFilter = ctx.createBiquadFilter();
    this.rotorFilter.type = 'lowpass';
    this.rotorFilter.frequency.value = 420;
    this.rotorFilter.Q.value = 1.5;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    this.rotorLfo = ctx.createOscillator();
    this.rotorLfo.type = 'sawtooth';
    this.rotorLfo.frequency.value = 0;
    this.rotorLfoGain = ctx.createGain();
    this.rotorLfoGain.gain.value = 0.5;
    this.rotorLfo.connect(this.rotorLfoGain).connect(am.gain);
    this.rotorGain = ctx.createGain();
    this.rotorGain.gain.value = 0;
    rn.connect(this.rotorFilter).connect(am).connect(this.rotorGain).connect(this.master);
    rn.start();
    this.rotorLfo.start();
    // turbine whine
    this.turbOsc = ctx.createOscillator();
    this.turbOsc.type = 'sawtooth';
    this.turbOsc2 = ctx.createOscillator();
    this.turbOsc2.type = 'sawtooth';
    const tf = ctx.createBiquadFilter();
    tf.type = 'bandpass';
    tf.frequency.value = 1800;
    tf.Q.value = 3;
    this.turbGain = ctx.createGain();
    this.turbGain.gain.value = 0;
    this.turbOsc.connect(tf);
    this.turbOsc2.connect(tf);
    tf.connect(this.turbGain).connect(this.master);
    this.turbOsc.start();
    this.turbOsc2.start();
    // wind
    const wn = ctx.createBufferSource();
    wn.buffer = this.noiseBuf;
    wn.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 700;
    wf.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wn.connect(wf).connect(this.windGain).connect(this.master);
    wn.start();
    this.decodeSamples();
    this.syncMusic();
  }

  /** Browsers only start audio after a click or key press (gamepad input doesn't count). */
  get blocked(): boolean {
    return !this.ctx || this.ctx.state !== 'running';
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  setListener(x: number, z: number) {
    this.listenerX = x;
    this.listenerZ = z;
  }

  // ======================================================================== engine loops

  /** Swap the procedural rotor/turbine for the sampled loops once both have loaded. */
  private startLoops() {
    const ctx = this.ctx;
    const rotor = this.buffers.get('rotor_loop');
    const engine = this.buffers.get('engine_loop');
    if (!ctx || !rotor || !engine || this.sampleRotor) return;
    const loop = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.master);
      src.start();
      return { src, gain };
    };
    this.sampleRotor = loop(rotor);
    this.sampleEngine = loop(engine);
  }

  /** Continuous engine sounds. */
  engine(rpm: number, collective: number, speed: number, alive: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = alive ? 1 : 0;
    if (this.sampleRotor && this.sampleEngine) {
      // sampled loops: rotor chops faster and the turbine pitches up with RPM
      this.sampleRotor.src.playbackRate.setTargetAtTime(0.55 + rpm * 0.45, t, 0.1);
      this.sampleRotor.gain.gain.setTargetAtTime(on * rpm * (0.22 + collective * 0.22), t, 0.1);
      this.sampleEngine.src.playbackRate.setTargetAtTime(0.7 + rpm * 0.32, t, 0.2);
      this.sampleEngine.gain.gain.setTargetAtTime(on * rpm * 0.08, t, 0.2);
      this.rotorGain.gain.setTargetAtTime(0, t, 0.1);
      this.turbGain.gain.setTargetAtTime(0, t, 0.1);
    } else {
      this.rotorLfo.frequency.setTargetAtTime(rpm * 11.5, t, 0.1);
      this.rotorGain.gain.setTargetAtTime(on * rpm * (0.32 + collective * 0.35), t, 0.1);
      this.rotorFilter.frequency.setTargetAtTime(300 + collective * 500 + rpm * 200, t, 0.1);
      this.turbOsc.frequency.setTargetAtTime(220 + rpm * 640, t, 0.2);
      this.turbOsc2.frequency.setTargetAtTime(223 + rpm * 652, t, 0.2);
      this.turbGain.gain.setTargetAtTime(on * rpm * 0.022, t, 0.2);
    }
    this.windGain.gain.setTargetAtTime(Math.min(0.12, speed * 0.002) * on, t, 0.2);
  }

  // ======================================================================== music

  /** Which music should be playing; null for silence. Safe to call before audio has started. */
  music(id: MusicId | null) {
    this.musicWant = id;
    this.syncMusic();
  }

  setMusicEnabled(on: boolean) {
    this.musicOn = on;
    this.syncMusic();
  }

  private syncMusic() {
    const ctx = this.ctx;
    if (!ctx) return;
    const want = this.musicOn ? this.musicWant : null;
    if (this.musicNow?.id === want) return;
    const t = ctx.currentTime;
    const old = this.musicNow;
    if (old) {
      clearTimeout(old.timer);
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + 1.2);
      for (const s of old.sources) s.stop(t + 1.3);
      this.musicNow = null;
    }
    if (!want) return;
    const buf = this.buffers.get(MUSIC_TRACKS[want]);
    if (!buf) return; // starts from onSampleReady when it has loaded
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + 1.5);
    gain.connect(this.musicBus);
    const now: MusicPlayback = { id: want, gain, sources: [], timer: 0 };
    this.musicNow = now;
    this.musicPass(now, buf, t + 0.05, true);
  }

  /** Play one pass of the track and schedule the next to start, crossfaded, before this one ends. */
  private musicPass(m: MusicPlayback, buf: AudioBuffer, when: number, first: boolean) {
    const ctx = this.ctx!;
    const x = Math.min(MUSIC_CROSSFADE, buf.duration / 4);
    const end = when + buf.duration;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(first ? 1 : 0, when);
    if (!first) g.gain.linearRampToValueAtTime(1, when + x);
    g.gain.setValueAtTime(1, end - x);
    g.gain.linearRampToValueAtTime(0, end);
    src.connect(g).connect(m.gain);
    src.start(when);
    m.sources.push(src);
    src.onended = () => m.sources.splice(m.sources.indexOf(src), 1);
    const next = end - x;
    m.timer = window.setTimeout(
      () => {
        if (this.musicNow === m) this.musicPass(m, buf, next, false);
      },
      Math.max(0, (next - ctx.currentTime - 1) * 1000),
    );
  }

  /** Short music sting; the background music dips out underneath it. */
  private jingle(id: 'jingle_sector_clear' | 'jingle_game_over', gain: number) {
    const ctx = this.ctx;
    const buf = this.buffers.get(id);
    if (!ctx || !buf) return false;
    const t = ctx.currentTime;
    const d = this.musicDuck.gain;
    d.cancelScheduledValues(t);
    d.setValueAtTime(d.value, t);
    d.linearRampToValueAtTime(0, t + 0.3);
    d.setValueAtTime(0, t + buf.duration);
    d.linearRampToValueAtTime(1, t + buf.duration + 2);
    return this.sample(id, gain);
  }

  sectorCleared() {
    this.jingle('jingle_sector_clear', 0.6);
  }
  gameOver() {
    this.jingle('jingle_game_over', 0.6);
  }

  // ======================================================================== one-shots

  private spatial(x: number, z: number): { gain: number; pan: number } {
    const dx = x - this.listenerX,
      dz = z - this.listenerZ;
    const d = Math.hypot(dx, dz);
    return { gain: 1 / (1 + d / 90), pan: Math.max(-1, Math.min(1, dx / 160)) };
  }

  /**
   * Play a generated sample. Returns false when it isn't loaded, so the caller can
   * fall back to the procedural sound.
   */
  private sample(id: SampleId, gain: number, o: { x?: number; z?: number; rate?: number; jitter?: number } = {}): boolean {
    const ctx = this.ctx;
    const buf = this.buffers.get(id);
    if (!ctx || !buf) return false;
    let pan = 0;
    if (o.x !== undefined && o.z !== undefined) {
      const s = this.spatial(o.x, o.z);
      gain *= s.gain;
      pan = s.pan;
    }
    if (gain < 0.004 || this.voices >= MAX_VOICES) return true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (o.jitter ?? 0.04));
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.master);
    this.voices++;
    src.onended = () => this.voices--;
    src.start();
    return true;
  }

  private noiseShot(opts: { x?: number; z?: number; dur: number; freq: number; q?: number; type?: BiquadFilterType; gain: number; sweep?: number; delay?: number }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.freq * opts.sweep), t + opts.dur);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    let gain = opts.gain;
    let pan = 0;
    if (opts.x !== undefined && opts.z !== undefined) {
      const s = this.spatial(opts.x, opts.z);
      gain *= s.gain;
      pan = s.pan;
    }
    if (gain < 0.004) return;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + opts.dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 1.5, opts.dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'square', slide = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.last[key] ?? 0) + ms > now) return false;
    this.last[key] = now;
    return true;
  }

  engineStart() {
    this.sample('engine_start', 0.45);
  }
  /** The aircraft is going down (the explosion comes separately when it hits the ground). */
  crash() {
    this.sample('heli_crash', 0.7);
  }
  gun() {
    if (!this.throttle('gun', 45)) return;
    if (this.sample('cannon', 0.4, { jitter: 0.06 })) return;
    this.noiseShot({ dur: 0.09, freq: 2200, gain: 0.35, sweep: 0.3 });
    this.noiseShot({ dur: 0.12, freq: 180, gain: 0.5, sweep: 0.5 });
  }
  rocket() {
    if (this.sample('rocket', 0.5)) return;
    this.noiseShot({ dur: 0.7, freq: 1500, type: 'bandpass', q: 1.2, gain: 0.5, sweep: 0.25 });
  }
  missile() {
    if (this.sample('missile', 0.6)) return;
    this.noiseShot({ dur: 1.4, freq: 900, type: 'bandpass', q: 1.5, gain: 0.5, sweep: 0.3 });
  }
  flare() {
    if (this.sample('flare', 0.4)) return;
    this.noiseShot({ dur: 0.25, freq: 3000, type: 'highpass', gain: 0.25 });
  }
  enemyFire(x: number, z: number, kind: 'mg' | 'flak' | 'tank' | 'sam') {
    const heavy = kind !== 'mg';
    if (!this.throttle('ef' + kind, heavy ? 120 : 60)) return;
    if (kind === 'mg' && this.sample('enemy_mg', 0.4, { x, z, jitter: 0.08 })) return;
    if (kind === 'flak' && this.sample('enemy_flak', 0.7, { x, z })) return;
    if (kind === 'tank' && this.sample('enemy_flak', 0.8, { x, z, rate: 0.8 })) return;
    if (kind === 'sam' && this.sample('enemy_missile', 0.9, { x, z })) return;
    this.noiseShot({ x, z, dur: heavy ? 0.4 : 0.08, freq: heavy ? 500 : 1600, gain: heavy ? 0.8 : 0.35, sweep: 0.3 });
  }
  explosion(x: number, z: number, size: number) {
    const big = Math.min(1, size / 10);
    const played = size >= 5 ? this.sample('explosion_big', 0.6 + big * 0.4, { x, z }) : this.sample('explosion_small', 0.45 + big * 0.5, { x, z, jitter: 0.1 });
    if (played) return;
    this.noiseShot({ x, z, dur: 0.6 + big * 1.6, freq: 900 + big * 600, gain: 0.6 + big * 0.9, sweep: 0.06 });
    this.noiseShot({ x, z, dur: 0.3 + big, freq: 120, gain: 0.8 + big, sweep: 0.4 });
  }
  impact(x: number, z: number) {
    if (!this.throttle('imp', 30)) return;
    if (this.sample('impact', 0.3, { x, z, jitter: 0.12 })) return;
    this.noiseShot({ x, z, dur: 0.12, freq: 1200, gain: 0.25, sweep: 0.3 });
  }
  hit() {
    if (!this.throttle('hit', 70)) return;
    if (this.sample('player_hit', 0.5, { jitter: 0.08 })) return;
    this.noiseShot({ dur: 0.12, freq: 3500, type: 'bandpass', q: 4, gain: 0.5 });
    this.tone(180, 0.08, 0.12, 'square', 0.6);
  }
  crumble(x: number, z: number, mass: number) {
    if (!this.throttle('crumble', 80)) return;
    if (this.sample('collapse', Math.min(1, 0.3 + mass / 600), { x, z, jitter: 0.1 })) return;
    this.noiseShot({ x, z, dur: 0.8 + Math.min(1.5, mass / 400), freq: 400, gain: Math.min(1.2, 0.3 + mass / 600), sweep: 0.3 });
  }
  levelUp() {
    if (this.sample('level_up', 0.45)) return;
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.16, 0.12, 'square'), i * 80));
  }
  winch() {
    if (this.sample('winch', 0.2, { jitter: 0.1 })) return;
    this.tone(520, 0.12, 0.08, 'triangle', 1.5);
  }
  pickup() {
    if (this.sample('pickup', 0.4)) return;
    this.tone(660, 0.1, 0.12, 'square');
    setTimeout(() => this.tone(990, 0.15, 0.12, 'square'), 90);
  }
  crewBoarded() {
    if (this.sample('crew_boarded', 0.4)) return;
    this.ui();
  }
  creditsBanked() {
    this.sample('credits_banked', 0.4);
  }
  baseDestroyed() {
    this.sample('base_destroyed', 0.5);
  }
  ui() {
    this.tone(880, 0.06, 0.08, 'square');
  }
  deny() {
    this.tone(180, 0.18, 0.12, 'square');
  }
  /** Repeating warning tones. kind: 'missile' | 'lock' | 'fuel' */
  alarm(kind: 'missile' | 'lock' | 'fuel' | 'vrs', dt: number) {
    this.alarmT -= dt;
    if (this.alarmT > 0) return;
    if (kind === 'missile') {
      this.tone(1300, 0.08, 0.15);
      this.alarmT = 0.15;
    } else if (kind === 'lock') {
      this.tone(900, 0.12, 0.1);
      this.alarmT = 0.45;
    } else if (kind === 'vrs') {
      this.tone(420, 0.1, 0.1, 'sawtooth');
      this.alarmT = 0.3;
    } else {
      this.tone(600, 0.2, 0.08, 'triangle');
      this.alarmT = 1.2;
    }
  }
}
