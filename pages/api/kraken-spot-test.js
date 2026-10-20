// pages/api/kraken-spot-test.js
// 🟢 AM68 — the "Test Connection" endpoint behind the Settings Kraken SPOT (+ margin)
// card. ONE cheap authenticated POST /0/private/Balance that proves or disproves the
// tenant's KRAKENSPOT vault row BEFORE any entry order depends on it. This should be
// the FIRST GREEN authenticated Kraken probe on a US account (the derivative lanes are
// geo-blocked — see AM68 Part A).
//
// SECURITY SHAPE (mirrors kraken-futures-test.js / configure-api-keys.js):
//   - withTenantAuth: the tenant is derived SERVER-SIDE from the verified session —
//     never from the request body. A tenant can only probe its OWN vault row.
//   - The probe resolves creds INSIDE the provider (krSpotAuthProbe → retrieveAPIKey);
//     no key material ever crosses this route's return path.
//   - The response carries the venue's VERBATIM error(s) + a hint — enough to separate
//     a bad key from a missing scope from an unprovisioned vault row in one click.
import { withTenantAuth } from '../../lib/auth-middleware';
import { krSpotAuthProbe, getKrakenSpotTradeBalance } from '../../lib/providers/kraken-spot.js';

async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN' && role !== 'TRADER' && role !== 'TRIAL') {
            return res.status(403).json({ error: 'Unauthorized role' });
        }

        const verdict = await krSpotAuthProbe({ supabase, tenantId });

        if (!verdict.ok) {
            return res.status(200).json({
                ok: false,
                host: verdict.host,
                error: verdict.error || 'unknown_error',
                errorMessage: verdict.errorMessage || null,
                hint: verdict.hint || null,
                message: `Kraken Spot rejected the probe: ${verdict.error || 'unknown_error'}${verdict.errorMessage ? ` — ${verdict.errorMessage}` : ''}${verdict.hint ? `\n\n${verdict.hint}` : ''}`,
            });
        }

        // Best-effort: also read the trade balance so the card can show the real
        // margin equity (the risk validator's source). A failure here does NOT fail
        // the probe — the Balance read already proved the key.
        let tradeBalance = null;
        try {
            const tb = await getKrakenSpotTradeBalance({ supabase, tenantId });
            if (!tb.error) tradeBalance = { equity_usd: tb.equity_usd, available_margin: tb.available_margin, margin_level: tb.margin_level };
        } catch { /* non-fatal */ }

        return res.status(200).json({
            ok: true,
            host: verdict.host,
            tradeBalance,
            message: 'Kraken Spot connection verified — the KRAKENSPOT vault row signed a successful private call.'
                + (tradeBalance && tradeBalance.equity_usd != null ? ` Equity ≈ $${tradeBalance.equity_usd}.` : ''),
        });
    } catch (error) {
        console.error('[KRSPOT_TEST_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
