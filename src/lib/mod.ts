// A fixed, global set of modulators (2 LFOs + 2 Euclid-triggered envelopes)
// that can be routed to any track parameter. Modulation is sampled at note-on
// (control rate) — `resolveParam` evaluates a param's base value plus the sum
// of its routed modulators at a given audio-clock time.

import { type EP, evalEP } from './euclid';

export type ModSrc = 'lfo1' | 'lfo2' | 'env1' | 'env2';
export const MOD_SRCS: ModSrc[] = ['lfo1', 'lfo2', 'env1', 'env2'];
export const MOD_LABEL: Record<ModSrc, string> = { lfo1: 'L1', lfo2: 'L2', env1: 'E1', env2: 'E2' };

export type LfoShape = 'sine' | 'tri' | 'saw' | 'square';
export interface Lfo { rate: number; shape: LfoShape; unipolar: boolean; } // rate = cycles per bar
export interface Env { euclid: EP; attack: number; decay: number; }         // attack/decay in ms
export interface Modulators { lfo1: Lfo; lfo2: Lfo; env1: Env; env2: Env; }

// A modulatable parameter: integer base value in [min,max] plus routed mods.
export interface ModRef { src: ModSrc; depth: number; } // depth = percent, -100..100
export interface MParam { value: number; min: number; max: number; mods: ModRef[]; }

// Transport reference for evaluating modulators at audio time `t`.
export interface ModCtx { bpm: number; t0: number; } // t0 = audio time of step 0

export const mp = (value: number, min: number, max: number): MParam => ({ value, min, max, mods: [] });

export const defModulators = (): Modulators => ({
  lfo1: { rate: 1, shape: 'sine', unipolar: false },
  lfo2: { rate: 2, shape: 'tri', unipolar: false },
  env1: { euclid: { len: 16, steps: 4, div: 16, offset: 0 }, attack: 4, decay: 300 },
  env2: { euclid: { len: 16, steps: 2, div: 16, offset: 0 }, attack: 4, decay: 500 },
});

function lfoValue(l: Lfo, t: number, ctx: ModCtx): number {
  const secPerBar = (60 / ctx.bpm) * 4;
  const hz = l.rate / secPerBar;
  let ph = ((t - ctx.t0) * hz) % 1;
  if (ph < 0) ph += 1;
  let v: number; // bipolar -1..1
  switch (l.shape) {
    case 'sine': v = Math.sin(ph * 2 * Math.PI); break;
    case 'tri': v = 1 - 4 * Math.abs(ph - 0.5); break;
    case 'saw': v = 2 * ph - 1; break;
    case 'square': v = ph < 0.5 ? 1 : -1; break;
  }
  return l.unipolar ? (v + 1) / 2 : v;
}

function arEnv(age: number, aSec: number, dSec: number): number {
  if (age < 0) return 0;
  if (age < aSec) return aSec > 0 ? age / aSec : 1;
  const d = age - aSec;
  if (d >= dSec) return 0;
  return 1 - d / dSec;
}

function envValue(e: Env, t: number, ctx: ModCtx): number {
  const pattern = evalEP(e.euclid);
  const n = pattern.length;
  if (!n) return 0;
  const stepDur = 60 / ctx.bpm / e.euclid.div;
  const elapsed = t - ctx.t0;
  if (elapsed < 0) return 0;
  const curStep = Math.floor(elapsed / stepDur);
  // Walk backwards to the most recent active step.
  let trig = -1;
  for (let k = curStep; k > curStep - n && k >= 0; k--) {
    if (pattern[((k % n) + n) % n]) { trig = k; break; }
  }
  if (trig < 0) return 0;
  const age = t - (ctx.t0 + trig * stepDur);
  return arEnv(age, e.attack / 1000, e.decay / 1000);
}

export function modValue(m: Modulators, src: ModSrc, t: number, ctx: ModCtx): number {
  switch (src) {
    case 'lfo1': return lfoValue(m.lfo1, t, ctx);
    case 'lfo2': return lfoValue(m.lfo2, t, ctx);
    case 'env1': return envValue(m.env1, t, ctx);
    case 'env2': return envValue(m.env2, t, ctx);
  }
}

export function resolveParam(p: MParam, m: Modulators, t: number, ctx: ModCtx): number {
  let v = p.value;
  const range = p.max - p.min;
  for (const r of p.mods) v += (r.depth / 100) * range * modValue(m, r.src, t, ctx);
  return Math.max(p.min, Math.min(p.max, v));
}
