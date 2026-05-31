-- 018-one-active-strategy-per-asset.sql
-- Purpose: Guarantee at the DATABASE layer that at most ONE strategy can be
-- active (is_active = true) per (tenant_id, asset). Running two active strategies
-- on the same asset can produce conflicting orders and unexpected position
-- closures, which can blow up a user's account.
--
-- Layered enforcement:
--   1. API (subscribe-strategy / deploy-strategy) — friendly UX + confirmation popup.
--   2. THIS partial unique index — a hard, race-proof guarantee at the data layer.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. PRE-CLEANUP: collapse any pre-existing duplicates so the index can build.
--    Keep the most recently updated active row per (tenant_id, asset); deactivate
--    the rest. We coalesce on common timestamp columns to be schema-tolerant.
-- ---------------------------------------------------------------------------
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY tenant_id, asset
            ORDER BY COALESCE(updated_at, last_updated, created_at, now()) DESC, id DESC
        ) AS rn
    FROM public.strategy_config
    WHERE is_active = true
)
UPDATE public.strategy_config sc
SET is_active = false
FROM ranked r
WHERE sc.id = r.id
  AND r.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. PARTIAL UNIQUE INDEX: only one active strategy per (tenant_id, asset).
--    Inactive rows are unconstrained (a tenant may keep many paused strategies).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_strategy_per_asset
    ON public.strategy_config (tenant_id, asset)
    WHERE is_active = true;
