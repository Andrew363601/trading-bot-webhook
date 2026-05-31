# Release Runbook

This runbook covers what YOU need to do to ship the changes in this branch:
1. Apply the new database migrations.
2. Migrate Stripe from sandbox (test) to live mode.
3. Set/verify environment variables.

---

## 1. Database migrations (run in order)

Apply these new migrations to your Supabase project (SQL editor or `supabase db push`):

| File | What it does |
|------|--------------|
| `supabase/migrations/017-cancellation-enforcement.sql` | Adds `enforce_billing_strategy_lockdown()` + hourly `pg_cron` sweep that disables strategies for canceled/expired tenants. Runs an immediate one-time sweep. |
| `supabase/migrations/018-one-active-strategy-per-asset.sql` | Cleans up duplicate active strategies, then adds a partial UNIQUE index so only ONE strategy can be active per `(tenant_id, asset)`. |
| `supabase/migrations/019-add-jurisdiction.sql` | Adds `tenant_settings.jurisdiction` (gates LIVE trading to US users). |
| `supabase/migrations/020-optimizer-tenant-scope.sql` | Ensures `optimization_logs.tenant_id` exists (optimizer is now tenant-scoped). |

### pg_cron note (migration 017)
The hourly trial-end sweep uses `pg_cron`. If it isn't enabled, the migration skips
scheduling (gracefully) — the Stripe webhook + worker guard still fully protect you.
To enable pg_cron in Supabase: **Dashboard → Database → Extensions → enable `pg_cron`**,
then re-run migration 017 so the schedule is created.

### Verify after applying
```sql
-- Confirm the unique index exists
SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_active_strategy_per_asset';
-- Confirm the lockdown function exists
SELECT proname FROM pg_proc WHERE proname = 'enforce_billing_strategy_lockdown';
-- (If pg_cron enabled) confirm the schedule
SELECT jobname, schedule FROM cron.job WHERE jobname = 'billing_strategy_lockdown';
```

---

## 2. Stripe: Sandbox → Live migration

> ⚠️ Test-mode objects (products, prices, customers, webhooks) do NOT carry over to
> live mode. You must recreate the prices and webhook in **live** mode.

### Step-by-step
1. **Toggle to Live mode** in the Stripe Dashboard (top-right switch).
2. **Recreate Products & Prices** in live mode (Retail, Pro, Institutional). Copy the
   new **live price IDs** (`price_...`). These replace your sandbox price IDs.
3. **Get live API keys**: Dashboard → Developers → API keys → copy the **live**
   `sk_live_...` secret key.
4. **Create a live webhook endpoint**: Dashboard → Developers → Webhooks → Add endpoint:
   - URL: `https://<your-prod-domain>/api/stripe-webhook`
   - Events to send:
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
   - After creating, copy the **live signing secret** (`whsec_...`).
5. **Confirm metadata**: our webhook reads `tenantId` from subscription/session
   `metadata`. `create-checkout-session.js` already sets it on the customer and should
   pass it to the subscription — verify on a live test that `metadata.tenantId` is
   present on the subscription object (Stripe → the test subscription → Metadata).
6. **(Recommended)** Configure the **Customer Portal** (Billing → Customer portal) and
   enable Radar / tax settings in live mode if you use them.

### Update environment variables (Vercel → Project → Settings → Environment Variables)
Set these to the **live** values (Production environment):

| Variable | Sandbox → Live |
|----------|----------------|
| `STRIPE_SECRET_KEY` | `sk_test_...` → `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | test `whsec_...` → **live** `whsec_...` (from the live endpoint) |
| `STRIPE_PRICE_RETAIL` | test price → **live** `price_...` |
| `STRIPE_PRICE_PRO` | test price → **live** `price_...` |
| `STRIPE_PRICE_INSTITUTIONAL` | test price → **live** `price_...` |
| `NEXT_PUBLIC_SITE_URL` | confirm = your production URL (used for success/cancel redirects) |

Then **redeploy** so the new env vars take effect.

### Smoke test in live mode
- Start a checkout for each tier → confirm a real subscription is created.
- Confirm `subscriptions` + `tenants.subscription_active` update via the webhook.
- Cancel a test live subscription → confirm `strategy_config.is_active` flips to `false`
  for that tenant (this validates the new cancellation enforcement).

---

## 3. Other environment variables touched by this release

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `DEMO_TENANT_ID` *(new, optional)* | Server-only demo tenant id for `/api/demo-feed`. If unset, the endpoint falls back to `NEXT_PUBLIC_DEMO_TENANT_ID`. | Optional |
| `NEXT_PUBLIC_DEMO_TENANT_ID` | Existing — still used as fallback by `/api/demo-feed`. Value: `fc1cfe61-6bd7-49a8-8f36-e0712d67034b`. | Keep |
| `MASTER_ENCRYPTION_KEY` | Already required for LIVE API key decryption. | Keep |

> The demo page no longer reads Supabase directly (RLS blocked it). It now polls the
> service-role `/api/demo-feed` endpoint, so the demo will populate again as long as the
> demo tenant has rows in `agent_session_logs` / `trade_logs` / `strategy_config`.
