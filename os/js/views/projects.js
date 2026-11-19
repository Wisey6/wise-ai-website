// Projects: client jobs and the tasks inside them, plus "My tasks", the daily work list.
import {
  el, clear, fill, icon, badge, toast, modal, confirmDialog, field, input, select, textarea, emptyState,
  money, num, plural, go, busy
} from '../ui.js?v=20261119b';
import { state, saveRow, deleteRow, rowById } from '../api.js?v=20261119b';
import { today, addDays, fmtDate, keyOf } from './roi-reports.js?v=20261119b';
import { ownerPicker, ownerBadge, ownerLabel, ownerName, saveOwner, activeTeam, meId, isMe } from '../owners.js?v=20261119b';
import { linkedFiles } from './files-linked.js?v=20261119b';

/* ============================================================ constants */
export const PROJECT_STATUSES = [
  { id: 'active', label: 'Active', tone: 'ok' },
  { id: 'waiting', label: 'Waiting', tone: 'warn' },
  { id: 'planned', label: 'Planned', tone: 'info' },
  { id: 'done', label: 'Done', tone: 'mute' },
  { id: 'cancelled', label: 'Cancelled', tone: 'mute' }
];
const PSTATUS = Object.fromEntries(PROJECT_STATUSES.map((s) => [s.id, s]));
export const TASK_STATES = [
  { id: 'todo', label: 'To do', next: { id: 'doing', label: 'Start' } },
  { id: 'doing', label: 'In progress', next: { id: 'review', label: 'To review' } },
  { id: 'review', label: 'Needs review', next: { id: 'done', label: 'Done' } },
  { id: 'blocked', label: 'Blocked', next: { id: 'doing', label: 'Unblock' } },
  { id: 'done', label: 'Done', next: { id: 'todo', label: 'Reopen' } }
];
const TSTATE = Object.fromEntries(TASK_STATES.map((s) => [s.id, s]));
export const PRIORITIES = [{ id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' }];
const PRANK = { high: 0, medium: 1, low: 2 };
const OPEN_PROJECT = ['planned', 'active', 'waiting'];
const UUID = /^[0-9a-f-]{36}$/i;

/* ============================================================== helpers */
export const projectBadge = (s) => { const x = PSTATUS[s] || { label: s, tone: 'mute' }; return badge(x.label, x.tone); };
export const taskClientId = (t) => t.client_id || rowById('projects', t.project_id)?.client_id || null;
export const isOpenProject = (p) => !p.archived && OPEN_PROJECT.includes(p.status);
export const isOverdue = (due) => Boolean(due) && due < today();
const bySort = (a, b) => (a.sort - b.sort) || String(a.created_at).localeCompare(String(b.created_at));

/** done/total tasks for a project. */
export function projectProgress(projectId, st = state) {
  const list = st.tasks.filter((t) => t.project_id === projectId);
  return { done: list.filter((t) => t.state === 'done').length, total: list.length };
}

/** Not-done tasks, sorted the way the daily list wants: due date (none last), then priority, then manual order. */
export function sortMyTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const da = a.due_on || '9999-12-31';
    const db = b.due_on || '9999-12-31';
    return da.localeCompare(db) || (PRANK[a.priority] - PRANK[b.priority]) || bySort(a, b);
  });
}

/** Re-focus the control a repaint replaced, and never repaint over text being typed. */
export function guardedPaint(container, paint) {
  let timer = 0;
  const typing = () => {
    const a = document.activeElement;
    return a && container.contains(a) && a.matches('input:not([type=checkbox]):not([type=date]), textarea');
  };
  function run() {
    if (typing()) {
      // Try again once the field is left (polled: a removed field fires no blur).
      if (!timer) timer = setInterval(() => { if (!typing()) { clearInterval(timer); timer = 0; run(); } }, 250);
      return;
    }
    keepFocus(container, paint);
  }
  return run;
}

/** Run a repaint and put keyboard focus back on the control with the same data-fk. */
export function keepFocus(container, paint) {
  const a = document.activeElement;
  const key = a && container.contains(a) ? a.dataset.fk : null;
  paint();
  if (key && !container.contains(document.activeElement)) container.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

const dueLabel = (due) => {
  if (!due) return null;
  const t = today();
  if (due === t) return 'Today';
  if (due === addDays(t, 1)) return 'Tomorrow';
  if (due === addDays(t, -1)) return 'Yesterday';
  return fmtDate(due, { day: 'numeric', month: 'short' });
};

export function progressBar(p) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return el('span', { class: 'dl-progress', title: `${p.done} of ${p.total} tasks done` },
    el('span', { class: 'dl-meter', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })),
    el('span', { class: 'dl-progress-n tnum' }, p.total ? `${p.done}/${p.total}` : 'No tasks'));
}

/* ================================================================ tasks */
async function setTaskState(t, stateId) {
  const patch = { id: t.id, state: stateId, done_at: stateId === 'done' ? new Date().toISOString() : null };
  if (stateId !== 'done' && t.state !== 'done') delete patch.done_at;
  try { await saveRow('tasks', patch); } catch (e) { toast(e.message, 'bad'); }
}

