-- An "Approve all" link names exactly the candidates in the email it came in.
alter table private.scout_links add column if not exists candidate_ids uuid[];
create or replace function public.scout_link_create(p_action text, p_candidate uuid, p_run uuid, p_member uuid, p_ids uuid[] default null) returns uuid
language sql security definer set search_path = '' as $$
  insert into private.scout_links (action, candidate_id, run_id, member_id, candidate_ids) values (p_action, p_candidate, p_run, p_member, p_ids) returning id;
$$;
drop function if exists public.scout_link_create(text, uuid, uuid, uuid);
revoke all on function public.scout_link_create(text, uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.scout_link_create(text, uuid, uuid, uuid, uuid[]) to service_role;
