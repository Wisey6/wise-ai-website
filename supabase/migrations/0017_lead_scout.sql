-- The lead scout: on a schedule (or when asked) the assistant searches the web for local businesses
-- that fit the owner's brief and puts what it finds in a review queue. Nothing becomes a lead and
-- nobody is contacted until the owner approves each candidate (in the hub, or from the emailed
-- digest). 10-80-10: the owner sets the brief, the scout does the searching, the owner approves.

-- ------------------------------------------------------------------ direction (settings)
alter table public.settings
  add column if not exists scout_enabled boolean not null default false,
  add column if not exists scout_brief text,
  add column if not exists scout_daily_max int not null default 10 check (scout_daily_max between 1 and 30),
  add column if not exists scout_days int[] not null default '{1,2,3,4,5}',      -- ISO weekday, 1 = Monday
  add column if not exists scout_hour int not null default 7 check (scout_hour between 0 and 23),  -- local
  add column if not exists scout_monthly_cap_usd numeric not null default 10 check (scout_monthly_cap_usd between 0 and 100);

-- New lead source, run kind and proposal kind.
alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('import','manual','website','booking','inbound_sms','scout'));
alter table public.agent_runs drop constraint if exists agent_runs_agent_check;
alter table public.agent_runs add constraint agent_runs_agent_check
  check (agent in ('researcher','briefing','ask','doer','chat','scout'));
alter table public.agent_actions drop constraint if exists agent_actions_kind_check;
alter table public.agent_actions add constraint agent_actions_kind_check check (kind in (
  'lead.set_status','lead.set_followup','lead.set_hook','note.add',
  'task.create','deal.create','deal.update','message.draft','invoice.draft','lead.add'));

-- ------------------------------------------------------------------ the review queue
create table if not exists public.lead_candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id uuid references public.agent_runs(id) on delete set null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','expired')),
  business text not null check (char_length(business) between 1 and 160),
  suburb text,
  industry text,
  website text,
  website_host text,                         -- normalised host, for de-duplication
  phone text not null,                       -- E.164 (+61...), published by the business itself
  phone_kind text not null default 'other' check (phone_kind in ('mobile','landline','other')),
  number_source_url text not null,           -- the public page where that number is published
  contact_first_name text,                   -- only when published
  observations jsonb not null default '[]',  -- [{text, source_url}], 1-3
  hook text check (hook is null or char_length(hook) <= 140),
  pain text,
  est_monthly_value numeric check (est_monthly_value is null or (est_monthly_value >= 0 and est_monthly_value <= 100000)),
  value_reasoning text,
  first_text text,                           -- a suggested first SMS (proposed as a draft only after approval)
  score int not null default 50 check (score between 0 and 100),
  score_reason text,
  name_key text not null,                    -- normalised business name (+ suburb), for de-duplication
  decided_at timestamptz,
  decided_by uuid references public.team_members(id) on delete set null,
  decided_via text check (decided_via in ('hub','email','chat','system')),
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 300),
  lead_id uuid references public.leads(id) on delete set null,
  action_id uuid references public.agent_actions(id) on delete set null,
  expires_at timestamptz not null default now() + interval '14 days'
);
create index if not exists lead_candidates_status_idx on public.lead_candidates (status, created_at desc);
create index if not exists lead_candidates_phone_idx on public.lead_candidates (phone);
create index if not exists lead_candidates_host_idx on public.lead_candidates (website_host) where website_host is not null;
create index if not exists lead_candidates_run_idx on public.lead_candidates (run_id);

alter table public.lead_candidates enable row level security;
revoke all on public.lead_candidates from anon;
revoke insert, update, delete, truncate, references, trigger on public.lead_candidates from authenticated;
drop policy if exists operator_read on public.lead_candidates;
create policy operator_read on public.lead_candidates for select to authenticated using ((select public.is_operator()));
alter publication supabase_realtime add table public.lead_candidates;

-- Rejecting the hub card (agent_actions 'lead.add', the existing Reject button) rejects the candidate too.
create or replace function public.lead_candidate_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'lead.add' and new.status = 'rejected' and old.status = 'proposed' then
    update public.lead_candidates
       set status = 'rejected', decided_at = now(), decided_via = coalesce(decided_via, 'hub'),
           decided_by = coalesce(decided_by, public.current_member())
     where action_id = new.id and status = 'proposed';
  end if;
  return new;
end; $$;
drop trigger if exists agent_actions_candidate_sync on public.agent_actions;
create trigger agent_actions_candidate_sync after update of status on public.agent_actions
  for each row execute function public.lead_candidate_sync();

