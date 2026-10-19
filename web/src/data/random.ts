// Small deterministic PRNG (mulberry32) so the seeded demo dataset looks the
// same every time it's regenerated within a session, while still expressing
// dates relative to "now" so the tournament always looks current.

export function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function randFloat(rand: () => number, min: number, max: number, decimals = 2): number {
  const val = rand() * (max - min) + min;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

export function chance(rand: () => number, probability: number): boolean {
  return rand() < probability;
}

export function isoDateDaysFromNow(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoTimestampDaysFromNow(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isoTimestampHoursFromNow(hours: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}
