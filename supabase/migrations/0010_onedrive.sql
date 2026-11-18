-- OneDrive: a live window onto the business's OneDrive (a personal Microsoft
-- account), read through Microsoft Graph each time. Nothing is copied here
-- except what the hub itself adds: links between files and records, and a log
-- of every move, rename and new folder so each one can be undone.
--
-- The Microsoft sign-in (refresh token, cached access token, account name) lives
-- in the private schema, which the API cannot reach. Only the `onedrive` edge
-- function (service role) reads or writes it, through the functions below.

-- One connection for the whole business.
create table private.onedrive_connection (
  id int primary key default 1 check (id = 1),
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  drive_id text,
  root_id text,
  account_name text,
  account_email text,
  connected_by uuid references public.team_members(id) on delete set null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  needs_reconnect boolean not null default false,
  last_error text
);
alter table private.onedrive_connection enable row level security;

-- Each sign-in attempt's one-time number, so a callback can be used only once.
create table private.onedrive_oauth_nonces (
  nonce text primary key,
  used_at timestamptz not null default now()
);
alter table private.onedrive_oauth_nonces enable row level security;

-- The whole connection row (tokens included). Service role only.
create or replace function public.onedrive_get() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(c) from private.onedrive_connection c where id = 1;
$$;

-- Insert or patch the connection. Keys not present in p are left as they are.
create or replace function public.onedrive_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.onedrive_connection%rowtype;
begin
  if p ? 'refresh_token' and coalesce(p->>'refresh_token', '') <> '' and p ? 'connected_at' then
    -- A fresh sign-in replaces everything.
    insert into private.onedrive_connection (id, refresh_token, access_token, access_expires_at, drive_id, root_id,
      account_name, account_email, connected_by, connected_at, updated_at, needs_reconnect, last_error)
    values (1, p->>'refresh_token', p->>'access_token', (p->>'access_expires_at')::timestamptz, p->>'drive_id', p->>'root_id',
      p->>'account_name', p->>'account_email', (p->>'connected_by')::uuid, now(), now(), false, null)
    on conflict (id) do update set
      refresh_token = excluded.refresh_token, access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at, drive_id = excluded.drive_id, root_id = excluded.root_id,
      account_name = excluded.account_name, account_email = excluded.account_email,
      connected_by = excluded.connected_by, connected_at = now(), updated_at = now(),
      needs_reconnect = false, last_error = null
    returning * into r;
  else
    update private.onedrive_connection set
      refresh_token = coalesce(nullif(p->>'refresh_token', ''), refresh_token),
      access_token = case when p ? 'access_token' then p->>'access_token' else access_token end,
      access_expires_at = case when p ? 'access_expires_at' then (p->>'access_expires_at')::timestamptz else access_expires_at end,
      drive_id = coalesce(p->>'drive_id', drive_id),
      root_id = coalesce(p->>'root_id', root_id),
      account_name = coalesce(p->>'account_name', account_name),
      needs_reconnect = coalesce((p->>'needs_reconnect')::boolean, needs_reconnect),
      last_error = case when p ? 'last_error' then left(p->>'last_error', 300) else last_error end,
      updated_at = now()
    where id = 1
    returning * into r;
  end if;
  return jsonb_build_object('ok', r.id is not null);
end;
$$;

create or replace function public.onedrive_clear() returns void
language sql security definer set search_path = '' as $$
  delete from private.onedrive_connection where id = 1;
$$;

-- true the first time a nonce is seen, false after. Old nonces are tidied away.
create or replace function public.onedrive_use_nonce(p_nonce text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_nonce is null or length(p_nonce) < 16 or length(p_nonce) > 128 then return false; end if;
  delete from private.onedrive_oauth_nonces where used_at < now() - interval '1 day';
  insert into private.onedrive_oauth_nonces (nonce) values (p_nonce) on conflict do nothing;
  return found;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.onedrive_get()', 'public.onedrive_save(jsonb)', 'public.onedrive_clear()',
    'public.onedrive_use_nonce(text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- A OneDrive file or folder linked to a client, project, deal or lead.
create table public.file_links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  item_id text not null check (char_length(item_id) between 1 and 200),
  name text not null default '',
  web_url text,
  mime text,
  is_folder boolean not null default false,
  kind text not null check (kind in ('client','project','deal','lead')),
  record_id uuid not null,
  created_by uuid references public.team_members(id) on delete set null,
  unique (item_id, kind, record_id)
);
create index file_links_record_idx on public.file_links (kind, record_id);
create index file_links_item_idx on public.file_links (item_id);

-- Every move, rename and new folder made from the hub (or by the assistant), with
-- the before and after so it can be undone. There is no delete.
create table public.file_changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  item_id text not null,
  op text not null check (op in ('move','rename','create_folder')),
  before jsonb,
  after jsonb,
  summary text not null default '',
  member_id uuid references public.team_members(id) on delete set null,
  source text not null default 'hub' check (source in ('hub','assistant')),
  chat_id uuid references public.agent_chats(id) on delete set null,
  undone_at timestamptz,
  undone_by uuid references public.team_members(id) on delete set null
);
create index file_changes_at_idx on public.file_changes (at desc);
create index file_changes_item_idx on public.file_changes (item_id, at desc);

do $$
declare t text;
begin
  foreach t in array array['file_links','file_changes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('create policy operator_read on public.%I for select to authenticated using ((select public.is_operator()))', t);
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;
