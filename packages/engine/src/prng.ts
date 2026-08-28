/**
 * mulberry32: a tiny, well-known 32-bit PRNG. Deterministic per seed, good
 * enough for timing jitter and fake identifiers; not for anything secret.
 */
export interface Prng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, max). */
  int(max: number): number;
  /** Lower-case hex string of `length` characters. */
  hex(length: number): string;
  /** Digits string of `length` characters. */
  digits(length: number): string;
}

export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * max);
  const hex = (length: number): string => {
    let s = '';
    for (let i = 0; i < length; i++) s += int(16).toString(16);
    return s;
  };
  const digits = (length: number): string => {
    let s = '';
    for (let i = 0; i < length; i++) s += String(int(10));
    return s;
  };
  return { next, int, hex, digits };
}

/** FNV-1a over UTF-16 code units, two lanes, 16 hex chars. Stable across runtimes. */
export function fnv1a16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
