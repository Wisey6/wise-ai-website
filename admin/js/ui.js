// Small DOM/formatting toolkit. No framework, no dependencies.

/** Create an element from a tag, props and children. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ------------------------------------------------------------- formatting */

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency', currency: 'AUD', maximumFractionDigits: 0
});
const AUD_CENTS = new Intl.NumberFormat('en-AU', {
  style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2
});

export function money(value, cents = false) {
  const n = Number(value) || 0;
  return cents ? AUD_CENTS.format(n) : AUD.format(n);
}

export function shortMoney(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}m`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

export function dateLabel(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/** Whole days from today to `iso` — negative when overdue. */
export function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

export function dueLabel(iso) {
  const days = daysUntil(iso);
  if (days === null) return '—';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= 30) return `in ${days}d`;
  return shortDate(iso);
}

export const titleCase = (s) =>
  String(s || '').replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());

/* ------------------------------------------------------------------ icons */

const PATHS = {
  overview: '<path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/>',
  pipeline: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="5" height="7" rx="1.5"/>',
  clients:  '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/>',
  work:     '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="M8.5 15.5l2 2 4-4"/>',
  money:    '<path d="M12 2v20"/><path d="M17 6.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.7 5 3.2 5 1.3 5 3.3-2.2 3.5-5 3.5-5-1.3-5-3.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  lock:     '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  edit:     '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/>',
  trash:    '<path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  check:    '<path d="M20 6L9 17l-5-5"/>',
  close:    '<path d="M18 6L6 18M6 6l12 12"/>',
  up:       '<path d="M7 17L17 7M9 7h8v8"/>',
  down:     '<path d="M17 7L7 17M15 17H7V9"/>',
  wallet:   '<path d="M20 12V8H6a2 2 0 010-4h12v4"/><path d="M4 6v12a2 2 0 002 2h14v-4"/><path d="M18 12a2 2 0 000 4h4v-4z"/>',
  clock:    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  target:   '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  invoice:  '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  upload:   '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  inbox:    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>',
  alert:    '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  archive:  '<rect x="2" y="4" width="20" height="5" rx="1.5"/><path d="M4 9v10a2 2 0 002 2h12a2 2 0 002-2V9"/><path d="M10 13h4"/>',
  library:  '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><path d="M9 7h7"/>',
  outputs:  '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 002 2h14a2 2 0 002-2v-2"/>',
  search:   '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'
};

/** Inline SVG icon by name. */
export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/* ---------------------------------------------------------------- widgets */

export function badge(text, tone = '') {
  return el('span', { class: `badge${tone ? ` badge-${tone}` : ''}` },
    el('span', { class: 'badge-dot' }), text);
}

export function chip(text, direction = 'flat') {
  const name = direction === 'up' ? 'up' : direction === 'down' ? 'down' : null;
  return el('span', { class: `chip chip-${direction}` }, name ? icon(name, 11) : null, text);
}

export function emptyState(message, actionLabel, onAction) {
  return el('div', { class: 'empty' },
    icon('inbox', 30),
    el('p', {}, message),
    actionLabel ? el('button', { class: 'btn btn-ghost btn-sm', onClick: onAction }, actionLabel) : null
  );
}

/** Toast notification. */
export function toast(message, tone = 'ok') {
  let wrap = $('.toast-wrap');
  if (!wrap) {
    wrap = el('div', { class: 'toast-wrap' });
    document.body.append(wrap);
  }
  const node = el('div', { class: `toast toast-${tone}` }, message);
  wrap.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, 3200);
}

/**
 * Modal dialog. `fields` render into the body; resolves with the form values,
 * or null if dismissed.
 */
export function modal({ title, body, confirmLabel = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const form = el('form', { class: 'modal-body' }, body);

    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };

    const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'modal-head' },
        el('h2', {}, title),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('close'))
      ),
      form,
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', form: 'modal-form' }, confirmLabel)
      )
    );
    form.id = 'modal-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      close(Object.fromEntries(new FormData(form)));
    });

    const backdrop = el('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(null); } }, dialog);
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    setTimeout(() => form.querySelector('input, select, textarea')?.focus(), 40);
  });
}

/** Labelled form field. */
export function field(label, control) {
  return el('label', { class: 'field' }, el('span', {}, label), control);
}

export function input(name, { type = 'text', value = '', required = false, placeholder = '', step } = {}) {
  return el('input', {
    class: 'input', name, type, value: value ?? '', placeholder,
    required: required || null, step: step || null
  });
}

export function select(name, options, value) {
  return el('select', { class: 'select', name },
    options.map((o) => {
      const opt = el('option', { value: o.id ?? o }, o.label ?? titleCase(o));
      if ((o.id ?? o) === value) opt.selected = true;
      return opt;
    })
  );
}

export function textarea(name, value = '', placeholder = '') {
  return el('textarea', { class: 'textarea', name, placeholder }, value ?? '');
}

/**
 * The edit / archive / delete trio every record row carries.
 * Archive is offered first and deletion is always confirmed, so the
 * destructive path is the deliberate one.
 */
export function recordActions({ label, onEdit, onArchive, onRestore, onDelete, isArchived }) {
  return el('div', { class: 'row-actions' },
    onEdit ? el('button', { class: 'icon-btn', 'aria-label': `Edit ${label}`, onClick: onEdit }, icon('edit')) : null,
    isArchived
      ? el('button', { class: 'icon-btn', 'aria-label': `Restore ${label}`, onClick: onRestore }, icon('up'))
      : el('button', { class: 'icon-btn', 'aria-label': `Archive ${label}`, onClick: onArchive }, icon('archive')),
    onDelete ? el('button', { class: 'icon-btn', 'aria-label': `Delete ${label}`, onClick: onDelete }, icon('trash')) : null
  );
}

export function confirmDialog(title, message) {
  return modal({
    title,
    body: [el('p', { class: 'muted', style: 'font-size:13px;line-height:1.6' }, message)],
    confirmLabel: 'Delete',
    danger: true
  });
}
