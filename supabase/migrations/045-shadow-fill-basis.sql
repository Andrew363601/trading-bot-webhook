-- 🟢 shadow-v2: observable fill basis for shadow-portfolio veto counterfactuals.
-- 'far_side' = entry priced at the far side of the book at signal time
-- (BUY veto → best_ask, SELL veto → best_bid, from paired signal scan telemetry).
-- 'mid_legacy' = pre-deploy scans priced at mid (vetoPrice) with the old
-- HIGH/LOW exit math. The bound upgrades automatically as new scans populate
-- best_bid/best_ask in scan_results telemetry.
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS fill_basis TEXT;
-- 🟢 PUSH AA: point-in-time TF pair stamped at veto time (for trainer ingestion)
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS macro_tf TEXT;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS trigger_tf TEXT;
