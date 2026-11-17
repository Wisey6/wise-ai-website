-- Allow PINs of 4 to 12 digits (was 6 to 12), at the owner's request.
-- The lockout is unchanged: 5 wrong tries, then a wait that doubles each time.

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

  good := p_pin is not null and p_pin ~ '^[0-9]{4,12}$'
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
  if p_new is null or p_new !~ '^[0-9]{4,12}$' then
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
