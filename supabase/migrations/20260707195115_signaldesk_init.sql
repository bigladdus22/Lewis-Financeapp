-- tradingbot.ai initial schema: profiles, api_keys, usage, signals, RLS, helpers
-- (already applied to production ogvhprlgugrpzrocmqft; tracked here for CI/CD)

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  paid       boolean not null default false,
  paid_at    timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  key_prefix   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false,
  unique (user_id, name)
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);

create table if not exists public.api_key_usage (
  key_id        uuid not null references public.api_keys(id) on delete cascade,
  minute_bucket timestamptz not null,
  request_count integer not null default 0,
  primary key (key_id, minute_bucket)
);

create table if not exists public.signals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  ticker       text not null,
  signal       text not null check (signal in ('buy','sell','hold')),
  confidence   numeric(4,3) not null check (confidence between 0 and 1),
  rationale    text,
  generated_at timestamptz not null default now()
);
create index if not exists signals_user_time_idx on public.signals (user_id, generated_at desc);

alter table public.profiles      enable row level security;
alter table public.api_keys      enable row level security;
alter table public.api_key_usage enable row level security;
alter table public.signals       enable row level security;

create policy "own profile: select" on public.profiles
  for select using (auth.uid() = id);
create policy "own keys: select" on public.api_keys
  for select using (auth.uid() = user_id);
create policy "own keys: update" on public.api_keys
  for update using (auth.uid() = user_id);
create policy "own keys: delete" on public.api_keys
  for delete using (auth.uid() = user_id);
create policy "own signals: select" on public.signals
  for select using (auth.uid() = user_id);
create policy "own signals: insert" on public.signals
  for insert with check (auth.uid() = user_id);

create or replace function public.create_api_key(key_name text)
returns text language plpgsql security definer set search_path = public as $$
declare full_key text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  full_key := 'fd_live_' || encode(gen_random_bytes(18), 'hex');
  insert into public.api_keys (user_id, name, key_hash, key_prefix)
  values (auth.uid(), key_name,
          encode(digest(full_key, 'sha256'), 'hex'),
          'fd_live_…' || right(full_key, 4));
  return full_key;
end; $$;
revoke all on function public.create_api_key(text) from anon;
grant execute on function public.create_api_key(text) to authenticated;

create or replace function public.increment_usage(p_key_id uuid, p_bucket timestamptz)
returns integer language sql security definer set search_path = public as $$
  insert into public.api_key_usage (key_id, minute_bucket, request_count)
  values (p_key_id, p_bucket, 1)
  on conflict (key_id, minute_bucket)
  do update set request_count = api_key_usage.request_count + 1
  returning request_count;
$$;
revoke all on function public.increment_usage(uuid, timestamptz) from anon, authenticated;

create or replace function public.activate_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.profiles set paid = true, paid_at = now() where id = auth.uid();
end; $$;
revoke all on function public.activate_account() from anon;
grant execute on function public.activate_account() to authenticated;
