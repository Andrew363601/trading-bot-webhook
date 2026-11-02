// pages/api/kraken-spot-test.js
// 🟢 AM68 — the "Test Connection" endpoint behind the Settings Kraken SPOT (+ margin)
// card. ONE cheap authenticated POST /0/private/Balance that proves or disproves the
// tenant's KRAKENSPOT vault row BEFORE any entry order depends on it. This should be
// the FIRST GREEN authenticated Kraken probe on a US account (the derivative lanes are
// geo-blocked — see AM68 Part A).
//
// 🟢 AM73 — ORDER-READINESS extension. The route now accepts an OPTIONAL
// { pair, leverage } body and returns structured readiness rows { check, ok, detail }:
//   (1) order-permission + venue-acceptance DRY-RUN via placeKrakenSpotOrder({validate:true})
//       — validate places NOTHING; success = the key has order perms AND Kraken accepts
//       the order shape;
//   (2) margin-account read (available_margin / margin_level from TradeBalance);
//   (3) ECP HONESTY RULE — Kraken's validate does NOT gate account eligibility, so a
//       passing validate on a MARGIN order reports "unverified until first order",
//       never a green check. The copy follows the observation, never an assumption.
// Results are negative-cached for 30s (module-scope Map) so a card render does not
// hammer the venue. The legacy fields (ok/host/tradeBalance/message) are preserved.
//
// SECURITY SHAPE (mirrors kraken-futures-test.js / configure-api-keys.js):
//   - withTenantAuth: the tenant is derived SERVER-SIDE from the verified session —
//     never from the request body. A tenant can only probe its OWN vault row.
//   - The probe resolves creds INSIDE the provider (krSpotAuthProbe → retrieveAPIKey);
//     no key material ever crosses this route's return path.
//   - The response carries the venue's VERBATIM error(s) + a hint — enough to separate
//     a bad key from a missing scope from an unprovisioned vault row in one click.
import { withTenantAuth } from '../../lib/auth-middleware';
import { krSpotAuthProbe, getKrakenSpotTradeBalance, placeKrakenSpotOrder, resolveKrakenSpotProduct } from '../../lib/providers/kraken-spot.js';
import { deriveOrderMode, readinessRows } from '../../lib/order-readiness.js';

// 🟢 AM73 — 30s negative cache (module-scope, per tenant+pair+leverage). A card
// render must not hammer the venue; a rejected probe is DATA, not a transient.
const READINESS_CACHE_TTL_MS = 30 * 1000;
const readinessCache = new Map(); // key → { at, payload }

async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN' && role !== 'TRADER' && role !== 'TRIAL') {
            return res.status(403).json({ error: 'Unauthorized role' });
        }

        // 🟢 AM73 — optional readiness inputs. Absent ⇒ the legacy probe-only shape.
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const pair = body.pair ? String(body.pair) : null;
        const leverage = body.leverage != null ? parseFloat(body.leverage) : null;
        const wantsReadiness = !!pair;

        const cacheKey = `${tenantId}:${pair || '-'}:${Number.isFinite(leverage) ? leverage : '-'}`;
        if (wantsReadiness) {
            const hit = readinessCache.get(cacheKey);
            if (hit && Date.now() - hit.at < READINESS_CACHE_TTL_MS) {
                return res.status(200).json({ ...hit.payload, cached: true });
            }
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

        // 🟢 AM73 — readiness rows (only when a pair was supplied).
        let rows = null;
        let orderPerms = null;
        let marginVerified = null;
        let mode = null;
        if (wantsReadiness) {
            // Resolve the venue product so the dry-run uses the REAL pair + margin facts.
            let product = null;
            try { product = await resolveKrakenSpotProduct(pair); } catch { /* non-fatal */ }
            const marginEligible = product && product.margin !== false;
            mode = deriveOrderMode({ leverage, marginEligible });

            // (1) Order-permission + venue-acceptance DRY-RUN. validate:true places NOTHING.
            // A passing validate proves the key has order perms AND Kraken accepts the shape.
            if (product && product.nativeSymbol) {
                try {
                    const dry = await placeKrakenSpotOrder({
                        pair: product.nativeSymbol,
                        type: 'buy',
                        ordertype: 'limit',
                        volume: product.ordermin != null ? product.ordermin : 1,
                        price: 1, // validate-only: price is not matched, only shape-checked
                        leverage: mode.mode === 'MARGIN' ? String(mode.leverage) : null,
                        validate: true,
                        supabase, tenantId,
                    });
                    orderPerms = { query: true, orders: !!dry.placed };
                    // ECP honesty: a passing validate does NOT prove margin eligibility.
                    marginVerified = null;
                } catch {
                    orderPerms = { query: true, orders: false };
                }
            } else {
                orderPerms = { query: true, orders: null };
            }

            // (2) Margin-account read. If both available_margin and margin_level are
            // null/zero on a USD pair, the account has no margin surface — honest-absent.
            if (mode.mode === 'MARGIN' && tradeBalance) {
                const am = tradeBalance.available_margin;
                const ml = tradeBalance.margin_level;
                const hasMarginSurface = (am != null && am > 0) || (ml != null && ml > 0);
                if (!hasMarginSurface) marginVerified = false; // NOT ENABLED on this account
                // else: leave null (unverified until first order — ECP honesty rule).
            }

            rows = readinessRows({
                balance: tradeBalance,
                keyPerms: orderPerms,
                mode,
                lastVerdict: null,
                marginVerified,
            });
        }

        const payload = {
            ok: true,
            host: verdict.host,
            tradeBalance,
            ...(wantsReadiness ? { rows, mode: mode ? mode.mode : null } : {}),
            message: 'Kraken Spot connection verified — the KRAKENSPOT vault row signed a successful private call.'
                + (tradeBalance && tradeBalance.equity_usd != null ? ` Equity ≈ $${tradeBalance.equity_usd}.` : ''),
        };

        if (wantsReadiness) readinessCache.set(cacheKey, { at: Date.now(), payload });

        return res.status(200).json(payload);
    } catch (error) {
        console.error('[KRSPOT_TEST_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
