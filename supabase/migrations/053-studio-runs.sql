-- Migration 053: Studio Episode Theater per-run persistence (PUSH AM52a).
--
-- backtest_results stores summary columns only (win_rate, pnl_percent, ...).
-- The rich per-run shapes the theater replays (trades w/ regime, equity curve,
-- trigger candles, params, regime_breakdown) are persisted here, one row per
-- run, so the feed can serve the tenant's N most recent runs.
--
-- NOTE: the window column is named `run_window` (not `window`) because WINDOW
-- is a reserved keyword in PostgreSQL and would require quoting everywhere.
--
-- Gating doctrine: same as migration 052 — tenant-scoped RLS; service-role
-- APIs bypass RLS and derive tenant_id server-side from the session.

create table if not exists studio_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid,
  created_at timestamptz not null default now(),
  product text not null,
  horizon text,
  first_close numeric,
  run_window jsonb,
  parameters jsonb,
  effective_parameters jsonb,
  summary jsonb,
  regime_breakdown jsonb,
  regime_proxy_version text,
  trades jsonb,
  equity_curve jsonb,
  trigger_candles jsonb
);

create index if not exists idx_studio_runs_tenant_created
  on studio_runs (tenant_id, created_at desc);

alter table studio_runs enable row level security;

drop policy if exists "tenant reads own studio_runs" on studio_runs;
create policy "tenant reads own studio_runs" on studio_runs
  for select using (
    tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
  );
