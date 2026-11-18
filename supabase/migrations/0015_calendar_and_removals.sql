-- 1. The assistant can now remove records the person asks it to remove: a real delete through
--    the audited write path, with the whole row kept in agent_changes.before so Undo can put it
--    back with the same id.
alter table public.agent_changes drop constraint if exists agent_changes_op_check;
alter table public.agent_changes add constraint agent_changes_op_check check (op in ('insert', 'update', 'delete'));

-- 2. The person's own Google Calendar. Changes the assistant made to their calendar (for Undo),
--    and changes that involve guests, which wait for the person to press the button
--    (Google emails the guests). Each row belongs to one member and only they can read it;
--    only the functions (service role) write.
create table public.calendar_changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  chat_id uuid references public.agent_chats(id) on delete set null,
  event_id text not null check (char_length(event_id) between 1 and 1024),
  op text not null check (op in ('insert', 'update', 'delete')),
  before jsonb,
  after jsonb,
  summary text not null default '',
  undone_at timestamptz
);
create index calendar_changes_member_idx on public.calendar_changes (member_id, at desc);

create table public.calendar_proposals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  member_id uuid not null references public.team_members(id) on delete cascade,
  chat_id uuid references public.agent_chats(id) on delete set null,
  action text not null check (action in ('create', 'update', 'remove')),
  event_id text,
  payload jsonb not null default '{}'::jsonb,
  title text not null default '',
  when_text text not null default '',
  guests text[] not null default '{}',
  location text,
  status text not null default 'pending' check (status in ('pending', 'working', 'done', 'cancelled', 'expired')),
  done_at timestamptz,
  result_event_id text
);
create index calendar_proposals_member_idx on public.calendar_proposals (member_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['calendar_changes', 'calendar_proposals']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;
create policy own_calendar_changes on public.calendar_changes for select to authenticated
  using ((select public.is_operator()) and member_id = (select public.current_member()));
create policy own_calendar_proposals on public.calendar_proposals for select to authenticated
  using ((select public.is_operator()) and member_id = (select public.current_member()));
