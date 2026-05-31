-- 019-add-jurisdiction.sql
-- Purpose: Track a tenant's declared jurisdiction so LIVE trading can be gated to
-- US-based users (Coinbase Financial Markets approved CDE futures are US-only).
--
-- LIVE trading eligibility = (jurisdiction = 'US') AND (Coinbase API keys configured)
-- AND (asset is a Coinbase CDE future). Enforced in deploy-strategy / subscribe-strategy
-- and surfaced by the Nexus assistant.
--
-- Idempotent and safe to re-run.

ALTER TABLE public.tenant_settings
    ADD COLUMN IF NOT EXISTS jurisdiction text;

COMMENT ON COLUMN public.tenant_settings.jurisdiction IS
    'User-declared jurisdiction (e.g. "US"). LIVE trading is restricted to US-based users.';
