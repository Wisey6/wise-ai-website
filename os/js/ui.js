// Wise AI OS: small DOM + formatting toolkit shared by every view.
// No framework, no dependencies. Untrusted text (lead fields, inbound SMS)
// must only ever reach the page as a child string of `el()` (a text node) or
// through `textContent`; never through innerHTML.

/* --------------------------------------------------------------------- DOM */

/**
 * Create an element: el(tag, props, ...children).
 * Same semantics as admin/js/ui.js:
 *  - null / undefined / false props and children are skipped; children are flattened
 *  - `class` sets className, `dataset` merges into dataset, `on<Event>` adds a listener,
 *    `html` sets innerHTML (static markup only, never data), anything else is an attribute
 *    (`true` becomes an empty attribute).
 * Additions (compatible): `style` may be an object; `value` and `checked` are set as
 * properties (so a <select>'s value applies after its options are appended).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(props || {})) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class') node.className = val;
    else if (key === 'html') node.innerHTML = val;
    else if (key === 'dataset') Object.assign(node.dataset, val);
    else if (key === 'style' && typeof val === 'object') Object.assign(node.style, val);
    else if (key === 'value') value = val;
    else if (key === 'checked') node.checked = true;
    else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
    else node.setAttribute(key, val === true ? '' : val);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (value !== undefined) {
    node.value = value;
    if (tag === 'input') node.setAttribute('value', value);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's children; null / undefined / false children are skipped (unlike Node.append). */
export function fill(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Set location.hash ('#leads', 'leads/<id>' and 'leads' all work). */
export function go(hash) {
  const h = String(hash || '').replace(/^#?/, '#');
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = h;
}

/* ------------------------------------------------------------------ icons */
// Static path data only (never data from the database).
const PATHS = {
  home: '<path d="M3 11.5L12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  leads: '<path d="M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20"/><circle cx="10" cy="8" r="3.5"/><path d="M20 20v-1.5a3.5 3.5 0 00-2.5-3.35"/><path d="M15.5 4.6a3.5 3.5 0 010 6.8"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><path d="M9 7h7M9 11h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 018 0V11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="M3 6.5l9 6.5 9-6.5"/>',
  link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.5 2"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  external: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  spark: '<path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  archive: '<rect x="2" y="4" width="20" height="5" rx="1.5"/><path d="M4 9v10a2 2 0 002 2h12a2 2 0 002-2V9"/><path d="M10 13h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0114 0v1"/>',
  note: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
  message: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  ban: '<circle cx="12" cy="12" r="9.5"/><path d="M5.3 5.3l13.4 13.4"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 6.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.7 5 3.2 5 1.3 5 3.3-2.2 3.5-5 3.5-5-1.3-5-3.2"/>',
  refresh: '<path d="M21 12a9 9 0 01-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0115.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  backspace: '<path d="M21 5H8l-6 7 6 7h13a1 1 0 001-1V6a1 1 0 00-1-1z"/><path d="M17 9.5l-5 5M12 9.5l5 5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 010 19M12 2.5a14.5 14.5 0 000 19"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z"/><path d="M7 7h.01"/>',
  wifi: '<path d="M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M2 9a15 15 0 0120 0M12 19.5h.01"/>',
  grow: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  deliver: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  agents: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  'panel-pin': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="M5.5 8h1M5.5 11h1"/>',
  video: '<path d="M7 17L17 7M8 7h9v9"/>'
};

/** Inline SVG icon by name. Unknown names render an empty 16px box. */
export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/* --------------------------------------------------------------- statuses */

/** Lead statuses in pipeline order. tone maps to `.badge.is-<tone>`. */
export const STATUSES = [
  { id: 'new', label: 'New', tone: 'mute' },
  { id: 'queued', label: 'Queued', tone: 'info' },
  { id: 'contacted', label: 'Contacted', tone: 'info' },
  { id: 'replied', label: 'Replied', tone: 'warn' },
  { id: 'interested', label: 'Interested', tone: 'warn' },
  { id: 'booked', label: 'Booked', tone: 'ok' },
  { id: 'won', label: 'Won', tone: 'ok' },
  { id: 'lost', label: 'Lost', tone: 'mute' },
  { id: 'dnc', label: 'Do not contact', tone: 'bad' }
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

/** Pill badge. tone: ok | warn | bad | info | mute | '' */
export function badge(text, tone = '') {
  return el('span', { class: `badge${tone ? ` is-${tone}` : ''}` }, text);
}

export function statusBadge(status) {
  const s = STATUS[status] || { label: status || 'Unknown', tone: 'mute' };
  return el('span', { class: `badge is-${s.tone}`, dataset: { status: status || '' } },
    el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), s.label);
}

/* ----------------------------------------------------------------- toasts */

/** Toast message. tone: ok | bad | warn | info. Returns the node. */
export function toast(message, tone = 'ok') {
  let wrap = $('.toast-wrap');
  if (!wrap) {
    wrap = el('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' });
    document.body.append(wrap);
  }
  const iconName = tone === 'bad' ? 'alert' : tone === 'warn' ? 'alert' : tone === 'info' ? 'spark' : 'check';
  const node = el('div', { class: `toast is-${tone}` }, icon(iconName, 16), el('span', {}, message));
  wrap.append(node);
  const ttl = tone === 'bad' ? 6000 : 3600;
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  }, ttl);
  return node;
}

