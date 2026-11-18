-- Gmail for the assistant: each team member may connect their OWN mailbox (read, and write
-- drafts that only the person sends). Separate from the business Google Drive connection.
--
-- private.gmail_connection: one row per member, API-inaccessible, reached only through the
--   service-role functions gmail_get / gmail_save / gmail_clear / gmail_email_in_use.
-- public.mail_drafts: the drafts the assistant wrote for a member (addresses and subject only,
--   never the body). Readable by its owner only; written only by the functions (service role).

create table private.gmail_connection (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  email text,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  scope text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  needs_reconnect boolean not null default false,
  last_error text
);
alter table private.gmail_connection enable row level security;

create or replace function public.gmail_get(p_member uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(c) from private.gmail_connection c where member_id = p_member;
$$;

-- Insert (a fresh sign-in, marked by connected_at) or patch one member's connection.
create or replace function public.gmail_save(p_member uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.gmail_connection%rowtype;
begin
  if p_member is null then return jsonb_build_object('ok', false); end if;
  if coalesce(p->>'refresh_token', '') <> '' and p ? 'connected_at' then
    insert into private.gmail_connection (member_id, email, refresh_token, access_token, access_expires_at, scope,
      connected_at, updated_at, needs_reconnect, last_error)
    values (p_member, p->>'email', p->>'refresh_token', p->>'access_token', (p->>'access_expires_at')::timestamptz,
      p->>'scope', now(), now(), false, null)
    on conflict (member_id) do update set
      email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at, scope = excluded.scope, connected_at = now(),
      updated_at = now(), needs_reconnect = false, last_error = null
    returning * into r;
  else
    update private.gmail_connection set
      refresh_token = coalesce(nullif(p->>'refresh_token', ''), refresh_token),
      access_token = case when p ? 'access_token' then p->>'access_token' else access_token end,
      access_expires_at = case when p ? 'access_expires_at' then (p->>'access_expires_at')::timestamptz else access_expires_at end,
      needs_reconnect = coalesce((p->>'needs_reconnect')::boolean, needs_reconnect),
      last_error = case when p ? 'last_error' then left(p->>'last_error', 300) else last_error end,
      updated_at = now()
    where member_id = p_member
    returning * into r;
  end if;
  return jsonb_build_object('ok', r.member_id is not null);
end;
$$;

create or replace function public.gmail_clear(p_member uuid) returns void
language sql security definer set search_path = '' as $$
  delete from private.gmail_connection where member_id = p_member;
$$;

-- Is this Google address connected for Gmail by anyone other than p_except? (No address is returned.)
create or replace function public.gmail_email_in_use(p_email text, p_except uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.gmail_connection
    where lower(email) = lower(p_email) and (p_except is null or member_id <> p_except));
$$;

do $$
declare f text;
begin
  foreach f in array array['public.gmail_get(uuid)', 'public.gmail_save(uuid, jsonb)', 'public.gmail_clear(uuid)',
    'public.gmail_email_in_use(text, uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Drafts the assistant wrote. No body is stored. Sending happens only from the hub, when the
-- person presses Send (gdrive function action mail_send), never from the assistant.
create table public.mail_drafts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  chat_id uuid references public.agent_chats(id) on delete set null,
  gmail_draft_id text not null check (char_length(gmail_draft_id) between 1 and 200),
  gmail_draft_message_id text,
  thread_id text,
  reply_to_message_id text,
  is_reply boolean not null default false,
  to_addrs text[] not null default '{}',
  cc_addrs text[] not null default '{}',
  subject text not null default '' check (char_length(subject) <= 300),
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  gmail_message_id text,
  discarded_at timestamptz,
  unique (member_id, gmail_draft_id)
);
create index mail_drafts_member_idx on public.mail_drafts (member_id, created_at desc);
create index mail_drafts_sent_idx on public.mail_drafts (member_id, sent_at) where sent_at is not null;

alter table public.mail_drafts enable row level security;
revoke all on public.mail_drafts from anon;
revoke insert, update, delete, truncate, references, trigger on public.mail_drafts from authenticated;
create policy own_mail_drafts on public.mail_drafts for select to authenticated
  using ((select public.is_operator()) and member_id = (select public.current_member()));
alter publication supabase_realtime add table public.mail_drafts;
