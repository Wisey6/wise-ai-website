// Builds the hub SNAPSHOT the briefing, ask and doer agents read. Pure (no Deno APIs).
//
// What goes in: names, first names, suburbs, industries, statuses, amounts, dates, short
// record text. What never goes in: phone numbers, email addresses, URLs (every free-text field
// is passed through scrubText, and contact columns are simply never read into it).
// Ordering and key order are fixed so the serialised snapshot is byte-identical for the same
// data on the same day (a stable prefix for prompt caching).
import { localParts } from "../_shared/time.ts";
import { addDays, localDate, scrubText } from "./validate.ts";

type Row = Record<string, unknown>;

export type SnapshotRows = {
  settings: Row;
  leadStatuses: string[];        // status of every non-archived lead (for counts)
  leads: Row[];                  // up to 150 most recently active, non-archived, not dnc
  lastInbound: Record<string, string>; // lead id -> latest inbound message body
  deals: Row[];                  // open (not won/lost), not archived
  clients: Row[];
  tasks: Row[];                  // not done
  projects: Row[];
  invoices: Row[];               // last 120 days + all unpaid
  costs: Row[];                  // recurring (running or ended in the last 60 days) + one-offs in the last 90 days
  costCount?: number;            // every cost record (for the empty-hub check)
  team?: Row[];                  // team members {id, name} for owner names
  bookings: Row[];               // next 14 days
  proposals: Row[];              // draft or sent
};

export const SECTION_LINKS: Record<string, string> = {
  home: "#home", inbox: "#inbox", leads: "#leads", pipeline: "#pipeline", clients: "#clients",
  projects: "#projects", tasks: "#projects/tasks", income: "#income", costs: "#costs",
  bookings: "#bookings", proposals: "#proposals", campaigns: "#campaigns",
};

const s = (v: unknown, max = 120) => scrubText(v, max) || undefined;
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const d = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
const b = (v: unknown) => (v === true ? true : undefined);

/** First word of a contact name (scrubbed), or undefined. */
export function firstName(v: unknown): string | undefined {
  const t = scrubText(v, 60).split(" ")[0];
  return t && !t.startsWith("[") ? t : undefined;
}

