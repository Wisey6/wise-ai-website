// Work — projects and the tasks under them.

import { el, icon, dueLabel, dateLabel, badge, modal, field, input, select, textarea,
         toast, confirmDialog, emptyState, daysUntil, titleCase } from '../ui.js';
import { TASK_STATES, PRIORITIES, clientName } from '../store.js';

const PROJECT_STATES = [
  { id: 'active',   label: 'Active' },
  { id: 'planned',  label: 'Planned' },
  { id: 'blocked',  label: 'Blocked' },
  { id: 'shipped',  label: 'Shipped' },
  { id: 'archived', label: 'Archived' }
];

const PROJECT_TONES = { active: 'ok', planned: 'info', blocked: 'bad', shipped: '', archived: '' };

/* ---------------------------------------------------------------- projects */

async function openProject(store, project) {
  const clientOptions = [{ id: '', label: '— internal —' },
    ...store.data.clients.map((c) => ({ id: c.id, label: c.name }))];

  const values = await modal({
    title: project ? 'Edit project' : 'New project',
    body: [
      field('Project', input('name', { value: project?.name, required: true, placeholder: 'Website build — Phase 1' })),
      el('div', { class: 'field-row' },
        field('Client', select('clientId', clientOptions, project?.clientId || '')),
        field('Status', select('status', PROJECT_STATES, project?.status || 'active'))
      ),
      el('div', { class: 'field-row' },
        field('Start', input('start', { type: 'date', value: project?.start })),
        field('Target', input('due', { type: 'date', value: project?.due }))
      ),
      field('Notes', textarea('notes', project?.notes, 'Scope, phase, what "done" means…'))
    ],
    confirmLabel: project ? 'Save' : 'Add project'
  });
  if (!values) return;
  if (project) await store.patch('projects', project.id, values);
  else await store.add('projects', values);
  toast(project ? 'Project updated.' : 'Project added.');
}

/* ------------------------------------------------------------------- tasks */

async function openTask(store, task, presetProjectId = '') {
  const d = store.data;
  const projectOptions = [{ id: '', label: '— no project —' },
    ...d.projects.map((p) => ({ id: p.id, label: p.name }))];
  const clientOptions = [{ id: '', label: '— none —' },
    ...d.clients.map((c) => ({ id: c.id, label: c.name }))];

  const values = await modal({
    title: task ? 'Edit task' : 'New task',
    body: [
      field('Task', input('title', { value: task?.title, required: true, placeholder: 'Send the proposal' })),
      el('div', { class: 'field-row' },
        field('Project', select('projectId', projectOptions, task?.projectId || presetProjectId)),
        field('Client', select('clientId', clientOptions, task?.clientId || ''))
      ),
      el('div', { class: 'field-row' },
        field('Status', select('status', TASK_STATES, task?.status || 'todo')),
        field('Priority', select('priority', PRIORITIES, task?.priority || 'medium'))
      ),
      field('Due', input('due', { type: 'date', value: task?.due })),
      field('Notes', textarea('notes', task?.notes, 'The exact next physical step…'))
    ],
    confirmLabel: task ? 'Save' : 'Add task'
  });
  if (!values) return;
  if (task) await store.patch('tasks', task.id, values);
  else await store.add('tasks', values);
  toast(task ? 'Task updated.' : 'Task added.');
}

function taskRow(store, task) {
  const d = store.data;
  const done = task.status === 'done';
  const overdue = !done && task.due && daysUntil(task.due) < 0;
  const project = d.projects.find((p) => p.id === task.projectId);

  const check = el('button', {
    class: 'task-check', type: 'button',
    role: 'checkbox', 'aria-checked': String(done),
    'aria-label': `Mark "${task.title}" ${done ? 'not done' : 'done'}`,
    onClick: () => store.patch('tasks', task.id, { status: done ? 'todo' : 'done' })
  }, icon('check', 11));

  return el('div', { class: `task${done ? ' done' : ''}` },
    check,
    el('div', { class: 'task-main' },
      el('div', { class: 'task-title' }, task.title),
      el('div', { class: 'task-meta' },
        el('span', { class: `pri-${task.priority || 'medium'}` }, `● ${titleCase(task.priority || 'medium')}`),
        project ? el('span', {}, project.name) : null,
        task.clientId ? el('span', {}, clientName(d, task.clientId)) : null,
        task.due ? el('span', { class: overdue ? 'pri-high' : '' }, dueLabel(task.due)) : null,
        task.status && task.status !== 'todo' && !done
          ? badge(TASK_STATES.find((s) => s.id === task.status)?.label || task.status,
                  task.status === 'blocked' ? 'bad' : task.status === 'review' ? 'warn' : 'info')
          : null
      )
    ),
    el('div', { class: 'row-actions' },
      el('button', { class: 'icon-btn', 'aria-label': 'Edit task', onClick: () => openTask(store, task) }, icon('edit')),
      el('button', {
        class: 'icon-btn', 'aria-label': 'Delete task',
        onClick: async () => {
          const ok = await confirmDialog('Delete task', `Remove "${task.title}"?`);
          if (ok) { await store.remove('tasks', task.id); toast('Task removed.', 'bad'); }
        }
      }, icon('trash'))
    )
  );
}

