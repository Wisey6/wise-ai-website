-- Wise AI OS stage 2: Sell, Deliver, Money and the Library.
-- Same rule as before: one operator, every table locked to them by RLS.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,                         -- the business
  contact_name text,
  email text,
  phone text,
  website text,
  industry text,
  suburb text,
  status text not null default 'active' check (status in ('active','paused','past')),
  lead_id uuid references public.leads(id) on delete set null,
  started_on date,
  monthly_value numeric not null default 0,   -- retainer, $/month
  notes text,
  tags text[] not null default '{}',
  archived boolean not null default false
);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  client_id uuid references public.clients(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  stage text not null default 'qualified'
    check (stage in ('qualified','proposal','negotiation','won','lost')),
  value numeric not null default 0,           -- one-off, $
  monthly_value numeric not null default 0,   -- recurring, $/month
  probability int not null default 30 check (probability between 0 and 100),
  expected_close date,
  next_step text,
  next_step_on date,
  lost_reason text,
  closed_on date,
  notes text,
  archived boolean not null default false
);
create index deals_stage_idx on public.deals (stage) where not archived;

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deal_id uuid references public.deals(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  number text,                                -- e.g. WA-2026-014
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','sent','accepted','declined','expired')),
  recipient_name text,
  recipient_business text,
  problem text,                               -- what it is costing them now
  solution text,                              -- what we will build
  scope jsonb not null default '[]',          -- [{title, detail}]
  line_items jsonb not null default '[]',     -- [{label, amount, recurring}]
  roi jsonb not null default '{}',            -- calculator inputs and results
  terms text,
  valid_until date,
  sent_on date,
  decided_on date,
  archived boolean not null default false
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_id uuid references public.clients(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  name text not null,
  status text not null default 'planned'
    check (status in ('planned','active','waiting','done','cancelled')),
  started_on date,
  due_on date,
  value numeric not null default 0,
  description text,
  archived boolean not null default false
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_id uuid references public.projects(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  title text not null,
  state text not null default 'todo' check (state in ('todo','doing','review','blocked','done')),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  due_on date,
  done_at timestamptz,
  sort int not null default 0,
  notes text
);
create index tasks_project_idx on public.tasks (project_id);

create table public.roi_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_id uuid references public.clients(id) on delete cascade,
  title text not null,
  period_start date,
  period_end date,
  metrics jsonb not null default '[]',        -- [{label, before, after, unit, value_per_unit}]
  hours_saved numeric not null default 0,
  hourly_value numeric not null default 0,
  revenue_gained numeric not null default 0,
  cost_saved numeric not null default 0,
  fee numeric not null default 0,             -- what the client paid us for the period
  summary text,
  next_steps text,
  status text not null default 'draft' check (status in ('draft','sent')),
  sent_on date
);

create table public.income (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  description text not null,
  amount numeric not null check (amount >= 0),  -- as invoiced, GST-inclusive if GST applies
  gst numeric not null default 0,
  kind text not null default 'one_off' check (kind in ('one_off','retainer')),
  status text not null default 'invoiced' check (status in ('draft','invoiced','paid','void')),
  invoice_no text,
  issued_on date,
  due_on date,
  paid_on date,
  notes text
);
create index income_paid_idx on public.income (paid_on);

create table public.costs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  vendor text,
  category text not null default 'software',
  amount numeric not null check (amount >= 0),
  cadence text not null default 'monthly' check (cadence in ('monthly','yearly','one_off')),
  started_on date,
  ended_on date,                               -- recurring cost stopped
  incurred_on date,                            -- for one-off purchases
  next_due date,
  client_id uuid references public.clients(id) on delete set null,  -- cost of serving a client
  notes text,
  active boolean not null default true
);

create table public.library (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  kind text not null default 'knowledge'
    check (kind in ('playbook','standard','knowledge','research','brand','template','case_study','other')),
  body text,
  url text,
  client_id uuid references public.clients(id) on delete set null,
  tags text[] not null default '{}',
  pinned boolean not null default false,
  archived boolean not null default false
);

alter table public.settings
  add column cash_on_hand numeric not null default 0,
  add column cash_as_of date,
  add column tax_rate numeric not null default 0.25 check (tax_rate >= 0 and tax_rate < 1),
  add column gst_registered boolean not null default false,
  add column monthly_target numeric not null default 10000,
  add column owner_draw numeric not null default 4300,     -- what Tyler needs to take home each month
  add column business_name text not null default 'Wise AI',
  add column abn text,
  add column proposal_terms text;

do $$
declare t text;
begin
  foreach t in array array['clients','deals','proposals','projects','tasks','roi_reports','income','costs','library']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy operator_all on public.%I for all to authenticated
         using ((select public.is_operator())) with check ((select public.is_operator()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;