/** Swap a task with its neighbour in the same group. */
async function moveTask(t, dir, group) {
  const list = [...group].sort(bySort);
  const i = list.findIndex((x) => x.id === t.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const changes = list.map((x, k) => ({ x, sort: (k + 1) * 10 })).filter(({ x, sort }) => x.sort !== sort);
  try { await Promise.all(changes.map(({ x, sort }) => saveRow('tasks', { id: x.id, sort }))); } catch (e) { toast(e.message, 'bad'); }
}

/**
 * One task row. opts: group (siblings for reordering), showProject, showClient.
 * Title edits in place (Enter saves, Escape cancels); state, priority and due date save on change.
 */
export function taskRow(t, { group = null, showProject = false, showClient = false } = {}) {
  const done = t.state === 'done';
  const check = el('input', { type: 'checkbox', class: 'check', 'aria-label': `${done ? 'Reopen' : 'Done'}: ${t.title}`, checked: done || null, dataset: { fk: `${t.id}-check` } });
  check.addEventListener('change', () => setTaskState(t, check.checked ? 'done' : 'todo'));

  const titleWrap = el('div', { class: 'dl-task-main' });
  const showTitle = () => {
    const proj = showProject && t.project_id ? rowById('projects', t.project_id) : null;
    const cid = showClient ? taskClientId(t) : null;
    const client = cid ? rowById('clients', cid) : null;
    fill(titleWrap,
      el('button', { type: 'button', class: 'dl-task-title', dataset: { fk: `${t.id}-title` }, title: 'Click to edit', onClick: editTitle }, t.title),
      proj || client ? el('span', { class: 'dl-task-ctx' },
        proj ? el('a', { href: `#projects/${proj.id}` }, proj.name) : null,
        proj && client ? ' · ' : null,
        client ? el('a', { href: `#clients/${client.id}` }, client.name) : null) : null);
  };
  function editTitle() {
    const inp = el('input', { class: 'input sm dl-task-edit', value: t.title, 'aria-label': 'Task title', dataset: { fk: `${t.id}-edit` } });
    let doneEditing = false;
    const finish = async (save) => {
      if (doneEditing) return;
      doneEditing = true;
      const v = inp.value.trim();
      if (save && v && v !== t.title) {
        t = { ...t, title: v };
        showTitle();
        try { await saveRow('tasks', { id: t.id, title: v }); } catch (e) { toast(e.message, 'bad'); }
      } else showTitle();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); titleWrap.querySelector('button')?.focus(); }
    });
    inp.addEventListener('blur', () => finish(true));
    fill(titleWrap, inp);
    inp.focus();
    inp.select();
  }
  showTitle();

  const pri = select('priority', PRIORITIES, t.priority);
  pri.className = `input sm dl-pri is-${t.priority}`;
  pri.setAttribute('aria-label', `Priority: ${t.title}`);
  pri.dataset.fk = `${t.id}-pri`;
  pri.addEventListener('change', async () => { try { await saveRow('tasks', { id: t.id, priority: pri.value }); } catch (e) { toast(e.message, 'bad'); } });

  const due = dueControl(t);
  const owner = taskOwner(t);

  const st = select('state', TASK_STATES.map((s) => ({ id: s.id, label: s.label })), t.state);
  st.classList.add('sm', 'dl-state');
  st.setAttribute('aria-label', `State: ${t.title}`);
  st.dataset.fk = `${t.id}-state`;
  st.addEventListener('change', () => setTaskState(t, st.value));

  const next = TSTATE[t.state]?.next;
  const nextBtn = next && !done ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm dl-next', dataset: { fk: `${t.id}-next` }, onClick: () => setTaskState(t, next.id) }, next.label) : null;

  const order = group && group.length > 1 ? (() => {
    const sorted = [...group].sort(bySort);
    const i = sorted.findIndex((x) => x.id === t.id);
    return el('span', { class: 'dl-order' },
      el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Move up: ${t.title}`, disabled: i <= 0 || null, dataset: { fk: `${t.id}-up` }, onClick: () => moveTask(t, -1, group) }, el('span', { class: 'dl-rot' }, icon('chevron', 15))),
      el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Move down: ${t.title}`, disabled: i >= sorted.length - 1 || null, dataset: { fk: `${t.id}-down` }, onClick: () => moveTask(t, 1, group) }, el('span', { class: 'dl-rot is-down' }, icon('chevron', 15))));
  })() : null;

  const del = el('button', {
    type: 'button', class: 'icon-btn sm dl-del', 'aria-label': `Delete task: ${t.title}`,
    onClick: async () => {
      if (!await confirmDialog('Delete this task?', `“${t.title}” goes for good.`)) return;
      try { await deleteRow('tasks', t.id); toast('Task deleted'); } catch (e) { toast(e.message, 'bad'); }
    }
  }, icon('trash', 14));

  return el('li', { class: `dl-task${done ? ' is-done' : ''}`, dataset: { id: t.id, state: t.state } },
    check, titleWrap,
    el('div', { class: 'dl-task-ctl' }, nextBtn, el('span', { class: 'dl-od' }, owner, due), pri, st, order, del));
}

/** The task's owner: one click to change. */
export function taskOwner(t) {
  const p = ownerPicker({
    value: t.owner_id || null, compact: true, label: `Owner: ${t.title}`,
    onChange: (id) => saveOwner('tasks', t.id, id)
  });
  p.dataset.fk = `${t.id}-owner`;
  return p;
}

/**
 * The due date as a word ("Today", "12 Dec") or "TBC" when there is none. The real
 * date input sits over the label: one click opens the date picker; focused, it shows
 * the date fields for typing.
 */
export function dueControl(t, { onSave = null } = {}) {
  const done = t.state === 'done';
  const over = !done && isOverdue(t.due_on);
  const label = el('span', { class: 'dl-due-label', 'aria-hidden': 'true' }, t.due_on ? dueLabel(t.due_on) : 'TBC');
  const inp = el('input', { type: 'date', class: 'dl-due-input', value: t.due_on || '', 'aria-label': `Due date: ${t.title}${t.due_on ? '' : ' (to be confirmed)'}`, dataset: { fk: `${t.id}-due` } });
  inp.addEventListener('click', () => { try { inp.showPicker?.(); } catch { /* not allowed here */ } });
  inp.addEventListener('change', async () => {
    const v = inp.value || null;
    label.textContent = v ? dueLabel(v) : 'TBC';
    wrap.classList.toggle('is-tbc', !v);
    try { if (onSave) await onSave(v); else await saveRow('tasks', { id: t.id, due_on: v }); } catch (e) { toast(e.message, 'bad'); }
  });
  const wrap = el('span', { class: `dl-due-wrap${t.due_on ? '' : ' is-tbc'}${over ? ' is-overdue' : ''}`, title: t.due_on ? `Due ${fmtDate(t.due_on)}` : 'Date to be confirmed. Click to set one' }, label, inp);
  return wrap;
}

