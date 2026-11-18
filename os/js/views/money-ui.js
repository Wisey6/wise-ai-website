// Wise AI OS: small presentation helpers shared by Income, Costs and Runway.
import { el, icon, money } from '../ui.js?v=20261118d';

const AUD2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Dollars, with cents only when there are cents: "$2,400", "$218.18". */
export function money2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? money(v) : AUD2.format(v);
}

/** "17 Nov" this year, "17 Nov 2025" otherwise. Takes YYYY-MM-DD. */
export function dateFmt(iso, { year } = {}) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const showYear = year ?? d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(showYear ? { year: 'numeric' } : {}) });
}

/** One line of small plain print: how a figure is worked out. */
export const how = (text) => el('p', { class: 'money-how' }, text);

/**
 * Number strip: [{label, value, sub, how, tone, bar, id}] → open numerals over an ink rule.
 * tone: 'warn' | 'bad' | 'ok' colours the value. bar: 0..1 draws a thin progress bar.
 */
export function kpiStrip(cells, cls = '') {
  return el('div', { class: `money-kpis ${cls}`.trim() },
    cells.filter(Boolean).map((c) => el('div', { class: 'money-kpi', dataset: c.id ? { kpi: c.id } : {} },
      el('p', { class: 'eyebrow' }, c.label),
      el('p', { class: `money-kpi-value${c.tone ? ` is-${c.tone}` : ''}` }, c.value),
      c.bar !== undefined && c.bar !== null ? el('div', { class: 'money-bar', role: 'img', 'aria-label': `${Math.round(c.bar * 100)}%` },
        el('i', { style: { width: `${Math.max(0, Math.min(1, c.bar)) * 100}%` } })) : null,
      c.sub ? el('p', { class: 'money-kpi-sub' }, c.sub) : null,
      c.how ? how(c.how) : null)));
}

/** Link to a client record, or a muted dash. */
export function clientLink(client) {
  if (!client) return el('span', { class: 'faint' }, '—');
  return el('a', { href: `#clients/${client.id}`, class: 'money-link' }, client.name);
}

export function pageHead(eyebrow, title, lede, actions) {
  return el('div', { class: 'page-head' },
    el('div', { class: 'stack' },
      el('p', { class: 'eyebrow' }, eyebrow),
      el('h1', { class: 'h1' }, title),
      lede ? el('p', { class: 'muted money-lede' }, lede) : null),
    actions ? el('div', { class: 'row money-actions' }, actions) : null);
}

export function sectionHead(eyebrow, title, right) {
  return el('div', { class: 'section-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, eyebrow), el('h2', { class: 'h2' }, title)),
    right || null);
}

/** Small icon button with an accessible name. */
export function iconAction(name, label, onClick, extra = '') {
  return el('button', { type: 'button', class: `icon-btn sm ${extra}`.trim(), 'aria-label': label, title: label, onClick: (e) => { e.stopPropagation(); onClick(e); } }, icon(name, 15));
}

/** Labelled <select> for a toolbar. */
export function toolSelect(label, options, value, onChange) {
  const s = el('select', { class: 'input sm', 'aria-label': label },
    options.map((o) => el('option', { value: o.id }, o.label)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Replace a select's options and keep its value when it still exists. */
export function setOptions(sel, options) {
  const cur = sel.value;
  sel.replaceChildren(...options.map((o) => el('option', { value: o.id }, o.label)));
  sel.value = options.some((o) => o.id === cur) ? cur : (options[0]?.id ?? '');
}

export const clientOptions = (clients, empty = 'No client') => [
  { id: '', label: empty },
  ...clients.filter((c) => !c.archived).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => ({ id: c.id, label: c.name }))
];
