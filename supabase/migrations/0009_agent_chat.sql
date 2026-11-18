-- The conversational agent: saved chats, long-term memory, and a record of every
-- change it makes so each one can be undone.
alter table public.agent_runs drop constraint agent_runs_agent_check;
alter table public.agent_runs add constraint agent_runs_agent_check
  check (agent in ('researcher','briefing','ask','doer','chat'));

alter table public.settings
  add column agent_chat boolean not null default true,
  add column agent_chat_model text not null default 'claude-sonnet-5-5'
    check (agent_chat_model in ('claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5'));

create table public.agent_chats (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  title text not null default 'New conversation',
  archived boolean not null default false
);
create index agent_chats_member_idx on public.agent_chats (member_id, updated_at desc);

create table public.agent_chat_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.agent_chats(id) on delete cascade,
  at timestamptz not null default now(),
  role text not null check (role in ('user','assistant')),
  text text not null default '',
  steps jsonb not null default '[]',        -- what it looked up and what it changed, for display
  links jsonb not null default '[]',        -- [{label, hash}] hub links offered with the answer
  model text,
  cost_usd numeric not null default 0
);
create index agent_chat_messages_chat_idx on public.agent_chat_messages (chat_id, id);

-- Things the agent has been told to remember. member_id null = true for the whole business.
create table public.agent_memory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  member_id uuid references public.team_members(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  source_chat_id uuid references public.agent_chats(id) on delete set null,
  active boolean not null default true
);

-- Every record the agent creates or edits, with the before and after, so it can be undone.
create table public.agent_changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  chat_id uuid references public.agent_chats(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,
  member_id uuid references public.team_members(id) on delete set null,
  table_name text not null,
  row_id uuid not null,
  op text not null check (op in ('insert','update')),
  before jsonb,
  after jsonb,
  summary text not null,
  undone_at timestamptz
);
create index agent_changes_chat_idx on public.agent_changes (chat_id, at);

do $$
declare t text;
begin
  foreach t in array array['agent_chats','agent_chat_messages','agent_memory','agent_changes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;

-- A person sees their own conversations; the function (service role) writes them.
create policy own_chats on public.agent_chats for select to authenticated
  using ((select public.is_operator()) and member_id = (select public.current_member()));
create policy own_chat_messages on public.agent_chat_messages for select to authenticated
  using ((select public.is_operator()) and exists (
    select 1 from public.agent_chats c where c.id = chat_id and c.member_id = (select public.current_member())));
-- Memory: your own notes and the shared ones. Changes are visible to everyone signed in.
create policy read_memory on public.agent_memory for select to authenticated
  using ((select public.is_operator()) and (member_id is null or member_id = (select public.current_member())));
create policy read_changes on public.agent_changes for select to authenticated
  using ((select public.is_operator()));
