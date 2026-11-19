// The Wise AI assistant as a command bar, reachable from anywhere. At rest it is a small
// "Ask Wise AI" pill at the bottom centre (the white owl in a navy circle, the label and
// its shortcut). Click it, press Ctrl+J (⌘J) or "." and it widens in place into a long
// bar that IS the composer; the conversation stacks up above it, newest next to the bar,
// the older part fading out at the top, with the whole conversation and its history one
// click away. Click off and it goes back to the small pill: nothing is lost (the
// conversation is kept on the server, the unsent text is kept here). A reply that lands
// while it is folded shows for a few seconds above the pill, and a dot stays until it is
// opened. It makes the changes you ask for, lists each with an Undo, and never sends.
import { el, icon, fill, busy, plural } from './ui.js?v=20261119a';
import { state, onChange } from './api.js?v=20261119a';
import { chatSurface, chatBusy, onChatChange, lastReply } from './chat.js?v=20261119a';
import { agentsInfo, pendingActions, todaysBriefing, writeBriefing, usd } from './views/agents.js?v=20261119a';
import { reducedMotion } from './motion.js?v=20261119a';

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
const reduced = reducedMotion;

/* Motion (tokens in os.css, rule 8). The pill → bar change is one shape: the bar is laid
   out at its final width at once (nothing inside reflows mid-flight) and its skin, a
   paper pill with an ink edge and a soft shadow, is revealed from the pill's outline with
   clip-path; the owl slides from the pill's spot to the bar's, and the words arrive a beat
   after the shape. Folding plays it back. Only clip-path, transform and opacity move. */
const MORPH_MS = 360;
const FOLD_MS = 300;
const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_IN = 'cubic-bezier(.5,0,.75,0)';
const EASE_IN_OUT = 'cubic-bezier(.65,0,.35,1)';
let springCurve = '';
const spring = () => {
  if (springCurve) return springCurve;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim();
  try { document.createElement('i').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, easing: v }).cancel(); springCurve = v; } catch { springCurve = 'cubic-bezier(.3,1.25,.55,1)'; }
  return springCurve || 'cubic-bezier(.3,1.25,.55,1)';
};
/** The presence layers around the owl: a breathing ring (idle), a held ring (listening),
 *  two counter-turning arcs (thinking). Which one shows is set by data-presence. */