/** A timestamp as local "YYYY-MM-DD HH:mm" in the zone. */
function when(v: unknown, tz: string): string | undefined {
  if (!v) return undefined;
  const t = new Date(String(v));
  if (Number.isNaN(t.getTime())) return undefined;
  const l = localParts(t, tz);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${l.year}-${p(l.month)}-${p(l.day)} ${p(l.hour)}:${p(l.minute)}`;
}

/** Drops undefined values (key order is the order the object was built in). */
function tidy<T extends Row>(o: T): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const byKey = (key: string, dir: 1 | -1 = 1) => (a: Row, c: Row) => {
  const x = String(a[key] ?? ""), y = String(c[key] ?? "");
  if (x !== y) return x < y ? -dir : dir;
  return String(a.id ?? "") < String(c.id ?? "") ? -1 : 1;
};

export function buildSnapshot(rows: SnapshotRows, now: Date) {
  const st = rows.settings ?? {};
  const tz = String(st.timezone || "Australia/Brisbane");
  const today = localDate(now, tz);
  const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long" }).format(now);

  const ownerName = (id: unknown) => (id ? s((rows.team ?? []).find((m) => m.id === id)?.name, 40) ?? "former member" : undefined);

  const byStatus: Record<string, number> = {};
  for (const status of [...rows.leadStatuses].sort()) byStatus[status] = (byStatus[status] ?? 0) + 1;

  const leads = [...rows.leads]
    .map((l): Row => ({ ...l, _active: [l.last_reply_at, l.last_contacted_at, l.updated_at].map((x) => String(x ?? "")).sort().pop() }))
    .sort(byKey("_active", -1))
    .slice(0, 150)
    .map((l: Row) => {
      const id = String(l.id);
      const inbound = rows.lastInbound[id];
      return tidy({
        id,
        business: s(l.business, 80),
        first_name: firstName(l.contact_name),
        suburb: s(l.suburb, 40),
        industry: s(l.industry, 40),
        status: String(l.status),
        has_hook: Boolean(l.hook && String(l.hook).trim()),
        est_monthly_value: n(l.est_monthly_value),
        owner: ownerName(l.owner_id),
        last_contacted_at: when(l.last_contacted_at, tz),
        last_reply_at: when(l.last_reply_at, tz),
        next_followup_at: when(l.next_followup_at, tz),
        unread: b(l.unread),
        last_inbound: inbound ? scrubText(inbound, 200) : undefined,
        link: `#leads/${id}`,
        inbox: l.unread || l.last_reply_at || inbound ? `#inbox/${id}` : undefined,
      });
    });

  const deals = [...rows.deals].sort(byKey("updated_at", -1)).slice(0, 100).map((x) => tidy({
    id: String(x.id), title: s(x.title, 100), stage: String(x.stage), value: n(x.value), monthly_value: n(x.monthly_value),
    probability: n(x.probability), expected_close: d(x.expected_close), next_step: s(x.next_step, 160), next_step_on: d(x.next_step_on),
    lead_id: x.lead_id ? String(x.lead_id) : undefined, client_id: x.client_id ? String(x.client_id) : undefined,
    owner: ownerName(x.owner_id), updated: when(x.updated_at, tz), link: `#pipeline/${x.id}`,
  }));

  const clients = [...rows.clients].sort(byKey("name")).slice(0, 100).map((x) => tidy({
    id: String(x.id), name: s(x.name, 80), first_name: firstName(x.contact_name), status: String(x.status),
    industry: s(x.industry, 40), suburb: s(x.suburb, 40), monthly_value: n(x.monthly_value), started_on: d(x.started_on),
    owner: ownerName(x.owner_id), link: `#clients/${x.id}`,
  }));

  const tasks = [...rows.tasks].sort(byKey("due_on")).slice(0, 100).map((x) => tidy({
    id: String(x.id), title: s(x.title, 120), state: String(x.state), priority: String(x.priority), due_on: d(x.due_on),
    client_id: x.client_id ? String(x.client_id) : undefined, project_id: x.project_id ? String(x.project_id) : undefined,
    owner: ownerName(x.owner_id), link: x.project_id ? `#projects/${x.project_id}` : SECTION_LINKS.tasks,
  }));

  const projects = [...rows.projects].sort(byKey("name")).slice(0, 60).map((x) => tidy({
    id: String(x.id), name: s(x.name, 100), status: String(x.status), due_on: d(x.due_on), value: n(x.value),
    client_id: x.client_id ? String(x.client_id) : undefined, owner: ownerName(x.owner_id), link: `#projects/${x.id}`,
  }));

  const invoices = [...rows.invoices].sort(byKey("issued_on", -1)).slice(0, 150).map((x) => tidy({
    id: String(x.id), client_id: x.client_id ? String(x.client_id) : undefined, description: s(x.description, 100),
    amount: n(x.amount), kind: String(x.kind), status: String(x.status), invoice_no: s(x.invoice_no, 30),
    issued_on: d(x.issued_on), due_on: d(x.due_on), paid_on: d(x.paid_on),
    overdue: x.status === "invoiced" && d(x.due_on) !== undefined && d(x.due_on)! < today ? true : undefined,
    link: `#income/${x.id}`,
  }));

  const costs = [...rows.costs].sort(byKey("name")).slice(0, 60).map((x) => tidy({
    name: s(x.name, 60), vendor: s(x.vendor, 60), category: s(x.category, 30), amount: n(x.amount), cadence: String(x.cadence),
    active: x.active === false ? false : true, started_on: d(x.started_on), ended_on: d(x.ended_on), incurred_on: d(x.incurred_on),
    next_due: d(x.next_due), notes: s(x.notes, 300),
    link: x.id ? `#costs/${x.id}` : SECTION_LINKS.costs,
  }));

  const bookings = [...rows.bookings].sort(byKey("starts_at")).slice(0, 50).map((x) => tidy({
    id: String(x.id), title: s(x.title, 100), starts_at: when(x.starts_at, tz), status: String(x.status),
    attendee_first_name: firstName(x.attendee_name), lead_id: x.lead_id ? String(x.lead_id) : undefined,
    link: x.lead_id ? `#inbox/${x.lead_id}` : SECTION_LINKS.bookings,
  }));

  const proposals = [...rows.proposals].sort(byKey("updated_at", -1)).slice(0, 50).map((x) => {
    const items = Array.isArray(x.line_items) ? x.line_items as Row[] : [];
    const total = items.reduce((sum, it) => sum + (Number(it?.amount) || 0), 0);
    return tidy({
      id: String(x.id), number: s(x.number, 30), title: s(x.title, 100), status: String(x.status),
      recipient_business: s(x.recipient_business, 80), total: total || undefined, sent_on: d(x.sent_on), valid_until: d(x.valid_until),
      deal_id: x.deal_id ? String(x.deal_id) : undefined, client_id: x.client_id ? String(x.client_id) : undefined,
      lead_id: x.lead_id ? String(x.lead_id) : undefined, link: `#proposals/${x.id}`,
    });
  });

  const dueBy = addDays(today, 0);
  const counts = {
    leads_total: rows.leadStatuses.length,
    leads_by_status: byStatus,
    unread: leads.filter((l) => l.unread).length,
    followups_due: leads.filter((l) => l.next_followup_at && l.next_followup_at.slice(0, 10) <= dueBy).length,
    open_deals: deals.length,
    clients_active: clients.filter((c) => c.status === "active").length,
    open_tasks: tasks.length,
    unpaid_invoices: invoices.filter((i) => i.status === "invoiced").length,
    upcoming_bookings: bookings.length,
    costs_total: rows.costCount ?? rows.costs.length,
  };

  return {
    today,
    weekday,
    timezone: tz,
    business: tidy({
      name: s(st.business_name, 60), monthly_target: n(st.monthly_target), owner_draw: n(st.owner_draw),
      cash_on_hand: n(st.cash_on_hand), cash_as_of: d(st.cash_as_of), tax_rate: n(st.tax_rate),
      gst_registered: st.gst_registered === true, avg_deal_value: n(st.avg_deal_value),
    }),
    counts,
    leads, deals, clients, tasks, projects, invoices, costs, bookings, proposals,
    links: SECTION_LINKS,
  };
}

