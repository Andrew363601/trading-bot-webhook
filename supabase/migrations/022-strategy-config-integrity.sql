-- 022-strategy-config-integrity.sql
-- Purpose: Make structurally invalid strategy_config rows impossible.
--
-- This is a last-line-of-defense in addition to the application-level guards in
-- pages/api/chat.js (manageStrategy) and pages/api/{subscribe,deploy}-strategy.js.
-- Even if a bug or rogue caller slips through, the database itself will refuse:
--   * blank/null strategy names
--   * null tenant_id
--
-- Also adds a useful unique constraint so the same (tenant, asset, strategy) tuple
-- can only exist once, preventing duplicate rows under any race condition.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. NOT NULL + NOT BLANK on the critical columns.
-- ---------------------------------------------------------------------------

-- 1a. Backfill any pre-existing blank-name rows before adding the check,
--     otherwise the constraint creation will fail on legacy bad data. We don't
--     auto-delete because admins may want to inspect them — instead we mark
--     them obviously invalid so the application can show / clean them up.
UPDATE public.strategy_config
SET strategy = '__INVALID_BLANK__',
    is_active = false
WHERE strategy IS NULL OR trim(strategy) = '';

-- 1b. NOT NULL guards. ALTER COLUMN ... SET NOT NULL is idempotent in the sense
--     that it's a no-op when already set, so we don't need a DO block.
ALTER TABLE public.strategy_config
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN strategy  SET NOT NULL,
    ALTER COLUMN asset     SET NOT NULL;

-- 1c. Non-blank check (idempotent via IF NOT EXISTS pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'strategy_config_strategy_not_blank'
          AND conrelid = 'public.strategy_config'::regclass
    ) THEN
        ALTER TABLE public.strategy_config
            ADD CONSTRAINT strategy_config_strategy_not_blank
            CHECK (length(trim(strategy)) > 0);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Unique (tenant_id, asset, strategy) — one row per logical strategy per
--    tenant. Migration 018 already covers "one active per asset" with a
--    partial unique index; this one covers "one ROW per (tenant, asset, strategy)"
--    regardless of active state, so the same strategy can't be duplicated.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_strategy_config_tenant_asset_strategy
    ON public.strategy_config (tenant_id, asset, strategy);
