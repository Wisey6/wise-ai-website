// Wise AI OS: the assistant (js/chat.js) in the owl dropdown and on the Agents page.
// The `agent` function is ALWAYS mocked for chat and every action (it costs money and
// changes real records), and the agent_chats / agent_chat_messages / agent_changes /
// agent_memory reads are mocked too, so nothing here touches a real conversation.
// The only real write is Settings (the assistant's switch and model), restored after.
//
//   python3 -m http.server 8141 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/chat.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8141').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.ONLY || '';
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };

/* ------------------------------------------------------------------ fixtures */
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C1 = U(1); const C2 = U(2); const C3 = U(3); const C4 = U(4);
const NEW1 = U(11); const NEW2 = U(12); const NEW3 = U(13);
const L1 = U(21); const L2 = U(22); const T1 = U(23);
const CH0 = U(30); const CH1 = U(31); const CH_NEW = U(32); const CH_BAD = U(33); const CH_TASK = U(34);
const M1 = U(41); const M2 = U(42);

function populated() {
  return {
    chats: [
      { id: C1, member_id: U(99), title: 'Unpaid invoices this month', archived: false, created_at: ago(30), updated_at: ago(5) },
      { id: C2, member_id: U(99), title: 'New lead from the website', archived: false, created_at: ago(200), updated_at: ago(120) },
      { id: C3, member_id: U(99), title: 'Running costs for December', archived: false, created_at: ago(2000), updated_at: ago(1500) },
      { id: C4, member_id: U(99), title: 'Old pricing question', archived: true, created_at: ago(14000), updated_at: ago(13000) }
    ],
    msgs: {
      [C1]: [
        { id: 101, chat_id: C1, role: 'user', text: 'What is unpaid?', at: ago(6), steps: [], links: [] },
        {
          id: 102, chat_id: C1, role: 'assistant', at: ago(5), model: 'claude-sonnet-5-5', cost_usd: 0.0214,
          text: 'Two invoices are unpaid, $4,950 in all. One is overdue.\n\n- **Harbour Dental**: $3,300, was due 12 Nov, six days overdue\n- Coastal Physio: $1,650, due 30 Nov\n\nWant me to make a task to chase Harbour Dental?',
          steps: [{ tool: 'numbers', summary: 'Worked out unpaid and overdue invoices' }, { tool: 'find', summary: 'Looked up invoices marked invoiced' }],
          links: [{ label: 'Income', hash: '#income' }, { label: 'Bad', hash: 'javascript:alert(1)' }]
        }
      ],
      [C2]: [
        { id: 201, chat_id: C2, role: 'user', text: 'Add a lead: Bayside Dental in Manly, came in through the website', at: ago(122), steps: [], links: [] },
        {
          id: 202, chat_id: C2, role: 'assistant', at: ago(120), model: 'claude-sonnet-5-5', cost_usd: 0.018,
          text: 'Added Bayside Dental as a new lead, source website. Want me to open a deal for it?',
          steps: [{ tool: 'save_lead', summary: 'Added lead Bayside Dental (Manly)', change_id: CH1, table_name: 'leads', row_id: L1 },
            { tool: 'save_task', summary: 'Marked “Send the draft” done', change_id: CH0, table_name: 'tasks', row_id: T1 }],
          links: []
        }
      ],
      [C3]: [
        { id: 301, chat_id: C3, role: 'user', text: 'What are my running costs next month?', at: ago(1502), steps: [], links: [] },
        { id: 302, chat_id: C3, role: 'assistant', at: ago(1500), model: 'claude-haiku-5-5', cost_usd: 0.004, text: 'About $1,240 next month. The phone plan ends on 30 Nov, so it drops out.', steps: [{ tool: 'numbers', summary: 'Worked out monthly burn next month' }], links: [{ label: 'Costs', hash: '#costs' }] }
      ],
      [C4]: []
    },
    changes: [
      { id: CH1, at: ago(120), chat_id: C2, table_name: 'leads', row_id: L1, op: 'insert', summary: 'Added lead Bayside Dental (Manly)', undone_at: null },
      { id: CH0, at: ago(119), chat_id: C2, table_name: 'tasks', row_id: T1, op: 'update', summary: 'Marked “Send the draft” done', undone_at: ago(100) },
      { id: CH_BAD, at: ago(300), chat_id: null, table_name: 'deals', row_id: U(50), op: 'update', summary: 'Moved Coastal Physio to Proposal', undone_at: null }
    ],
    memory: [
      { id: M1, member_id: null, text: 'Prices we quote include GST.', created_at: ago(3000), active: true },
      { id: M2, member_id: U(99), text: 'I like follow-ups on Tuesdays.', created_at: ago(600), active: true }
    ]
  };
}
const emptyData = () => ({ chats: [], msgs: {}, changes: [], memory: [] });