export type Snapshot = ReturnType<typeof buildSnapshot>;

/** True only when the hub has no leads, clients, deals, jobs, tasks, invoices AND no costs (nor bookings/proposals). */
export function isEmptyHub(snap: Snapshot): boolean {
  return snap.counts.leads_total === 0 && !snap.leads.length && !snap.deals.length && !snap.clients.length &&
    !snap.tasks.length && !snap.projects.length && !snap.invoices.length && !snap.bookings.length && !snap.proposals.length &&
    !snap.counts.costs_total && !snap.costs.length;
}

/** Every hub hash the snapshot offers (section links plus each row's link / inbox link). */
export function allowedHashes(snap: Snapshot): Set<string> {
  const out = new Set<string>(Object.values(snap.links));
  for (const list of [snap.leads, snap.deals, snap.clients, snap.tasks, snap.projects, snap.invoices, snap.bookings, snap.proposals, snap.costs]) {
    for (const r of list as Row[]) {
      if (typeof r.link === "string") out.add(r.link);
      if (typeof r.inbox === "string") out.add(r.inbox);
    }
  }
  return out;
}

/** The serialised snapshot that goes into a prompt (stable for the same data and day). */
export function serialiseSnapshot(snap: Snapshot): string {
  return JSON.stringify(snap);
}
