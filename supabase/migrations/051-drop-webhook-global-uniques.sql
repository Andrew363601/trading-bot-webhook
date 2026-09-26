-- Global uniques on webhook URL columns poison the whole table: one tenant's
-- '' (or a shared Discord webhook) blocks every other tenant's save.
-- Per-tenant uniqueness is already enforced by configure-tenant-settings.js
-- upserting with onConflict: 'tenant_id'.
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_notification_nexus_webhook_url_key;
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_notification_webhook_url_key;
-- Normalize existing empty strings to NULL (semantic: not set)
UPDATE tenant_settings SET notification_nexus_webhook_url = NULL WHERE notification_nexus_webhook_url = '';
UPDATE tenant_settings SET notification_webhook_url = NULL WHERE notification_webhook_url = '';
