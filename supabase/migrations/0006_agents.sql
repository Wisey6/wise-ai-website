-- Wise AI agents: four tightly scoped assistants. They read, research, draft and
-- propose. They never send anything or change a record themselves: a proposed
-- change sits in agent_actions until the operator approves it in the hub.
alter table public.settings
  add column agents_enabled boolean not null default true,
  add column agent_monthly_cap_usd numeric not null default 25 check (agent_monthly_cap_usd >= 0 and agent_monthly_cap_usd <= 100),
  add column agent_researcher boolean not null default true,
  add column agent_briefing boolean not null default true,
  add column agent_ask boolean not null default true,
  add column agent_doer boolean not null default true;

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  agent text not null check (agent in ('researcher','briefing','ask','doer')),
  status text not null default 'ok' check (status in ('ok','error','declined','capped','empty')),
  lead_id uuid references public.leads(id) on delete set null,
  input jsonb not null default '{}',        -- what was asked (no contact details)
  output jsonb not null default '{}',       -- what came back
  sources jsonb not null default '[]',      -- pages read, for the researcher
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  searches int not null default 0,
  cost_usd numeric not null default 0,
  duration_ms int not null default 0,
  error text
);
create index agent_runs_at_idx on public.agent_runs (at desc);
create index agent_runs_lead_idx on public.agent_runs (lead_id) where lead_id is not null;

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id uuid references public.agent_runs(id) on delete cascade,
  kind text not null check (kind in (
    'lead.set_status','lead.set_followup','lead.set_hook','note.add',
    'task.create','deal.create','deal.update','message.draft','invoice.draft')),
  payload jsonb not null,
  summary text not null,                    -- one plain line shown on the approval card
  reason text,                              -- why the agent suggests it
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','applied','failed')),
  decided_at timestamptz,
  result text
);
create index agent_actions_status_idx on public.agent_actions (status, created_at desc);

alter table public.agent_runs enable row level security;
alter table public.agent_actions enable row level security;
-- Runs are written only by the agent function (service role); the operator reads them.
create policy operator_read on public.agent_runs for select to authenticated using ((select public.is_operator()));
revoke all on public.agent_runs from anon;
revoke insert, update, delete on public.agent_runs from authenticated;
-- The operator decides on proposals (approve / reject / mark applied) but cannot create them.
create policy operator_read on public.agent_actions for select to authenticated using ((select public.is_operator()));
create policy operator_decide on public.agent_actions for update to authenticated
  using ((select public.is_operator())) with check ((select public.is_operator()));
revoke all on public.agent_actions from anon;
revoke insert, delete on public.agent_actions from authenticated;

alter publication supabase_realtime add table public.agent_runs, public.agent_actions;
