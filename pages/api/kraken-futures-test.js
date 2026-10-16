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
            host: verdict.host,
            message: `Kraken Futures rejected the probe: ${verdict.error || 'unknown_error'}${verdict.errorMessage ? ` — ${verdict.errorMessage}` : ''}`,
        });
    } catch (error) {
        console.error('[KRF_TEST_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