/** Quick-add: type a task and press Enter. `defaults` sets project/client/state. */
export function quickAdd(defaults = {}, { placeholder = 'Add a task and press Enter', clientPicker = false, ownerDefault = null } = {}) {
  const inp = input('new-task', { placeholder, 'aria-label': 'New task', autocomplete: 'off' });
  inp.dataset.fk = 'quick-add';
  const cSel = clientPicker ? select('new-task-client', [{ id: '', label: 'No client' }, ...state.clients.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name }))], defaults.client_id || '') : null;
  if (cSel) { cSel.setAttribute('aria-label', 'Client for the new task'); cSel.classList.add('dl-qa-client'); }
  const dueIn = el('input', { type: 'date', class: 'input dl-qa-due', 'aria-label': 'Due date for the new task (leave empty for TBC)', title: 'Leave empty for TBC' });
  // New tasks go to the project's owner, else the person adding them (or whoever My tasks is showing).
  const defOwner = () => (ownerDefault ? ownerDefault() : undefined) ?? (defaults.project_id ? rowById('projects', defaults.project_id)?.owner_id : null) ?? meId();
  let ownerTouched = false;
  const ownPick = ownerPicker({ value: defOwner(), compact: true, label: 'Owner of the new task', onChange: () => { ownerTouched = true; } });
  ownPick.classList.add('dl-qa-owner');
  inp.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const title = inp.value.trim();
    if (!title) return;
    const sibling = state.tasks.filter((t) => t.state === 'todo' && (defaults.project_id ? t.project_id === defaults.project_id : !t.project_id));
    const sort = sibling.reduce((m, t) => Math.max(m, t.sort || 0), 0) + 10;
    inp.value = '';
    try {
      await saveRow('tasks', {
        title, state: 'todo', priority: 'medium', sort,
        project_id: defaults.project_id || null,
        client_id: (cSel ? cSel.value : defaults.client_id) || null,
        due_on: dueIn.value || null,
        owner_id: ownPick.value || null
      });
      dueIn.value = '';
      ownerTouched = false;
      ownPick.setValue(defOwner());
    } catch (err) { inp.value = title; toast(err.message, 'bad'); }
    inp.focus();
  });
  const node = el('div', { class: 'dl-qa' }, el('span', { class: 'dl-qa-icon', 'aria-hidden': 'true' }, icon('plus', 16)), inp, cSel, ownPick, dueIn);
  node.syncOwner = () => { if (!ownerTouched) ownPick.setValue(defOwner()); };
  return node;
}

