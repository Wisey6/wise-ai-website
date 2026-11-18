-- Google Drive as a second Files provider (the business's Google Workspace account).
-- Additive: the OneDrive tables and functions from 0010 stay as they are (dormant until
-- Microsoft is set up). Links and the change log are shared and gain a provider column.

alter table public.file_links add column provider text not null default 'onedrive'
  check (provider in ('onedrive','gdrive'));
alter table public.file_changes add column provider text not null default 'onedrive'
  check (provider in ('onedrive','gdrive'));
create index file_changes_provider_idx on public.file_changes (provider, at desc);

-- One Google connection for the whole business. API-inaccessible (private schema).
create table private.gdrive_connection (
  id int primary key default 1 check (id = 1),
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  root_id text,
  account_name text,
  account_email text,
  scope text,
  connected_by uuid references public.team_members(id) on delete set null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  needs_reconnect boolean not null default false,
  last_error text
);
alter table private.gdrive_connection enable row level security;

create or replace function public.gdrive_get() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(c) from private.gdrive_connection c where id = 1;
$$;

-- Insert (a fresh sign-in, marked by connected_at) or patch the connection.
create or replace function public.gdrive_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.gdrive_connection%rowtype;
begin
  if coalesce(p->>'refresh_token', '') <> '' and p ? 'connected_at' then
    insert into private.gdrive_connection (id, refresh_token, access_token, access_expires_at, root_id,
      account_name, account_email, scope, connected_by, connected_at, updated_at, needs_reconnect, last_error)
    values (1, p->>'refresh_token', p->>'access_token', (p->>'access_expires_at')::timestamptz, p->>'root_id',
      p->>'account_name', p->>'account_email', p->>'scope', (p->>'connected_by')::uuid, now(), now(), false, null)
    on conflict (id) do update set
      refresh_token = excluded.refresh_token, access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at, root_id = excluded.root_id,
      account_name = excluded.account_name, account_email = excluded.account_email, scope = excluded.scope,
      connected_by = excluded.connected_by, connected_at = now(), updated_at = now(),
      needs_reconnect = false, last_error = null
    returning * into r;
  else
    update private.gdrive_connection set
      refresh_token = coalesce(nullif(p->>'refresh_token', ''), refresh_token),
      access_token = case when p ? 'access_token' then p->>'access_token' else access_token end,
      access_expires_at = case when p ? 'access_expires_at' then (p->>'access_expires_at')::timestamptz else access_expires_at end,
      root_id = coalesce(p->>'root_id', root_id),
      needs_reconnect = coalesce((p->>'needs_reconnect')::boolean, needs_reconnect),
      last_error = case when p ? 'last_error' then left(p->>'last_error', 300) else last_error end,
      updated_at = now()
    where id = 1
    returning * into r;
  end if;
  return jsonb_build_object('ok', r.id is not null);
end;
$$;

create or replace function public.gdrive_clear() returns void
language sql security definer set search_path = '' as $$
  delete from private.gdrive_connection where id = 1;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.gdrive_get()', 'public.gdrive_save(jsonb)', 'public.gdrive_clear()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
