-- AI assistance: a monthly spend cap and a record of every call, so the cost is always visible.
alter table public.settings
  add column ai_enabled boolean not null default true,
  add column ai_monthly_cap_usd numeric not null default 5 check (ai_monthly_cap_usd >= 0 and ai_monthly_cap_usd <= 500);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  task text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric not null default 0,
  ok boolean not null default true
);
create index ai_usage_at_idx on public.ai_usage (at desc);

alter table public.ai_usage enable row level security;
create policy operator_read on public.ai_usage for select to authenticated using ((select public.is_operator()));
revoke all on public.ai_usage from anon;
revoke insert, update, delete on public.ai_usage from authenticated;
