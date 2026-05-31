-- 024-legal-compliance.sql
-- Purpose: Add terms_accepted field to tenant_settings for legal compliance.
-- Idempotent and safe to re-run.

ALTER TABLE public.tenant_settings
    ADD COLUMN IF NOT EXISTS terms_accepted boolean DEFAULT false;

COMMENT ON COLUMN public.tenant_settings.terms_accepted IS
    'Whether the tenant has accepted the legal Terms of Service and Risk Disclosures for the beta platform.';

-- Set existing tenants to true (grandfathered) or leave them false so they get the popup.
-- Usually, you want everyone to accept the terms at least once, so we leave it false by default.
