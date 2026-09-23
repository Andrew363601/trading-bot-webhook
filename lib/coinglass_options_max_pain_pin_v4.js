import { cgGet, cgBase } from './coinglass-api.js';

// 🟢 AM20 — max-pain must RETURN THE PAYLOAD, never a hollow success.
// Previously a perp-only asset (no options chain) produced
// { status: 'success', max_pain: undefined } — the agent couldn't tell data
// from absence and kept re-calling. Contract now:
//   - success → full payload { status, symbol, max_pain }
//   - no options market (missing field OR CoinGlass business error) →
//     { status: 'empty', reason: 'no options market for <base>' } so the
//     gateway can cache the negative result and stop repeat calls.
export async function coinglass_options_max_pain_pin_v4(symbol) {
    // Market Context: Options Expiry Pinning Strategy [11, 28]
    // exchange param now required on this endpoint; BASE symbol.
    const base = cgBase(symbol);
    try {
        const data = await cgGet(`api/option/max-pain?symbol=${base}&exchange=Binance`);
        const max_pain = data?.maxPainPrice ?? data?.max_pain_price; // [28]
        if (max_pain === null || max_pain === undefined) {
            return { status: 'empty', reason: `no options market for ${base}` };
        }
        return { status: 'success', symbol: base, max_pain };
    } catch (e) {
        // cgGet throws on non-zero business code — for this endpoint that is
        // the normal "asset has no options chain" outcome, not a network fault.
        return { status: 'empty', reason: `no options market for ${base}` };
    }
}