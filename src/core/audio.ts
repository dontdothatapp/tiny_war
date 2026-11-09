// Procedural WebAudio sound: no asset files. Rotor "wop-wop" is amplitude
// modulated filtered noise driven by rotor RPM; turbine is a detuned saw pair;
// weapons/explosions are shaped noise bursts with distance attenuation + pan.

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

  /** Continuous engine sounds. */
  engine(rpm: number, collective: number, speed: number, alive: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = alive ? 1 : 0;
    this.rotorLfo.frequency.setTargetAtTime(rpm * 11.5, t, 0.1);
    this.rotorGain.gain.setTargetAtTime(on * rpm * (0.32 + collective * 0.35), t, 0.1);
    this.rotorFilter.frequency.setTargetAtTime(300 + collective * 500 + rpm * 200, t, 0.1);
    this.turbOsc.frequency.setTargetAtTime(220 + rpm * 640, t, 0.2);
    this.turbOsc2.frequency.setTargetAtTime(223 + rpm * 652, t, 0.2);
    this.turbGain.gain.setTargetAtTime(on * rpm * 0.022, t, 0.2);
    this.windGain.gain.setTargetAtTime(Math.min(0.12, speed * 0.002) * on, t, 0.2);
  }

  private spatial(x: number, z: number): { gain: number; pan: number } {
    const dx = x - this.listenerX,
      dz = z - this.listenerZ;
    const d = Math.hypot(dx, dz);
    return { gain: 1 / (1 + d / 90), pan: Math.max(-1, Math.min(1, dx / 160)) };
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

  gun() {
    if (!this.throttle('gun', 45)) return;
    this.noiseShot({ dur: 0.09, freq: 2200, gain: 0.35, sweep: 0.3 });
    this.noiseShot({ dur: 0.12, freq: 180, gain: 0.5, sweep: 0.5 });
  }
  rocket() {
    this.noiseShot({ dur: 0.7, freq: 1500, type: 'bandpass', q: 1.2, gain: 0.5, sweep: 0.25 });
  }
  missile() {
    this.noiseShot({ dur: 1.4, freq: 900, type: 'bandpass', q: 1.5, gain: 0.5, sweep: 0.3 });
  }
  flare() {
    this.noiseShot({ dur: 0.25, freq: 3000, type: 'highpass', gain: 0.25 });
  }
  enemyFire(x: number, z: number, heavy: boolean) {
    if (!this.throttle('ef' + (heavy ? 'h' : 'l'), heavy ? 120 : 60)) return;
    this.noiseShot({ x, z, dur: heavy ? 0.4 : 0.08, freq: heavy ? 500 : 1600, gain: heavy ? 0.8 : 0.35, sweep: 0.3 });
  }
  explosion(x: number, z: number, size: number) {
    const big = Math.min(1, size / 10);
    this.noiseShot({ x, z, dur: 0.6 + big * 1.6, freq: 900 + big * 600, gain: 0.6 + big * 0.9, sweep: 0.06 });
    this.noiseShot({ x, z, dur: 0.3 + big, freq: 120, gain: 0.8 + big, sweep: 0.4 });
  }
  impact(x: number, z: number) {
    if (!this.throttle('imp', 30)) return;
    this.noiseShot({ x, z, dur: 0.12, freq: 1200, gain: 0.25, sweep: 0.3 });
  }
  hit() {
    if (!this.throttle('hit', 70)) return;
    this.noiseShot({ dur: 0.12, freq: 3500, type: 'bandpass', q: 4, gain: 0.5 });
    this.tone(180, 0.08, 0.12, 'square', 0.6);
  }
  crumble(x: number, z: number, mass: number) {
    if (!this.throttle('crumble', 80)) return;
    this.noiseShot({ x, z, dur: 0.8 + Math.min(1.5, mass / 400), freq: 400, gain: Math.min(1.2, 0.3 + mass / 600), sweep: 0.3 });
  }
  winch() {
    this.tone(520, 0.12, 0.08, 'triangle', 1.5);
  }
  pickup() {
    this.tone(660, 0.1, 0.12, 'square');
    setTimeout(() => this.tone(990, 0.15, 0.12, 'square'), 90);
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
