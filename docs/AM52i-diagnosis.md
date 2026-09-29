# AM52i — Diagnose-only notes (no patches)

Two issues were investigated but deliberately NOT patched in this push. Root
causes below; each needs its own scoped fix.

## 1. `SKIPPED_OPEN_EXISTS` alert spam

**Source:** `workers/shadow-portfolio.js` (~L763).

```js
const { data: openSibling } = await supabase
  .from('shadow_portfolio')
  .select('id')
  .eq('tenant_id', scan.tenant_id)
  .eq('asset', asset)
  .eq('verdict', 'PENDING')
  .limit(1);
if (openSibling && openSibling.length > 0) {
  console.log(`[SHADOW] SKIPPED_OPEN_EXISTS ${scan.id} ${asset} — one open ticket per asset.`);
  return false;
}
```

**Root cause:** this is a *benign idempotency guard* (AM2 open-cap: one PENDING
ticket per tenant+asset), not an error. But the sniper evaluates on a
**wall-clock cadence** (`getEvalIntervalMs` ≈ 50s for a 5m TF), so every scan
for an asset that already has an open PENDING ticket re-logs the line until the
ticket resolves (up to the 24h sim horizon). The log level (`console.log`) and
per-cycle frequency make it look like an alert storm.

**Not a bug** — the guard is correct. **Deferred fix options:**
- Downgrade to `console.debug` / gate behind a debug flag.
- Dedupe by `scan_id` (log once per scan, not once per cycle).
- Rate-limit per (tenant, asset) with a short TTL.

## 2. Legacy money-rows (BIP -8704.53 / SLP $1.59 / XPP -8.38)

**Symptom:** stale PnL rows for symbols that no longer resolve to a live asset
appear in money aggregates.

**Root cause:** these are **live demo/seed rows in `trade_logs`** for
delisted/renamed symbols. They are NOT in `supabase/seed-demo-trades.sql`
(verified — no BIP/SLP/XPP/8704 matches). Money-aggregation queries
(`lib/calibration-engine.js`, performance endpoints) sum `pnl` without
filtering on asset resolvability, so the stale rows leak into totals.

**Deferred fix options:**
- Exclude non-resolvable symbols from money aggregates (join against
  `lib/asset-resolver.js` / `asset-contract-size.js`).
- Archive/delete the demo rows for the affected tenant.
- Add an `is_demo` / `archived` flag to `trade_logs` and filter on it.

## Explicitly deferred (need their own UI pushes)
- Publish-gate UI.
- Regime-map editor UI.