/* -------------------------------------------------------------------- view */

export function workView(store, filter = 'open') {
  const d = store.data;

  const visible = d.tasks.filter((t) => {
    if (filter === 'open') return t.status !== 'done';
    if (filter === 'review') return t.status === 'review';
    if (filter === 'blocked') return t.status === 'blocked';
    if (filter === 'done') return t.status === 'done';
    if (filter === 'overdue') return t.status !== 'done' && t.due && daysUntil(t.due) < 0;
    return true;
  });

  const grouped = new Map();
  for (const task of visible) {
    const key = task.projectId || '__none__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  }

  const sortTasks = (list) => [...list].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    const byPriority = (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    if (byPriority !== 0) return byPriority;
    return (a.due || '9999').localeCompare(b.due || '9999');
  });

  const projectSection = (project) => {
    const tasks = sortTasks(grouped.get(project.id) || []);
    const total = d.tasks.filter((t) => t.projectId === project.id);
    const complete = total.filter((t) => t.status === 'done').length;

    return el('section', { class: 'card section' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-head-left' },
          el('h2', {}, project.name),
          badge(PROJECT_STATES.find((s) => s.id === project.status)?.label || 'Active',
                PROJECT_TONES[project.status] ?? ''),
          project.clientId ? el('span', { class: 'muted', style: 'font-size:12.5px' }, clientName(d, project.clientId)) : null
        ),
        el('div', { class: 'topbar-actions' },
          el('span', { class: 'eyebrow' },
            `${complete}/${total.length} done${project.due ? ` · ${dateLabel(project.due)}` : ''}`),
          el('button', { class: 'icon-btn', 'aria-label': 'Add task to project', onClick: () => openTask(store, null, project.id) }, icon('plus')),
          el('button', { class: 'icon-btn', 'aria-label': 'Edit project', onClick: () => openProject(store, project) }, icon('edit'))
        )
      ),
      el('div', { class: 'card-body flush' },
        tasks.length
          ? el('div', {}, tasks.map((t) => taskRow(store, t)))
          : el('p', { class: 'muted', style: 'padding:20px 24px;font-size:13px' },
              filter === 'open' ? 'Nothing open here.' : 'No tasks match this filter.'))
    );
  };

  const loose = sortTasks(grouped.get('__none__') || []);

  return el('div', {},
    el('div', { class: 'topbar' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter tasks' },
        ['open', 'review', 'blocked', 'overdue', 'done', 'all'].map((key) =>
          el('button', {
            class: 'seg-btn', type: 'button',
            'aria-pressed': String(filter === key),
            onClick: () => store.emitFilter?.(key)
          }, titleCase(key)))
      ),
      el('div', { class: 'topbar-actions' },
        el('button', { class: 'btn btn-ghost btn-sm', onClick: () => openProject(store, null) }, icon('plus', 13), 'Project'),
        el('button', { class: 'btn btn-primary btn-sm', onClick: () => openTask(store, null) }, icon('plus', 13), 'Task')
      )
    ),

    !d.projects.length && !d.tasks.length
      ? el('section', { class: 'card' },
          emptyState('No projects or tasks yet. Start with a project, then hang tasks off it.',
            'Add a project', () => openProject(store, null)))
      : el('div', {},
          d.projects
            .filter((p) => p.status !== 'archived')
            .map((p) => projectSection(p)),

          loose.length
            ? el('section', { class: 'card section' },
                el('div', { class: 'card-head' },
                  el('div', { class: 'card-head-left' }, el('h2', {}, 'Unfiled')),
                  el('span', { class: 'eyebrow' }, `${loose.length} task${loose.length === 1 ? '' : 's'}`)),
                el('div', { class: 'card-body flush' }, loose.map((t) => taskRow(store, t))))
            : null
        )
  );
}

export { openProject, openTask };
