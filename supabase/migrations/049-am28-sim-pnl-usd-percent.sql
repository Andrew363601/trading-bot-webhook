-- Migration 049: PUSH AM28 — sim_pnl_usd = % of entry × notional (config-true $)
-- ADDITIVE ONLY (no schema change; data backfill for the 3 legacy Path B rows).
--
-- Old writer: sim_pnl_usd = sim_pnl_pts × qty  (raw price points × qty —
-- meaningless in $ for low-priced assets like BIP/SLP/XPP).
-- New writer: sim_pnl_usd = (signedPts / entryPrice) × notional,
--   notional = sim_params.qty, else $1,000 default (AM7 qty convention).
--   workers/shadow-portfolio.js now stamps sim_params.qty so every future row
--   is auditable from the row alone (qty null ⇒ $1k default applied).
--
-- Backfill: these are the ONLY 3 rows with a resolved sim (sim_pnl_usd set),
-- with values computed per the AM28 formula (raw pre-fee signedPts → % of the
-- far-side fill entry × notional; fees stay in sim_pnl_pts, rounded to cents):
--   BIP: +$17.38 | SLP: +$1.39 | XPP: −$5.58
--
-- Guard: (sim_params->>'qty') IS NULL targets ONLY legacy rows that pre-date
-- AM28's qty stamping — a newly-resolved row (always carries sim_params.qty)
-- can never be touched by this backfill, even if applied late.

UPDATE shadow_portfolio SET sim_pnl_usd = 17.38
WHERE asset = 'BIP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING'
  AND (sim_params->>'qty') IS NULL;

UPDATE shadow_portfolio SET sim_pnl_usd = 1.39
WHERE asset = 'SLP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING'
  AND (sim_params->>'qty') IS NULL;

UPDATE shadow_portfolio SET sim_pnl_usd = -5.58
WHERE asset = 'XPP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING'
  AND (sim_params->>'qty') IS NULL;
