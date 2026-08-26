// Data model, persistence and derived business metrics.
// Every mutation returns a new object — nothing here mutates state in place.

import { Vault } from './vault.js';

export const STAGES = [
  { id: 'lead',      label: 'Lead' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'proposal',  label: 'Proposal' },
  { id: 'won',       label: 'Won' },
  { id: 'lost',      label: 'Lost' }
];

export const TASK_STATES = [
  { id: 'todo',    label: 'To do' },
  { id: 'doing',   label: 'In progress' },
  { id: 'review',  label: 'Needs review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done',    label: 'Done' }
];

export const PRIORITIES = ['low', 'medium', 'high'];

/** Things WiseAI produced and can point a client at. */
export const OUTPUT_KINDS = [
  { id: 'proposal',    label: 'Proposal' },
  { id: 'contract',    label: 'Contract' },
  { id: 'deliverable', label: 'Deliverable' },
  { id: 'demo',        label: 'Demo' },
  { id: 'runbook',     label: 'Runbook' },
  { id: 'report',      label: 'Report' },
  { id: 'invoice',     label: 'Invoice' },
  { id: 'other',       label: 'Other' }
];

export const OUTPUT_STATES = [
  { id: 'draft',      label: 'Draft' },
  { id: 'ready',      label: 'Ready to send' },
  { id: 'sent',       label: 'Sent' },
  { id: 'accepted',   label: 'Accepted' },
  { id: 'superseded', label: 'Superseded' }
];

/** Reference material — the things you consult rather than ship. */
export const LIBRARY_KINDS = [
  { id: 'playbook',  label: 'Playbook' },
  { id: 'standard',  label: 'Standard' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'research',  label: 'Research' },
  { id: 'brand',     label: 'Brand' },
  { id: 'template',  label: 'Template' },
  { id: 'other',     label: 'Other' }
];

/** Collections that support archiving. */
export const ARCHIVABLE = ['clients', 'deals', 'projects', 'tasks', 'outputs', 'library'];

export function emptyData() {
  return {
    meta: { version: 1, created: today(), updated: today() },
    settings: { quitLine: 4300, currency: 'AUD', businessName: 'Wise AI' },
    clients: [], deals: [], projects: [], tasks: [],
    income: [], expenses: [], subscriptions: [],
    outputs: [], library: []
  };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function uid(prefix = 'i') {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Normalise an imported payload so a partial file still loads cleanly. */
export function hydrate(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const merged = { ...base, ...raw };
  merged.meta = { ...base.meta, ...(raw.meta || {}) };
  merged.settings = { ...base.settings, ...(raw.settings || {}) };
  for (const key of ['clients', 'deals', 'projects', 'tasks', 'income', 'expenses',
                     'subscriptions', 'outputs', 'library']) {
    merged[key] = Array.isArray(raw[key]) ? raw[key] : [];
  }
  return merged;
}

/* ------------------------------------------------------------------ store */

export class Store {
  constructor(session) {
    this.session = session;
    this.data = hydrate(session.data);
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.data);
  }

  /** Apply `fn` to the current data and persist the result. */
  async update(fn) {
    const next = fn(this.data);
    this.data = { ...next, meta: { ...next.meta, updated: today() } };
    await Vault.save(this.session, this.data);
    this.emit();
    return this.data;
  }

  /** Add a record to a collection. */
  add(collection, record) {
    return this.update((d) => ({
      ...d,
      [collection]: [...d[collection], { id: uid(collection[0]), ...record }]
    }));
  }

  /** Patch one record by id. */
  patch(collection, id, changes) {
    return this.update((d) => ({
      ...d,
      [collection]: d[collection].map((r) => (r.id === id ? { ...r, ...changes } : r))
    }));
  }

  remove(collection, id) {
    return this.update((d) => ({
      ...d,
      [collection]: d[collection].filter((r) => r.id !== id)
    }));
  }

  /**
   * Archiving keeps the record and its history; deleting does not. Everything
   * that can be archived should be, so the only destructive path is explicit.
   */
  archive(collection, id) {
    return this.patch(collection, id, { archived: true, archivedAt: today() });
  }

  restore(collection, id) {
    return this.patch(collection, id, { archived: false, archivedAt: '' });
  }

  replaceAll(data) {
    return this.update(() => hydrate(data));
  }
}

/* ------------------------------------------------------------- selectors */

const sum = (rows, field = 'amount') =>
  rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

/** Live records only. Archived ones stay readable but stop counting. */
export const live = (rows = []) => rows.filter((r) => !r.archived);
export const archived = (rows = []) => rows.filter((r) => r.archived);

/** Monthly-equivalent cost of a recurring line. */
export function monthlyCost(sub) {
  const amount = Number(sub.amount) || 0;
  switch ((sub.cycle || 'monthly').toLowerCase()) {
    case 'yearly':
    case 'annual':    return amount / 12;
    case 'quarterly': return amount / 3;
    case 'weekly':    return amount * 52 / 12;
    default:          return amount;
  }
}

export function metrics(d) {
  // Archived records stay readable but must not move any number on the dashboard.
  const clients = live(d.clients);
  const deals = live(d.deals);
  const tasks = live(d.tasks);

  const paid = d.income.filter((r) => r.status === 'paid');
  const outstanding = d.income.filter((r) => r.status === 'invoiced');
  const unbilled = d.income.filter((r) => r.status === 'unbilled');

  const activeSubs = d.subscriptions.filter((s) => (s.status || 'active') === 'active');
  const burn = activeSubs.reduce((total, s) => total + monthlyCost(s), 0);

  const mrr = clients
    .filter((c) => c.status === 'active')
    .reduce((total, c) => total + (Number(c.mrr) || 0), 0);

  const openDeals = deals.filter((x) => !['won', 'lost'].includes(x.stage));

  // An invoice with no due date cannot be aged, so it is never counted overdue
  // — that is a missing term to go and set, not a debt to chase today.
  const overdue = outstanding.filter((r) => r.due && r.due < today());
  const quitLine = Number(d.settings.quitLine) || 0;

  return {
    collected: sum(paid),
    outstanding: sum(outstanding),
    overdueInvoices: overdue.length,
    overdueAmount: sum(overdue),
    undatedInvoices: outstanding.filter((r) => !r.due).length,
    unbilled: sum(unbilled),
    burn,
    mrr,
    net: mrr - burn,
    quitLine,
    gapToQuitLine: Math.max(0, quitLine - (mrr - burn)),
    quitProgress: quitLine > 0 ? Math.min(1, Math.max(0, (mrr - burn) / quitLine)) : 0,
    activeClients: clients.filter((c) => c.status === 'active').length,
    openDeals: openDeals.length,
    pipelineValue: sum(openDeals, 'value'),
    weightedPipeline: openDeals.reduce(
      (t, x) => t + (Number(x.value) || 0) * ((Number(x.probability) || 0) / 100), 0),
    openTasks: tasks.filter((t) => t.status !== 'done').length,
    reviewTasks: tasks.filter((t) => t.status === 'review').length,
    blockedTasks: tasks.filter((t) => t.status === 'blocked').length,
    overdueTasks: tasks.filter((t) => t.status !== 'done' && t.due && t.due < today()).length,
    outputsDraft: live(d.outputs).filter((o) => ['draft', 'ready'].includes(o.status)).length,
    archivedCount: ARCHIVABLE.reduce((t, k) => t + archived(d[k] || []).length, 0)
  };
}

/** Income grouped into the last `months` calendar months, oldest first. */
export function incomeByMonth(d, months = 12) {
  const buckets = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    buckets.push({
      key: dt.toISOString().slice(0, 7),
      label: dt.toLocaleDateString('en-AU', { month: 'short' }),
      value: 0
    });
  }
  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const row of d.income) {
    if (row.status !== 'paid' || !row.date) continue;
    const bucket = index.get(String(row.date).slice(0, 7));
    if (bucket) bucket.value += Number(row.amount) || 0;
  }
  return buckets;
}

