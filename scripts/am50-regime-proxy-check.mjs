// AM50 validation: determinism + all-four-labels reachability for the OHLCV proxy.
import { classifyRegimeProxy, REGIME_PROXY_VERSION } from '../lib/regime-proxy.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
function volatile(n, seed, amp, base = 100) {
  const rnd = rng(seed); const out = []; let p = base;
  for (let i = 0; i < n; i++) { const r = amp * (0.5 + Math.abs(rnd())); p += rnd() * r * 0.6; out.push({ open: p, high: p + r / 2, low: p - r / 2, close: p, volume: 1 }); }
  return out;
}
// Consolidation band after a volatile history, ending at the requested extreme.
function banded(nVol, { lo, hi, endAt }, seed = 7) {
  const out = volatile(nVol, seed, 3, 100);
  for (let i = nVol; i < nVol + 260; i++) { const p = (i % 2 === 0) ? lo : hi; out.push({ open: p, high: hi, low: lo, close: p, volume: 1 }); }
  const last = out[out.length - 1]; last.close = endAt; last.open = endAt; last.high = hi; last.low = lo;
  return out;
}

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// 1. Determinism.
const fixA = volatile(300, 1, 0.6);
check('determinism (same fixture twice)', classifyRegimeProxy(fixA) === classifyRegimeProxy(fixA.slice()));

// 2. Insufficient -> CHOP, never null.
check('insufficient -> CHOP', classifyRegimeProxy(fixA.slice(0, 10)) === 'CHOP');
check('empty -> CHOP', classifyRegimeProxy([]) === 'CHOP');

// Clean strong uptrend: steady step + small noise => large EMA slope vs ATR14.
function trending(n, step = 0.9, noise = 0.15, base = 100) {
  const rnd = rng(11); const out = []; let p = base;
  for (let i = 0; i < n; i++) { p += step + rnd() * noise; const r = 0.3 + Math.abs(rnd()) * 0.2; out.push({ open: p, high: p + r / 2, low: p - r / 2, close: p, volume: 1 }); }
  return out;
}

// 3. All four labels reachable.
const suite = {
  TREND: trending(400),
  CHOP: volatile(400, 2, 0.4),
  ACCUMULATION: banded(220, { lo: 99.5, hi: 100.5, endAt: 99.5 }),
  DISTRIBUTION: banded(220, { lo: 99.5, hi: 100.5, endAt: 100.5 })
};
const labels = {};
for (const [want, candles] of Object.entries(suite)) {
  const got = classifyRegimeProxy(candles);
  labels[want] = got;
  check(`mixed series reaches ${want}`, got === want, `got ${got}`);
}
check('all four labels reachable', new Set(Object.values(labels)).size === 4, Object.values(labels).join(','));
check('version constant', REGIME_PROXY_VERSION === 'proxy_v1', REGIME_PROXY_VERSION);

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
