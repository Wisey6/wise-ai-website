// Wise AI OS: email in the hub. The Settings "Email and calendar" row (not connected, connected,
// the return flag from Google, Gmail API off, disconnect) and the assistant's email draft cards
// (To / Cc / Subject, long text folded, Send, Edit in Gmail, Discard, sent and error states).
// The `gdrive` function's mail actions and the `agent` function are ALWAYS mocked, and the
// conversation and mail_drafts reads are mocked too: nothing here touches a real mailbox, sends
// anything or calls the real chat endpoint.
//
//   python3 -m http.server 8163 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8163/os/ node os/tests/mail.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8163/os/').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
// The operator sign-in address: from the environment, or the one the existing suites use (not repeated here).
const EMAIL = process.env.OS_TEST_EMAIL || (readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'views.test.mjs'), 'utf8').match(/email: '([^']+)'/) || [])[1];
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = U(701); const D2 = U(702); const D3 = U(703); const CHAT = U(710); const P1 = U(730);
const FAKE_ADDR = 'owner@example.test';

const LONG = Array.from({ length: 16 }, (_, i) => `Line ${i + 1} of the email.`).join('\n');
const draftStep = (id, over = {}) => ({ tool: 'draft_email', kind: 'draft', ok: true, text: 'Drafted an email to sam@example.com.au: "Thursday" (not sent)', row_id: id, table_name: 'mail_drafts',
  email: { draft_id: id, to: ['sam@example.com.au'], cc: [], subject: 'Thursday', body: 'Hi Sam,\n\nThursday at 10 suits.\n\nTyler\nWise AI', is_reply: false, gmail_url: 'https://mail.google.com/mail/u/#drafts', status: 'draft', ...over } });

