// Synthesized techno drum voices. Each function builds a small throwaway
// Web Audio graph that plays one hit at time `at` into `dest`, then frees
// itself — same lifecycle as the original metronome click.

export type VoiceKind = 'kick' | 'hat' | 'clap' | 'perc' | 'sample';

// Resolved (plain number) params handed to the voice functions.
export interface KickParams { tune: number; decay: number; punch: number; } // Hz, s, 0..1
export interface HatParams { decay: number; tone: number; }                  // s, Hz
export interface ClapParams { decay: number; tone: number; }                 // s, Hz
export interface PercParams { tune: number; decay: number; }                 // Hz, s

let noiseBuf: AudioBuffer | null = null;
function getNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate); // 1s of white noise
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = b;
  return b;
}

export function playKick(ctx: AudioContext, dest: AudioNode, at: number, p: KickParams) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  const f0 = Math.max(20, p.tune);
  const fPeak = f0 * (1 + 4 * Math.max(0, Math.min(1, p.punch))); // punch raises the click pitch
  o.frequency.setValueAtTime(fPeak, at);
  o.frequency.exponentialRampToValueAtTime(f0, at + Math.min(0.09, p.decay * 0.5));
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(1, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0008, at + p.decay);
  o.connect(g); g.connect(dest);
  o.start(at); o.stop(at + p.decay + 0.03);
}

export function playHat(ctx: AudioContext, dest: AudioNode, at: number, p: HatParams) {
  const s = ctx.createBufferSource(); s.buffer = getNoise(ctx);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.tone;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.9, at);
  g.gain.exponentialRampToValueAtTime(0.0008, at + p.decay);
  s.connect(hp); hp.connect(g); g.connect(dest);
  s.start(at); s.stop(at + p.decay + 0.03);
}

export function playClap(ctx: AudioContext, dest: AudioNode, at: number, p: ClapParams) {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.tone; bp.Q.value = 1.5;
  bp.connect(dest);
  const bursts = [0, 0.009, 0.018, 0.027];
  bursts.forEach((off, i) => {
    const last = i === bursts.length - 1;
    const s = ctx.createBufferSource(); s.buffer = getNoise(ctx);
    const g = ctx.createGain();
    const dec = last ? p.decay : 0.014;
    g.gain.setValueAtTime(last ? 0.95 : 0.5, at + off);
    g.gain.exponentialRampToValueAtTime(0.0008, at + off + dec);
    s.connect(g); g.connect(bp);
    s.start(at + off); s.stop(at + off + dec + 0.03);
  });
}

export function playPerc(ctx: AudioContext, dest: AudioNode, at: number, p: PercParams) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(p.tune * 1.6, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, p.tune), at + 0.035);
  g.gain.setValueAtTime(0.9, at);
  g.gain.exponentialRampToValueAtTime(0.0008, at + p.decay);
  o.connect(g); g.connect(dest);
  o.start(at); o.stop(at + p.decay + 0.03);
}

// Fallback used by the 'sample' source when no sample is loaded yet.
export function playClick(ctx: AudioContext, dest: AudioNode, at: number, accent: boolean) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle'; o.frequency.value = accent ? 1400 : 800;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.6, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
  o.connect(g); g.connect(dest);
  o.start(at); o.stop(at + 0.05);
}

export function playSample(ctx: AudioContext, dest: AudioNode, buf: AudioBuffer, at: number) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.connect(dest); s.start(at);
}
