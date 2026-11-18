// The Wise AI assistant as a command bar, reachable from anywhere. At rest it is a small
// "Ask Wise AI" pill at the bottom centre (the white owl in a navy circle, the label and
// its shortcut). Click it, press Ctrl+J (⌘J) or "." and it widens in place into a long
// bar that IS the composer; the conversation stacks up above it, newest next to the bar,
// the older part fading out at the top, with the whole conversation and its history one
// click away. Click off and it goes back to the small pill: nothing is lost (the
// conversation is kept on the server, the unsent text is kept here). A reply that lands
// while it is folded shows for a few seconds above the pill, and a dot stays until it is
// opened. It makes the changes you ask for, lists each with an Undo, and never sends.
import { el, icon, fill, busy, plural } from './ui.js?v=20261118d';
import { state, onChange } from './api.js?v=20261118d';
import { chatSurface, chatBusy, onChatChange, lastReply } from './chat.js?v=20261118d';
import { agentsInfo, pendingActions, todaysBriefing, writeBriefing, usd } from './views/agents.js?v=20261118d';

const LOGO = '../logo.svg';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
/** The shortcut that opens and closes it (Ctrl+J, ⌘J on a Mac). The palette has Ctrl+K. */
export const AGENT_SHORTCUT = IS_MAC ? '⌘J' : 'Ctrl J';
const PEEK_MS = 8000;
let mounted = null;

/** The mark: the white owl in a navy circle. size: 'sm' (launcher) | 'lg' (panel header). */
export function agentMark(size = 'sm') {
  return el('span', { class: `agd-mark is-${size}`, 'aria-hidden': 'true' },
    el('span', { class: 'agd-owl' }, el('img', { src: LOGO, alt: '' })));
}

const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const onAgentsPage = () => /^#agents(\/|$)/.test(location.hash);
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A tiny single-stroke chevron (up), for "Earlier" and expand. */
function chevronUp(size = 15) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M6 15l6-6 6 6'); svg.append(p);
  return svg;
}