/* ======================================================== project forms */
export async function openProjectForm(clientId = '') {
  const clients = state.clients.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  const v = await modal({
    title: 'New project', confirmLabel: 'Create project', wide: true,
    body: el('div', { class: 'form-grid' },
      el('div', { class: 'full' }, field('Name', input('name', { required: true, placeholder: 'e.g. Missed-call text-back', autocomplete: 'off' }))),
      field('Client', select('client_id', [{ id: '', label: 'No client yet' }, ...clients.map((c) => ({ id: c.id, label: c.name }))], clientId)),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Owner'), ownerPicker({ value: meId(), name: 'owner_id', label: 'Project owner' })),
      field('Status', select('status', PROJECT_STATUSES.filter((s) => s.id !== 'cancelled').map((s) => ({ id: s.id, label: s.label })), 'active')),
      field('Start', input('started_on', { type: 'date', value: today() })),
      field('Due', input('due_on', { type: 'date' })),
      field('Value', input('value', { type: 'number', min: 0, step: 50, inputmode: 'decimal', placeholder: '0' }), 'One-off price for the job, $'),
      el('div', { class: 'full' }, field('What it is', textarea('description', '', 'What you are building and what it should change for them'))))
  });
  if (!v) return null;
  try {
    const row = await saveRow('projects', {
      name: v.name.trim(), client_id: v.client_id || null, status: v.status, started_on: v.started_on || null,
      due_on: v.due_on || null, value: Number(v.value) || 0, description: v.description.trim() || null,
      owner_id: v.owner_id || null
    });
    toast('Project created');
    go(`projects/${row.id}`);
    return row;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

/** After a project is marked done: offer the ROI report. */
async function offerReport(p) {
  if (!p.client_id) { toast('Project done'); return; }
  const c = rowById('clients', p.client_id);
  const open = state.tasks.filter((t) => t.project_id === p.id && t.state !== 'done').length;
  const ok = await modal({
    title: 'Project done',
    body: [el('p', { class: 'confirm-text' }, `Nice work. Now show ${c?.name || 'the client'} what it is worth: write the ROI report while the numbers are fresh.`),
      open ? el('p', { class: 'small muted' }, `${plural(open, 'task')} still open on this project.`) : null],
    confirmLabel: 'Write the ROI report', cancelLabel: 'Not now'
  });
  if (ok) go(`roi-reports/new/${p.client_id}`);
}

export async function setProjectStatus(p, status) {
  try {
    await saveRow('projects', { id: p.id, status });
    if (status === 'done' && p.status !== 'done') await offerReport({ ...p, status });
    else toast(`Moved to ${PSTATUS[status].label}`);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ================================================================ view */
const TV_KEY = 'wiseos.tasks.view';
const storeGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const ui = {
  q: '', client: '', archived: false, taskClient: '',
  taskView: storeGet(TV_KEY, 'list'),          // project tasks: 'list' | 'table'
  groupBy: storeGet(`${TV_KEY}.group`, 'status'), // list grouping: 'status' | 'person'
  tsort: { key: 'due', dir: 1 },                // table sort
  person: 'me'                                  // My tasks: 'me' | <member id> | 'all' | 'none'
};

/** Which tasks a My tasks person choice shows. */
export function tasksFor(person, tasks, me = meId()) {
  if (person === 'all') return tasks;
  if (person === 'none') return tasks.filter((t) => !t.owner_id);
  const id = person === 'me' ? me : person;
  return tasks.filter((t) => t.owner_id === id);
}

/** Open and overdue counts per owner (null = nobody yet). Pure. */
export function workload(tasks, t0 = today()) {
  const out = new Map();
  for (const t of tasks) {
    if (t.state === 'done') continue;
    const k = t.owner_id || null;
    const w = out.get(k) || { open: 0, overdue: 0, blocked: 0 };
    w.open++;
    if (t.due_on && t.due_on < t0) w.overdue++;
    if (t.state === 'blocked') w.blocked++;
    out.set(k, w);
  }
  return out;
}

const TABLE_SORT = {
  title: (a, b) => a.title.localeCompare(b.title),
  owner: (a, b) => ownerName(a.owner_id).localeCompare(ownerName(b.owner_id)),
  state: (a, b) => TASK_STATES.findIndex((s) => s.id === a.state) - TASK_STATES.findIndex((s) => s.id === b.state),
  due: (a, b) => String(a.due_on || '9999').localeCompare(String(b.due_on || '9999')),
  priority: (a, b) => PRANK[a.priority] - PRANK[b.priority]
};
/** Sort tasks for the table: by a column, then due date, then manual order. Pure. */
export function sortTaskTable(tasks, key = 'due', dir = 1) {
  const f = TABLE_SORT[key] || TABLE_SORT.due;
  return [...tasks].sort((a, b) => (f(a, b) * dir) || TABLE_SORT.due(a, b) || bySort(a, b));
}

export default function projectsView(ctx) {
  const { param } = ctx;
  if (param === 'tasks') return myTasksView();
  if (param && param.startsWith('new')) {
    const cid = param.split('/')[1] || '';
    history.replaceState(null, '', '#projects');
    const node = overview();
    setTimeout(() => openProjectForm(cid), 0);
    return node;
  }
  if (param && UUID.test(param)) return projectPage(param);
  return overview();
}

function areaTabs(active) {
  return el('nav', { class: 'tabs dl-tabs', 'aria-label': 'Projects or tasks' },
    el('a', { class: `tab${active === 'projects' ? ' is-active' : ''}`, href: '#projects', 'aria-current': active === 'projects' ? 'page' : null }, 'Projects'),
    el('a', { class: `tab${active === 'tasks' ? ' is-active' : ''}`, href: '#projects/tasks', 'aria-current': active === 'tasks' ? 'page' : null }, 'My tasks',
      el('span', { class: 'count' }, num(tasksFor('me', state.tasks.filter((t) => t.state !== 'done')).length))));
}

function overview() {
  const st = state;
  const root = el('div', { class: 'page dl-page' });
  const tabsBox = el('div');
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Deliver'), el('h1', { class: 'h1' }, 'Projects')),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openProjectForm() }, icon('plus', 16), 'New project')));
  const kpis = el('div');
  const search = input('q', { type: 'search', value: ui.q, placeholder: 'Search projects', 'aria-label': 'Search projects', autocomplete: 'off' });
  search.addEventListener('input', () => { ui.q = search.value.trim().toLowerCase(); paint(); });
  const cSel = el('select', { class: 'input sm', 'aria-label': 'Client' });
  cSel.addEventListener('change', () => { ui.client = cSel.value; paint(); });
  const arch = el('label', { class: 'check-row small' }, el('input', { type: 'checkbox', class: 'check', checked: ui.archived || null, onChange: (e) => { ui.archived = e.target.checked; paint(); } }), 'Archived');
  const bar = el('div', { class: 'toolbar dl-bar' }, el('label', { class: 'search' }, icon('search', 16), search), cSel, el('span', { class: 'spacer' }), arch);
  const content = el('div', { class: 'dl-groups' });
  root.append(head, tabsBox, kpis, bar, content);

  function paint() {
    fill(tabsBox, areaTabs('projects'));
    const t0 = today();
    const weekEnd = addDays(t0, 7);
    const live = st.projects.filter((p) => !p.archived);
    const open = st.tasks.filter((t) => t.state !== 'done');
    fill(kpis, el('div', { class: 'grid cols-4 dl-kpis' },
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Active projects'), el('span', { class: 'kpi-value', dataset: { k: 'active' } }, num(live.filter((p) => p.status === 'active').length)),
        el('span', { class: 'kpi-sub' }, `${num(live.filter((p) => p.status === 'waiting').length)} waiting, ${num(live.filter((p) => p.status === 'planned').length)} planned`)),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Open tasks'), el('span', { class: 'kpi-value', dataset: { k: 'open' } }, num(open.length)), el('span', { class: 'kpi-sub' }, `${num(open.filter((t) => t.state === 'blocked').length)} blocked`)),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Due this week'), el('span', { class: 'kpi-value', dataset: { k: 'week' } }, num(open.filter((t) => t.due_on && t.due_on >= t0 && t.due_on <= weekEnd).length)), el('span', { class: 'kpi-sub' }, 'tasks')),
      el('a', { class: 'kpi', href: '#projects/tasks' }, el('span', { class: 'kpi-label' }, 'Overdue'), el('span', { class: `kpi-value${open.some((t) => isOverdue(t.due_on)) ? ' dl-warn' : ''}`, dataset: { k: 'overdue' } }, num(open.filter((t) => isOverdue(t.due_on)).length)), el('span', { class: 'kpi-sub' }, 'tasks past their date'))));

    const cur = ui.client;
    const withProjects = st.clients.filter((c) => st.projects.some((p) => p.client_id === c.id)).sort((a, b) => a.name.localeCompare(b.name));
    fill(cSel, el('option', { value: '' }, 'All clients'), withProjects.map((c) => el('option', { value: c.id }, c.name)));
    cSel.value = cur;

    const list = st.projects.filter((p) => (ui.archived ? p.archived : !p.archived)
      && (!ui.client || p.client_id === ui.client)
      && (!ui.q || `${p.name} ${rowById('clients', p.client_id)?.name || ''} ${p.description || ''}`.toLowerCase().includes(ui.q)));
    clear(content);
    if (!st.projects.length) {
      content.append(emptyState({
        icon: 'deliver', title: 'No projects yet',
        text: 'A project is one client job: what you are building, when it is due, what it is worth, and the tasks inside it.',
        action: el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openProjectForm() }, icon('plus', 16), 'Start a project'),
          el('a', { class: 'btn btn-ghost', href: '#projects/tasks' }, 'Or just add tasks'))
      }));
      return;
    }
    if (!list.length) { content.append(emptyState({ icon: 'search', title: 'Nothing matches', text: ui.archived ? 'No archived projects.' : 'Try another search or client.' })); return; }
    const sortProjects = (a, b) => String(a.due_on || '9999').localeCompare(String(b.due_on || '9999')) || a.name.localeCompare(b.name);
    for (const s of PROJECT_STATUSES) {
      const items = list.filter((p) => p.status === s.id).sort(sortProjects);
      if (!items.length) continue;
      const rows = el('ul', { class: 'dl-plist' }, items.map(projectLine));
      const headNode = el('div', { class: 'dl-group-head' }, projectBadge(s.id), el('span', { class: 'count' }, num(items.length)));
      if (s.id === 'done' || s.id === 'cancelled') {
        content.append(el('details', { class: 'dl-group', dataset: { status: s.id } }, el('summary', {}, headNode), rows));
      } else content.append(el('section', { class: 'dl-group', dataset: { status: s.id } }, headNode, rows));
    }
  }
  paint();
  root.onState = paint;
  return root;
}

