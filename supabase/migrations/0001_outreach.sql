-- Wise AI HQ: outreach, lead tracking and bookings.
-- One operator. Every public table is locked to that operator by RLS; the
-- edge functions use the service role. No secrets live in this file.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------- auth state
create table private.hq_auth (
  id int primary key default 1 check (id = 1),
  pin_hash text not null,
  operator_user_id uuid,
  operator_email text not null,
  failed_count int not null default 0,
  lock_level int not null default 0,
  locked_until timestamptz
);

create table private.hq_devices (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  failed_count int not null default 0,
  lock_level int not null default 0,
  locked_until timestamptz
);

create table private.hq_login_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  known_device boolean not null,
  ip text
);

create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.hq_auth a where a.operator_user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated, service_role;

-- PIN check with lockout. A device that has logged in before carries a token
-- and is throttled on its own counter, so a stranger hammering the login from
-- elsewhere can slow down a *new* device but cannot lock out a known one.
create or replace function public.hq_verify_pin(p_pin text, p_device_token text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a private.hq_auth%rowtype;
  d private.hq_devices%rowtype;
  known boolean := false;
  good boolean;
  lock_until timestamptz;
  new_token text;
  cnt int;
  lvl int;
begin
  select * into a from private.hq_auth where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_configured');
  end if;

  if p_device_token is not null and length(p_device_token) between 32 and 128 then
    select * into d from private.hq_devices
      where token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
      for update;
    known := found;
  end if;

  lock_until := case when known then d.locked_until else a.locked_until end;
  if lock_until is not null and lock_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'retry_after_s', ceil(extract(epoch from (lock_until - now())))::int);
  end if;

  good := p_pin is not null and p_pin ~ '^[0-9]{6,12}$'
          and a.pin_hash = extensions.crypt(p_pin, a.pin_hash);

  insert into private.hq_login_log (ok, known_device, ip) values (good, known, left(p_ip, 64));

  if good then
    update private.hq_auth set failed_count = 0, lock_level = 0, locked_until = null where id = 1;
    if known then
      update private.hq_devices set failed_count = 0, lock_level = 0, locked_until = null,
        last_seen_at = now() where id = d.id;
    else
      new_token := encode(extensions.gen_random_bytes(32), 'hex');
      insert into private.hq_devices (token_hash)
        values (encode(extensions.digest(new_token, 'sha256'), 'hex'));
    end if;
    return jsonb_build_object('ok', true, 'device_token', new_token,
      'operator_email', a.operator_email);
  end if;

  if known then
    cnt := d.failed_count + 1; lvl := d.lock_level;
    if cnt >= 5 then
      update private.hq_devices set failed_count = 0, lock_level = lvl + 1,
        locked_until = now() + least(interval '1 hour', interval '5 minutes' * power(2, lvl))
        where id = d.id;
      return jsonb_build_object('ok', false, 'error', 'locked',
        'retry_after_s', least(3600, 300 * power(2, lvl))::int);
    end if;
    update private.hq_devices set failed_count = cnt where id = d.id;
  else
    cnt := a.failed_count + 1; lvl := a.lock_level;
    if cnt >= 5 then
      update private.hq_auth set failed_count = 0, lock_level = lvl + 1,
        locked_until = now() + least(interval '6 hours', interval '5 minutes' * power(2, lvl))
        where id = 1;
      return jsonb_build_object('ok', false, 'error', 'locked',
        'retry_after_s', least(21600, 300 * power(2, lvl))::int);
    end if;
    update private.hq_auth set failed_count = cnt where id = 1;
  end if;
  return jsonb_build_object('ok', false, 'error', 'bad_pin', 'remaining', 5 - cnt);
end;
$$;

create or replace function public.hq_change_pin(p_old text, p_new text, p_device_token text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if p_new is null or p_new !~ '^[0-9]{6,12}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  r := public.hq_verify_pin(p_old, p_device_token, p_ip);
  if not coalesce((r->>'ok')::boolean, false) then return r; end if;
  update private.hq_auth
    set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 11)) where id = 1;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.hq_verify_pin(text, text, text) from public, anon, authenticated;
