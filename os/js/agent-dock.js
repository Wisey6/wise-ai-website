// The Wise AI agent, reachable from anywhere: a round launcher at the top right
// (bottom right above the tab bar on phones) carrying the white owl on a slowly
// moving black-and-blue "paint splodge", and a dropdown with the assistant itself:
// the conversation (it opens on the most recent one), its history, and a few quick
// rows. It makes the changes you ask for, lists each with an Undo, and never sends.
import { el, icon, fill, busy, plural } from './ui.js?v=20261118d';
import { state, onChange } from './api.js?v=20261118d';
import { chatSurface, chatBusy } from './chat.js?v=20261118d';
import { agentsInfo, pendingActions, todaysBriefing, writeBriefing, usd } from './views/agents.js?v=20261118d';

const LOGO = '../logo.svg';
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
  let chat = null;
  let busyTimer = 0;

  const isOpen = () => Boolean(panel && !panel.hidden);

  function setBadge() {
    const n = pendingActions().length;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    launch.setAttribute('aria-label', n ? `Wise AI agent, ${plural(n, 'suggestion')} waiting for your approval` : 'Wise AI agent');
  }

  function working() {
    return chatBusy() || Boolean(document.querySelector('.ag-working, [data-act=brief-write][disabled], [data-act=brief-refresh][disabled]'));
  }
  const paintBusy = () => launch.classList.toggle('is-busy', working());

  /* ------------------------------------------------------------ panel */
  const head = el('div', { class: 'agd-head' });
  const body = el('div', { class: 'agd-body' });
  const quick = el('ul', { class: 'agd-quick' });
  const meta = el('p', { class: 'agd-meta small muted' });

  const histBtn = el('button', { type: 'button', class: 'agd-hbtn', dataset: { act: 'agd-history' }, 'aria-pressed': 'false', 'aria-label': 'Conversations', title: 'Conversations' }, icon('list', 17));
  const newBtn = el('button', { type: 'button', class: 'agd-hbtn', dataset: { act: 'agd-new' }, 'aria-label': 'New conversation', title: 'New conversation' }, icon('plus', 17));
  const closeBtn = el('button', { type: 'button', class: 'agd-hbtn agd-close', 'aria-label': 'Close the agent', title: 'Close (Esc)' }, icon('x', 17));
  const headTitle = el('h2', { class: 'agd-title', id: 'agd-title' }, 'Wise AI');
  const headSub = el('p', { class: 'agd-for' });
  histBtn.addEventListener('click', () => { if (!chat) return; chat.setView(chat.view === 'history' ? 'chat' : 'history'); drawHead(); if (chat.view === 'chat') chat.focus(); else panel.querySelector('.cx-item-open, .cx-new')?.focus(); });
  newBtn.addEventListener('click', () => { chat?.newChat(); drawHead(); });
  closeBtn.addEventListener('click', () => close());
  fill(head, agentMark('lg'), el('div', { class: 'agd-head-text' }, headTitle, headSub), el('div', { class: 'agd-head-acts' }, histBtn, newBtn, closeBtn));

  function drawHead() {
    const info = agentsInfo();
    const on = info.connected && info.master;
    histBtn.hidden = !on; newBtn.hidden = !on;
    const inHist = on && chat?.view === 'history';
    histBtn.setAttribute('aria-pressed', String(inHist));
    histBtn.classList.toggle('is-on', inHist);
    headSub.textContent = !on ? (state.me?.name ? `Working for ${state.me.name}` : 'Working for you') : inHist ? 'Conversations' : chat ? chat.title() : 'New conversation';
    headSub.title = headSub.textContent;
  }

  function drawQuick() {
    const n = pendingActions().length;
    const b = todaysBriefing();
    const headline = b?.out?.headline ? String(b.out.headline).trim() : '';
    const info = agentsInfo();
    fill(quick,
      el('li', {}, el('a', { href: '#agents/approvals', dataset: { quick: 'approvals' } }, icon('check', 15), el('span', {}, 'Waiting for your approval'), el('b', { class: 'tnum' }, String(n)))),
      el('li', {}, headline
        ? el('a', { href: '#agents/research', dataset: { quick: 'briefing' } }, icon('spark', 15), el('span', { class: 'agd-brief-line' }, headline))
        : info.ready('briefing')
          ? el('button', { type: 'button', dataset: { quick: 'briefing' }, onClick: (e) => busy(e.currentTarget, async () => { paintBusy(); await writeBriefing(false); paintBusy(); }) }, icon('spark', 15), el('span', {}, 'Write today’s briefing'), el('span', { class: 'small muted' }, 'uses budget'))
          : el('a', { href: '#agents/research', dataset: { quick: 'briefing' } }, icon('spark', 15), el('span', {}, 'Today’s briefing'), el('span', { class: 'small muted' }, 'off'))),
      el('li', {}, el('a', { href: '#agents/memory', dataset: { quick: 'memory' } }, icon('note', 15), el('span', {}, 'What it remembers'), el('b', { class: 'tnum' }, String((state.agent_memory || []).length)))),
      el('li', {}, el('a', { href: '#agents/research', dataset: { quick: 'research' } }, icon('search', 15), el('span', {}, 'Research a lead'), icon('arrow', 13))),
      el('li', {}, el('a', { href: '#agents', dataset: { quick: 'agents' } }, icon('agents', 15), el('span', {}, 'Open the Agents page'), icon('arrow', 13))));
    meta.textContent = [state.me?.name ? `Working for ${state.me.name}` : '', info.reachable ? `${usd(info.spent)} of ${usd(info.cap)} this month` : ''].filter(Boolean).join(' · ');
  }

  let bodyKey = '';
  function drawBody() {
    const info = agentsInfo();
    const on = info.connected && info.master;
    const key = `${info.reachable}|${info.connected}|${info.master}`;
    if (key === bodyKey && body.childNodes.length) return;
    bodyKey = key;
    if (!on) {
      fill(body, el('div', { class: 'agd-off', dataset: { agdOff: '' } },
        el('p', {}, !info.reachable ? 'The agents cannot be reached right now.' : !info.connected ? 'The agents are not connected yet.' : 'The agents are switched off.'),
        el('a', { href: '#settings', class: 'link-btn' }, 'Open Settings', icon('arrow', 13))),
      el('section', { class: 'agd-sec agd-quick-sec', 'aria-label': 'Quick links' }, quick));
      return;
    }
    if (!chat) {
      chat = chatSurface({
        mode: 'dock', active: () => isOpen(), onUpdate: () => drawHead(),
        footer: el('div', { class: 'agd-foot', 'aria-label': 'Quick links' }, quick, meta)
      });
    }
    fill(body, chat.node);
  }

  function build() {
    panel = el('div', { class: 'agd-panel', id: 'agd-panel', role: 'region', 'aria-labelledby': 'agd-title', hidden: true }, head, body);
    panel.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && a.getAttribute('href').startsWith('#')) close(false);
      // switching conversation or view inside the surface: keep the header in step
      if (e.target.closest('.cx-item-open, .cx-new')) setTimeout(drawHead, 0);
    });
    panel.addEventListener('submit', () => setTimeout(paintBusy, 30), true);
    document.body.append(panel);
  }

  function open() {
    if (!panel) build();
    panel.hidden = false;
    drawBody(); drawQuick();
    chat?.onOpen();
    drawHead();
    launch.setAttribute('aria-expanded', 'true');
    document.body.classList.add('agd-open');
    requestAnimationFrame(() => panel.classList.add('is-in'));
    setTimeout(() => {
      if (chat) chat.focus();
      else panel.querySelector('a, button:not(.agd-close)')?.focus({ preventScroll: true });
    }, 30);
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
    if (e.key === 'Escape' && isOpen() && !document.querySelector('.modal-backdrop, .pal, .own-menu')) {
      e.preventDefault();
      close();
      return;
    }
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
      drawBody(); drawQuick();
      chat?.update();
      drawHead();
    }
  });
  busyTimer = setInterval(paintBusy, 700);
  document.body.append(launch);
  setBadge();
  mounted = { launch, open, close, isOpen, destroy() { clearInterval(busyTimer); launch.remove(); panel?.remove(); mounted = null; } };
  return mounted;
}