async function session(viewport, { mail = { configured: true, connected: false }, flag = '' } = {}) {
  const ctx = await browser.newContext({ viewport });
  const calls = [];
  const json = (r, status, body) => r.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
  const st = { mail: { ok: true, needs_reconnect: false, email: null, can_read: false, can_draft: false, can_calendar: false, ...mail }, drafts: [] };
  await ctx.route('**/functions/v1/gdrive', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push({ fn: 'gdrive', ...body });
    if (body.action === 'mail_status') return json(r, 200, st.mail);
    if (body.action === 'mail_connect_url') return json(r, 200, { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly&fake=1', expires_in: 600 });
    if (body.action === 'mail_disconnect') { st.mail = { ...st.mail, connected: false, email: null }; return json(r, 200, { ok: true, connected: false }); }
    if (body.action === 'mail_send') {
      if (body.draft_id === D3) return json(r, 409, { ok: false, error: 'blocked', message: 'Not sent: bob@x.test has opted out (do not contact). Remove them from the draft first.' });
      await new Promise((res) => setTimeout(res, 300));
      return json(r, 200, { ok: true, draft: { id: body.draft_id, to: ['sam@example.com.au'], cc: [], subject: 'Thursday', status: 'sent', sent_at: new Date().toISOString() } });
    }
    if (body.action === 'mail_discard') return json(r, 200, { ok: true, draft: { id: body.draft_id, to: ['jo@example.com.au'], cc: [], subject: 'Long one', status: 'discarded', discarded_at: new Date().toISOString() } });
    if (body.action === 'cal_confirm') return json(r, 200, { ok: true, proposal: { proposal_id: body.proposal_id, action: 'create', status: 'done', done_at: new Date().toISOString() } });
    if (body.action === 'cal_cancel') return json(r, 200, { ok: true, proposal: { proposal_id: body.proposal_id, action: 'create', status: 'cancelled' } });
    if (body.action === 'status') return json(r, 200, { ok: true, provider: 'gdrive', configured: false, connected: false });
    return json(r, 400, { ok: false, error: 'bad_request' });
  });
  await ctx.route('**/functions/v1/agent', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'status') return json(r, 200, { configured: true, enabled: true, agents: { researcher: true, briefing: true, chat: true }, spent_usd: 1, cap_usd: 25, runs_today: { chat: 1 }, limits: { chat: 300 } });
    calls.push({ fn: 'agent', ...body });
    if (body.agent === 'chat') {
      const now = new Date().toISOString();
      const steps = [{ tool: 'search_email', kind: 'read', ok: true, text: 'Searched your email: 2 found' }, draftStep(D1),
        draftStep(D2, { to: ['jo@example.com.au'], cc: ['amy@example.com.au'], subject: 'Long one', body: LONG, is_reply: true, thread_subject: 'Quote' }),
        draftStep(D3, { to: ['bob@x.test'], subject: 'Hello Bob' }),
        { tool: 'find_events', kind: 'read', ok: true, text: 'Looked at your calendar: 2 events', events: [
          { id: 'ev1', title: 'Site visit, Harbour Dental', when: 'Fri 20 Nov, 9:00 am to 10:00 am', guests: ['Sam Lee'], location: 'Manly', all_day: false },
          { id: 'ev2', title: 'Gym', when: 'Fri 20 Nov, 5:30 pm to 6:30 pm', guests: [], location: null, all_day: false }] },
        { tool: 'save_event', kind: 'draft', ok: true, text: 'Waiting for you: Add and invite "Quote walk-through"', row_id: P1, table_name: 'calendar_proposals',
          proposal: { proposal_id: P1, action: 'create', title: 'Quote walk-through', when: 'Mon 23 Nov, 10:00 am to 10:30 am', guests: ['sam@example.com.au'], location: 'Phone', status: 'pending', expires_at: new Date(Date.now() + 86400000).toISOString() } }];
      return json(r, 200, { ok: true, chat_id: CHAT, title: 'Emails', changes: [], email_drafts: steps.filter((s) => s.email).map((s) => s.email),
        message: { id: 9901, role: 'assistant', at: now, text: 'Drafted. Press Send when you are happy.', steps, links: [] }, run_id: U(720), model: 'claude-sonnet-5-5', cost_usd: 0.01, spent_usd: 1.01, cap_usd: 25 });
    }
    if (['chat_rename', 'chat_archive', 'chat_delete'].includes(body.action)) return json(r, 200, { ok: true });
    return json(r, 400, { ok: false, error: 'bad_request' });
  });
  const rest = (path, fn) => ctx.route(`**/rest/v1/${path}*`, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (r.request().method() !== 'GET') return json(r, 403, { message: 'read only in tests' });
    return json(r, 200, fn(decodeURIComponent(r.request().url())));
  });
  await rest('agent_chats', () => []);
  await rest('agent_changes', () => []);
  await rest('agent_chat_messages', () => []);
  await rest('mail_drafts', () => st.drafts);
  await rest('calendar_proposals', () => []);
  await ctx.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google</title>Fake Google sign-in' }));
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/functions\/v1\/|net::ERR_FAILED|status of 40[0-9]/.test(m.text())) page.errors.push(m.text()); });
  page.calls = calls;
  page.st = st;
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.agents); i++) await new Promise((r) => setTimeout(r, 100)); });
  if (flag) {
    await page.evaluate((f) => { history.replaceState(null, '', `${location.pathname}?mail=${f}#home`); }, flag);
  }
  return { ctx, page };
}
const nav = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  await page.waitForTimeout(400);
};
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };

try {
  /* ---------------------------------------------------------- Settings: not connected, connect */
  {
    const { ctx, page } = await session({ width: 1280, height: 900 });
    await nav(page, '#settings');
    await page.waitForSelector('[data-mail-row][data-state=not-connected]', { timeout: 10000 });
    const row = page.locator('[data-mail-row]');
    const txt = await row.innerText();
    check(/Email and calendar/.test(txt) && /Not connected/.test(txt), 'Settings > Your sign-in has an Email and calendar row: not connected');
    check(/can search and read your inbox and write drafts\. Nothing is sent until you press Send\./.test(txt), 'the row says plainly what it can do');
    check(page.calls.some((c) => c.action === 'mail_status'), 'it asks the server for the caller\'s own status');
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'settings-not-connected');
    await Promise.all([page.waitForURL(/accounts\.google\.com/, { timeout: 10000 }), page.click('[data-act=mail-connect]')]);
    check(page.url().includes('gmail.readonly'), 'Connect goes to Google with the Gmail scope');
    check(page.calls.some((c) => c.action === 'mail_connect_url'), 'Connect asks for the caller\'s own sign-in link');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ---------------------------------------------------------- Settings: connected, disconnect */
  {
    const { ctx, page } = await session({ width: 1280, height: 900 }, { mail: { configured: true, connected: true, email: FAKE_ADDR, can_read: true, can_draft: true, can_calendar: true } });
    await nav(page, '#settings');
    await page.waitForSelector('[data-mail-row][data-state=connected]', { timeout: 10000 });
    const txt = await page.locator('[data-mail-row]').innerText();
    check(/Connected/.test(txt) && txt.includes(FAKE_ADDR), 'connected: shows the address it is connected as');
    check(await page.locator('[data-act=mail-disconnect]').isVisible(), 'connected: Disconnect is offered');
    await page.locator('[data-mail-row]').scrollIntoViewIfNeeded();
    await shot(page, 'settings-connected');
    await page.click('[data-act=mail-disconnect]');
    await page.waitForSelector('.modal');
    check(/Disconnect your email/.test(await page.locator('.modal').innerText()), 'Disconnect asks first');
    await page.click('.modal button[type=submit]');
    await page.waitForSelector('[data-mail-row][data-state=not-connected]', { timeout: 10000 });
    check(page.calls.some((c) => c.action === 'mail_disconnect'), 'Disconnect calls mail_disconnect');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ---------------------------------------------------------- the return flag */
  {
    const { ctx, page } = await session({ width: 1280, height: 900 }, { mail: { configured: true, connected: true, email: FAKE_ADDR, can_read: true, can_draft: true }, flag: 'connected' });
    await nav(page, '#settings');
    await page.waitForSelector('.toast', { timeout: 8000 });
    check(/Your email and calendar are connected\./.test(await page.locator('.toast').first().innerText()), '?mail=connected shows a toast');
    check(!/[?&]mail=/.test(page.url()), 'the flag is removed from the address');
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ width: 1280, height: 900 }, { flag: 'api_off' });
    await nav(page, '#settings');
    await page.waitForSelector('[data-mail-err]', { timeout: 8000 });
    await page.waitForTimeout(400);
    check(/Gmail API is not switched on in Google Cloud yet/.test(await page.locator('[data-mail-err]').innerText()), '?mail=api_off: says the Gmail API is not switched on');
    await ctx.close();
  }

  /* ---------------------------------------------------------- draft cards in the conversation */
  {
    const { ctx, page } = await session({ width: 1280, height: 900 }, { mail: { configured: true, connected: true, email: FAKE_ADDR, can_read: true, can_draft: true } });
    await nav(page, '#agents');
    await page.waitForSelector('.cx.is-page [data-chat-empty]');
    const ex = await page.$$eval('.cx.is-page [data-example]', (ns) => ns.map((n) => n.textContent.trim()));
    check(ex.some((t) => /email/i.test(t)), 'connected: the empty conversation offers an email example');
    check(/nothing is sent until you press Send/.test(await page.locator('.cx.is-page [data-chat-empty]').innerText()), 'connected: the empty state says nothing is sent until you press Send');
    await page.fill('.cx.is-page .cx-input', 'Draft replies to Sam, Jo and Bob');
    await page.locator('.cx.is-page .cx-input').press('Enter');
    await page.waitForSelector('.cx.is-page [data-mail-draft]', { timeout: 10000 });
    const cards = page.locator('.cx.is-page [data-mail-draft]');
    check(await cards.count() === 3, `three draft cards (${await cards.count()})`);
    const c1 = cards.nth(0);
    const t1 = await c1.innerText();
    check(/Email draft/.test(t1) && /sam@example\.com\.au/.test(t1) && /Thursday/.test(t1) && /Thursday at 10 suits/.test(t1) && /Not sent/.test(t1), 'a card shows To, Subject, the text and "Not sent"');
    check(/Send to sam@example\.com\.au/.test(await c1.locator('[data-act=mail-send]').innerText()), 'Send names the recipient');
    const edit = c1.locator('[data-act=mail-edit]');
    check((await edit.getAttribute('href')).startsWith('https://mail.google.com/') && (await edit.getAttribute('target')) === '_blank' && /noopener/.test(await edit.getAttribute('rel')), 'Edit in Gmail opens Gmail in a new tab');
    const c2 = cards.nth(1);
    check(/Reply draft/.test(await c2.innerText()) && /amy@example\.com\.au/.test(await c2.innerText()), 'a reply card shows Cc');
    check(!/Line 16/.test(await c2.locator('[data-mail-body]').innerText()) && await c2.locator('[data-act=mail-more]').isVisible(), 'a long email is folded after ten lines');
    await c2.locator('[data-act=mail-more]').click();
    check(/Line 16/.test(await page.locator(`[data-mail-draft="${D2}"] [data-mail-body]`).innerText()), 'Show all opens the whole text');
    check(!(await page.locator('.cx.is-page .cx-reads').innerText().catch(() => '')).includes('Drafted'), 'draft steps are not listed as look-ups');
    await shot(page, 'chat-draft-cards');
    // Send: one press, then "Sent <time>" and no buttons.
    await page.click(`[data-mail-draft="${D1}"] [data-act=mail-send]`);
    await page.waitForSelector(`[data-mail-draft="${D1}"][data-state=sent]`, { timeout: 8000 });
    const sent = await page.locator(`[data-mail-draft="${D1}"]`).innerText();
    check(/Sent \d{1,2}:\d{2}/i.test(sent) && await page.locator(`[data-mail-draft="${D1}"] [data-act=mail-send]`).count() === 0, 'after Send the card says Sent with the time and has no buttons');
    check(page.calls.filter((c) => c.action === 'mail_send').length === 1 && page.calls.find((c) => c.action === 'mail_send').draft_id === D1, 'Send called mail_send once, for that draft');
    // Discard
    await page.click(`[data-mail-draft="${D2}"] [data-act=mail-discard]`);
    await page.waitForSelector(`[data-mail-draft="${D2}"][data-state=discarded]`, { timeout: 8000 });
    check(/Discarded/.test(await page.locator(`[data-mail-draft="${D2}"]`).innerText()) && !page.calls.some((c) => c.action === 'mail_send' && c.draft_id === D2), 'Discard marks it discarded and sends nothing');
    // A refused send shows inline and keeps the card.
    await page.click(`[data-mail-draft="${D3}"] [data-act=mail-send]`);
    await page.waitForSelector(`[data-mail-draft="${D3}"] .cx-mail-err`, { timeout: 8000 });
    check(/opted out/.test(await page.locator(`[data-mail-draft="${D3}"] .cx-mail-err`).innerText()) && await page.locator(`[data-mail-draft="${D3}"][data-state=draft]`).count() === 1, 'a refused send says why, inline, and the draft stays');
    // Calendar: event tiles and a change with guests that waits for the button.
    const tiles = await page.locator('.cx.is-page [data-event]').allInnerTexts();
    check(tiles.length === 2 && /Site visit, Harbour Dental/.test(tiles[0]) && /Fri 20 Nov, 9:00 am/.test(tiles[0]) && /Sam Lee/.test(tiles[0]), 'calendar events show as tiles: title, day and time, guests');
    const pc = page.locator(`[data-cal-proposal="${P1}"]`);
    check(/New event/.test(await pc.innerText()) && /Quote walk-through/.test(await pc.innerText()) && /sam@example\.com\.au/.test(await pc.innerText()) && /Waiting for you/.test(await pc.innerText()), 'a calendar change with guests shows what, when, who and "Waiting for you"');
    check(/Add and invite/.test(await pc.locator('[data-act=cal-confirm]').innerText()), 'its button says Add and invite');
    await pc.locator('[data-act=cal-confirm]').click();
    await page.waitForSelector(`[data-cal-proposal="${P1}"][data-state=done]`, { timeout: 8000 });
    check(/Added and invited/.test(await page.locator(`[data-cal-proposal="${P1}"]`).innerText()) && page.calls.filter((c) => c.action === 'cal_confirm' && c.proposal_id === P1).length === 1, 'pressing it calls cal_confirm once and the card says Added and invited');
    await shot(page, 'chat-draft-states');
    check(page.calls.filter((c) => c.fn === 'agent' && c.agent === 'chat').length === 1, 'one (mocked) chat call, none real');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    // Phone width: no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390 px: the cards fit with no sideways scroll');
    await shot(page, 'chat-draft-390');
    await ctx.close();
  }
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed', e.stack);
} finally {
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
