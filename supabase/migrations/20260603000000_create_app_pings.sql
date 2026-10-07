create extension if not exists pgcrypto;

create table if not exists public.app_pings (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null,
  app_version text not null default 'unknown',
  platform text not null default 'unknown',
  os_version text not null default 'unknown',
  day date not null default (now() at time zone 'utc')::date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (device_hash, day)
);

alter table public.app_pings enable row level security;

create index if not exists app_pings_day_idx on public.app_pings (day);
create index if not exists app_pings_device_idx on public.app_pings (device_hash);

create or replace function public.metrics_active_snapshot(days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (now() at time zone 'utc')::date as today
  ),
  daily as (
    select p.day, count(distinct p.device_hash)::int as devices
    from public.app_pings p, bounds b
    where p.day >= b.today - (greatest(days, 1) - 1)
      and p.day <= b.today
    group by p.day
    order by p.day
  ),
  platforms as (
    select platform, count(distinct device_hash)::int as devices
    from public.app_pings
    group by platform
  ),
  versions as (
    select app_version, count(distinct device_hash)::int as devices
    from public.app_pings
    group by app_version
  )
  select jsonb_build_object(
    'dau', (select count(distinct device_hash)::int from public.app_pings, bounds where day = b.today),
    'wau', (select count(distinct device_hash)::int from public.app_pings, bounds where day >= b.today - 6),
    'mau', (select count(distinct device_hash)::int from public.app_pings, bounds where day >= b.today - 29),
    'total_devices', (select count(distinct device_hash)::int from public.app_pings),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', day, 'devices', devices) order by day), '[]'::jsonb)
      from daily
    ),
    'by_platform', (select coalesce(jsonb_object_agg(platform, devices), '{}'::jsonb) from platforms),
    'by_version', (select coalesce(jsonb_object_agg(app_version, devices), '{}'::jsonb) from versions)
  );
$$;

grant execute on function public.metrics_active_snapshot(integer) to anon, authenticated, service_role;