-- ------------------------------------------------------------------ private state (service role only)
-- One row per local day the schedule ran (claimed atomically, so a day runs once).
create table if not exists private.scout_days (
  day date primary key,
  claimed_at timestamptz not null default now(),
  batches int not null default 0,
  found int not null default 0,
  running_since timestamptz,
  done boolean not null default false,
  emailed_at timestamptz
);
-- Signed, single-use, expiring email links. The token is "<id>.<hmac>"; this row makes it single use.
create table if not exists private.scout_links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  action text not null check (action in ('approve','skip','approve_all')),
  candidate_id uuid,                         -- approve / skip
  run_id uuid,                               -- approve_all: every still-proposed candidate of this run
  member_id uuid not null,                   -- who the link was sent to (the approver)
  used_at timestamptz,
  result jsonb
);
alter table private.scout_days enable row level security;
alter table private.scout_links enable row level security;

-- Secrets live in Vault, created here with random values (never in this repo).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'scout_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'scout_cron_secret', 'Lead scout: header the schedule sends to the agent function');
  end if;
  if not exists (select 1 from vault.secrets where name = 'scout_link_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'scout_link_key', 'Lead scout: HMAC key for emailed approve/skip links');
  end if;
end $$;

-- The two scout secrets, for the agent function (service role only).
create or replace function public.scout_secret(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_name and p_name in ('scout_cron_secret', 'scout_link_key') limit 1;
$$;

-- The owner's address for the digest (the same one PIN resets use), service role only.
create or replace function public.scout_owner_contact() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('member_id', m.id, 'name', m.name, 'email', nullif(o.contact_email, ''))
    from public.team_members m left join private.operators o on o.member_id = m.id
   where m.role = 'owner' and m.active
   order by m.created_at limit 1;
$$;

-- Claim today's scheduled run (true once per local day per batch slot; false if one is running).
create or replace function public.scout_claim_day(p_day date, p_max_batches int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d private.scout_days%rowtype;
begin
  insert into private.scout_days (day) values (p_day) on conflict (day) do nothing;
  select * into d from private.scout_days where day = p_day for update;
  if d.done then return jsonb_build_object('ok', false, 'why', 'done', 'found', d.found, 'emailed_at', d.emailed_at); end if;
  if d.running_since is not null and d.running_since > now() - interval '4 minutes' then
    return jsonb_build_object('ok', false, 'why', 'running');
  end if;
  if d.batches >= p_max_batches then return jsonb_build_object('ok', false, 'why', 'batches'); end if;
  update private.scout_days set running_since = now(), batches = batches + 1 where day = p_day;
  return jsonb_build_object('ok', true, 'batch', d.batches + 1, 'found', d.found);
end; $$;

create or replace function public.scout_finish_day(p_day date, p_found int, p_done boolean, p_emailed boolean) returns void
language sql security definer set search_path = '' as $$
  update private.scout_days
     set running_since = null, found = found + greatest(p_found, 0), done = done or p_done,
         emailed_at = case when p_emailed then now() else emailed_at end
   where day = p_day;
$$;

create or replace function public.scout_link_create(p_action text, p_candidate uuid, p_run uuid, p_member uuid) returns uuid
language sql security definer set search_path = '' as $$
  insert into private.scout_links (action, candidate_id, run_id, member_id) values (p_action, p_candidate, p_run, p_member) returning id;
$$;

create or replace function public.scout_link_get(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(l) from private.scout_links l where l.id = p_id;
$$;

-- Use a link once: returns the row only if it was unused and unexpired (atomic).
create or replace function public.scout_link_use(p_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  update private.scout_links set used_at = now()
   where id = p_id and used_at is null and expires_at > now()
  returning to_jsonb(private.scout_links.*);
$$;

create or replace function public.scout_link_result(p_id uuid, p_result jsonb) returns void
language sql security definer set search_path = '' as $$
  update private.scout_links set result = p_result where id = p_id;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.scout_secret(text)', 'public.scout_owner_contact()', 'public.scout_claim_day(date, int)',
    'public.scout_finish_day(date, int, boolean, boolean)', 'public.scout_link_create(text, uuid, uuid, uuid)',
    'public.scout_link_get(uuid)', 'public.scout_link_use(uuid)', 'public.scout_link_result(uuid, jsonb)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function public.lead_candidate_sync() from public, anon, authenticated;

-- ------------------------------------------------------------------ the schedule
-- pg_cron calls the agent function every 10 minutes with the Vault secret in a header; the function
-- decides whether today is a scout day, the local hour has come, the switch is on and the budget
-- allows, and runs at most one batch per call (claimed above, so each day runs once).
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lead-scout') then perform cron.unschedule('lead-scout'); end if;
  perform cron.schedule('lead-scout', '*/10 * * * *', $job$
    select net.http_post(
      url := 'https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/agent',
      headers := jsonb_build_object('content-type', 'application/json',
        'x-scout-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scout_cron_secret')),
      body := '{"agent":"scout","trigger":"schedule"}'::jsonb,
      timeout_milliseconds := 150000)
  $job$);
end $$;
