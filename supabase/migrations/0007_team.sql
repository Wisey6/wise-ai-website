-- Team: more than one person can sign in, each with their own PIN, and every
-- job, task, deal, client and lead can have an owner.
--
-- Everyone who can sign in sees the same hub (same data, same sections). What
-- differs is what the hub puts in front of them: their tasks, their replies.
-- Only the owner role can manage the team.

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  initials text not null,
  role text not null default 'member' check (role in ('owner','member')),
  can_sign_in boolean not null default false,   -- false = can be given work but has no login
  active boolean not null default true,
  sort int not null default 0
);
alter table public.team_members enable row level security;
revoke all on public.team_members from anon;
revoke insert, update, delete on public.team_members from authenticated;   -- managed through hq-login only

create table private.operators (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  user_id uuid not null unique,
  email text not null,
  pin_hash text not null,
  failed_count int not null default 0,
  lock_level int not null default 0,
  locked_until timestamptz
);
alter table private.operators enable row level security;

-- Carry the existing single operator across as the owner.
do $$
declare a private.hq_auth%rowtype; mid uuid;
begin
  select * into a from private.hq_auth where id = 1;
  if found then
    insert into public.team_members (name, initials, role, can_sign_in, sort)
      values ('Tyler', 'TW', 'owner', true, 0) returning id into mid;
    insert into private.operators (member_id, user_id, email, pin_hash)
      values (mid, a.operator_user_id, a.operator_email, a.pin_hash);
  end if;
end $$;

create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.operators o
    join public.team_members m on m.id = o.member_id
    where o.user_id = (select auth.uid()) and m.active and m.can_sign_in
  );
$$;

-- Who am I? The team member behind the current session.
create or replace function public.current_member() returns uuid
language sql stable security definer set search_path = '' as $$
  select o.member_id from private.operators o
  join public.team_members m on m.id = o.member_id
  where o.user_id = (select auth.uid()) and m.active and m.can_sign_in;
$$;
revoke all on function public.current_member() from public, anon;
grant execute on function public.current_member() to authenticated, service_role;

create policy operator_read on public.team_members for select to authenticated
  using ((select public.is_operator()));

-- PIN check for one named person. Same lockout as before, counted per person:
-- a device that has signed in before is throttled on its own counter, anyone
-- else on that person's counter, so guessing at Jay's PIN cannot lock Tyler out.
create or replace function public.hq_verify_pin(p_member uuid, p_pin text, p_device_token text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o private.operators%rowtype;
  m public.team_members%rowtype;
  d private.hq_devices%rowtype;
  known boolean := false;
  good boolean;
  lock_until timestamptz;
  new_token text;
  cnt int;
  lvl int;
begin
  select * into o from private.operators where member_id = p_member for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'bad_pin');
  end if;
  select * into m from public.team_members where id = p_member;
  if not m.active or not m.can_sign_in then
    return jsonb_build_object('ok', false, 'error', 'bad_pin');
  end if;

  if p_device_token is not null and length(p_device_token) between 32 and 128 then
    select * into d from private.hq_devices
      where token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
      for update;
    known := found;
  end if;

  lock_until := case when known then d.locked_until else o.locked_until end;
  if lock_until is not null and lock_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'retry_after_s', ceil(extract(epoch from (lock_until - now())))::int);
  end if;

  good := p_pin is not null and p_pin ~ '^[0-9]{4,12}$'
          and o.pin_hash = extensions.crypt(p_pin, o.pin_hash);

  insert into private.hq_login_log (ok, known_device, ip) values (good, known, left(p_ip, 64));

  if good then
    update private.operators set failed_count = 0, lock_level = 0, locked_until = null where member_id = p_member;
    if known then
      update private.hq_devices set failed_count = 0, lock_level = 0, locked_until = null,
        last_seen_at = now() where id = d.id;
    else
      new_token := encode(extensions.gen_random_bytes(32), 'hex');
      insert into private.hq_devices (token_hash)
        values (encode(extensions.digest(new_token, 'sha256'), 'hex'));
    end if;
    return jsonb_build_object('ok', true, 'device_token', new_token,
      'operator_email', o.email, 'member_id', m.id, 'name', m.name, 'role', m.role);
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
    cnt := o.failed_count + 1; lvl := o.lock_level;
    if cnt >= 5 then
      update private.operators set failed_count = 0, lock_level = lvl + 1,
        locked_until = now() + least(interval '6 hours', interval '5 minutes' * power(2, lvl))
        where member_id = p_member;
      return jsonb_build_object('ok', false, 'error', 'locked',
        'retry_after_s', least(21600, 300 * power(2, lvl))::int);
    end if;
    update private.operators set failed_count = cnt where member_id = p_member;
  end if;
  return jsonb_build_object('ok', false, 'error', 'bad_pin', 'remaining', 5 - cnt);
