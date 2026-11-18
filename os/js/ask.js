// Ask the hub: a small, read-only conversation with the `ask` agent.
// The conversation lives in memory for this session only and is sent back as
// `history` so follow-up questions make sense. Answers and their links reach the
// page as text nodes through el(); links are hub hashes only.
import { el, icon, fill, toast, busy } from './ui.js?v=20261118e';
import { agentRun, agentStatus, notify } from './api.js?v=20261118e';

/** sessionStorage key the palette uses to hand over a question ("Ask the hub: …?"). */
export const ASK_PREFILL_KEY = 'wiseos.ask.q';
const MAX_Q = 600;
const MAX_TURNS = 10;

const conv = [];      // {role:'user'|'assistant', text, links?, cannot?, cost?, error?}
let draft = '';
let asking = false;

/** '#leads/<id>'-style hub links only. */
export function safeHash(h) {
  return typeof h === 'string' && /^#[a-z][\w-]*(\/[\w.-]+)*$/i.test(h.trim()) ? h.trim() : null;
}

function takePrefill() {
  try {
    const q = sessionStorage.getItem(ASK_PREFILL_KEY);
    if (q !== null) sessionStorage.removeItem(ASK_PREFILL_KEY);
    return q;
  } catch { return null; }
}

const pick = (res) => {
  const r = res?.result && typeof res.result === 'object' ? res.result : res?.output && typeof res.output === 'object' ? res.output : res;
  return r || {};
};

/**
 * askPanel({ costLabel }) → { node, update, focus }
 * update() repaints the conversation only; the question box keeps what is typed.
 */
export function askPanel({ costLabel = (n) => `US$${Number(n || 0).toFixed(2)}` } = {}) {
  const pre = takePrefill();
  if (pre) draft = pre.slice(0, MAX_Q);
  const box = el('textarea', {
    class: 'input ag-ask-input', name: 'ask', rows: 2, maxlength: String(MAX_Q),
    placeholder: 'e.g. Which clients have not been invoiced this month?', 'aria-label': 'Your question'
  });
  box.value = draft;
  const count = el('span', { class: 'small faint tnum ag-count' });
  const list = el('ol', { class: 'ag-ask-log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const send = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', dataset: { act: 'ask' } }, 'Ask');
  const reset = el('button', { type: 'button', class: 'link-btn small ag-ask-new', dataset: { act: 'ask-new' } }, 'New conversation');
  const form = el('form', { class: 'ag-ask-form', novalidate: true },
    box,
    el('div', { class: 'row ag-ask-bar' },
      el('span', { class: 'small muted' }, 'Answers come only from your hub. It cannot change anything.'),
      el('span', { class: 'spacer' }), count, send));

  const drawCount = () => { count.textContent = `${box.value.length}/${MAX_Q}`; };
  box.addEventListener('input', () => { draft = box.value; drawCount(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  reset.addEventListener('click', () => {
    conv.length = 0;
    paint();
    box.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = box.value.trim();
    if (!q || asking) { if (!q) box.focus(); return; }
    busy(send, async () => {
      asking = true;
      const history = conv.filter((t) => !t.error).slice(-MAX_TURNS).map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) }));
      conv.push({ role: 'user', text: q });
      box.value = ''; draft = ''; drawCount();
      paint();
      const res = await agentRun('ask', { question: q, history });
      asking = false;
      if (!res.ok) {
        conv.pop();
        box.value = box.value || q; draft = box.value; drawCount();
        conv.push({ role: 'assistant', text: res.message, error: true });
        paint();
        toast(res.message, 'bad');
        agentStatus();
        return;
      }
      const out = pick(res);
      conv.push({
        role: 'assistant',
        text: String(out.answer || '').trim() || 'No answer came back.',
        links: (Array.isArray(out.links) ? out.links : []).filter((l) => l && safeHash(l.hash)).slice(0, 8),
        cannot: Boolean(out.cannot_answer),
        cost: res.cost_usd
      });
      paint();
      agentStatus();
      notify();
    });
  });

  function turn(t) {
    if (t.role === 'user') return el('li', { class: 'ag-turn is-q' }, el('p', { class: 'ag-q' }, t.text));
    if (t.error) return el('li', { class: 'ag-turn is-a is-error' }, el('p', { class: 'callout is-warn' }, icon('alert', 15), el('span', {}, t.text)));
    return el('li', { class: `ag-turn is-a${t.cannot ? ' is-cannot' : ''}` },
      t.cannot ? el('p', { class: 'ag-cannot' }, icon('alert', 14), 'It cannot answer that from your data.') : null,
      el('p', { class: 'ag-a' }, t.text),
      t.links?.length ? el('div', { class: 'ag-links' }, t.links.map((l) => el('a', { class: 'ag-link', href: safeHash(l.hash) }, String(l.label || l.hash).slice(0, 80), icon('arrow', 12)))) : null,
      t.cost !== undefined ? el('span', { class: 'small faint tnum' }, costLabel(t.cost)) : null);
  }

  function paint() {
    fill(list,
      conv.length ? conv.map(turn) : el('li', { class: 'ag-turn is-empty small muted' }, 'Ask about leads, deals, clients, invoices, tasks or bookings. It answers from what is in the hub, and says so when the hub does not know.'),
      asking ? el('li', { class: 'ag-turn is-a is-thinking small muted' }, 'Reading your hub…') : null);
    reset.hidden = !conv.length || asking;
  }

  drawCount();
  paint();
  const node = el('div', { class: 'ag-ask', dataset: { agent: 'ask' } }, list, form, el('div', { class: 'row' }, reset));
  return { node, update: paint, focus: () => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } };
}
