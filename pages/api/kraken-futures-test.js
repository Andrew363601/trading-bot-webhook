// pages/api/kraken-futures-test.js
// 🟢 Push 7 hotfix 3 — the "Test Connection" endpoint behind the Settings Kraken
// Futures card. ONE cheap authenticated GET /accounts (limiter cost 2) that proves
// or disproves the tenant's vault row BEFORE any entry order depends on it.
//
// SECURITY SHAPE (mirrors configure-api-keys.js):
//   - withTenantAuth: the tenant is derived SERVER-SIDE from the verified session —
//     never from the request body. A tenant can only probe its OWN vault row.
//   - The probe resolves creds INSIDE the provider (kfPrivateRequest →
//     retrieveAPIKey); no key material ever crosses this route's return path.
//   - The response carries the apiv3 error CODE + the venue's VERBATIM errorMessage
//     + the host actually used (prod vs demo) — enough to separate bad-creds from
//     a demo/prod mismatch from a code bug in one click. No secrets, no params.
import { withTenantAuth } from '../../lib/auth-middleware';
import { kfAuthProbe } from '../../lib/providers/kraken-futures.js';

async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN' && role !== 'TRADER' && role !== 'TRIAL') {
            return res.status(403).json({ error: 'Unauthorized role' });
        }

        // 🟢 AM65 — FIX probe variant: ?transport=fix runs the JURISDICTION PROBE —
        // TLS connect → Logon → SecurityListRequest → the account's PF_* instrument
        // universe in Kraken's own words. Geo enforcement happens at Kraken's OES
        // BEFORE any order fills; this probe answers PF_* eligibility before a
        // dollar moves. GUARD (E6): if a FIX session is already live for this
        // tenant, REFUSE — a second logon on the same SenderCompID kicks the first
        // session, and CoD (default ON) would cancel its resident TP/SL orders.
        const transport = String(req.query.transport || 'rest').toLowerCase();
        if (transport === 'fix') {
            const fixMod = await import('../../lib/providers/kraken-fix.js');
            if (fixMod.peekFixSession(tenantId)) {
                return res.status(409).json({
                    ok: false,
                    error: 'fix_session_live',
                    message: 'A FIX session is already live for this tenant. Probing again would open a SECOND session on the same SenderCompID and kick the live one (Cancel-on-Disconnect would cancel its resident orders). Destroy the session first or use the REST probe.',
                });
            }
            const probe = await fixFixProbe({ tenantId, supabase });
            return res.status(200).json(probe);
        }

        const verdict = await kfAuthProbe({ supabase, tenantId });

        if (verdict.ok) {
            return res.status(200).json({
                ok: true,
                host: verdict.host,
                message: 'Kraken Futures connection verified — the vault row signed a successful private call.',
            });
        }
        return res.status(200).json({
            ok: false,
            error: verdict.error || 'unknown_error',
            errorMessage: verdict.errorMessage || null,
            hint: verdict.hint || null,
            host: verdict.host,
            message: `Kraken Futures rejected the probe: ${verdict.error || 'unknown_error'}${verdict.errorMessage ? ` — ${verdict.errorMessage}` : ''}${verdict.hint ? `\n\n${verdict.hint}` : ''}`,
        });
    } catch (error) {
        console.error('[KRF_TEST_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

/**
 * 🟢 AM65 — the FIX jurisdiction probe. TLS connect → Logon → SecurityListRequest
 * → the account's PF_* instrument universe, verbatim from Kraken. This is the
 * probe that answers "is this account geo-eligible for derivatives on FIX?"
 * with Kraken's own words BEFORE any order is placed. Owner-process only (E6):
 * the probe OPENS a session, so it must never run where a session is live.
 */
async function fixFixProbe({ tenantId, supabase }) {
    const fixMod = await import('../../lib/providers/kraken-fix.js');
    const { retrieveAPIKey } = await import('../../lib/secrets-manager.js');
    try {
        const creds = await retrieveAPIKey(supabase, tenantId, 'krakenfutures');
        const config = await fixMod.resolveFixConfig({ supabase, tenantId, creds });
        // The probe is a THROWAWAY session — it must not register in the owner's
        // session Map (peekFixSession must stay null afterwards). Construct the
        // session class directly instead of getFixSession.
        const live = new fixMod.KrakenFixSession({ tenantId, ...config });
        try {
            await live.connect();
            const slr = await live.securityList({}, 6000);
            const instruments = slr
                .map((raw) => fixMod.parseFixFields(raw))
                .filter((f) => f['35'] === 'y')
                .map((f) => ({ symbol: f['55'] || null, raw: null }));
            const pfSymbols = instruments.map((i) => i.symbol).filter((s) => s && s.startsWith('PF_'));
            return {
                ok: true,
                transport: 'fix',
                host: fixMod.KRF_FIX_HOST,
                port: fixMod.KRF_FIX_PORT_DRV_TRD,
                senderCompId: config.senderCompId,
                configSource: config.source,
                instrumentCount: instruments.length,
                pfSymbols: pfSymbols.slice(0, 50),
                message: `FIX logon OK on ${fixMod.KRF_FIX_HOST}:${fixMod.KRF_FIX_PORT_DRV_TRD} as ${config.senderCompId}. ${pfSymbols.length} PF_* instruments visible — this is Kraken's own answer to derivatives eligibility for this account.`,
            };
        } finally {
            await live.destroy().catch(() => {});
        }
    } catch (e) {
        return {
            ok: false,
            transport: 'fix',
            error: e.message,
            message: `FIX probe failed: ${e.message}. Common causes: (1) no SenderCompID on file — set it in Settings or ask your Kraken agent; (2) the FIX key lacks FIX permission (pro.kraken.com settings); (3) this egress IP is not whitelisted (Kraken requires IP whitelisting BEFORE logon); (4) geo enforcement at the OES — the probe reports what Kraken's own door says.`,
        };
    }
}

export default withTenantAuth(handler);
