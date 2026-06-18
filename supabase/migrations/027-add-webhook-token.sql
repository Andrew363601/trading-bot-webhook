-- 027-add-webhook-token.sql
-- Purpose: Add per-strategy webhook_token for TradingView auth and
-- formalize last_veto_time (already in use by workers/sniper.js but
-- never formally added via migration).

-- ---------------------------------------------------------------------------
-- 1. ADD webhook_token COLUMN
-- ---------------------------------------------------------------------------
ALTER TABLE public.strategy_config
    ADD COLUMN IF NOT EXISTS webhook_token UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS uniq_strategy_config_webhook_token
    ON public.strategy_config (webhook_token)
    WHERE webhook_token IS NOT NULL;

-- Backfill any existing rows that might have NULL
UPDATE public.strategy_config
SET webhook_token = gen_random_uuid()
WHERE webhook_token IS NULL;

-- ---------------------------------------------------------------------------
-- 2. FORMALIZE last_veto_time (already in use by workers/sniper.js)
-- ---------------------------------------------------------------------------
ALTER TABLE public.strategy_config
    ADD COLUMN IF NOT EXISTS last_veto_time TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.strategy_config.last_veto_time IS
    'Timestamp of the last veto/cooldown trigger. Used by webhook receiver and sniper worker for signal throttling.';

COMMENT ON COLUMN public.strategy_config.webhook_token IS
    'Per-strategy UUID for TradingView webhook authentication. Token-gated instead of tenant_id for security.';
