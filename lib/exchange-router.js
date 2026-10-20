// lib/exchange-router.js
// 🟢 PUSH AM63 (Push 2) — the ONE venue resolver.
//
// Maps an `exchange` string to its provider module. 'coinbase' resolves to the
// AM63 Push 1 transport door. Anything else fails LOUD: a wrong-venue trade must
// never route to the wrong credentials or be silently coerced to Coinbase.
//
// Push 2 ships ONLY a void validator (assertExchangeSupported) — the watchdog uses
// it per-trade. The adapter-binding call site (`const adapter = resolveExchange(...)`)
// arrives with Push 4, when a second adapter actually exists to bind. There is
// deliberately NO requireAdapterFor export here — no dead API.
//
// Normalization: missing / undefined / empty → 'coinbase' (every existing row and
// every existing call site). Unknown venue → supported:false + adapter:null, and
// callers that need to act on it throw.

import * as coinbase from './providers/coinbase.js';

/**
 * Resolves an exchange identifier to its provider module.
 * @param {string} [exchange] - venue name; falsy defaults to 'coinbase'.
 * @returns {{ exchange: string, adapter: object|null, supported: boolean }}
 */
export function resolveExchange(exchange) {
  const name = (exchange || 'coinbase').toLowerCase();
  if (name === 'coinbase') return { exchange: 'coinbase', adapter: coinbase, supported: true };
  return { exchange: name, adapter: null, supported: false };
}

/**
 * Throws if the venue has no adapter yet. Void — the watchdog calls this
 * per-trade so a hand-edited unsupported venue row can never be routed to the
 * wrong credentials or silently coerced to Coinbase.
 * @param {string} [exchange]
 */
export function assertExchangeSupported(exchange) {
  const r = resolveExchange(exchange);
  // 🟢 AM63 (Push 4) — the allowlist widened to admit 'kraken' (the Bitnomial
  // provider now exists; Paper-only in Push 4 — LIVE refuses inside execute-trade).
  // 🟢 AM63 (Push 5) — widened again to admit 'krakenfutures' (the REAL Kraken
  // Futures apiv3 provider; Paper-only until Push 6 — LIVE refuses inside execute-trade).
  // This is a BODY change only: exports stay exactly {resolveExchange,
  // assertExchangeSupported}. Any OTHER venue still throws — that negative control
  // is what keeps this a contract (a widened allowlist), not a loosening.
  // 🟢 AM68 — widened to admit 'krakenspot' (the Kraken SPOT + margin lane; LIVE
  // allowed with the KRAKENSPOT vault row). 'kraken' stays FROZEN = Bitnomial.
  if (r.exchange === 'kraken') return;
  if (r.exchange === 'krakenfutures') return;
  if (r.exchange === 'krakenspot') return;
  if (!r.supported) {
    throw new Error(`[AM63] exchange '${r.exchange}' is configured but not supported yet ` +
      `(Push 5). Trade routing stopped rather than silently using Coinbase.`);
  }
}
