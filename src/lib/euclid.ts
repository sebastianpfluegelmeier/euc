// Euclidean rhythm primitives shared by the component and the modulators.

export interface EP { len: number; steps: number; div: number; offset: number; }

export function bjorklund(k: number, n: number): boolean[] {
  n = n | 0; k = Math.max(0, Math.min(k | 0, n));
  if (n <= 0) return [];
  const p: boolean[] = new Array(n);
  for (let i = 0; i < n; i++)
    p[i] = Math.floor((i * k) / n) > Math.floor(((i - 1) * k) / n);
  return p;
}

export function rotate(p: boolean[], off: number): boolean[] {
  const n = p.length; if (!n) return [];
  const o = ((off | 0) % n + n) % n;
  return o === 0 ? p.slice() : [...p.slice(o), ...p.slice(0, o)];
}

export function evalEP(p: EP): boolean[] {
  return rotate(bjorklund(p.steps, p.len), p.offset);
}