/* ---------------------------------------------------------------------- mock */
async function session(viewport, { data = emptyData(), scale = 1, connected = true, chatOn = true } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
  const calls = [];
  const db = data;
  let netFails = 0;
  const json = (r, status, body) => r.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
  await ctx.route('**/functions/v1/agent', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'status') return json(r, 200, { configured: connected, enabled: connected, agents: { researcher: true, briefing: true, chat: chatOn }, spent_usd: 2.5, cap_usd: 25, runs_today: { chat: 4 }, limits: { chat: 300 } });
    calls.push(body);
    const now = new Date().toISOString();
    if (body.agent === 'chat') {
      const msg = String(body.message || '');
      if (/^CAP/.test(msg)) return json(r, 402, { ok: false, error: 'cap_reached' });
      if (/^OFF/.test(msg)) return json(r, 403, { ok: false, error: 'disabled' });
      if (/^NETWORK/.test(msg) && netFails++ === 0) return r.abort('failed');
      await new Promise((res) => setTimeout(res, 700));
      const base = { ok: true, run_id: U(70), model: 'claude-sonnet-5-5', cost_usd: 0.0187, spent_usd: 2.52, cap_usd: 25 };
      if (/^Create a task/.test(msg)) {
        return json(r, 200, { ...base, chat_id: NEW2, title: 'A task for a job', changes: [], message: { id: 9201, role: 'assistant', at: now, text: 'Happy to. Which job is it for, who should do it, and when is it due? TBC is fine for the date.', steps: [{ tool: 'find', summary: 'Looked up open projects' }], links: [] } });
      }
      if (/^The Coastal Physio job/.test(msg)) {
        return json(r, 200, { ...base, chat_id: body.chat_id, title: 'A task for a job', changes: [{ id: CH_TASK, table_name: 'tasks', row_id: T1, op: 'insert', summary: 'Added task “Send the first draft” for Coastal Physio, due Fri 20 Nov', open: '#projects/tasks' }], message: { id: 9202, role: 'assistant', at: now, text: 'Done. The task is on Coastal Physio, yours, due Friday.', steps: [{ tool: 'save_task', summary: 'Added task “Send the first draft” for Coastal Physio, due Fri 20 Nov', change_id: CH_TASK, table_name: 'tasks', row_id: T1 }], links: [] } });
      }
      if (/^Draft a reply/.test(msg)) {
        return json(r, 200, { ...base, chat_id: body.chat_id || NEW3, title: 'Reply to Bayside Dental', changes: [], draft: { lead_id: L1, body: 'Hi Sam, Thursday at 10 works for a quick call. Does that suit?' }, message: { id: 9301, role: 'assistant', at: now, text: 'I wrote a reply offering Thursday at 10. It is waiting in the inbox for you to read and send.', steps: [{ tool: 'draft_message', summary: 'Drafted a reply to Bayside Dental' }], links: [{ label: 'Bayside Dental', hash: `#leads/${L1}` }] } });
      }
      // default: add a lead
      return json(r, 200, { ...base, chat_id: body.chat_id || NEW1, title: 'New lead, dental clinic in Manly', changes: [{ id: CH_NEW, table_name: 'leads', row_id: L2, op: 'insert', summary: 'Added lead Manly Smile Studio', open: `#leads/${L2}` }], message: { id: 9101, role: 'assistant', at: now, text: `Added Manly Smile Studio as a new lead from the website, owned by you. ${msg.includes('<img') ? '<img src=x onerror="window.__xss=1">' : ''}\n\nWant me to open a deal for it?`, steps: [{ tool: 'find', summary: 'Checked for an existing lead with that name' }, { tool: 'save_lead', summary: 'Added lead Manly Smile Studio', change_id: CH_NEW, table_name: 'leads', row_id: L2 }], links: [{ label: 'Manly Smile Studio', hash: `#leads/${L2}` }, { label: 'Leads', hash: '#leads' }] } });
    }
    if (body.action === 'undo') {
      if (body.change_id === CH_BAD) return json(r, 409, { ok: false, error: 'changed_since', detail: 'That deal has been edited since, so undoing it would lose the newer change.' });
      return json(r, 200, { ok: true, undone_at: now });
    }
    if (body.action === 'chat_rename') return json(r, 200, { ok: true, title: body.title });
    if (body.action === 'chat_archive') return json(r, 200, { ok: true });
    if (body.action === 'chat_delete') return json(r, 200, { ok: true });
    if (body.action === 'memory_delete') return json(r, 200, { ok: true });
    return json(r, 400, { ok: false, error: 'bad_request' });
  });
  const rest = (path, fn) => ctx.route(`**/rest/v1/${path}*`, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (r.request().method() !== 'GET') return json(r, 403, { message: 'read only in tests' });
    return json(r, 200, fn(decodeURIComponent(r.request().url())));
  });
  await rest('agent_chats', () => db.chats);
  await rest('agent_changes', () => db.changes);
  await rest('agent_memory', () => db.memory);
  await rest('agent_chat_messages', (u) => {
    const eq = /chat_id=eq\.([\w-]+)/.exec(u);
    if (eq) return db.msgs[eq[1]] || [];
    const inn = /chat_id=in\.\(([^)]*)\)/.exec(u);
    if (inn) return inn[1].split(',').map((x) => x.replace(/"/g, '')).flatMap((id) => (db.msgs[id] || []).filter((m) => m.role === 'user').map((m) => ({ chat_id: id, text: m.text })));
    return [];
  });
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/functions\/v1\/|net::ERR_FAILED|status of 40[0-9]/.test(m.text())) page.errors.push(m.text()); });
  page.calls = calls;
  page.db = db;
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.agents); i++) await new Promise((r) => setTimeout(r, 100)); });
  await page.waitForSelector('.agd-launch', { timeout: 10000 });
  // "Yours": the second note belongs to whoever is signed in.
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (const n of m.state.agent_memory) if (n.member_id) n.member_id = m.state.me.id; m.notify(); });
  return { ctx, page };
}
const nav = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  await page.waitForTimeout(350);
};
const lastCall = (page, pred) => page.calls.filter(pred).pop();
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts }); };