const presenceLayers = () => [
  el('span', { class: 'agd-ring' }),
  el('span', { class: 'agd-listen' }),
  el('span', { class: 'agd-arcs' }, el('span', { class: 'agd-arc is-a' }), el('span', { class: 'agd-arc is-b' }))
];

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
  const orb = el('span', { class: 'agd-orb', 'aria-hidden': 'true' }, ...presenceLayers(), agentMark('sm'), el('span', { class: 'agd-dot' }), badge);
  const launch = el('button', {
    type: 'button', class: 'agd-launch', 'aria-label': 'Ask Wise AI', 'aria-expanded': 'false', 'aria-controls': 'agd-panel',
    'aria-keyshortcuts': 'Control+J Meta+J', 'aria-describedby': 'agd-tip', dataset: { agentDock: '', state: 'idle' }
  }, orb, el('span', { class: 'agd-words' }, label, kbd), tip);

  /* ---------------------------------------------------------- the brief line */
  const peekText = el('span', { class: 'agd-peek-text' });
  const peekMeta = el('span', { class: 'agd-peek-meta' });
  const peekTime = el('span', { class: 'agd-peek-time', 'aria-hidden': 'true' });
  const peek = el('button', { type: 'button', class: 'agd-peek', hidden: true, dataset: { agdPeek: '' }, 'aria-label': 'Open the reply' },
    el('span', { class: 'agd-peek-by' }, 'Wise AI'), peekText, peekMeta, peekTime);
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
  const barOrb = el('span', { class: 'agd-bar-orb', 'aria-hidden': 'true' }, ...presenceLayers(), agentMark('sm'));
  const skin = el('span', { class: 'agd-skin', 'aria-hidden': 'true' }, el('span', { class: 'agd-skin-ring' }), el('span', { class: 'agd-skin-edge' }), el('span', { class: 'agd-skin-fill' }));
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

  /* presence: what the owl is doing. idle · listening (the bar has the cursor) · dictating
     (the microphone is on) · thinking (a reply is on its way) · done (a brief settle when
     it lands) · error (one small nudge and a dim). Each is a layer that cross-fades. */
  let flashState = '';
  let flashTimer = 0;
  function flash(st, ms) {
    flashState = st;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashState = ''; paint(); }, ms);
  }
  function presence(w) {
    if (chat?.voice?.listening) return 'dictating';
    if (w) return 'thinking';
    if (flashState) return flashState;
    if (isOpen() && document.activeElement === chat?.input) return 'listening';
    return 'idle';
  }

  function working() {
    return chatBusy() || Boolean(document.querySelector('.ag-working, [data-act=brief-write][disabled], [data-act=brief-refresh][disabled]'));
  }
  /** Name, label, tooltip and state in one place. */
  // Only touch the page when something actually changed: these run several times a second.
  const setText = (node, v) => { if (node.textContent !== v) node.textContent = v; };
  const setAttr = (node, k, v) => { if (node.getAttribute(k) !== v) node.setAttribute(k, v); };
  const setHidden = (node, v) => { if (node.hidden !== v) node.hidden = v; };
  function paint() {
    const n = pendingActions().length;
    const w = working();
    const st = isOpen() ? 'open' : w ? 'working' : ready ? 'ready' : 'idle';
    if (launch.dataset.state !== st) launch.dataset.state = st;
    const pr = presence(w);
    if (root.dataset.presence !== pr) root.dataset.presence = pr;
    launch.classList.toggle('is-busy', w);
    barOrb.classList.toggle('is-busy', w);
    launch.classList.toggle('is-ready', ready && !isOpen());
    setHidden(badge, !n);
    setText(badge, n > 99 ? '99+' : String(n));
    const words = st === 'working' ? 'Working on it' : st === 'ready' ? 'Answer ready' : 'Ask Wise AI';
    if (label.textContent !== words) label.textContent = words;
    const waiting = n ? `, ${plural(n, 'suggestion')} waiting for your approval` : '';
    const name = st === 'working' ? 'Wise AI is working on your request. Open it'
      : st === 'ready' ? 'Wise AI has an answer ready. Open it' : 'Ask Wise AI';
    setAttr(launch, 'aria-label', name + waiting);
    setText(tip, `${words}  ·  ${AGENT_SHORTCUT}`);
    setHidden(root, onAgentsPage() && !isOpen());
    setHidden(launch, root.hidden);
  }
  const paintBusy = () => {
    const w = chatBusy();
    if (wasBusy && !w) flash(lastReply()?.error ? 'error' : 'done', lastReply()?.error ? 900 : 1300);
    if (wasBusy && !w && !isOpen() && !onAgentsPage()) { ready = true; showPeek(); }
    wasBusy = w;
    paint();
  };

  /* ---------------------------------------------------------- brief line above the pill */
  // The brief line rises out of the pill, holds (a hairline under it runs down the time
  // left, and stops while the pointer is on it) and fades back into the pill.
  let peekAnim = null;
  let peekOut = null;
  function hidePeek(instant = false) {
    clearTimeout(peekTimer); peekTimer = 0;
    peekAnim?.cancel(); peekAnim = null;
    if (peek.hidden) return;
    peek.classList.remove('is-in');
    peekOut?.cancel(); peekOut = null;
    if (instant) { peek.hidden = true; return; }
    const move = !reduced();
    peekOut = peek.animate([{ opacity: 1 }, { opacity: 0, transform: move ? 'translate(-50%, 6px) scale(.97)' : 'translate(-50%, 0)' }], { duration: 200, easing: EASE_IN, fill: 'forwards' });
    peekOut.finished.then(() => { if (!peek.classList.contains('is-in')) peek.hidden = true; peekOut?.cancel(); peekOut = null; }, () => {});
  }
  function armPeek(ms) {
    clearTimeout(peekTimer); peekLeft = ms; peekStarted = Date.now(); peekTimer = setTimeout(hidePeek, ms);
    if (peekAnim) {
      const p = peekAnim.effect.getComputedTiming().progress;
      const left = (1 - (typeof p === 'number' ? p : 1)) * PEEK_MS;
      if (left > 0) { peekAnim.updatePlaybackRate(left / ms); peekAnim.play(); }
    }
  }
  function showPeek() {
    const r = lastReply();
    if (!r || !r.text) return;
    peekText.textContent = r.text.length > 220 ? `${r.text.slice(0, 219).trim()}…` : r.text;
    peekMeta.textContent = r.error ? 'Open to try again' : r.changes ? `${plural(r.changes, 'change')} · Open` : 'Open';
    peek.classList.toggle('is-error', Boolean(r.error));
    peekLive.textContent = r.error ? r.text : `Wise AI replied: ${peekText.textContent}`;
    const was = !peek.hidden && peek.classList.contains('is-in');
    peekOut?.cancel(); peekOut = null;
    peek.hidden = false;
    peek.classList.add('is-in');
    if (!was) {
      const move = !reduced();
      peek.animate([{ opacity: 0, transform: move ? 'translate(-50%, 12px) scale(.96)' : 'translate(-50%, 0)' }, { opacity: 1, transform: 'translate(-50%, 0)' }],
        { duration: move ? 440 : 200, easing: move ? spring() : EASE_OUT, fill: 'backwards' });
    }
    peekAnim?.cancel();
    peekAnim = reduced() ? null : peekTime.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: PEEK_MS, easing: 'linear', fill: 'forwards' });
    armPeek(PEEK_MS);
  }
  peek.addEventListener('mouseenter', () => { peekAnim?.pause(); if (peekTimer) { clearTimeout(peekTimer); peekTimer = 0; peekLeft = Math.max(1500, peekLeft - (Date.now() - peekStarted)); } });
  peek.addEventListener('mouseleave', () => { if (!peek.hidden && !peekTimer) armPeek(peekLeft || 2500); });
  peek.addEventListener('click', () => open());

  /* ---------------------------------------------------------- what sits above the bar */
  function drawHead() {
    const info = agentsInfo();
    const on = info.connected && info.master;
    const inHist = on && chat?.view === 'history';
    setAttr(histBtn, 'aria-pressed', String(inHist));
    histBtn.classList.toggle('is-on', inHist);
    setAttr(expandBtn, 'aria-pressed', String(expanded));
    expandBtn.classList.toggle('is-on', expanded);
    setText(headSub, !on ? (state.me?.name ? `Working for ${state.me.name}` : 'Working for you') : inHist ? 'Conversations' : chat ? chat.title() : 'New conversation');
    if (headSub.title !== headSub.textContent) headSub.title = headSub.textContent;
    const v = inHist ? 'history' : 'chat';
    if (root.dataset.view !== v) root.dataset.view = v;
    root.classList.toggle('is-expanded', expanded || inHist || !on);
    requestAnimationFrame(paintEarlier);
  }
  /** "Earlier" shows when the compact transcript has more than fits. */
  function paintEarlier() {
    const sc = chat?.scroller;
    const more = Boolean(isOpen() && sc && chat.view === 'chat' && sc.scrollHeight > sc.clientHeight + 8);
    root.classList.toggle('has-more', more);
    setHidden(earlier, !(more && !expanded));
  }

  let quickKey = '';
  function drawQuick() {
    const n = pendingActions().length;
    const b = todaysBriefing();
    const headline = b?.out?.headline ? String(b.out.headline).trim() : '';
    const info = agentsInfo();
    const qk = `${n}|${headline}|${info.ready('briefing')}|${(state.agent_memory || []).length}|${state.me?.name || ''}|${info.reachable}|${usd(info.spent)}|${usd(info.cap)}`;
    if (qk === quickKey && quick.childNodes.length) return;
    quickKey = qk;
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
      chat.composer.querySelector('.cx-box')?.prepend(skin);
      chat.composer.addEventListener('cx-voice', () => paint());
      chat.scroller.addEventListener('scroll', () => { if (!expanded && chat.scroller.scrollTop < 4 && chat.scroller.scrollHeight > chat.scroller.clientHeight + 8) earlier.classList.add('is-top'); else earlier.classList.remove('is-top'); }, { passive: true });
    }
    const late = !barSlot.contains(chat.composer);
    fill(body, chat.node);
    fill(barSlot, chat.composer);
    // The agents came online after the bar was opened: put the cursor in the bar.
    if (late && isOpen()) chat.focus();
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
  root.addEventListener('focusin', () => paint());
  root.addEventListener('focusout', () => setTimeout(paint, 0));

  /* ---------------------------------------------------------- the morph */
  let morph = null;   // { anims, end }
  function stopMorph() {
    if (!morph) return;
    const m = morph; morph = null;
    m.anims.forEach((a) => a.cancel());
    m.end?.();
  }
  const rectOf = (n) => n.getBoundingClientRect();
  // Compositor (transform) and main-thread (clip-path) animations would otherwise start a
  // frame or two apart and the owl would leave its outline behind: one start time for all.
  // They also start on the next frame, not when they were made: the work of opening takes
  // a frame or two on a slow machine, and the first frames shown would otherwise be skipped.
  const syncStart = (anims) => {
    if (!anims.length || document.timeline?.currentTime == null) return;
    for (const a of anims) a.pause();
    requestAnimationFrame((t) => { for (const a of anims) if (a.playState === 'paused') a.startTime = t; });
  };
  /** The pill's outline as a clip-path on the bar's skin: inset from the bar's edges. */
  const insetFor = (pill, bar, grow, r) => `inset(${pill.top - bar.top + grow}px ${bar.right - pill.right + grow}px ${bar.bottom - pill.bottom + grow}px ${pill.left - bar.left + grow}px round ${r}px)`;
  const fullInset = (r) => `inset(0px 0px 0px 0px round ${r}px)`;
  const SKIN = [['.agd-skin-edge', 0, 23], ['.agd-skin-fill', -1, 22], ['.agd-skin-ring', 3, 26]];
  /** Everything in the bar except the skin and the owl: arrives a beat after the shape. */
  const barParts = () => [...(chat?.composer.querySelector('.cx-box')?.children || [])].filter((n) => n !== skin && n !== barOrb);

  function morphOpen(pill) {
    const box = chat?.composer.querySelector('.cx-box');
    const words = launch.querySelector('.agd-words');
    const anims = [];
    const go = (n, k, o) => { if (n) anims.push(n.animate(k, o)); };
    root.classList.add('is-morphing');
    if (box && pill && !reduced()) {
      const bar = rectOf(box);
      for (const [sel, grow, r] of SKIN) go(skin.querySelector(sel), [{ clipPath: insetFor(pill.box, bar, grow, r) }, { clipPath: fullInset(r) }], { duration: MORPH_MS, easing: EASE_OUT });
      const o = rectOf(barOrb);
      go(barOrb, [{ transform: `translate(${pill.orb.left - o.left}px, ${pill.orb.top - o.top}px)` }, { transform: 'none' }], { duration: MORPH_MS, easing: EASE_OUT });
      for (const n of barParts()) go(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 110, easing: EASE_OUT, fill: 'backwards' });
      go(words, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: EASE_IN, fill: 'forwards' });
      go(panel, [{ opacity: 0, transform: 'translateY(14px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 460, delay: 50, easing: spring(), fill: 'backwards' });
    } else {
      // reduced motion (or nothing to measure): the bar and the sheet fade in where they are
      go(skin, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE_OUT });
      for (const n of barParts().concat(barOrb)) go(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE_OUT, fill: 'backwards' });
      go(words, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
      go(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE_OUT, fill: 'backwards' });
    }
    syncStart(anims);
    const m = { anims, end: () => root.classList.remove('is-morphing') };
    morph = m;
    Promise.all(anims.map((a) => a.finished)).then(() => { if (morph === m) stopMorph(); }, () => {});
  }

  function morphClose(after) {
    const box = chat?.composer.querySelector('.cx-box');
    const words = launch.querySelector('.agd-words');
    const anims = [];
    const go = (n, k, o) => { if (n) anims.push(n.animate(k, o)); };
    root.classList.add('is-morphing', 'is-closing');
    if (box && !reduced()) {
      const bar = rectOf(box);
      const pill = rectOf(launch);
      const po = rectOf(launch.querySelector('.agd-orb'));
      const o = rectOf(barOrb);
      for (const n of barParts()) go(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: EASE_IN, fill: 'forwards' });
      for (const [sel, grow, r] of SKIN) go(skin.querySelector(sel), [{ clipPath: fullInset(r) }, { clipPath: insetFor(pill, bar, grow, r) }], { duration: FOLD_MS, easing: EASE_IN_OUT, fill: 'forwards' });
      go(barOrb, [{ transform: 'none' }, { transform: `translate(${po.left - o.left}px, ${po.top - o.top}px)` }], { duration: FOLD_MS, easing: EASE_IN_OUT, fill: 'forwards' });
      go(words, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: FOLD_MS - 120, easing: EASE_OUT, fill: 'both' });
      go(panel, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px) scale(.985)' }], { duration: 200, easing: EASE_IN, fill: 'forwards' });
    } else {
      go(skin, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      for (const n of barParts().concat(barOrb)) go(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      go(words, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 80, fill: 'both' });
      go(panel, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    }
    syncStart(anims);
    const m = { anims, end: () => { root.classList.remove('is-morphing', 'is-closing'); after(); } };
    morph = m;
    Promise.all(anims.map((a) => a.finished)).then(() => { if (morph === m) stopMorph(); }, () => {});
  }

  function open() {
    if (isOpen()) { chat?.focus(); return; }
    stopMorph();
    hidePeek(true);
    // the pill, where the shape starts from (measured before anything changes)
    const pill = !launch.hidden && launch.getClientRects().length ? { box: rectOf(launch), orb: rectOf(orb) } : null;
    root.dataset.agdState = 'open';
    panel.hidden = false;
    drawBody(); drawQuick();
    chat?.onOpen();
    drawHead();
    launch.setAttribute('aria-expanded', 'true');
    ready = false;
    paint();
    document.body.classList.add('agd-open');
    root.classList.add('is-in'); panel.classList.add('is-in');
    morphOpen(pill);
    requestAnimationFrame(paintEarlier);
    // The cursor goes in straight away, so typing during the morph is never lost.
    if (chat) chat.focus(0);
    else setTimeout(() => panel.querySelector('a, button:not(.agd-close)')?.focus({ preventScroll: true }), 30);
  }
  function close(focusBack = true) {
    if (!isOpen()) return;
    stopMorph();
    const hadFocus = root.contains(document.activeElement);
    root.classList.remove('is-in');
    panel.classList.remove('is-in');
    root.dataset.agdState = 'rest';
    chat?.voice?.stop();
    expanded = false;
    // what is above the bar folds away as it is; it is tidied once out of sight
    morphClose(() => {
      if (isOpen()) return;
      panel.hidden = true;
      earlier.hidden = true;
      if (chat && chat.view !== 'chat') chat.setView('chat');
      drawHead();
    });
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
