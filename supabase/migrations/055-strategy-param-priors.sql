-- Migration 055: strategy_param_priors — measured per-regime param priors (PUSH AM51).
--
-- After each backtest run, one row per regime is upserted from the run's
-- regime_breakdown + effective_parameters. The chat tool readParamPriors reads
-- these back as CONTEXT for tuning proposals (never a veto authority).
--
-- Gating doctrine: same as 052/053 — tenant-scoped RLS; service-role APIs
-- bypass RLS and derive tenant_id server-side from the session.
--
-- NOTE: the version column is `regime_proxy_version` (the value the backtester
-- already emits and studio_runs already stores), NOT `classifier_version`.

create table if not exists strategy_param_priors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  library_id uuid references strategy_library(id) on delete cascade,
  regime text not null,
  params jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  n integer not null default 0,
  source text not null default 'backtest',
  regime_proxy_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, library_id, regime, regime_proxy_version, source)
);

create index if not exists idx_strategy_param_priors_lookup
  on strategy_param_priors (tenant_id, library_id, regime, regime_proxy_version);

alter table strategy_param_priors enable row level security;

drop policy if exists "tenant reads own strategy_param_priors" on strategy_param_priors;
create policy "tenant reads own strategy_param_priors" on strategy_param_priors
  for select using (
    tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
  );
