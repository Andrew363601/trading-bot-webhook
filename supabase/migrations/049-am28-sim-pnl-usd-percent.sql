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
-- with values computed per the AM28 formula (fee-inclusive pts → % of the
-- far-side fill entry × notional, rounded to cents):
--   BIP: +$17.38 | SLP: +$1.39 | XPP: −$5.58

UPDATE shadow_portfolio SET sim_pnl_usd = 17.38
WHERE asset = 'BIP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING';

UPDATE shadow_portfolio SET sim_pnl_usd = 1.39
WHERE asset = 'SLP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING';

UPDATE shadow_portfolio SET sim_pnl_usd = -5.58
WHERE asset = 'XPP' AND sim_pnl_usd IS NOT NULL AND verdict <> 'PENDING';
