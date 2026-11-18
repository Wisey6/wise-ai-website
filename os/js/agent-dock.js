// The Wise AI agent, reachable from anywhere: a round launcher at the top right
// (bottom right above the tab bar on phones) carrying the white owl on a slowly
// moving black-and-blue "paint splodge", and a dropdown panel with Ask, the Doer and
// a few quick rows. Same rules as the Agents page: nothing here sends or changes
// anything; the Doer only proposes, and proposals wait in #agents/approvals.
import { el, icon, fill, clear, toast, busy, plural } from './ui.js?v=20261118d';
import { state, agentRun, agentStatus, onChange } from './api.js?v=20261118d';
import { askPanel } from './ask.js?v=20261118d';
import { agentsInfo, pendingActions, todaysBriefing, writeBriefing, usd, unwrap } from './views/agents.js?v=20261118d';

const LOGO = '../logo.svg';
const MAX_DOER = 600;
let mounted = null;

/** The splodge + owl mark. size: 'sm' (launcher) | 'lg' (panel header). */
export function agentMark(size = 'sm') {
  return el('span', { class: `agd-mark is-${size}`, 'aria-hidden': 'true' },
    el('span', { class: 'agd-blob' },
      el('span', { class: 'agd-hue is-a' }), el('span', { class: 'agd-hue is-b' }), el('span', { class: 'agd-hue is-c' })),
    el('span', { class: 'agd-owl' }, el('img', { src: LOGO, alt: '' })));
}