function projectLine(p) {
  const c = rowById('clients', p.client_id);
  const prog = projectProgress(p.id);
  const over = isOpenProject(p) && isOverdue(p.due_on);
  return el('li', { class: 'dl-pline', dataset: { id: p.id } },
    el('div', { class: 'dl-pline-main' },
      el('a', { class: 'dl-name', href: `#projects/${p.id}` }, p.name),
      el('span', { class: 'dl-sub' }, c ? el('a', { href: `#clients/${c.id}` }, c.name) : el('span', { class: 'faint' }, 'No client'))),
    el('span', { class: 'dl-pline-owner' }, ownerBadge(p.owner_id, { size: 'md' })),
    el('span', { class: `dl-pline-due small${over ? ' dl-warn' : ''}` }, p.due_on ? [over ? 'Overdue · ' : 'Due ', fmtDate(p.due_on, { day: 'numeric', month: 'short' })] : el('span', { class: 'faint' }, 'No due date')),
    el('span', { class: 'dl-pline-val tnum' }, p.value ? money(p.value) : el('span', { class: 'faint' }, '—')),
    progressBar(prog));
}

/* ========================================================== task table */
/** A sortable table of tasks: Task, Owner, Status, Due, Priority. Every cell edits in place. */
export function taskTable(tasks, repaint, { showProject = false } = {}) {
  const cols = [['title', 'Task'], ['owner', 'Owner'], ['state', 'Status'], ['due', 'Due'], ['priority', 'Priority']];
  const rows = sortTaskTable(tasks, ui.tsort.key, ui.tsort.dir);
  const th = ([key, label]) => {
    const on = ui.tsort.key === key;
    return el('th', { scope: 'col', class: `dl-tt-${key}`, 'aria-sort': on ? (ui.tsort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      el('button', {
        type: 'button', class: `dl-sort${on ? ' is-on' : ''}`, dataset: { sort: key },
        onClick: () => { ui.tsort = { key, dir: on ? -ui.tsort.dir : 1 }; repaint(); }
      }, label, el('span', { class: `dl-sort-ic${on && ui.tsort.dir < 0 ? ' is-desc' : ''}`, 'aria-hidden': 'true' }, on ? icon('chevron', 12) : null)));
  };
  const body = rows.map((t) => {
    const done = t.state === 'done';
    const check = el('input', { type: 'checkbox', class: 'check', 'aria-label': `${done ? 'Reopen' : 'Done'}: ${t.title}`, checked: done || null, dataset: { fk: `${t.id}-tcheck` } });
    check.addEventListener('change', () => setTaskState(t, check.checked ? 'done' : 'todo'));
    const st = select('state', TASK_STATES.map((x) => ({ id: x.id, label: x.label })), t.state);
    st.classList.add('sm', 'dl-state');
    st.setAttribute('aria-label', `State: ${t.title}`);
    st.dataset.fk = `${t.id}-tstate`;
    st.addEventListener('change', () => setTaskState(t, st.value));
    const pri = select('priority', PRIORITIES, t.priority);
    pri.className = `input sm dl-pri is-${t.priority}`;
    pri.setAttribute('aria-label', `Priority: ${t.title}`);
    pri.dataset.fk = `${t.id}-tpri`;
    pri.addEventListener('change', async () => { try { await saveRow('tasks', { id: t.id, priority: pri.value }); } catch (e) { toast(e.message, 'bad'); } });
    const proj = showProject && t.project_id ? rowById('projects', t.project_id) : null;
    return el('tr', { class: `dl-trow${done ? ' is-done' : ''}`, dataset: { id: t.id, state: t.state } },
      el('td', { class: 'dl-tt-title' }, el('div', { class: 'dl-tt-cell' }, check,
        el('span', { class: 'dl-tt-name' }, el('span', { class: 'dl-task-title is-static' }, t.title),
          proj ? el('a', { class: 'dl-task-ctx', href: `#projects/${proj.id}` }, proj.name) : null))),
      el('td', { class: 'dl-tt-owner', 'data-label': 'Owner' }, taskOwner(t), el('span', { class: 'dl-tt-ownername small' }, ownerName(t.owner_id, { you: true }))),
      el('td', { class: 'dl-tt-state', 'data-label': 'Status' }, st),
      el('td', { class: 'dl-tt-due', 'data-label': 'Due' }, dueControl(t)),
      el('td', { class: 'dl-tt-priority', 'data-label': 'Priority' }, pri));
  });
  return el('div', { class: 'table-wrap dl-ttable-wrap' },
    el('table', { class: 'table dl-ttable', 'aria-label': 'Tasks' },
      el('thead', {}, el('tr', {}, cols.map(th))),
      el('tbody', {}, body)));
}

/* ============================================================ my tasks */
function myTasksView() {
  const st = state;
  const root = el('div', { class: 'page dl-page' });
  const tabsBox = el('div');
  const titleH = el('h1', { class: 'h1' }, 'My tasks');
  const lede = el('p', { class: 'muted dl-lede' });
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Deliver'), titleH, lede));
  const cSel = el('select', { class: 'input sm', 'aria-label': 'Filter by client' });
  cSel.addEventListener('change', () => { ui.taskClient = cSel.value; paint(); });
  // A new task belongs to whoever the list is showing (you, unless you picked someone else).
  const qa = quickAdd({}, {
    placeholder: 'Add a task and press Enter', clientPicker: true,
    ownerDefault: () => (ui.person === 'me' || ui.person === 'all' ? meId() : ui.person === 'none' ? null : ui.person)
  });
  const switcher = el('div', { class: 'dl-people', role: 'group', 'aria-label': 'Whose tasks' });
  const strip = el('div', { class: 'dl-load', 'aria-label': 'Workload: open and overdue tasks per person' });
  const bar = el('div', { class: 'toolbar dl-bar' }, el('span', { class: 'small muted' }, 'Show'), cSel);
  const list = el('div', { class: 'dl-tasks-wrap' });
  root.append(head, tabsBox, switcher, strip, qa, bar, list);

  const pick = (v) => { ui.person = v; paint(); qa.syncOwner?.(); switcher.querySelector(`[data-person="${CSS.escape(v)}"]`)?.focus(); };

  function paint() {
    fill(tabsBox, areaTabs('tasks'));
    const open = st.tasks.filter((t) => t.state !== 'done');
    const t0 = today();
    const team = activeTeam();
    if (ui.person !== 'me' && ui.person !== 'all' && ui.person !== 'none' && !team.some((m) => m.id === ui.person)) ui.person = 'me';
    const others = team.filter((m) => !isMe(m.id));
    const opts = [
      ['me', 'Me', null],
      ...others.map((m) => [m.id, m.name, m.id]),
      ['all', 'Everyone', undefined],
      ['none', 'Unassigned', undefined]
    ];
    fill(switcher, opts.map(([v, label, oid]) => {
      const n = tasksFor(v, open).length;
      const on = ui.person === v;
      return el('button', { type: 'button', class: `dl-person${on ? ' is-active' : ''}`, 'aria-pressed': String(on), dataset: { person: v }, onClick: () => pick(v) },
        v === 'me' ? ownerBadge(meId(), { size: 'sm', title: false }) : oid ? ownerBadge(oid, { size: 'sm', title: false }) : null,
        el('span', {}, label), el('span', { class: 'count' }, num(n)));
    }));

    // Workload: everyone with open work, plus nobody yet.
    const load = workload(st.tasks, t0);
    const ids = [...team.map((m) => m.id), ...[...load.keys()].filter((k) => k && !team.some((m) => m.id === k)), null].filter((k) => k !== null || load.has(null));
    const max = Math.max(1, ...ids.map((k) => load.get(k)?.open || 0));
    fill(strip, ids.map((k) => {
      const w = load.get(k) || { open: 0, overdue: 0 };
      const v = k === null ? 'none' : isMe(k) ? 'me' : k;
      return el('button', { type: 'button', class: `dl-load-item${ui.person === v ? ' is-active' : ''}`, dataset: { owner: k || 'none' }, onClick: () => pick(v),
        'aria-label': `${ownerName(k)}: ${plural(w.open, 'open task')}${w.overdue ? `, ${w.overdue} overdue` : ''}` },
        ownerBadge(k, { size: 'md', title: false }),
        el('span', { class: 'dl-load-text' },
          el('span', { class: 'dl-load-name' }, ownerName(k, { you: true })),
          el('span', { class: 'dl-load-n tnum' }, el('b', {}, num(w.open)), ' open', w.overdue ? el('span', { class: 'dl-warn' }, ` · ${num(w.overdue)} overdue`) : null)),
        el('span', { class: 'dl-load-bar', 'aria-hidden': 'true' },
          el('i', { style: `width:${Math.round((w.open / max) * 100)}%` }),
          w.overdue ? el('i', { class: 'is-over', style: `width:${Math.round((w.overdue / max) * 100)}%` }) : null));
    }));

    const who = ui.person === 'me' ? 'You' : ui.person === 'all' ? 'Everyone' : ui.person === 'none' ? 'Nobody yet' : ownerName(ui.person);
    titleH.textContent = ui.person === 'me' ? 'My tasks' : ui.person === 'all' ? 'Everyone\'s tasks' : ui.person === 'none' ? 'Unassigned tasks' : `${who}'s tasks`;
    lede.textContent = ui.person === 'none'
      ? 'Work nobody owns yet. Give each one an owner so it does not drift.'
      : 'Everything not done, across every project. Soonest due first, then priority.';

    const mine = tasksFor(ui.person, open);
    const cur = ui.taskClient;
    const cids = new Set(mine.map(taskClientId).filter(Boolean));
    fill(cSel, el('option', { value: '' }, 'All clients'), el('option', { value: 'none' }, 'No client'),
      st.clients.filter((c) => cids.has(c.id) || c.id === cur).sort((a, b) => a.name.localeCompare(b.name)).map((c) => el('option', { value: c.id }, c.name)));
    cSel.value = cur;
    const shown = sortMyTasks(mine.filter((t) => !ui.taskClient || (ui.taskClient === 'none' ? !taskClientId(t) : taskClientId(t) === ui.taskClient)));
    clear(list);
    if (!mine.length) {
      list.append(emptyState({
        icon: 'check',
        title: ui.person === 'me' ? 'Nothing on your list' : ui.person === 'none' ? 'Every task has an owner' : `Nothing on ${who === 'Everyone' ? 'anyone' : who}'s list`,
        text: ui.person === 'me' ? 'Type a task above and press Enter. Add a client or a date if it has one, or leave the date as TBC.' : 'Type a task above to give them one.'
      }));
      return;
    }
    if (!shown.length) { list.append(emptyState({ icon: 'search', title: 'Nothing for that client', text: 'Every task for them is done.' })); return; }
    const buckets = [
      ['Overdue', (t) => t.due_on && t.due_on < t0],
      ['Today', (t) => t.due_on === t0],
      ['Next 7 days', (t) => t.due_on && t.due_on > t0 && t.due_on <= addDays(t0, 7)],
      ['Later', (t) => t.due_on && t.due_on > addDays(t0, 7)],
      ['No date', (t) => !t.due_on]
    ];
    for (const [label, fn] of buckets) {
      const items = shown.filter(fn);
      if (!items.length) continue;
      list.append(el('section', { class: 'dl-tgroup', dataset: { bucket: label } },
        el('div', { class: 'dl-group-head' }, el('span', { class: `dl-tg-label${label === 'Overdue' ? ' dl-warn' : ''}` }, label === 'No date' ? 'Date TBC' : label), el('span', { class: 'count' }, num(items.length))),
        el('ul', { class: 'dl-tasks' }, items.map((t) => taskRow(t, { showProject: true, showClient: true })))));
    }
  }
  paint();
  root.onState = guardedPaint(list, paint);
  return root;
}

/* ========================================================= project page */
function projectPage(id) {
  const st = state;
  const root = el('div', { class: 'page dl-page' });
  const p0 = rowById('projects', id);
  if (!p0) {
    root.append(el('a', { href: '#projects', class: 'dl-back' }, icon('chevron-left', 15), 'Projects'),
      emptyState({ icon: 'alert', title: 'That project is not here', text: 'It may have been deleted.', action: el('a', { class: 'btn btn-ghost', href: '#projects' }, 'Back to projects') }));
    return root;
  }
  const eyebrow = el('p', { class: 'eyebrow' });
  const h1 = el('h1', { class: 'h1' });
  const sub = el('div', { class: 'dl-headsub' });
  const ownerBox = el('span', { class: 'dl-powner' });
  const actions = el('div', { class: 'row' });
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('a', { href: '#projects', class: 'dl-back' }, icon('chevron-left', 15), 'Projects'), eyebrow, h1, sub), actions);
  const tasksBox = el('div', { class: 'dl-taskgroups' });
  const viewBar = el('div', { class: 'dl-viewbar' });
  const qaNode = quickAdd({ project_id: id, client_id: p0.client_id });
  const details = detailsForm();
  root.append(head, el('div', { class: 'dl-split' },
    el('div', { class: 'dl-main' },
      el('section', { class: 'section' },
        el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Tasks'), el('h2', { class: 'h2' }, 'What is left to do')), viewBar),
        qaNode,
        tasksBox)),
    el('aside', { class: 'dl-side' }, details.node, linkedFiles('project', id))));

  function paintHead() {
    const p = rowById('projects', id);
    if (!p) return;
    const c = rowById('clients', p.client_id);
    eyebrow.textContent = `Project${p.archived ? ' · archived' : ''}`;
    h1.textContent = p.name;
    const prog = projectProgress(id);
    if (!ownerBox.firstChild || ownerBox.firstChild.dataset.for !== p.id) {
      const op = ownerPicker({ value: p.owner_id || null, label: 'Project owner', onChange: (oid) => saveOwner('projects', id, oid) });
      op.dataset.for = p.id;
      op.dataset.fk = 'powner';
      fill(ownerBox, op);
    } else ownerBox.firstChild.setValue(p.owner_id || null);
    fill(sub, projectBadge(p.status), ownerBox,
      c ? el('a', { href: `#clients/${c.id}` }, icon('user', 13), c.name) : el('span', { class: 'faint' }, 'No client'),
      p.due_on ? el('span', { class: isOpenProject(p) && isOverdue(p.due_on) ? 'dl-warn' : '' }, `Due ${fmtDate(p.due_on)}`) : null,
      p.value ? el('span', { class: 'tnum' }, money(p.value)) : null,
      progressBar(prog));
    const stSel = select('status', PROJECT_STATUSES.map((s) => ({ id: s.id, label: s.label })), p.status);
    stSel.classList.add('sm');
    stSel.style.width = 'auto';
    stSel.setAttribute('aria-label', 'Project status');
    stSel.dataset.fk = 'pstatus';
    stSel.addEventListener('change', () => setProjectStatus(rowById('projects', id), stSel.value));
    fill(actions,
      stSel,
      p.status !== 'done' ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { fk: 'pdone' }, onClick: () => setProjectStatus(rowById('projects', id), 'done') }, icon('check', 14), 'Mark done')
        : (p.client_id ? el('a', { class: 'btn btn-ghost btn-sm', href: `#roi-reports/new/${p.client_id}` }, icon('spark', 14), 'Write the ROI report') : null),
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'parch' }, onClick: async () => {
          try { await saveRow('projects', { id, archived: !p.archived }); toast(p.archived ? 'Restored' : 'Archived'); } catch (e) { toast(e.message, 'bad'); }
        }
      }, icon('archive', 14), p.archived ? 'Restore' : 'Archive'),
      el('button', {
        type: 'button', class: 'icon-btn', 'aria-label': 'Delete project', title: 'Delete project', onClick: async () => {
          const n = st.tasks.filter((t) => t.project_id === id).length;
          if (!await confirmDialog(`Delete ${p.name}?`, `${n ? `Its ${plural(n, 'task')} ${n === 1 ? 'is' : 'are'} deleted with it. ` : ''}Invoices linked to it keep their record but lose the link. Archive it instead to keep everything.`)) return;
          try { await deleteRow('projects', id); toast('Project deleted'); go('projects'); } catch (e) { toast(e.message, 'bad'); }
        }
      }, icon('trash', 16)));
  }

  const seg = (name, value, opts, onPick) => el('div', { class: 'own-scope dl-seg', role: 'group', 'aria-label': name, dataset: { seg: name.toLowerCase().replace(/\s+/g, '-') } },
    opts.map(([v, label]) => el('button', { type: 'button', class: `own-scope-btn${value === v ? ' is-active' : ''}`, 'aria-pressed': String(value === v), dataset: { v }, onClick: () => onPick(v) }, label)));
  function paintViewBar() {
    fill(viewBar,
      ui.taskView === 'list' ? seg('Group by', ui.groupBy, [['status', 'Status'], ['person', 'Person']], (v) => { ui.groupBy = v; storeSet(`${TV_KEY}.group`, v); paintViewBar(); paintTasks(); }) : null,
      seg('Layout', ui.taskView, [['list', 'List'], ['table', 'Table']], (v) => { ui.taskView = v; storeSet(TV_KEY, v); paintViewBar(); paintTasks(); }));
  }
  paintViewBar();

  function paintTasks() {
    const all = st.tasks.filter((t) => t.project_id === id);
    qaNode.syncOwner?.();
    clear(tasksBox);
    if (!all.length) {
      tasksBox.append(el('p', { class: 'dl-none' }, 'No tasks yet. Type the first one above and press Enter.'));
      return;
    }
    if (ui.taskView === 'table') { tasksBox.append(taskTable(all, () => paintTasks())); return; }
    if (ui.groupBy === 'person') {
      const people = [...activeTeam().map((m) => m.id), ...new Set(all.map((t) => t.owner_id).filter((o) => o && !activeTeam().some((m) => m.id === o))), null];
      for (const pid of people) {
        const items = all.filter((t) => (t.owner_id || null) === pid).sort((a, b) => (a.state === 'done') - (b.state === 'done') || bySort(a, b));
        if (!items.length) continue;
        const open = items.filter((t) => t.state !== 'done').length;
        tasksBox.append(el('section', { class: 'dl-tgroup dl-pgroup', dataset: { owner: pid || 'none' } },
          el('div', { class: 'dl-group-head' }, ownerLabel(pid, { size: 'sm' }), el('span', { class: 'count' }, num(open)), open !== items.length ? el('span', { class: 'small faint' }, `${num(items.length - open)} done`) : null),
          el('ul', { class: 'dl-tasks' }, items.map((t) => taskRow(t)))));
      }
      return;
    }
    for (const s of TASK_STATES) {
      const items = all.filter((t) => t.state === s.id).sort(bySort);
      if (!items.length) continue;
      const body = el('ul', { class: 'dl-tasks' }, items.map((t) => taskRow(t, { group: items })));
      const headNode = el('div', { class: 'dl-group-head' }, el('span', { class: 'dl-tg-label' }, s.label), el('span', { class: 'count' }, num(items.length)));
      tasksBox.append(s.id === 'done'
        ? el('details', { class: 'dl-tgroup', dataset: { state: s.id }, open: items.length <= 5 || null }, el('summary', {}, headNode), body)
        : el('section', { class: 'dl-tgroup', dataset: { state: s.id } }, headNode, body));
    }
  }

  function detailsForm() {
    const p = p0;
    const deals = st.deals.filter((d) => !p.client_id || d.client_id === p.client_id || d.id === p.deal_id);
    const fields = {
      name: input('name', { value: p.name }),
      client_id: select('client_id', [{ id: '', label: 'No client' }, ...st.clients.filter((c) => !c.archived || c.id === p.client_id).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name }))], p.client_id || ''),
      started_on: input('started_on', { type: 'date', value: p.started_on || '' }),
      due_on: input('due_on', { type: 'date', value: p.due_on || '' }),
      value: input('value', { type: 'number', min: 0, step: 50, value: p.value ?? 0, inputmode: 'decimal' }),
      deal_id: select('deal_id', [{ id: '', label: 'No deal' }, ...deals.map((d) => ({ id: d.id, label: d.title }))], p.deal_id || ''),
      description: textarea('description', p.description || '', 'What you are building and what it should change for them')
    };
    fields.description.rows = 5;
    const status = el('span', { class: 'small muted', role: 'status' });
    const dealLink = el('div', { class: 'small' });
    const paintDeal = () => {
      const d = rowById('deals', rowById('projects', id)?.deal_id);
      fill(dealLink, d ? el('a', { href: `#pipeline/${d.id}`, class: 'link-btn' }, `Open the deal: ${d.title}`) : null);
    };
    for (const [k, node] of Object.entries(fields)) {
      node.dataset.fk = `d-${k}`;
      node.addEventListener('change', async () => {
        let v = node.value;
        if (k === 'name') { v = v.trim(); if (!v) { node.value = rowById('projects', id)?.name || ''; toast('A project needs a name', 'warn'); return; } }
        if (k === 'value') v = Number(v) || 0;
        else if (k !== 'name') v = typeof v === 'string' ? (v.trim() || null) : v;
        status.textContent = 'Saving…';
        try {
          const patch = { id, [k]: v };
          await saveRow('projects', patch);
          if (k === 'client_id') {
            // Loose links: tasks on this project follow the project's client.
            const kids = st.tasks.filter((t) => t.project_id === id && t.client_id !== v);
            await Promise.all(kids.map((t) => saveRow('tasks', { id: t.id, client_id: v })));
          }
          status.textContent = 'Saved';
        } catch (e) { status.textContent = ''; toast(e.message, 'bad'); }
      });
    }
    const node = el('section', { class: 'section dl-details' },
      el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Details'), el('h2', { class: 'h2' }, 'The job')), status),
      el('div', { class: 'stack' },
        field('Name', fields.name), field('Client', fields.client_id),
        el('div', { class: 'form-grid' }, field('Start', fields.started_on), field('Due', fields.due_on)),
        field('Value', fields.value, 'One-off price, $'),
        field('Deal', fields.deal_id), dealLink,
        field('What it is', fields.description)));
    paintDeal();
    return {
      node,
      sync() {
        const pr = rowById('projects', id);
        if (!pr) return;
        for (const [k, nd] of Object.entries(fields)) {
          if (document.activeElement === nd) continue;
          const want = k === 'value' ? String(pr.value ?? 0) : (pr[k] ?? '');
          if (nd.value !== String(want)) nd.value = String(want);
        }
        paintDeal();
      }
    };
  }

  const paintAll = () => {
    if (!rowById('projects', id)) {
      fill(root, el('a', { href: '#projects', class: 'dl-back' }, icon('chevron-left', 15), 'Projects'),
        emptyState({ icon: 'alert', title: 'This project was deleted', action: el('a', { class: 'btn btn-ghost', href: '#projects' }, 'Back to projects') }));
      return;
    }
  };
  paintHead();
  paintTasks();
  const tasksPaint = guardedPaint(tasksBox, paintTasks);
  root.onState = () => {
    if (!rowById('projects', id)) { paintAll(); return; }
    keepFocus(head, paintHead);
    tasksPaint();
    details.sync();
  };
  return root;
}