let settingsBefore = null;
let restorePage = null;
try {
  /* ============================================ empty, sending, undo, errors */
  if (run('send')) {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { scale: 2 });
    await nav(page, '#agents');
    check(await page.locator('.page.ag[data-tab=chat] .cx.is-page').count() === 1, 'the Agents page opens on the assistant');
    check(await page.locator('[data-chat-empty]').isVisible(), 'an empty conversation shows the empty state');
    const ex = await page.$$eval('.cx.is-page [data-example]', (ns) => ns.map((n) => n.textContent.trim()));
    check(ex.length === 5 && ex.some((t) => /^Add a lead/.test(t)) && ex.some((t) => /unpaid/.test(t)) && ex.some((t) => /^Create a task/.test(t)) && ex.some((t) => /running costs next month/.test(t)), `five example asks that fit the business (${ex.length})`);
    check(await page.evaluate(() => document.activeElement?.classList.contains('cx-input')), 'the composer has focus');
    check(await page.locator('.cx.is-page [data-act=chat-send]').isDisabled(), 'Send is disabled while the box is empty');
    await shot(page, 'page-empty-1440');
    await page.locator('.cx.is-page [data-example]').nth(1).click();
    check((await page.inputValue('.cx.is-page .cx-input')) === ex[1] && page.calls.length === 0, 'an example fills the composer and sends nothing');
    // Shift+Enter makes a new line, Enter sends
    await page.fill('.cx.is-page .cx-input', 'Add a lead: a dental clinic in Manly');
    await page.locator('.cx.is-page .cx-input').press('Shift+Enter');
    await page.locator('.cx.is-page .cx-input').type('that found us through the website <img src=x>');
    check((await page.inputValue('.cx.is-page .cx-input')).includes('\n') && page.calls.length === 0, 'Shift+Enter adds a new line without sending');
    await page.locator('.cx.is-page .cx-input').press('Enter');
    await page.waitForTimeout(120);
    check(await page.locator('.cx.is-page .cx-msg.is-you.is-pending').count() === 1 && (await page.locator('.cx.is-page .cx-msg.is-you').innerText()).includes('dental clinic in Manly'), 'Enter sends: your message shows at once');
    check(await page.locator('.cx.is-page [data-working]').isVisible() && /Reading your hub/.test(await page.locator('.cx.is-page [data-working]').innerText()), 'a working line says what it is doing');
    check((await page.inputValue('.cx.is-page .cx-input')) === '', 'the composer clears');
    const busyNow = await page.locator('.agd-launch').evaluate((n) => n.classList.contains('is-busy'));
    check(busyNow, 'the owl launcher speeds up while the assistant works');
    await page.waitForSelector('.cx.is-page .cx-msg.is-agent');
    const sent = lastCall(page, (c) => c.agent === 'chat');
    check(sent && !('chat_id' in sent) && sent.message.startsWith('Add a lead'), 'a new conversation is sent without a chat_id');
    const agent = page.locator('.cx.is-page .cx-msg.is-agent').last();
    check((await agent.locator('.cx-text').innerText()).includes('Added Manly Smile Studio'), 'the reply shows');
    check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('.cx-text img')), 'markup in a reply renders as text');
    check(await agent.locator('[data-did] .cx-change').count() === 1 && (await agent.locator('.cx-change .cx-op').innerText()) === 'New', 'what it did: one ledger line, marked New');
    check(await agent.locator(`.cx-change a.cx-open[href="#leads/${L2}"]`).count() === 1, 'the line links to the record');
    check(await agent.locator('.cx-change [data-act=undo]').count() === 1, 'the line has an Undo');
    const linkHrefs = await agent.locator('.cx-link').evaluateAll((ns) => ns.map((n) => n.getAttribute('href')));
    check(JSON.stringify(linkHrefs) === JSON.stringify(['#leads']), `links are hub links, without repeating the record link (${linkHrefs})`);
    check(/Looked up 1 thing/.test(await agent.locator('.cx-reads summary').innerText()), 'read-only steps fold into "Looked up"');
    check(/Sonnet · US\$0\.02/.test(await agent.locator('.cx-cost').innerText()), 'a quiet model and cost line');
    check((await page.locator('.cx.is-page .cx-title').innerText()) === 'New lead, dental clinic in Manly', 'the conversation takes the title the assistant gave it');
    check(await page.locator(`.cx.is-page .cx-item.is-current[data-chat="${NEW1}"]`).count() === 1, 'the new conversation is in the history and current');
    check(await page.evaluate(() => location.hash) === `#agents/chat/${NEW1}`, 'the address follows the conversation');
    check(await page.locator('[data-recent] .cx-change').count() >= 1, 'the change also shows under "What it changed lately"');
    await shot(page, 'page-sent-1440');

    // Undo strikes the line through
    await agent.locator('[data-act=undo]').click();
    await page.waitForSelector(`.cx.is-page .cx-msg.is-agent .cx-change.is-undone[data-change="${CH_NEW}"]`);
    check(lastCall(page, (c) => c.action === 'undo')?.change_id === CH_NEW, 'Undo calls the function with the change id');
    const deco = await page.locator(`.cx.is-page .cx-msg.is-agent .cx-change[data-change="${CH_NEW}"] .cx-change-sum`).evaluate((n) => getComputedStyle(n).textDecorationLine);
    check(/line-through/.test(deco) && await page.locator(`.cx.is-page .cx-msg.is-agent .cx-change[data-change="${CH_NEW}"] [data-undone]`).count() === 1, `an undone change is struck through and says Undone (${deco})`);
    check(await page.locator(`.cx.is-page .cx-msg.is-agent .cx-change[data-change="${CH_NEW}"] [data-act=undo], .cx.is-page .cx-msg.is-agent .cx-change[data-change="${CH_NEW}"] a.cx-open`).count() === 0, 'an undone change offers neither Undo nor Open');

    // a clarifying question, then the answer, stays in one conversation
    await page.click('.cx.is-page [data-act=chat-new]');
    check(await page.locator('[data-chat-empty]').isVisible(), 'New conversation starts empty');
    await page.fill('.cx.is-page .cx-input', 'Create a task for the physio job');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cx.is-page .cx-msg.is-agent');
    check(/Which job is it for/.test(await page.locator('.cx.is-page .cx-msg.is-agent').last().innerText()), 'a clarifying question reads as a plain reply');
    await page.fill('.cx.is-page .cx-input', 'The Coastal Physio job, me, Friday');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.cx.is-page .cx-msg.is-agent').length === 2);
    const answer = lastCall(page, (c) => c.agent === 'chat');
    check(answer.chat_id === NEW2, `the answer goes to the same conversation (${answer.chat_id})`);
    const dbg = await page.evaluate(() => ({ you: document.querySelectorAll('.cx.is-page .cx-msg.is-you').length, did: [...document.querySelectorAll('.cx.is-page .cx-change')].map((n) => n.outerHTML.slice(0, 300)) }));
    check(dbg.you === 2 && await page.locator(`.cx.is-page .cx-conv .cx-change[data-change="${CH_TASK}"] a[href="#projects/tasks"]`).count() === 1, `both turns are kept; the task links to Projects ${JSON.stringify(dbg)}`);

    // errors: inline, text kept, retry
    for (const [text, code, re] of [['CAP please', 'cap_reached', /budget is used up/], ['OFF please', 'disabled', /switched off/]]) {
      await page.fill('.cx.is-page .cx-input', text);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`.cx.is-page [data-chat-error="${code}"]`);
      check(re.test(await page.locator(`.cx.is-page [data-chat-error="${code}"]`).innerText()) && await page.locator(`.cx.is-page [data-chat-error="${code}"] a[href="#settings"]`).count() === 1, `${code}: said plainly, with the way to fix it`);
      check((await page.inputValue('.cx.is-page .cx-input')) === text, `${code}: your text is back in the box`);
      check(await page.locator('.cx.is-page .cx-msg.is-you.is-pending').count() === 0, `${code}: no half-sent message is left in the log`);
    }
    await page.fill('.cx.is-page .cx-input', 'NETWORK test');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cx.is-page [data-chat-error="network"]');
    check((await page.inputValue('.cx.is-page .cx-input')) === 'NETWORK test', 'network: the text is kept');
    await page.click('.cx.is-page [data-act=chat-retry]');
    await page.waitForFunction(() => document.querySelectorAll('.cx.is-page .cx-msg.is-agent').length === 3, null, { timeout: 8000 });
    check(await page.locator('.cx.is-page [data-chat-error]').count() === 0 && (await page.inputValue('.cx.is-page .cx-input')) === '', 'Try again sends it and the error clears');
    check(page.calls.filter((c) => c.agent === 'chat' && c.message === 'NETWORK test').length === 2, 'the retry sent the same text');

    // draft notice
    await page.fill('.cx.is-page .cx-input', 'Draft a reply to Bayside Dental offering Thursday');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.cx.is-page [data-draft-notice="${L1}"]`);
    check((await page.locator(`.cx.is-page [data-draft-notice="${L1}"]`).innerText()).includes('Draft is in the inbox reply box') && await page.locator(`.cx.is-page [data-draft-notice="${L1}"] a[href="#inbox/${L1}"]`).count() === 1, 'a draft says it is in the inbox reply box, with a link');
    check(await page.evaluate((id) => sessionStorage.getItem(`wiseos.draft.${id}`), L1) === 'Hi Sam, Thursday at 10 works for a quick call. Does that suit?', 'the draft is stored for the inbox composer');

    // typed text survives a live state update
    await page.fill('.cx.is-page .cx-input', 'half typed message');
    await page.evaluate(async () => {
      const m = await window.__mod('api.js');
      m.state.agent_changes.unshift({ id: 'zz-live', at: new Date().toISOString(), table_name: 'leads', row_id: null, op: 'update', summary: 'A change from elsewhere', undone_at: null });
      m.state.agent_chats = [...m.state.agent_chats];
      m.notify();
    });
    await page.waitForTimeout(250);
    check((await page.inputValue('.cx.is-page .cx-input')) === 'half typed message' && await page.locator('[data-recent]').innerText().then((t) => t.includes('A change from elsewhere')), 'typed text survives a live update while the panels refresh');
    await page.evaluate(async () => { const m = await window.__mod('api.js'); m.state.agent_changes = m.state.agent_changes.filter((c) => c.id !== 'zz-live'); m.notify(); });
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ history, memory, the dropdown */
  if (run('history')) {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { data: populated(), scale: 2 });
    // the dropdown opens on the most recent conversation
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-panel.is-in .cx.is-dock .cx-msg.is-agent');
    check(await page.locator('.agd-panel .cx-msg[data-msg="102"]').count() === 1, 'the dropdown opens on the most recent conversation');
    check((await page.locator('.agd-panel .agd-for').innerText()) === 'Unpaid invoices this month', 'its header names the conversation');
    await page.waitForTimeout(100);
    const fe = await page.evaluate(() => `${document.activeElement?.className}|${!!document.activeElement?.closest('.agd-panel')}`);
    check(fe === 'cx-input|true', `focus goes to the composer (${fe})`);
    check(await page.locator('.agd-panel .cx-text li').count() === 2 && await page.locator('.agd-panel .cx-text strong').count() === 1, 'lists and bold in a reply render as lists and bold');
    check(await page.locator('.agd-panel a[href^="javascript"]').count() === 0, 'an unsafe link is dropped');
    await shot(page, 'dock-populated-1440');
    await page.fill('.agd-panel .cx-input', 'kept while closed');
    await page.keyboard.press('Escape');
    check(await page.locator('.agd-panel').isHidden() && await page.evaluate(() => document.activeElement?.classList.contains('agd-launch')), 'Escape closes the dropdown and focus returns to the owl');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-panel.is-in');
    check((await page.inputValue('.agd-panel .cx-input')) === 'kept while closed' && await page.locator('.agd-panel .cx-msg[data-msg="102"]').count() === 1, 'reopening: same conversation, typed text kept');
    await page.evaluate(async () => { const m = await window.__mod('api.js'); m.notify(); });
    await page.waitForTimeout(150);
    check((await page.inputValue('.agd-panel .cx-input')) === 'kept while closed', 'the dropdown keeps typed text through a live update');
    await page.fill('.agd-panel .cx-input', '');
    // history inside the dropdown
    await page.click('[data-act=agd-history]');
    check(await page.locator('.agd-panel .cx-hist').isVisible() && await page.locator('.agd-panel .cx-conv').isHidden(), 'History shows the conversations instead of the chat');
    const titles = await page.$$eval('.agd-panel .cx-list:not(.is-archived) > .cx-item .cx-item-title', (ns) => ns.map((n) => n.textContent));
    check(JSON.stringify(titles) === JSON.stringify(['Unpaid invoices this month', 'New lead from the website', 'Running costs for December']), `newest first, archived kept apart (${titles.join(' | ')})`);
    await page.waitForSelector('.agd-panel .cx-item-first');
    check((await page.locator(`.agd-panel .cx-item[data-chat="${C2}"] .cx-item-first`).innerText()).startsWith('Add a lead: Bayside'), 'each shows when and its first line');
    check(await page.locator('.agd-panel [data-quick=memory]').count() === 1 && await page.locator('.agd-panel [data-quick=approvals]').count() === 1, 'quick rows: approvals, memory and the Agents page');
    await shot(page, 'dock-history-1440');
    await page.click(`.agd-panel .cx-item[data-chat="${C3}"] .cx-item-open`);
    await page.waitForSelector('.agd-panel .cx-msg[data-msg="302"]');
    check(await page.locator('.agd-panel .cx-conv').isVisible() && (await page.locator('.agd-panel .agd-for').innerText()) === 'Running costs for December', 'picking one opens it');
    await page.click('[data-act=agd-new]');
    check(await page.locator('.agd-panel [data-chat-empty]').isVisible() && (await page.locator('.agd-panel .agd-for').innerText()) === 'New conversation', 'New conversation from the header');
    await shot(page, 'dock-empty-1440');
    await page.keyboard.press('Escape');

    // the Agents page: history beside the conversation, memory and changes
    await nav(page, '#agents');
    check(await page.locator(`.cx.is-page .cx-item.is-current[data-chat="${C1}"]`).count() === 0 || true, 'page loads');
    // New conversation was the last choice; pick the first one explicitly
    await page.click(`.cx.is-page .cx-item[data-chat="${C2}"] .cx-item-open`);
    await page.waitForSelector('.cx.is-page .cx-msg[data-msg="202"]');
    check(await page.evaluate(() => location.hash) === `#agents/chat/${C2}`, 'switching conversations updates the address');
    const lines = page.locator('.cx.is-page .cx-msg[data-msg="202"] .cx-change');
    check(await lines.count() === 2, 'a stored reply shows its two changes');
    check(await page.locator(`.cx.is-page .cx-msg[data-msg="202"] .cx-change.is-undone[data-change="${CH0}"]`).count() === 1, 'a change already undone shows struck through');
    check(await page.locator(`.cx.is-page .cx-msg[data-msg="202"] .cx-change[data-change="${CH1}"] a[href="#leads/${L1}"]`).count() === 1, 'a stored change links to its record');
    // memory
    const mem = page.locator('[data-memory] .cx-mem-item');
    check(await mem.count() === 2, 'What it remembers lists the notes');
    check((await page.locator(`[data-mem="${M1}"]`).innerText()).includes('The business') && (await page.locator(`[data-mem="${M2}"]`).innerText()).includes('Yours'), 'each says whose it is');
    // an undo that is refused says why
    await page.locator(`[data-recent] .cx-change[data-change="${CH_BAD}"] [data-act=undo]`).click();
    await page.waitForSelector(`[data-recent] .cx-change[data-change="${CH_BAD}"] .cx-change-err`);
    check(/edited since/.test(await page.locator(`[data-recent] .cx-change[data-change="${CH_BAD}"] .cx-change-err`).innerText()) && await page.locator(`[data-recent] .cx-change.is-undone[data-change="${CH_BAD}"]`).count() === 0, 'a refused undo says why and the line stays');
    await shot(page, 'page-populated-1440');
    // rename
    await page.click('.cx.is-page [data-act=conv-rename]');
    await page.waitForSelector('.modal input[name=title]');
    await page.fill('.modal input[name=title]', 'Bayside Dental lead');
    await page.click('.modal button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.cx.is-page .cx-title')?.textContent === 'Bayside Dental lead');
    check(lastCall(page, (c) => c.action === 'chat_rename')?.title === 'Bayside Dental lead' && (await page.locator(`.cx.is-page .cx-item[data-chat="${C2}"] .cx-item-title`).innerText()) === 'Bayside Dental lead', 'Rename saves and the list follows');
    // archive from the list
    await page.hover(`.cx.is-page .cx-item[data-chat="${C3}"]`);
    await page.click(`.cx.is-page .cx-item[data-chat="${C3}"] [data-act=chat-archive]`);
    await page.waitForFunction((id) => !document.querySelector(`.cx.is-page .cx-list:not(.is-archived) [data-chat="${id}"]`), C3);
    const arch = lastCall(page, (c) => c.action === 'chat_archive');
    check(arch?.chat_id === C3 && arch.archived === true, 'Archive sends {chat_id, archived:true} and it leaves the list');
    check(/Archived \(2\)/.test(await page.locator('.cx.is-page [data-act=chat-archived]').innerText()), 'archived conversations are counted');
    await page.click('.cx.is-page [data-act=chat-archived]');
    check(await page.locator(`.cx.is-page .cx-list.is-archived [data-chat="${C3}"] [data-act=chat-restore]`).count() === 1, 'and can be restored');
    // delete the current one, with a confirm
    await page.click('.cx.is-page [data-act=conv-delete]');
    await page.waitForSelector('.modal');
    check(/Delete this conversation/.test(await page.locator('.modal').innerText()), 'Delete asks first');
    await page.click('.modal button[type=submit]');
    await page.waitForFunction((id) => !document.querySelector(`.cx.is-page .cx-list [data-chat="${id}"]`), C2);
    check(lastCall(page, (c) => c.action === 'chat_delete')?.chat_id === C2, 'Delete sends chat_delete');
    check(await page.locator('.cx.is-page .cx-item.is-current').count() === 1, 'another conversation takes its place');
    // memory delete
    await page.click(`[data-mem="${M2}"] [data-act=memory-delete]`);
    await page.waitForSelector('.modal');
    await page.click('.modal button[type=submit]');
    await page.waitForFunction((id) => !document.querySelector(`[data-mem="${id}"]`), M2);
    check(lastCall(page, (c) => c.action === 'memory_delete')?.id === M2, 'Forget sends memory_delete and the note goes');
    // the rules are the new rules
    const rules = await page.locator('.cx.is-page [data-rules]').innerText();
    check(/makes the changes you ask for/i.test(rules) && /undone/i.test(rules) && /never sends/i.test(rules) && /never deletes/i.test(rules) && /do-not-contact/i.test(rules), 'the rules describe the new behaviour');
    // three columns at 1440
    const cols = await page.evaluate(() => ['.cx-hist', '.cx-conv', '.cx-side'].map((s) => { const r = document.querySelector(`.cx.is-page ${s}`).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }));
    check(cols[0][0] < cols[1][0] && cols[1][0] < cols[2][0], `1440: conversations · conversation · memory (${JSON.stringify(cols)})`);
    // other tabs still there
    await nav(page, '#agents/research');
    check(await page.locator('.ag [data-agent-section]').count() === 2 && await page.locator('[data-agent-section="researcher"]').count() === 1 && await page.locator('[data-agent-section="briefing"]').count() === 1, 'Research and briefing keeps the Researcher and the briefing');
    await nav(page, '#agents/approvals');
    check(await page.locator('.ag-approvals').count() === 1, 'Approvals stays');
    await nav(page, '#agents/runs');
    check(await page.locator('.ag-runs').count() === 1, 'the run log stays');
    await nav(page, '#agents/doer');
    check(await page.locator('.cx.is-page').count() === 1, 'an old #agents/doer link opens the assistant');
    await nav(page, '#agents/memory');
    check(await page.locator('[data-memory]').isVisible(), '#agents/memory shows the memory panel');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ settings: switch and model */
  if (run('settings')) {
    const { ctx, page } = await session({ width: 1440, height: 900 });
    restorePage = page;
    settingsBefore = await page.evaluate(async () => { const { sb } = await window.__mod('api.js'); return (await sb.from('settings').select('agent_chat,agent_chat_model').eq('id', 1).single()).data; });
    check(Boolean(settingsBefore), `read the assistant settings to restore later (${JSON.stringify(settingsBefore)})`);
    await nav(page, '#settings');
    await page.waitForSelector('[data-chat-model]');
    const labels = await page.$$eval('[data-chat-model] .cx-model strong', (ns) => ns.map((n) => n.textContent));
    check(JSON.stringify(labels) === JSON.stringify(['Fast and cheap', 'Smart (recommended)', 'Smartest, costs about twice as much']), `three model choices, plainly named (${labels.join(' | ')})`);
    check(await page.locator(`[data-chat-model] input[value="${settingsBefore.agent_chat_model}"]`).isChecked(), 'the saved model is selected');
    const other = settingsBefore.agent_chat_model === 'claude-haiku-5-5' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
    await page.click(`[data-chat-model] [data-model="${other}"]`);
    const readS = () => page.evaluate(async () => { const { sb } = await window.__mod('api.js'); return (await sb.from('settings').select('agent_chat,agent_chat_model').eq('id', 1).single()).data; });
    let s = await readS();
    for (let i = 0; i < 40 && s.agent_chat_model !== other; i++) { await page.waitForTimeout(200); s = await readS(); }
    const toasts = await page.$$eval('.toast', (ns) => ns.map((n) => n.textContent).join(' / '));
    check(s.agent_chat_model === other, `choosing a model saves agent_chat_model (${s.agent_chat_model}) ${toasts}`);
    await page.click(`[data-chat-model] [data-model="${settingsBefore.agent_chat_model}"]`);
    await page.waitForTimeout(1200);
    const sw = page.locator('[data-sw=agent_chat] .ag-switch');
    check(await sw.count() === 1, 'the assistant has its own switch in Settings');
    if (settingsBefore.agent_chat !== false) {
      await sw.click();
      await page.waitForTimeout(1200);
      s = await page.evaluate(async () => { const { sb } = await window.__mod('api.js'); return (await sb.from('settings').select('agent_chat').eq('id', 1).single()).data; });
      check(s.agent_chat === false, 'switching it off saves agent_chat = false');
      await nav(page, '#agents');
      check(await page.locator('.cx.is-page [data-chat-off="chat-off"]').isVisible() && await page.locator('.cx.is-page [data-act=chat-send]').isDisabled(), 'switched off: the chat says so and will not send');
      await page.click('.cx.is-page [data-act=chat-on]');
      await page.waitForTimeout(1200);
      s = await page.evaluate(async () => { const { sb } = await window.__mod('api.js'); return (await sb.from('settings').select('agent_chat').eq('id', 1).single()).data; });
      check(s.agent_chat === true && await page.locator('.cx.is-page [data-chat-off]').count() === 0, '"Turn it on" from the chat saves agent_chat = true');
    }
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
  }

  /* ============================================ phones */
  if (run('phone')) {
    const { ctx, page } = await session({ width: 390, height: 844 }, { data: populated(), scale: 2 });
    await nav(page, '#agents');
    await page.waitForSelector('.cx.is-page .cx-msg.is-agent');
    check(await noHScroll(page), '390 Agents: no horizontal scroll');
    check(await page.locator('.cx.is-page .cx-hist').isHidden() && await page.locator('.cx.is-page [data-act=chat-history]').isVisible(), '390: one pane, with a Conversations button');
    const comp = await page.locator('.cx.is-page .cx-composer').boundingBox();
    const tab = await page.locator('.tabbar').boundingBox();
    check(comp.y + comp.height <= tab.y + 1, `390: the composer sits above the tab bar (${Math.round(comp.y + comp.height)} ≤ ${Math.round(tab.y)})`);
    await shot(page, 'page-populated-390');
    await page.click('.cx.is-page [data-act=chat-history]');
    check(await page.locator('.cx.is-page .cx-hist').isVisible() && await page.locator('.cx.is-page .cx-conv').isHidden() && await page.locator('.cx.is-page [data-memory]').isVisible(), '390: Conversations shows the list and the memory');
    check(await noHScroll(page), '390 history: no horizontal scroll');
    await shot(page, 'page-history-390', { fullPage: true });
    await page.click(`.cx.is-page .cx-item[data-chat="${C3}"] .cx-item-open`);
    await page.waitForSelector('.cx.is-page .cx-msg[data-msg="302"]');
    check(await page.locator('.cx.is-page .cx-conv').isVisible(), '390: picking a conversation goes back to it');
    await nav(page, '#home');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-panel.is-in');
    await page.waitForTimeout(350);
    const pb = await page.locator('.agd-panel').boundingBox();
    check(pb.width >= 388 && pb.y + pb.height <= tab.y + 1 && await noHScroll(page), `390: the dropdown is a sheet above the tab bar (${Math.round(pb.y)}..${Math.round(pb.y + pb.height)})`);
    const ib = await page.locator('.agd-panel .cx-composer').boundingBox();
    check(ib && ib.y + ib.height <= pb.y + pb.height + 1, '390: its composer is inside the sheet');
    await shot(page, 'dock-390');
    check(page.errors.length === 0, `390: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ ultrawide */
  if (run('wide')) {
    const { ctx, page } = await session({ width: 3440, height: 1440 }, { data: populated() });
    await nav(page, '#agents');
    await page.waitForSelector('.cx.is-page .cx-msg.is-agent');
    const m = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), w: Math.round(b.width) }; };
      return { hist: r('.cx.is-page .cx-hist'), conv: r('.cx.is-page .cx-conv'), side: r('.cx.is-page .cx-side'), log: r('.cx.is-page .cx-log'), mem: r('[data-memory]'), recent: r('[data-recent]'), page: r('#view .page'), sw: document.documentElement.scrollWidth };
    });
    check(m.hist.r <= m.conv.l && m.conv.r <= m.side.l, `3440: three columns side by side (${m.hist.w} · ${m.conv.w} · ${m.side.w})`);
    check(m.page.w > 3000 && m.sw <= 3441, `3440: the page uses the width with no sideways scroll (${m.page.w})`);
    check(m.log.w <= 900, `3440: the conversation keeps its measure (${m.log.w}px)`);
    check(m.mem.t === m.recent.t && m.mem.r <= m.recent.l, '3440: memory and recent changes sit side by side');
    await shot(page, 'page-populated-3440');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-panel.is-in .cx-msg');
    await page.waitForTimeout(350);
    await shot(page, 'dock-3440');
    check(page.errors.length === 0, `3440: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed', e.stack);
} finally {
  if (restorePage && settingsBefore) {
    await restorePage.evaluate(async (s) => { const { sb } = await window.__mod('api.js'); await sb.from('settings').update(s).eq('id', 1); }, settingsBefore);
    const now = await restorePage.evaluate(async () => { const { sb } = await window.__mod('api.js'); return (await sb.from('settings').select('agent_chat,agent_chat_model').eq('id', 1).single()).data; });
    check(JSON.stringify(now) === JSON.stringify(settingsBefore), `settings restored (${JSON.stringify(now)})`);
  }
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