revoke all on function public.hq_change_pin(text, text, text, text) from public, anon, authenticated;
grant execute on function public.hq_verify_pin(text, text, text) to service_role;
grant execute on function public.hq_change_pin(text, text, text, text) to service_role;

-- ------------------------------------------------------------------- tables
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  description text,
  active boolean not null default true
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  name text not null,
  step int not null default 0,           -- 0 = first touch, 1.. = follow-ups
  delay_days int not null default 0,     -- days after the previous step
  body text not null,
  active boolean not null default true
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  business text,
  contact_name text,
  phone text,                            -- E.164, e.g. +61412345678
  email text,
  website text,
  suburb text,
  industry text,
  source text not null default 'manual'
    check (source in ('import','manual','website','booking','inbound_sms')),
  number_source_url text,                -- where the number is publicly listed
  status text not null default 'new'
    check (status in ('new','queued','contacted','replied','interested','booked','won','lost','dnc')),
  campaign_id uuid references public.campaigns(id) on delete set null,
  sequence_step int not null default 0,  -- next template step to send
  last_contacted_at timestamptz,
  last_reply_at timestamptz,
  next_followup_at timestamptz,
  unread boolean not null default false,
  notes text,
  tags text[] not null default '{}',
  archived boolean not null default false
);
create unique index leads_phone_key on public.leads (phone) where phone is not null;
create index leads_status_idx on public.leads (status) where not archived;
create index leads_followup_idx on public.leads (next_followup_at) where next_followup_at is not null;
create index leads_email_idx on public.leads (lower(email)) where email is not null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  direction text not null check (direction in ('out','in')),
  channel text not null default 'sms' check (channel in ('sms','email','call','note')),
  body text not null,
  status text not null default 'sent'
    check (status in ('queued','sent','delivered','failed','received','manual')),
  provider_sid text unique,
  error text,
  template_id uuid references public.templates(id) on delete set null,
  sent_at timestamptz
);
create index messages_lead_idx on public.messages (lead_id, created_at);
create index messages_out_day_idx on public.messages (created_at) where direction = 'out' and channel = 'sms';

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid references public.leads(id) on delete set null,
  cal_uid text unique,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  attendee_name text,
  attendee_email text,
  attendee_phone text,
  status text not null default 'booked' check (status in ('booked','rescheduled','cancelled')),
  meeting_url text,
  raw jsonb
);
create index bookings_start_idx on public.bookings (starts_at);

-- Opt-outs outlive the lead record: a deleted lead must stay un-textable.
create table public.suppressions (
  phone text primary key,
  created_at timestamptz not null default now(),
  reason text not null default 'opt_out'
);

create table public.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  lead_id uuid references public.leads(id) on delete cascade,
  summary text not null
);
create index events_at_idx on public.events (at desc);

create table public.settings (
  id int primary key default 1 check (id = 1),
  sender_name text not null default 'Wise AI',
  optout_text text not null default 'Reply STOP to opt out',
  daily_cap int not null default 40 check (daily_cap between 0 and 500),
  send_start_hour int not null default 9 check (send_start_hour between 0 and 23),
  send_end_hour int not null default 17 check (send_end_hour between 1 and 24),
  send_days int[] not null default '{1,2,3,4,5}',   -- ISO weekday, 1 = Monday
  timezone text not null default 'Australia/Brisbane',
  booking_url text,
  notify_email text,
  avg_deal_value numeric not null default 3000
);
insert into public.settings (id) values (1);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['campaigns','templates','leads','messages','bookings','suppressions','events','settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy operator_all on public.%I for all to authenticated
         using ((select public.is_operator())) with check ((select public.is_operator()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

alter table private.hq_auth enable row level security;
alter table private.hq_devices enable row level security;
alter table private.hq_login_log enable row level security;

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.leads, public.messages, public.bookings, public.events;
