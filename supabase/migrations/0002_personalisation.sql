-- Personal, value-led outreach: every cold first touch carries a line written
-- for that one business, and each lead can hold an estimate of what it is worth to them.
alter table public.leads
  add column hook text,                       -- one personal observation about this business
  add column pain text,                       -- the problem we think we can fix for them
  add column est_monthly_value numeric;       -- our estimate of $/month the fix is worth to them
alter table public.settings
  add column require_hook boolean not null default true;
