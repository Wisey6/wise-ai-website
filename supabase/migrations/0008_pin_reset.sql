-- Forgot your PIN: a one-time link emailed to the address on file for that person.
-- The address lives in the private schema and is never sent to the browser in full.
alter table private.operators
  add column contact_email text,
  add column reset_hash text,
  add column reset_expires timestamptz,
  add column reset_count int not null default 0,
  add column reset_window_start timestamptz;

-- Start a reset: at most 3 an hour per person; the link lasts 20 minutes. Service role only.
create or replace function public.hq_reset_start(p_member uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o private.operators%rowtype; m public.team_members%rowtype; token text;
begin
  select * into o from private.operators where member_id = p_member for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_email'); end if;
  select * into m from public.team_members where id = p_member;
  if not m.active or not m.can_sign_in or o.contact_email is null or o.contact_email = '' then
    return jsonb_build_object('ok', false, 'error', 'no_email');
  end if;
  if o.reset_window_start is not null and o.reset_window_start > now() - interval '1 hour' then
    if o.reset_count >= 3 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
    update private.operators set reset_count = reset_count + 1 where member_id = p_member;
  else
    update private.operators set reset_count = 1, reset_window_start = now() where member_id = p_member;
  end if;
  token := encode(extensions.gen_random_bytes(24), 'hex');
  update private.operators
    set reset_hash = encode(extensions.digest(token, 'sha256'), 'hex'), reset_expires = now() + interval '20 minutes'
    where member_id = p_member;
  return jsonb_build_object('ok', true, 'email', o.contact_email, 'name', m.name, 'token', token);
end;
$$;

-- Finish a reset with the emailed token. The token works once. Service role only.
create or replace function public.hq_reset_finish(p_token text, p_new text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o private.operators%rowtype;
begin
  if p_new is null or p_new !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  if p_token is null or length(p_token) < 32 then
    return jsonb_build_object('ok', false, 'error', 'bad_token');
  end if;
  select * into o from private.operators
    where reset_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and reset_expires > now()
    for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'bad_token'); end if;
  update private.operators
    set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 11)),
        reset_hash = null, reset_expires = null, failed_count = 0, lock_level = 0, locked_until = null
    where member_id = o.member_id;
  return jsonb_build_object('ok', true, 'member_id', o.member_id);
end;
$$;

create or replace function public.hq_team_set_email(p_member uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update private.operators set contact_email = nullif(lower(trim(p_email)), '') where member_id = p_member;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- The session's member, now with a masked copy of their reset address for Settings.
create or replace function public.hq_member_for_user(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('member_id', m.id, 'name', m.name, 'role', m.role,
    'email_hint', case when o.contact_email is null or o.contact_email = '' then null
      else left(o.contact_email, 2) || '•••' || substring(o.contact_email from position('@' in o.contact_email)) end)
  from private.operators o join public.team_members m on m.id = o.member_id
  where o.user_id = p_user_id and m.active and m.can_sign_in;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.hq_reset_start(uuid)', 'public.hq_reset_finish(text, text)',
    'public.hq_team_set_email(uuid, text)', 'public.hq_member_for_user(uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
