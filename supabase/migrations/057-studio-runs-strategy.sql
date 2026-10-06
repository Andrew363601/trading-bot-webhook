-- Migration 057: studio_runs.strategy_name (PUSH AM57c).
--
-- studio_runs had NO strategy column, so the Episode Theater feed was
-- tenant-wide: switching strategies in the Studio did not change the replay
-- feed, and provenance "Mismatch" chips tripped on foreign cards.
--
-- strategy_name records the resolved strategy_library.name at insert time
-- (lib/backtest-service.js). Legacy rows keep NULL and therefore stay visible
-- only in unscoped views (the API's ?strategy= filter is an equality match,
-- which excludes NULL).
--
-- Gating doctrine: same as 052/053 — tenant-scoped RLS; service-role APIs
-- bypass RLS and derive tenant_id server-side from the session.

alter table studio_runs
  add column if not exists strategy_name text;

create index if not exists idx_studio_runs_tenant_strategy
  on studio_runs (tenant_id, strategy_name, created_at desc);
