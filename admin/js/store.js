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
  { id: 'blocked', label: 'Blocked' },
  { id: 'done',    label: 'Done' }
];

export const PRIORITIES = ['low', 'medium', 'high'];

export function emptyData() {
  return {
    meta: { version: 1, created: today(), updated: today() },
    settings: { quitLine: 4300, currency: 'AUD', businessName: 'Wise AI' },
    clients: [], deals: [], projects: [], tasks: [],
    income: [], expenses: [], subscriptions: []
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
  for (const key of ['clients', 'deals', 'projects', 'tasks', 'income', 'expenses', 'subscriptions']) {
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

  replaceAll(data) {
    return this.update(() => hydrate(data));
  }
}

/* ------------------------------------------------------------- selectors */

const sum = (rows, field = 'amount') =>
  rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

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
  const paid = d.income.filter((r) => r.status === 'paid');
  const outstanding = d.income.filter((r) => r.status === 'invoiced');
  const unbilled = d.income.filter((r) => r.status === 'unbilled');

  const activeSubs = d.subscriptions.filter((s) => (s.status || 'active') === 'active');
  const burn = activeSubs.reduce((total, s) => total + monthlyCost(s), 0);

  const mrr = d.clients
    .filter((c) => c.status === 'active')
    .reduce((total, c) => total + (Number(c.mrr) || 0), 0);

  const quitLine = Number(d.settings.quitLine) || 0;

  return {
    collected: sum(paid),
    outstanding: sum(outstanding),
    unbilled: sum(unbilled),
    burn,
    mrr,
    net: mrr - burn,
    quitLine,
    gapToQuitLine: Math.max(0, quitLine - (mrr - burn)),
    quitProgress: quitLine > 0 ? Math.min(1, Math.max(0, (mrr - burn) / quitLine)) : 0,
    activeClients: d.clients.filter((c) => c.status === 'active').length,
    openDeals: d.deals.filter((x) => !['won', 'lost'].includes(x.stage)).length,
    pipelineValue: sum(d.deals.filter((x) => !['won', 'lost'].includes(x.stage)), 'value'),
    weightedPipeline: d.deals
      .filter((x) => !['won', 'lost'].includes(x.stage))
      .reduce((t, x) => t + (Number(x.value) || 0) * ((Number(x.probability) || 0) / 100), 0),
    openTasks: d.tasks.filter((t) => t.status !== 'done').length,
    overdueTasks: d.tasks.filter((t) => t.status !== 'done' && t.due && t.due < today()).length
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