end;
$$;

create or replace function public.hq_change_pin(p_member uuid, p_old text, p_new text, p_device_token text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if p_new is null or p_new !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  r := public.hq_verify_pin(p_member, p_old, p_device_token, p_ip);
  if not coalesce((r->>'ok')::boolean, false) then return r; end if;
  update private.operators
    set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 11)) where member_id = p_member;
  return jsonb_build_object('ok', true);
end;
$$;

-- The owner sets or resets someone's PIN (no old PIN needed). Service role only.
create or replace function public.hq_team_set_pin(p_member uuid, p_new text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_new is null or p_new !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  update private.operators
    set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 11)),
        failed_count = 0, lock_level = 0, locked_until = null
    where member_id = p_member;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Give a team member a login (their auth user is created by the function first). Service role only.
create or replace function public.hq_team_add_login(p_member uuid, p_user_id uuid, p_email text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  insert into private.operators (member_id, user_id, email, pin_hash)
    values (p_member, p_user_id, p_email, extensions.crypt(p_pin, extensions.gen_salt('bf', 11)));
  update public.team_members set can_sign_in = true where id = p_member;
  return jsonb_build_object('ok', true);
end;
$$;

-- The session's member, for the function to check the owner role. Service role only.
create or replace function public.hq_member_for_user(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('member_id', m.id, 'name', m.name, 'role', m.role)
  from private.operators o join public.team_members m on m.id = o.member_id
  where o.user_id = p_user_id and m.active and m.can_sign_in;
$$;

-- The old single-operator versions: keep the three-argument PIN check working for
-- the login function already deployed (it signs in the owner), drop the old change.
drop function public.hq_verify_pin(text, text, text);
create function public.hq_verify_pin(p_pin text, p_device_token text, p_ip text)
returns jsonb
language sql security definer set search_path = '' as $$
  select public.hq_verify_pin(
    (select id from public.team_members where role = 'owner' and active order by sort, created_at limit 1),
    p_pin, p_device_token, p_ip);
$$;
drop function if exists public.hq_change_pin(text, text, text, text);

do $$
declare f text;
begin
  foreach f in array array[
    'public.hq_verify_pin(uuid, text, text, text)', 'public.hq_verify_pin(text, text, text)',
    'public.hq_change_pin(uuid, text, text, text, text)', 'public.hq_team_set_pin(uuid, text)',
    'public.hq_team_add_login(uuid, uuid, text, text)', 'public.hq_member_for_user(uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

drop table private.hq_auth;

-- Owners on the work itself. Null = nobody yet (shown to everyone).
alter table public.leads    add column owner_id uuid references public.team_members(id) on delete set null;
alter table public.deals    add column owner_id uuid references public.team_members(id) on delete set null;
alter table public.clients  add column owner_id uuid references public.team_members(id) on delete set null;
alter table public.projects add column owner_id uuid references public.team_members(id) on delete set null;
alter table public.tasks    add column owner_id uuid references public.team_members(id) on delete set null;
create index tasks_owner_idx on public.tasks (owner_id) where owner_id is not null;
alter table public.agent_actions add column decided_by uuid references public.team_members(id) on delete set null;

alter publication supabase_realtime add table public.team_members;
