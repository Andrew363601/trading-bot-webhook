import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_options_max_pain_pin_v4(symbol) {
    // Market Context: Options Expiry Pinning Strategy [11, 28]
    // exchange param now required on this endpoint; BASE symbol.
    try {
        const data = await cgGet(`api/option/max-pain?symbol=${cgBase(symbol)}&exchange=Binance`);
        const max_pain = data?.maxPainPrice ?? data?.max_pain_price; // [28]
        return { status: "success", max_pain };
    } catch (e) { return { status: "error", message: e.message }; }
}