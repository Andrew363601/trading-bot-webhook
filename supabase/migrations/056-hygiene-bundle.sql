-- Migration 056: hygiene bundle (PUSH AM52i).
--
-- 1. Normalize tenant_users.role to the allowed set, then add a CHECK.
--    Allowed set is ADMIN/TRADER/TRIAL (VIEWER is unused in the codebase).
--    NULL and any out-of-set value (including lowercase 'trader') -> 'TRIAL'.
-- 2. scan_results.evaluated_bar_time — newest CLOSED trigger-TF bar open time
--    (pairs with AM52g dedup). Nullable; the sniper writes it going forward.

-- ── 1. tenant_users.role ──
-- Print the distinct values first (visible in the migration log).
do $$
declare
  r record;
begin
  raise notice 'tenant_users.role distinct values:';
  for r in select distinct role from tenant_users loop
    raise notice '  %', coalesce(r.role, '<NULL>');
  end loop;
end $$;

-- Normalize: uppercase, then map anything outside the allowed set to TRIAL.
update tenant_users
set role = 'TRIAL'
where role is null
   or upper(role) not in ('ADMIN', 'TRADER', 'TRIAL');

update tenant_users
set role = upper(role)
where role is not null
  and role <> upper(role)
  and upper(role) in ('ADMIN', 'TRADER', 'TRIAL');

alter table tenant_users drop constraint if exists role_allowed;
alter table tenant_users
  add constraint role_allowed check (role in ('ADMIN', 'TRADER', 'TRIAL'));

-- ── 2. scan_results.evaluated_bar_time ──
alter table scan_results
  add column if not exists evaluated_bar_time timestamptz;

create index if not exists idx_scan_results_evaluated_bar_time
  on scan_results (tenant_id, asset, evaluated_bar_time desc);