/* ----------------------------------------------------------------- modals */

let modalSeq = 0;

/**
 * Modal dialog with a form body. Resolves with the form's values or null when
 * dismissed. The resolved value is a plain object of the fields
 * (`values.name`) that ALSO answers the FormData methods `get`, `getAll`, `has`
 * (`values.get('name')`), so either style works.
 * Options: title, body (node or array), confirmLabel, danger, wide, cancelLabel,
 * hideConfirm, onOpen(formNode, close).
 */
export function modal({ title, body, confirmLabel = 'Save', danger = false, wide = false,
  cancelLabel = 'Cancel', hideConfirm = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const id = `modal-form-${++modalSeq}`;
    const titleId = `${id}-title`;
    const prevFocus = document.activeElement;
    const form = el('form', { class: 'modal-body', id, novalidate: false }, body);

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('is-leaving');
      setTimeout(() => backdrop.remove(), 160);
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Tab') trapFocus(e, dialog);
    };

    const dialog = el('div', {
      class: `modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId
    },
      el('div', { class: 'modal-head' },
        el('h2', { class: 'h2', id: titleId }, title),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('x', 18))
      ),
      form,
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, cancelLabel),
        hideConfirm ? null : el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', form: id }, confirmLabel)
      )
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      close(formValues(form));
    });

    const backdrop = el('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === backdrop) close(null); } }, dialog);
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    if (onOpen) onOpen(form, close);
    setTimeout(() => (form.querySelector('[autofocus], input:not([type=hidden]), select, textarea') || dialog.querySelector('button'))?.focus(), 30);
  });
}

function formValues(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  Object.defineProperties(out, {
    get: { value: (k) => fd.get(k), enumerable: false },
    getAll: { value: (k) => fd.getAll(k), enumerable: false },
    has: { value: (k) => fd.has(k), enumerable: false },
    formData: { value: fd, enumerable: false }
  });
  return out;
}

/** Keep Tab focus inside `root`. */
export function trapFocus(e, root) {
  const items = $$('button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
    .filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Yes/no confirmation. Resolves true or false.
 * confirmDialog(title, message, {confirmLabel = 'Delete', danger = true})
 */
export async function confirmDialog(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
  const res = await modal({
    title,
    body: el('p', { class: 'muted confirm-text' }, message),
    confirmLabel,
    danger
  });
  return res !== null;
}

/* ------------------------------------------------------------- form bits */

/** Labelled field: a <label class="field"> wrapping the control and an optional hint. */
export function field(label, control, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}

/**
 * <input class="input">. opts: type, value, required, placeholder, step, min, max,
 * maxlength, autocomplete, inputmode, pattern, id, list, disabled, readonly, autofocus,
 * checked, 'aria-label', onInput, onChange.
 */
export function input(name, opts = {}) {
  const { type = 'text', value = '', ...rest } = opts;
  const props = { class: type === 'checkbox' || type === 'radio' ? 'check' : 'input', name, type };
  for (const [k, v] of Object.entries(rest)) {
    if (v === null || v === undefined || v === false || v === '') continue;
    props[k] = v;
  }
  if (type !== 'checkbox' && type !== 'radio' && value !== null && value !== undefined) props.value = String(value);
  if ((type === 'checkbox' || type === 'radio') && value !== '' && value !== null && value !== undefined) props.value = String(value);
  return el('input', props);
}

/** <select class="input">. options: strings, or {id|value, label}. */
export function select(name, options, value) {
  const sel = el('select', { class: 'input', name },
    (options || []).map((o) => {
      const v = typeof o === 'object' ? (o.id ?? o.value ?? '') : o;
      const l = typeof o === 'object' ? (o.label ?? String(v)) : titleCase(o);
      return el('option', { value: v, disabled: typeof o === 'object' && o.disabled }, l);
    }));
  if (value !== undefined && value !== null) sel.value = String(value);
  return sel;
}

export function textarea(name, value = '', placeholder = '') {
  const t = el('textarea', { class: 'input', name, placeholder, rows: 3 });
  t.value = value ?? '';
  return t;
}

/** Empty state block. */
export function emptyState({ icon: iconName = 'spark', title, text, action } = {}) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-icon' }, icon(iconName, 22)),
    title ? el('p', { class: 'empty-title' }, title) : null,
    text ? el('p', { class: 'muted' }, text) : null,
    action || null);
}

/* -------------------------------------------------------------- formatting */

const TZ = 'Australia/Brisbane';

export const titleCase = (s) => String(s || '').replace(/(^|[\s_-])\w/g, (m) => m.toUpperCase()).replace(/_/g, ' ');

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
/** "$2,400" (no cents). */
export const money = (n) => AUD.format(Math.round(Number(n) || 0));
/** "1,234" */
export const num = (n) => new Intl.NumberFormat('en-AU').format(Number(n) || 0);
/** "3 leads" / "1 lead" */
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function toDate(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date. Future times read "in 5m". */
export function timeAgo(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const a = Math.abs(s);
  const fmt = (v) => (s < 0 ? `in ${v}` : `${v} ago`);
  if (a < 45) return s < 0 ? 'in a moment' : 'just now';
  if (a < 3600) return fmt(`${Math.round(a / 60)}m`);
  if (a < 86400) return fmt(`${Math.round(a / 3600)}h`);
  if (a < 86400 * 7) return fmt(`${Math.round(a / 86400)}d`);
  return d.toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' });
}

/** "Tue 17 Nov, 2:30 pm" in Brisbane time. */
export function dateTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return d.toLocaleString('en-AU', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  });
}

/** "2:30 pm" in Brisbane time. */
export function timeOnly(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
}

/** YYYY-MM-DD of a moment in Brisbane. */
export function dayKey(iso = new Date()) {
  const d = toDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** "Today", "Yesterday", "Tomorrow", else "Mon 17 Nov". */
export function dayLabel(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const k = dayKey(d);
  const today = dayKey();
  const diff = Math.round((Date.parse(`${k}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

/** +61412345678 → "0412 345 678"; other values unchanged. */
export function prettyPhone(p) {
  const m = /^\+61(4\d{2})(\d{3})(\d{3})$/.exec(p || '');
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  const l = /^\+61([2378])(\d{4})(\d{4})$/.exec(p || '');
  if (l) return `(0${l[1]}) ${l[2]} ${l[3]}`;
  return p || '';
}

/**
 * Copy text to the clipboard. Toasts `label` on success (pass label=false to
 * stay quiet). Resolves true/false.
 */
export async function copyText(text, label = 'Copied') {
  let ok = false;
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    ok = true;
  } catch {
    const t = el('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
    t.value = String(text ?? '');
    document.body.append(t);
    t.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
  }
  if (label !== false) toast(ok ? label : 'Could not copy. Select and copy it by hand.', ok ? 'ok' : 'bad');
  return ok;
}

/** Download a string as a file. */
export function downloadFile(name, text, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** Rows (array of objects) → CSV text with a header from `columns` (or the first row's keys). */
export function toCsv(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formula injection when opened in a spreadsheet
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

/** Wrap a button's async action: disables it, shows a spinner, restores after. */
export async function busy(button, fn) {
  if (!button) return fn();
  const prev = button.disabled;
  button.disabled = true;
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally {
    button.disabled = prev;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}
