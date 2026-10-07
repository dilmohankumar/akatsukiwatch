// Deterministic mock-data helpers. Same (seed, timestamp) => same value, so
// refreshes are stable and charts don't "re-roll" on every poll.

export const RANGES = {
  '1h': { n: 60, step: 60_000 },
  '6h': { n: 72, step: 300_000 },
  '24h': { n: 48, step: 1_800_000 },
  '7d': { n: 84, step: 7_200_000 },
  '30d': { n: 60, step: 43_200_000 },
};

export function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function timeline(range) {
  const { n, step } = RANGES[range] || RANGES['24h'];
  const end = Math.floor(Date.now() / step) * step;
  return { step, n, ts: Array.from({ length: n }, (_, i) => end - (n - 1 - i) * step) };
}

/** One numeric series aligned to the timeline. `base` is "per minute". */
export function series(tl, o) {
  const { seed, base, amp = 0.35, noise = 0.2, spike = 0, spikeMul = 6, min = 0, round = true, flat = false } = o;
  const k = flat ? 1 : tl.step / 60_000;
  return tl.ts.map((t) => {
    const r = rng(hash(seed) + Math.floor(t / 1000));
    const d = new Date(t);
    const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
    const season = 1 + amp * Math.sin(((hr - 6) / 24) * 2 * Math.PI);
    let v = base * k * season * (1 + (r() - 0.5) * 2 * noise);
    if (spike && r() < spike) v *= spikeMul * (0.5 + r());
    v = Math.max(min, v);
    return round ? Math.round(v) : +v.toFixed(2);
  });
}

/** Split `total[]` into parts by weight (+ per-bucket jitter); parts always sum to total. */
export function split(tl, total, weights, seed) {
  const keys = Object.keys(weights);
  const out = Object.fromEntries(keys.map((k) => [k, []]));
  total.forEach((tot, i) => {
    const r = rng(hash(seed) + Math.floor(tl.ts[i] / 1000));
    const w = keys.map((k) => weights[k] * (0.7 + r() * 0.6));
    const s = w.reduce((a, b) => a + b, 0);
    let left = tot;
    keys.forEach((k, j) => {
      const v = j === keys.length - 1 ? left : Math.min(left, Math.round((tot * w[j]) / s));
      out[k].push(v);
      left -= v;
    });
  });
  return out;
}

export const rows = (tl, cols) =>
  tl.ts.map((t, i) => ({ t, ...Object.fromEntries(Object.entries(cols).map(([k, arr]) => [k, arr[i]])) }));

export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const avg = (a) => (a.length ? sum(a) / a.length : 0);
export const last = (a) => a[a.length - 1];
export const max = (a) => Math.max(...a);

/** % change, second half vs first half of the window. */
export function trend(arr, mode = 'sum') {
  const h = Math.floor(arr.length / 2);
  const f = mode === 'sum' ? sum : avg;
  const a = f(arr.slice(0, h));
  const b = f(arr.slice(h));
  return a === 0 ? 0 : ((b - a) / a) * 100;
}

/** goodWhen: 'up' | 'down' | null — decides delta colour (e.g. 5xx going down is good). */
export function kpi(label, value, fmt, arr, { goodWhen = null, mode = 'sum', sub, empty = false, delta: given, basis } = {}) {
  const delta = given !== undefined ? given : arr ? +trend(arr, mode).toFixed(1) : null;
  let tone = 'neutral';
  if (delta && goodWhen) tone = (delta > 0) === (goodWhen === 'up') ? 'good' : 'bad';
  return { label, value, fmt, delta, tone, spark: arr || null, sub, empty, basis: given !== undefined ? basis || 'previous' : 'halves' };
}

/** Zipf-ish top list that sums to ~total. */
export function toplist(seed, names, total, skew = 1.1) {
  const r = rng(hash(seed + new Date().toISOString().slice(0, 13)));
  const w = names.map((_, i) => (1 / Math.pow(i + 1, skew)) * (0.85 + r() * 0.3));
  const s = sum(w);
  return names.map((label, i) => ({ label, value: Math.round((total * w[i]) / s) })).sort((a, b) => b.value - a.value);
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
export const ago = (ms) => Date.now() - ms;