const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function mountAgentDock() {
  if (mounted) return mounted;
  const badge = el('span', { class: 'agd-count', hidden: true, 'aria-hidden': 'true' });
  const launch = el('button', {
    type: 'button', class: 'agd-launch', 'aria-label': 'Wise AI agent', 'aria-expanded': 'false', 'aria-controls': 'agd-panel',
    'aria-keyshortcuts': '.', title: 'Wise AI agent  ( . )', dataset: { agentDock: '' }
  }, agentMark('sm'), badge);

  let panel = null;
  let ask = null;
  let doerDraft = '';
  let doerBusy = false;
  let doerLast = null;   // {note, run_id, count} | {error}
  let busyTimer = 0;

  const isOpen = () => Boolean(panel && !panel.hidden);

  function setBadge() {
    const n = pendingActions().length;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    launch.setAttribute('aria-label', n ? `Wise AI agent, ${plural(n, 'suggestion')} waiting for your approval` : 'Wise AI agent');
  }

  function working() {
    return doerBusy || Boolean(document.querySelector('.ag-turn.is-thinking, .ag-working, [data-act=brief-write][disabled], [data-act=brief-refresh][disabled]'));
  }
  const paintBusy = () => launch.classList.toggle('is-busy', working());

  /* ------------------------------------------------------------ panel */
  const head = el('div', { class: 'agd-head' });
  const body = el('div', { class: 'agd-body' });
  const doerOut = el('div', { class: 'agd-doer-out', 'aria-live': 'polite' });
  const quick = el('ul', { class: 'agd-quick' });

  const doerBox = el('textarea', { class: 'input agd-doer-input', name: 'agd-instruction', rows: 2, maxlength: String(MAX_DOER), placeholder: 'e.g. Make a task to send this month\'s retainer invoices', 'aria-label': 'Tell it what to set up' });
  doerBox.addEventListener('input', () => { doerDraft = doerBox.value; });
  doerBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doerForm.requestSubmit(); } });
  const doerSend = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', dataset: { act: 'agd-doer' } }, 'Suggest changes');
  const doerForm = el('form', { class: 'agd-doer', novalidate: true }, doerBox,
    el('div', { class: 'row agd-bar' }, el('span', { class: 'small muted' }, 'It only suggests. You approve each change.'), el('span', { class: 'spacer' }), doerSend));
  doerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const instruction = doerBox.value.trim();
    if (!instruction || doerBusy) { if (!instruction) doerBox.focus(); return; }
    busy(doerSend, async () => {
      doerBusy = true; doerLast = null; drawDoer(); paintBusy();
      const res = await agentRun('doer', { instruction });
      doerBusy = false;
      if (!res.ok) { doerLast = { error: res.message }; toast(res.message, 'bad'); } else {
        const o = unwrap(res) || {};
        const acts = Array.isArray(res.actions ?? o.actions) ? (res.actions ?? o.actions) : [];
        doerLast = { note: String(o.note || '').trim(), run_id: res.run_id || null, count: acts.length };
        doerBox.value = ''; doerDraft = '';
      }
      drawDoer(); paintBusy(); agentStatus();
    });
  });

  function drawDoer() {
    if (doerBusy) { fill(doerOut, el('p', { class: 'small muted ag-working' }, 'Reading your hub and working out the changes…')); return; }
    if (!doerLast) { clear(doerOut); return; }
    if (doerLast.error) { fill(doerOut, el('p', { class: 'callout is-warn' }, icon('alert', 15), el('span', {}, doerLast.error))); return; }
    const fromRun = doerLast.run_id ? state.agent_actions.filter((a) => a.run_id === doerLast.run_id && a.status === 'proposed').length : null;
    const n = fromRun ?? doerLast.count;
    fill(doerOut,
      doerLast.note ? el('div', { class: 'agd-note', dataset: { doerNote: '' } }, el('p', { class: 'ag-rc-label' }, 'Its note'), el('p', {}, doerLast.note)) : null,
      n ? el('a', { class: 'agd-approve', href: '#agents/approvals', dataset: { act: 'agd-approvals' } }, `${plural(n, 'suggestion')} waiting for your approval`, icon('arrow', 13))
        : el('p', { class: 'small muted' }, 'No changes suggested.'));
  }

  function drawHead() {
    const info = agentsInfo();
    fill(head, agentMark('lg'),
      el('div', { class: 'agd-head-text' },
        el('h2', { class: 'agd-title', id: 'agd-title' }, 'Wise AI agent'),
        el('p', { class: 'agd-for' }, state.me?.name ? `Working for ${state.me.name}` : 'Working for you'),
        info.reachable ? el('p', { class: 'agd-spend tnum' }, `${usd(info.spent)} of ${usd(info.cap)} this month`) : null),
      el('button', { type: 'button', class: 'agd-close', 'aria-label': 'Close the agent', onClick: () => close() }, icon('x', 16)));
  }

  function drawQuick() {
    const n = pendingActions().length;
    const b = todaysBriefing();
    const headline = b?.out?.headline ? String(b.out.headline).trim() : '';
    const info = agentsInfo();
    fill(quick,
      el('li', {}, el('a', { href: '#agents/approvals', dataset: { quick: 'approvals' } }, icon('check', 15), el('span', {}, 'Waiting for you'), el('b', { class: 'tnum' }, String(n)))),
      el('li', {}, headline
        ? el('a', { href: '#agents', dataset: { quick: 'briefing' } }, icon('spark', 15), el('span', { class: 'agd-brief-line' }, headline))
        : info.ready('briefing')
          ? el('button', { type: 'button', dataset: { quick: 'briefing' }, onClick: (e) => busy(e.currentTarget, async () => { paintBusy(); await writeBriefing(false); paintBusy(); }) }, icon('spark', 15), el('span', {}, 'Write today\'s briefing'), el('span', { class: 'small muted' }, 'uses budget'))
          : el('a', { href: '#agents', dataset: { quick: 'briefing' } }, icon('spark', 15), el('span', {}, 'Today\'s briefing'), el('span', { class: 'small muted' }, 'off'))),
      el('li', {}, el('a', { href: '#agents', dataset: { quick: 'research' } }, icon('search', 15), el('span', {}, 'Research a lead'), icon('arrow', 13))),
      el('li', {}, el('a', { href: '#agents', dataset: { quick: 'agents' } }, icon('agents', 15), el('span', {}, 'Open the Agents page'), icon('arrow', 13))));
  }

  let bodyKey = '';
  function drawBody() {
    const info = agentsInfo();
    const key = `${info.reachable}|${info.connected}|${info.master}|${info.ready('ask')}|${info.ready('doer')}`;
    if (key === bodyKey && body.childNodes.length) return;
    bodyKey = key;
    if (!info.connected || !info.master) {
      fill(body, el('div', { class: 'agd-off', dataset: { agdOff: '' } },
        el('p', {}, !info.reachable ? 'The agents cannot be reached right now.' : !info.connected ? 'The agents are not connected yet.' : 'The agents are switched off.'),
        el('a', { href: '#settings', class: 'link-btn' }, 'Open Settings', icon('arrow', 13))), quickSec());
      return;
    }
    if (!ask) ask = askPanel();
    fill(body,
      el('section', { class: 'agd-sec', 'aria-labelledby': 'agd-ask-h' },
        el('h3', { class: 'agd-sec-h', id: 'agd-ask-h' }, 'Ask anything about the business'),
        info.ready('ask') ? ask.node : el('p', { class: 'small muted' }, 'Ask is switched off in Settings.')),
      el('section', { class: 'agd-sec', 'aria-labelledby': 'agd-doer-h' },
        el('h3', { class: 'agd-sec-h', id: 'agd-doer-h' }, 'Tell it what to set up'),
        info.ready('doer') ? [doerForm, doerOut] : el('p', { class: 'small muted' }, 'The Doer is switched off in Settings.')),
      quickSec());
    if (doerDraft && doerBox.value !== doerDraft) doerBox.value = doerDraft;
  }
  const quickSec = () => el('section', { class: 'agd-sec agd-quick-sec', 'aria-label': 'Quick links' }, quick);

  function build() {
    panel = el('div', { class: 'agd-panel', id: 'agd-panel', role: 'region', 'aria-labelledby': 'agd-title', hidden: true }, head, el('div', { class: 'agd-scroll' }, body));
    panel.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && a.getAttribute('href').startsWith('#')) close(false);
    });
    // An Ask or Doer run starting: let the launcher pick up speed at once.
    panel.addEventListener('submit', () => setTimeout(paintBusy, 30), true);
    document.body.append(panel);
  }

  function open() {
    if (!panel) build();
    drawHead(); drawBody(); drawQuick(); drawDoer();
    ask?.update();
    panel.hidden = false;
    launch.setAttribute('aria-expanded', 'true');
    document.body.classList.add('agd-open');
    requestAnimationFrame(() => panel.classList.add('is-in'));
    setTimeout(() => (panel.querySelector('.ag-ask-input') || panel.querySelector('a, button, textarea'))?.focus({ preventScroll: true }), 30);
  }
  function close(focusBack = true) {
    if (!isOpen()) return;
    panel.classList.remove('is-in');
    panel.hidden = true;
    launch.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('agd-open');
    if (focusBack) launch.focus({ preventScroll: true });
  }
  const toggle = () => (isOpen() ? close() : open());

  launch.addEventListener('click', toggle);
  window.addEventListener('wiseos:agent-dock', () => open());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !document.querySelector('.modal-backdrop, .pal, .own-menu')) { e.preventDefault(); close(); return; }
    if (e.key === '.' && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target) && !document.querySelector('.modal-backdrop, .pal, .drawer, .gate')) {
      e.preventDefault();
      toggle();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !panel.contains(e.target) && !launch.contains(e.target) && !e.target.closest('.toast-wrap, .modal-backdrop, .own-menu')) close(false);
  });
  window.addEventListener('hashchange', () => close(false));

  onChange(() => {
    setBadge();
    paintBusy();
    if (isOpen()) {
      drawHead(); drawBody(); drawQuick();
      ask?.update();
      if (!doerBusy) drawDoer();
    }
  });
  busyTimer = setInterval(paintBusy, 700);
  document.body.append(launch);
  setBadge();
  mounted = { launch, open, close, isOpen, destroy() { clearInterval(busyTimer); launch.remove(); panel?.remove(); mounted = null; } };
  return mounted;
}
