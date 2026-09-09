import { cgGet } from './coinglass-api.js';

export async function coinglass_exchange_wallet_assets_v4(exchange = 'Binance') {
    // Market Context: Solvency and Systemic Risk Tracking [21, 24]
    // NOTE: old /v4/spot/exchange-assets path is 404 since the v4 migration.
    // New path returns rows: { symbol, balance, balance_usd, price, wallet_address }.
    try {
        const data = await cgGet(`api/exchange/assets?exchange=${encodeURIComponent(exchange || 'Binance')}`);
        const rows = Array.isArray(data) ? data : [];
        if (!rows.length) throw new Error('Exchange assets returned no rows');

        const usdOf = (a) => Number(a?.balance_usd ?? a?.valueUsd ?? 0);
        const total_usd = rows.reduce((sum, a) => sum + usdOf(a), 0);
        const hhi_assets = total_usd > 0
            ? rows.reduce((sum, a) => sum + Math.pow(usdOf(a) / total_usd, 2), 0) // [24]
            : 0;
        
        return { status: "success", hhi_assets, total_usd };
    } catch (e) { return { status: "error", message: e.message }; }
}