/** Cumulative collected revenue over the same window. */
export function cumulativeIncome(d, months = 12) {
  let running = 0;
  return incomeByMonth(d, months).map((b) => ({ ...b, value: (running += b.value) }));
}

/** Month label for a `YYYY-MM` key. */
function monthLabel(key) {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

/**
 * Every income row grouped by calendar month, newest month first, undated last.
 * Unlike `incomeByMonth` this keeps the rows themselves and spans the whole
 * history rather than a fixed window, so the Money table can group by month
 * without losing an entry. `gross` counts paid rows only, matching `collected`
 * — an invoiced or unbilled row is money promised, not money earned.
 */
export function incomeMonths(d) {
  const groups = new Map();
  for (const row of d.income) {
    const key = row.date ? String(row.date).slice(0, 7) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (!a) return 1;          // undated sinks to the bottom, never the top
      if (!b) return -1;
      return b.localeCompare(a);
    })
    .map(([key, rows]) => ({
      key,
      label: key ? monthLabel(key) : 'Undated',
      rows: [...rows].sort((x, y) => (y.date || '').localeCompare(x.date || '')),
      gross: sum(rows.filter((r) => r.status === 'paid'))
    }));
}

/** Paid revenue per client, largest first. */
export function revenueByClient(d) {
  const totals = new Map();
  for (const row of d.income) {
    if (row.status !== 'paid') continue;
    const name = clientName(d, row.clientId) || row.client || 'Unattributed';
    totals.set(name, (totals.get(name) || 0) + (Number(row.amount) || 0));
  }
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function clientName(d, clientId) {
  return d.clients.find((c) => c.id === clientId)?.name || '';
}

/** Recurring lines due within `days`, soonest first. */
export function upcomingBills(d, days = 30) {
  const limit = new Date();
  limit.setDate(limit.getDate() + days);
  const cutoff = limit.toISOString().slice(0, 10);
  return d.subscriptions
    .filter((s) => (s.status || 'active') === 'active' && s.nextDue && s.nextDue <= cutoff)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}
