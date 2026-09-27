-- Migration 052: Strategy Studio library: tenant-owned strategy source, versioned.
--
-- Gating doctrine: Access governed by tenants.billing_tier in ('PRO','ENTERPRISE','INSTITUTIONAL','ADMIN').
-- APIs enforce the gate server-side; client reads direct via RLS see own rows or public rows.

create table if not exists strategy_library (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  display_name text,
  description text,
  code text not null,
  version integer not null default 1,
  visibility text not null default 'private'
    check (visibility in ('private','public')),
  status text not null default 'draft'
    check (status in ('draft','backtested','live','archived')),
  latest_backtest jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists strategy_library_versions (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references strategy_library(id) on delete cascade,
  version integer not null,
  code text not null,
  change_note text,
  created_at timestamptz not null default now(),
  unique (library_id, version)
);

-- Enable RLS; mirror the convention used across tenant-scoped tables:
-- direct client reads see own rows (or public rows for library), service-role APIs bypass RLS.
alter table strategy_library enable row level security;
alter table strategy_library_versions enable row level security;

-- Drop existing policies if any
drop policy if exists "tenant reads own library rows or public" on strategy_library;
create policy "tenant reads own library rows or public" on strategy_library
  for select using (
    tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
    or visibility = 'public'
  );

drop policy if exists "tenant writes own library rows" on strategy_library;
create policy "tenant writes own library rows" on strategy_library
  for all using (
    tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
  ) with check (
    tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
  );

drop policy if exists "tenant reads own library version rows" on strategy_library_versions;
create policy "tenant reads own library version rows" on strategy_library_versions
  for select using (
    library_id in (
      select id from strategy_library
      where tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
         or visibility = 'public'
    )
  );

drop policy if exists "tenant writes own library version rows" on strategy_library_versions;
create policy "tenant writes own library version rows" on strategy_library_versions
  for all using (
    library_id in (
      select id from strategy_library
      where tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
    )
  ) with check (
    library_id in (
      select id from strategy_library
      where tenant_id in (select tenant_id from tenant_users where auth_user_id = auth.uid())
    )
  );

create index if not exists idx_strategy_library_tenant on strategy_library(tenant_id);
create index if not exists idx_strategy_library_public on strategy_library(visibility)
  where visibility = 'public';
create index if not exists idx_strategy_library_versions_lib on strategy_library_versions(library_id);