export function mountAgentDock() {
  if (mounted) return mounted;

  /* ---------------------------------------------------------- the small pill */
  const badge = el('span', { class: 'agd-count', hidden: true, 'aria-hidden': 'true' });
  const label = el('span', { class: 'agd-label' }, 'Ask Wise AI');
  const kbd = el('kbd', { class: 'agd-kbd', 'aria-hidden': 'true' }, AGENT_SHORTCUT);
  const tip = el('span', { class: 'agd-tip', role: 'tooltip', id: 'agd-tip' });
  const orb = el('span', { class: 'agd-orb', 'aria-hidden': 'true' }, el('span', { class: 'agd-ring' }), agentMark('sm'), el('span', { class: 'agd-dot' }), badge);
  const launch = el('button', {
    type: 'button', class: 'agd-launch', 'aria-label': 'Ask Wise AI', 'aria-expanded': 'false', 'aria-controls': 'agd-panel',
    'aria-keyshortcuts': 'Control+J Meta+J', 'aria-describedby': 'agd-tip', dataset: { agentDock: '', state: 'idle' }
  }, orb, el('span', { class: 'agd-words' }, label, kbd), tip);

  /* ---------------------------------------------------------- the brief line */
  const peekText = el('span', { class: 'agd-peek-text' });
  const peekMeta = el('span', { class: 'agd-peek-meta' });
  const peek = el('button', { type: 'button', class: 'agd-peek', hidden: true, dataset: { agdPeek: '' }, 'aria-label': 'Open the reply' },
    el('span', { class: 'agd-peek-by' }, 'Wise AI'), peekText, peekMeta);
  const peekLive = el('p', { class: 'sr-only', 'aria-live': 'polite' });

  /* ---------------------------------------------------------- the bar and what sits above it */
  const barSlot = el('div', { class: 'agd-barslot' });
  const head = el('div', { class: 'agd-head' });
  const body = el('div', { class: 'agd-body' });
  const earlier = el('button', { type: 'button', class: 'agd-earlier', dataset: { act: 'agd-earlier' }, hidden: true }, chevronUp(13), 'Earlier');
  const panel = el('div', { class: 'agd-panel', id: 'agd-panel', role: 'region', 'aria-labelledby': 'agd-title', hidden: true }, head, earlier, body);
  const root = el('div', { class: 'agd-dock', dataset: { agdState: 'rest' } }, peek, panel, barSlot, launch, peekLive);

  const quick = el('ul', { class: 'agd-quick' });
  const meta = el('p', { class: 'agd-meta small muted' });
  const histBtn = el('button', { type: 'button', class: 'agd-tool', dataset: { act: 'agd-history' }, 'aria-pressed': 'false', 'aria-label': 'Conversations', title: 'Conversations' }, icon('list', 16));
  const newBtn = el('button', { type: 'button', class: 'agd-tool', dataset: { act: 'agd-new' }, 'aria-label': 'New conversation', title: 'New conversation' }, icon('plus', 16));
  const expandBtn = el('button', { type: 'button', class: 'agd-tool', dataset: { act: 'agd-expand' }, 'aria-pressed': 'false', 'aria-label': 'Show the whole conversation', title: 'Whole conversation' }, chevronUp(16));
  const tools = el('span', { class: 'agd-tools' }, histBtn, newBtn, expandBtn);
  const barOrb = el('span', { class: 'agd-bar-orb', 'aria-hidden': 'true' }, el('span', { class: 'agd-ring' }), agentMark('sm'));
  const closeBtn = el('button', { type: 'button', class: 'agd-hbtn agd-close', 'aria-label': 'Close the assistant', title: 'Close (Esc)' }, icon('x', 16));
  const shrinkBtn = el('button', { type: 'button', class: 'agd-hbtn', dataset: { act: 'agd-shrink' }, 'aria-label': 'Show less', title: 'Show less' }, el('span', { class: 'agd-flip' }, chevronUp(16)));
  const headTitle = el('h2', { class: 'agd-title', id: 'agd-title' }, 'Wise AI');
  const headSub = el('p', { class: 'agd-for' });
  fill(head, agentMark('lg'), el('div', { class: 'agd-head-text' }, headTitle, headSub), el('div', { class: 'agd-head-acts' }, shrinkBtn, closeBtn));

  let chat = null;
  let busyTimer = 0;
  let ready = false;       // an answer arrived while it was folded
  let wasBusy = false;
  let expanded = false;
  let peekTimer = 0;
  let peekLeft = 0;
  let peekStarted = 0;

  const isOpen = () => root.dataset.agdState === 'open';

  function working() {
    return chatBusy() || Boolean(document.querySelector('.ag-working, [data-act=brief-write][disabled], [data-act=brief-refresh][disabled]'));
  }
  /** Name, label, tooltip and state in one place. */
  function paint() {
    const n = pendingActions().length;
    const w = working();
    const st = isOpen() ? 'open' : w ? 'working' : ready ? 'ready' : 'idle';
    launch.dataset.state = st;
    launch.classList.toggle('is-busy', w);
    barOrb.classList.toggle('is-busy', w);
    launch.classList.toggle('is-ready', ready && !isOpen());
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    const words = st === 'working' ? 'Working on it' : st === 'ready' ? 'Answer ready' : 'Ask Wise AI';
    if (label.textContent !== words) label.textContent = words;
    const waiting = n ? `, ${plural(n, 'suggestion')} waiting for your approval` : '';
    const name = st === 'working' ? 'Wise AI is working on your request. Open it'
      : st === 'ready' ? 'Wise AI has an answer ready. Open it' : 'Ask Wise AI';
    launch.setAttribute('aria-label', name + waiting);
    tip.textContent = `${words}  ·  ${AGENT_SHORTCUT}`;
    root.hidden = onAgentsPage() && !isOpen();
    launch.hidden = root.hidden;
  }
  const paintBusy = () => {
    const w = chatBusy();
    if (wasBusy && !w && !isOpen() && !onAgentsPage()) { ready = true; showPeek(); }
    wasBusy = w;
    paint();
  };

  /* ---------------------------------------------------------- brief line above the pill */
  function hidePeek() {
    clearTimeout(peekTimer); peekTimer = 0;
    if (peek.hidden) return;
    peek.classList.remove('is-in');
    setTimeout(() => { if (!peek.classList.contains('is-in')) peek.hidden = true; }, reduced() ? 0 : 220);
  }
  function armPeek(ms) { clearTimeout(peekTimer); peekLeft = ms; peekStarted = Date.now(); peekTimer = setTimeout(hidePeek, ms); }
  function showPeek() {
    const r = lastReply();
    if (!r || !r.text) return;
    peekText.textContent = r.text.length > 220 ? `${r.text.slice(0, 219).trim()}…` : r.text;
    peekMeta.textContent = r.error ? 'Open to try again' : r.changes ? `${plural(r.changes, 'change')} · Open` : 'Open';
    peek.classList.toggle('is-error', Boolean(r.error));
    peekLive.textContent = r.error ? r.text : `Wise AI replied: ${peekText.textContent}`;
    peek.hidden = false;
    requestAnimationFrame(() => peek.classList.add('is-in'));
    armPeek(PEEK_MS);
  }
  peek.addEventListener('mouseenter', () => { if (peekTimer) { clearTimeout(peekTimer); peekTimer = 0; peekLeft = Math.max(1500, peekLeft - (Date.now() - peekStarted)); } });
  peek.addEventListener('mouseleave', () => { if (!peek.hidden && !peekTimer) armPeek(peekLeft || 2500); });
  peek.addEventListener('click', () => open());

  /* ---------------------------------------------------------- what sits above the bar */
  function drawHead() {
    const info = agentsInfo();
    const on = info.connected && info.master;
    const inHist = on && chat?.view === 'history';
    histBtn.setAttribute('aria-pressed', String(inHist));
    histBtn.classList.toggle('is-on', inHist);
    expandBtn.setAttribute('aria-pressed', String(expanded));
    expandBtn.classList.toggle('is-on', expanded);
    headSub.textContent = !on ? (state.me?.name ? `Working for ${state.me.name}` : 'Working for you') : inHist ? 'Conversations' : chat ? chat.title() : 'New conversation';
    headSub.title = headSub.textContent;
    root.dataset.view = inHist ? 'history' : 'chat';
    root.classList.toggle('is-expanded', expanded || inHist || !on);
    requestAnimationFrame(paintEarlier);
  }
  /** "Earlier" shows when the compact transcript has more than fits. */
  function paintEarlier() {
    const sc = chat?.scroller;
    const more = Boolean(isOpen() && sc && chat.view === 'chat' && sc.scrollHeight > sc.clientHeight + 8);
    root.classList.toggle('has-more', more);
    earlier.hidden = !(more && !expanded);
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
    root.classList.toggle('is-off', !on);
    if (!on) {
      fill(barSlot);
      fill(body, el('div', { class: 'agd-off', dataset: { agdOff: '' } },
        el('p', {}, !info.reachable ? 'The agents cannot be reached right now.' : !info.connected ? 'The agents are not connected yet.' : 'The agents are switched off.'),
        el('a', { href: '#settings', class: 'link-btn' }, 'Open Settings', icon('arrow', 13))),
      el('section', { class: 'agd-sec agd-quick-sec', 'aria-label': 'Quick links' }, quick));
      return;
    }
    if (!chat) {
      chat = chatSurface({
        mode: 'dock', active: () => isOpen(), onUpdate: () => { drawHead(); }, lead: barOrb, tools,
        footer: el('div', { class: 'agd-foot', 'aria-label': 'Quick links' }, quick, meta)
      });
      chat.scroller.addEventListener('scroll', () => { if (!expanded && chat.scroller.scrollTop < 4 && chat.scroller.scrollHeight > chat.scroller.clientHeight + 8) earlier.classList.add('is-top'); else earlier.classList.remove('is-top'); }, { passive: true });
    }
    fill(body, chat.node);
    fill(barSlot, chat.composer);
  }

  function setExpanded(v) {
    expanded = v;
    if (chat && v && chat.view !== 'chat') chat.setView('chat');
    drawHead();
    if (chat) requestAnimationFrame(() => { chat.scroller.scrollTop = chat.scroller.scrollHeight; paintEarlier(); });
    chat?.focus();
  }
  histBtn.addEventListener('click', () => {
    if (!chat) return;
    chat.setView(chat.view === 'history' ? 'chat' : 'history');
    drawHead();
    if (chat.view === 'chat') chat.focus(); else panel.querySelector('.cx-item-open, .cx-new')?.focus();
  });
  newBtn.addEventListener('click', () => { chat?.newChat(); drawHead(); });
  expandBtn.addEventListener('click', () => setExpanded(!expanded));
  earlier.addEventListener('click', () => setExpanded(true));
  shrinkBtn.addEventListener('click', () => { if (chat?.view === 'history') chat.setView('chat'); setExpanded(false); });
  closeBtn.addEventListener('click', () => close());

  panel.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && a.getAttribute('href').startsWith('#')) close(false);
    if (e.target.closest('.cx-item-open, .cx-new')) setTimeout(drawHead, 0);
  });
  root.addEventListener('submit', () => setTimeout(paintBusy, 30), true);

  function open() {
    if (isOpen()) { chat?.focus(); return; }
    hidePeek();
    root.dataset.agdState = 'open';
    panel.hidden = false;
    drawBody(); drawQuick();
    chat?.onOpen();
    drawHead();
    launch.setAttribute('aria-expanded', 'true');
    ready = false;
    paint();
    document.body.classList.add('agd-open');
    requestAnimationFrame(() => { root.classList.add('is-in'); panel.classList.add('is-in'); paintEarlier(); });
    setTimeout(() => {
      if (chat) chat.focus();
      else panel.querySelector('a, button:not(.agd-close)')?.focus({ preventScroll: true });
    }, 30);
  }
  function close(focusBack = true) {
    if (!isOpen()) return;
    const hadFocus = root.contains(document.activeElement);
    root.classList.remove('is-in');
    panel.classList.remove('is-in');
    root.dataset.agdState = 'rest';
    panel.hidden = true;
    earlier.hidden = true;
    if (expanded) { expanded = false; }
    if (chat && chat.view !== 'chat') chat.setView('chat');
    launch.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('agd-open');
    paint();
    if (focusBack && hadFocus) launch.focus({ preventScroll: true });
    else if (hadFocus) document.activeElement?.blur?.();
  }
  const toggle = () => (isOpen() ? close() : open());

  launch.addEventListener('click', () => open());
  window.addEventListener('wiseos:agent-dock', () => open());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !document.querySelector('.modal-backdrop, .pal, .own-menu')) {
      e.preventDefault();
      if (expanded && root.contains(document.activeElement) && chat?.view === 'chat') { setExpanded(false); return; }
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
      if (document.querySelector('.modal-backdrop, .pal, .gate')) return;
      e.preventDefault();
      if (onAgentsPage() && !isOpen()) { document.querySelector('.cx.is-page .cx-input')?.focus(); return; }
      toggle();
      return;
    }
    if (e.key === '.' && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target) && !document.querySelector('.modal-backdrop, .pal, .drawer, .gate')) {
      e.preventDefault();
      toggle();
    }
  });
  // click off: back to the small pill
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !root.contains(e.target) && !e.target.closest('.toast-wrap, .modal-backdrop, .modal, .own-menu')) close(false);
  });
  window.addEventListener('hashchange', () => { close(false); hidePeek(); paint(); });

  /* phones: keep the bar above the on-screen keyboard */
  const vv = window.visualViewport;
  const keyboard = () => {
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    root.style.setProperty('--agd-kb', `${kb > 60 ? kb : 0}px`);
    root.classList.toggle('is-kb', kb > 60);
  };
  vv?.addEventListener('resize', keyboard);
  vv?.addEventListener('scroll', keyboard);

  onChange(() => {
    paint();
    paintBusy();
    if (isOpen()) {
      drawBody(); drawQuick();
      chat?.update();
      drawHead();
    }
  });
  onChatChange(() => { paintBusy(); if (isOpen()) requestAnimationFrame(paintEarlier); });
  busyTimer = setInterval(paintBusy, 700);
  document.body.append(root);
  paint();
  mounted = {
    launch, root, open, close, isOpen, showPeek, hidePeek,
    destroy() { clearInterval(busyTimer); vv?.removeEventListener('resize', keyboard); vv?.removeEventListener('scroll', keyboard); root.remove(); mounted = null; }
  };
  return mounted;
}
