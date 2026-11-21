// Wise AI OS: the lead scout's hub screens. The Scout page (review cards, keyboard, multi-select,
// Approve with Open lead and Undo, Skip with a reason or Undo, the filters, empty / loading /
// error states), its settings panel (switch, brief, schedule, Run now with progress and result)
// for the owner and a team member, the "to review" card on Today, the sidebar count, and the
// pointer from Agents, Approvals.
//
// Every scout door that changes anything (scout_decide, a scout_settings patch, a run, undo) is
// ALWAYS answered here with invented fixtures ("ZZSCOUT ..."): nothing here approves or skips a
// real candidate, changes a real setting, starts a paid run or sends anything. The agent_actions
// and agent_runs reads are answered with fixtures too, so no real business shows on screen.
// One last section reads the live queue through the read-only doors only (no clicks).
//
//   python3 -m http.server 8191 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8191/os/ node os/tests/scout.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8191/os/').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
// The operator sign-in address: from the environment, or the one the existing suites use (not repeated here).
const EMAIL = process.env.OS_TEST_EMAIL || (readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'views.test.mjs'), 'utf8').match(/email: '([^']+)'/) || [])[1];
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = U(900);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

/* ------------------------------------------------------------ invented fixtures */
const cand = (n, over = {}) => ({
  id: U(n), created_at: ago(n), run_id: RUN, status: 'proposed', business: `ZZSCOUT Example ${['Plumbing', 'Electrical', 'Physio', 'Concreting', 'Cleaning'][n % 5]} ${n}`,
  suburb: ['Exampleton', 'Sampleville', 'Testbury'][n % 3], industry: ['Plumbing', 'Electrical', 'Physiotherapy', 'Concreting', 'Cleaning'][n % 5],
  website: `https://zzscout-${n}.example.com/`, phone: n % 2 ? '+61491570156' : '+61755501234', phone_kind: n % 2 ? 'mobile' : 'landline',
  number_source_url: `https://zzscout-${n}.example.com/contact`, contact_first_name: n % 2 ? 'Sam' : null,
  observations: [
    { text: 'The contact page asks people to call for a quote; there is no online booking.', source_url: `https://zzscout-${n}.example.com/contact` },
    { text: 'Open Saturdays, by phone only.', source_url: `https://directory.example.org/zzscout-${n}` }
  ],
  hook: 'Saw your contact page sends every quote by phone, which is easy to miss on site.', pain: 'Calls missed on the job go to the next business.',
  est_monthly_value: 1200, value_reasoning: 'About 2 missed calls a week x $1,500 job x 20% won.', first_text: null,
  score: [72, 61, 40][n % 3], score_reason: 'Phone-first quoting and a small team.', decided_at: null, decided_by: null, decided_via: null,
  reject_reason: null, lead_id: null, action_id: U(n + 100), expires_at: new Date(Date.now() + 10 * 86400000).toISOString(), open: null, ...over
});
const PROPOSED = [cand(1), cand(2), cand(3), cand(4)];
const APPROVED = [cand(11, { status: 'approved', decided_at: ago(60), decided_via: 'hub', lead_id: U(511), open: `#leads/${U(511)}` }), cand(12, { status: 'approved', decided_at: ago(90), decided_via: 'email', lead_id: null })];
const REJECTED = [cand(21, { status: 'rejected', decided_at: ago(30), decided_via: 'hub', reject_reason: 'Too big' }), cand(22, { status: 'rejected', decided_at: ago(40), decided_via: 'hub' })];
const actionFor = (c) => ({ id: c.action_id, run_id: RUN, kind: 'lead.add', status: 'proposed', created_at: c.created_at, decided_at: null, decided_by: null, result: null,
  payload: { candidate_id: c.id, business: c.business, suburb: c.suburb, industry: c.industry, score: c.score, hook: c.hook, phone_kind: c.phone_kind },
  summary: `New lead: ${c.business}, ${c.suburb} (fit ${c.score}/100)`, reason: c.score_reason });
const SETTINGS = { scout_enabled: true, scout_brief: 'ZZSCOUT test brief: owner-run trades in Exampleton that quote by phone.', scout_daily_max: 10, scout_days: [1, 2, 3, 4, 5], scout_hour: 7, scout_monthly_cap_usd: 10 };
const SCOUT_RUN = { id: RUN, agent: 'scout', status: 'ok', at: ago(180), cost_usd: 0.13, input: { trigger: 'schedule', count: 6 }, output: { kept: 4, found: 6 }, error: null, sources: [], input_tokens: 0, output_tokens: 0, searches: 4, duration_ms: 29000, model: 'claude-sonnet-5-5', lead_id: null };

const browser = await chromium.launch();

/**
 * cfg: { role, lists:{proposed,approved,rejected}, settings, status, listFail, runDelay, run, decide(id, decision) → body, live }
 * page.calls records every agent call (minus 'status'), page.errors every page error and console error.
 */
async function session(cfg = {}, { viewport = { width: 1440, height: 900 }, hash = '#scout', scale = SHOTS ? 2 : 1 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
  const calls = [];
  const json = (r, status, body) => r.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
  const C = { role: 'owner', lists: { proposed: PROPOSED, approved: APPROVED, rejected: REJECTED }, settings: { ...SETTINGS }, ...cfg };
  C.lists = { ...C.lists };
  const statusBody = () => ({ ok: true, settings: C.settings, spent_usd: C.spent ?? 2.4, cap_usd: Number(C.settings.scout_monthly_cap_usd), runs_this_month: 9,
    last_run: { at: SCOUT_RUN.at, status: 'ok', kept: 4 }, waiting: C.lists.proposed.length, schedule_now: 'due' });
  await ctx.route('**/functions/v1/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const name = req.url().split('/functions/v1/')[1].split(/[?/]/)[0];
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* */ }
    if (name === 'hq-login' && (body.action === 'who' || body.action === 'me')) {
      const res = await r.fetch();
      const data = await res.json().catch(() => null);
      if (body.action === 'me' && data?.member && C.role) data.member = { ...data.member, role: C.role };
      return json(r, res.status(), data);
    }
    if (name === 'sms-send' && body.action === 'status') return json(r, 200, { configured: false, sent_today: 0, daily_cap: 40, window_open: true });
    if (name !== 'agent') return json(r, 403, { ok: false, error: 'mocked' });
    if (body.action === 'status') return json(r, 200, { configured: true, enabled: C.agentsOff ? false : true, agents: { chat: true }, spent_usd: 2.4, cap_usd: 25, runs_today: {}, limits: {} });
    calls.push(body);
    const readOnly = body.action === 'scout_status' || body.action === 'scout_candidates' || (body.action === 'scout_settings' && body.patch === undefined);
    if (C.live) {
      // Live: only the read-only doors reach the real function. Anything else is refused here.
      if (readOnly) { const res = await r.fetch(); return r.fulfill({ response: res }); }
      return json(r, 403, { ok: false, error: 'mocked' });
    }
    if (body.action === 'scout_status') return C.statusFail ? json(r, 500, { ok: false, error: 'server_error' }) : json(r, 200, statusBody());
    if (body.action === 'scout_settings') {
      if (body.patch === undefined) return json(r, 200, { ok: true, settings: C.settings, can_change_cap: C.role === 'owner' });
      if (C.role !== 'owner' && 'scout_monthly_cap_usd' in body.patch) return json(r, 403, { ok: false, error: 'owner_only' });
      C.settings = { ...C.settings, ...body.patch };
      return json(r, 200, { ok: true, settings: C.settings, can_change_cap: C.role === 'owner' });
    }
    if (body.action === 'scout_candidates') {
      if (C.slowList) await new Promise((res) => setTimeout(res, C.slowList));
      if (C.listFail) return json(r, 500, { ok: false, error: 'server_error' });
      return json(r, 200, { ok: true, items: C.lists[body.status || 'proposed'] || [], next_before: null });
    }
    if (body.action === 'scout_decide') {
      const ids = body.candidate_ids || [body.candidate_id];
      const one = (id) => (C.decide ? C.decide(id, body.decision) : null) || (body.decision === 'approve'
        ? { ok: true, status: 'approved', lead_id: U(500 + Number(id.slice(-3))), hash: `#leads/${U(500 + Number(id.slice(-3)))}`, business: 'x', change_id: U(800 + Number(id.slice(-3))) }
        : { ok: true, status: 'rejected', business: 'x' });
      C.lists.proposed = C.lists.proposed.filter((c) => !ids.includes(c.id));
      if (body.candidate_ids) { const results = ids.map((id) => ({ candidate_id: id, ...one(id) })); return json(r, 200, { ok: results.every((x) => x.ok), results, approved: results.filter((x) => x.status === 'approved').length, rejected: results.filter((x) => x.status === 'rejected').length }); }
      return json(r, 200, one(ids[0]));
    }
    if (body.action === 'undo') return json(r, 200, { ok: true, undone_at: new Date().toISOString(), kind: 'record' });
    if (body.agent === 'scout') {
      await new Promise((res) => setTimeout(res, C.runDelay ?? 1500));
      const [status, res] = C.run || [200, { ok: true, run_id: U(901), model: 'claude-sonnet-5-5', cost_usd: 0.12, found: 4, kept: 2, dropped: [{ business: 'ZZSCOUT Dropped One', why: 'number not on the cited page' }, { business: 'ZZSCOUT Dropped Two', why: 'same website' }], candidate_ids: [U(31), U(32)], searches: 4, fetches: 6 }];
      if (status === 200 && res.ok) C.lists.proposed = [cand(31), cand(32), ...C.lists.proposed];
      return json(r, status, res);
    }
    return json(r, 403, { ok: false, error: 'mocked' });
  });
  // No real business on screen: the scout's hub cards and the run log are fixtures.
  await ctx.route('**/rest/v1/agent_actions*', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(C.live ? [] : (C.actions ?? PROPOSED.map(actionFor))) }) : r.fulfill({ status: 403, headers: CORS, body: '{}' })));
  await ctx.route('**/rest/v1/agent_runs*', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(C.live ? [] : [SCOUT_RUN]) }) : r.fulfill({ status: 403, headers: CORS, body: '{}' })));
  // Pages a card links to never load from a test.
  await ctx.route(/example\.(com|org)/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>example</p>' }));
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.calls = calls;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of 40[13]|WebSocket/i.test(m.text())) page.errors.push(m.text()); });
  page.C = C;
  await page.goto(URL + '#home', { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.agents); i++) await new Promise((r) => setTimeout(r, 100)); });
  if (hash !== '#home') await go(page, hash);
  return { ctx, page };
}
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  if (hash.startsWith('#scout')) {
    await page.waitForSelector('[data-scout]', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.sc-list[aria-busy]') && !document.querySelector('.sc-panel.is-loading'), null, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(350);
}
const decides = (page) => page.calls.filter((c) => c.action === 'scout_decide');
const shot = async (page, name, locator = null) => { if (!SHOTS) return; if (locator) await locator.screenshot({ path: join(SHOTS, `${name}.png`) }); else await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const cardText = (page, i) => page.locator('.sc-list > .sc-card').nth(i).innerText();
const active = (page) => page.evaluate(() => ({ id: document.activeElement?.dataset?.id || null, cls: document.activeElement?.className || '' }));
const noHScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

try {
  /* ============================================ owner, 1440: the review list */
  {
    const { ctx, page } = await session();
    check(await page.locator('.sc-list > .sc-card').count() === 4, 'four businesses to review');
    check(await page.locator('h1').innerText() === 'Lead scout', 'page title: Lead scout');
    const t0 = await cardText(page, 0);
    check(t0.includes('ZZSCOUT Example Electrical 1') && /Electrical · Sampleville/.test(t0), 'card: business name, what they do and the area');
    check(/Phone-first quoting/.test(t0) && /no online booking/.test(t0), 'card: why it fits (the reason and what the pages show)');
    check(await page.locator('.sc-list > .sc-card').first().locator('a.sc-src[href^="https://"][target=_blank][rel*=noopener]').count() >= 2, 'card: source links open in a new tab');
    check(/0491 570 156/.test(t0) && /Sam/.test(t0) && /zzscout-1\.example\.com/.test(t0), 'card: contact details found (phone, first name, website)');
    check(/Worth about \$1,200 a month/.test(t0) && /Fit 61/.test(t0), 'card: value and fit score');
    check(await page.locator('.sc-list > .sc-card').first().locator('[data-act=approve]').isVisible() && await page.locator('.sc-list > .sc-card').first().locator('[data-act=skip]').isVisible(), 'card: Approve and Skip');
    check(/To review\s*4/.test(await page.locator('.sc-tabs').innerText()), 'To review tab shows the count');
    const safe = await page.locator('[data-safe]').innerText();
    check(safe.trim() === 'Nothing is sent to these businesses. Approving only adds them to Leads.', 'the plain safety line is on the page');
    check(/Weekdays at 7 am, up to 10 a day/.test(await page.locator('.sc-panel').innerText()), 'settings panel: schedule in plain words');
    check(/3h ago · found 4 · US\$0\.13/.test(await page.locator('.sc-panel').innerText()), 'settings panel: last run time, result and cost');
    check(/US\$2\.40 of US\$10\.00/.test(await page.locator('.sc-panel').innerText()), 'settings panel: this month against the budget');
    check(await page.locator('[data-route=scout] .nav-count').first().innerText() === '4', 'sidebar: Lead scout shows 4 to review');
    const navOrder = await page.evaluate(() => [...document.querySelectorAll('.rail .nav-item[data-route]')].map((a) => a.dataset.route).slice(0, 4).join(','));
    check(/leads,scout/.test(navOrder), `sidebar: Lead scout sits next to Leads (${navOrder})`);
    check(!/!/.test(await page.locator('.sc-page').innerText()), 'no exclamation marks');
    check(await noHScroll(page), 'no sideways scroll at 1440');
    await shot(page, 'scout-1440-list');
    await shot(page, 'scout-1440-settings-strip', page.locator('.sc-panel'));

    /* keyboard: move, approve, undo */
    await page.locator('.sc-list > .sc-card').first().locator('.sc-name').click();
    check((await active(page)).id === U(1), 'clicking a card focuses it');
    await page.keyboard.press('ArrowDown');
    check((await active(page)).id === U(2), 'ArrowDown moves to the next card');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('j');
    check((await active(page)).id === U(2), 'ArrowUp and J move too');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
    check(outline && outline !== 'none', 'the focused card shows a focus ring');
    await page.keyboard.press('a');
    await page.waitForSelector(`.sc-receipt[data-id="${U(2)}"][data-receipt=added]`, { timeout: 5000 });
    check(decides(page).length === 1 && decides(page)[0].candidate_id === U(2) && decides(page)[0].decision === 'approve', 'A approves the focused card (one decide call)');
    const rec = page.locator(`.sc-receipt[data-id="${U(2)}"]`);
    check(/Added to Leads/.test(await rec.innerText()) && await rec.locator('a[data-act=open-lead]').getAttribute('href') === `#leads/${U(502)}`, 'quiet confirmation in place: Added to Leads with Open lead');
    check(await rec.locator('[data-act=undo]').isVisible(), 'the confirmation has Undo');
    check((await active(page)).id === U(3), 'focus moves on to the next card');
    check(/To review\s*3/.test(await page.locator('.sc-tabs').innerText()), 'count drops to 3');
    check(await page.locator('[data-route=scout] .nav-count').first().innerText() === '3', 'sidebar count drops at once');
    await page.waitForTimeout(400);
    await shot(page, 'scout-1440-approved-receipt');
    await rec.locator('[data-act=undo]').click();
    await page.waitForSelector(`.sc-receipt[data-id="${U(2)}"][data-receipt=undone]`, { timeout: 5000 });
    check(page.calls.some((c) => c.action === 'undo' && c.change_id === U(802)), 'Undo removes the lead through the change log (undo door)');
    check(/Undone/.test(await rec.innerText()) && /lead was removed/i.test(await page.locator(`.sc-receipt[data-id="${U(2)}"]`).innerText()), 'after Undo: Undone, the lead was removed');

    /* skip with a reason */
    await page.locator(`.sc-card[data-id="${U(3)}"]`).focus();
    await page.keyboard.press('s');
    await page.waitForSelector(`.sc-receipt[data-id="${U(3)}"][data-receipt=skipping]`);
    check(decides(page).length === 1, 'S skips at once on screen, but saves only after a pause (Undo window)');
    const chips = await page.locator(`.sc-receipt[data-id="${U(3)}"] .sc-reason-chip`).allInnerTexts();
    check(chips.includes('Not a fit') && chips.length >= 4, 'skip offers short reasons');
    await shot(page, 'scout-1440-skip-reasons', page.locator(`.sc-receipt[data-id="${U(3)}"]`));
    await page.locator(`.sc-receipt[data-id="${U(3)}"] .sc-reason-chip`, { hasText: 'Not a fit' }).click();
    await page.waitForTimeout(400);
    const rj = decides(page).find((c) => c.decision === 'reject');
    check(rj && rj.candidate_id === U(3) && rj.reason === 'Not a fit', 'picking a reason saves the skip with that reason');
    check(/Skipped/.test(await page.locator(`.sc-receipt[data-id="${U(3)}"]`).innerText()) && /Not a fit/.test(await page.locator(`.sc-receipt[data-id="${U(3)}"]`).innerText()), 'skipped receipt shows the reason');

    /* skip then Undo: nothing is saved */
    await page.locator(`.sc-card[data-id="${U(4)}"]`).focus();
    await page.keyboard.press('s');
    await page.waitForSelector(`.sc-receipt[data-id="${U(4)}"][data-receipt=skipping]`);
    await page.keyboard.press('u');
    await page.waitForSelector(`.sc-card[data-id="${U(4)}"]`);
    check(!decides(page).some((c) => c.candidate_id === U(4)), 'U (Undo) before the pause puts the card back; nothing saved');
    check((await active(page)).id === U(4), 'focus returns to the card that came back');

    /* skip and wait: saved without a reason */
    await page.keyboard.press('s');
    await page.waitForTimeout(8600);
    const late = decides(page).find((c) => c.candidate_id === U(4));
    check(late && late.decision === 'reject' && !late.reason, 'a skip left alone saves after the pause, with no reason');
    await page.locator(`.sc-card[data-id="${U(1)}"] [data-act=approve]`).click();
    await page.waitForSelector(`.sc-receipt[data-id="${U(1)}"]`);
    check(await page.locator('.sc-list .sc-empty').count() === 1 && /All reviewed/.test(await page.locator('.sc-list .sc-empty').innerText()), 'all reviewed: a quiet end line');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ multi-select, filters, states */
  {
    const { ctx, page } = await session();
    await page.locator(`.sc-card[data-id="${U(1)}"] .sc-pick`).check();
    await page.locator(`.sc-card[data-id="${U(3)}"]`).focus();
    await page.keyboard.press('x');
    check(await page.locator('.sc-bulk').isVisible() && /2 selected/.test(await page.locator('.sc-bulk').innerText()), 'selecting two shows the bar: 2 selected');
    check(await page.locator('.sc-card.is-selected').count() === 2, 'selected cards are marked');
    await shot(page, 'scout-1440-selected');
    check(/Approve 2/.test(await page.locator('[data-act=approve-selected]').innerText()) && /Skip 2/.test(await page.locator('[data-act=skip-selected]').innerText()), 'Approve selected / Skip selected name the count');
    await page.locator('[data-act=approve-selected]').click();
    await page.waitForSelector(`.sc-receipt[data-id="${U(3)}"][data-receipt=added]`);
    const d = decides(page)[0];
    check(d && Array.isArray(d.candidate_ids) && d.candidate_ids.length === 2 && d.decision === 'approve', 'Approve selected: one call with both ids');
    check(await page.locator('.sc-receipt[data-receipt=added]').count() === 2 && await page.locator('.sc-bulk').isHidden(), 'both close into receipts; the bar goes');
    await page.locator('[data-act=select-all]').check();
    check(/2 selected/.test(await page.locator('.sc-bulk').innerText()), 'Select all picks what is left to review');
    await page.locator('[data-act=skip-selected]').click();
    check(await page.locator('.sc-receipt[data-receipt=skipping]').count() === 2, 'Skip selected: both wait with Undo');
    // Leaving the page saves skips still waiting.
    await page.locator('.sc-tabs [data-filter=approved]').click();
    await page.waitForSelector('.sc-row');
    const rejects = decides(page).filter((c) => c.decision === 'reject');
    check(rejects.length === 1 && rejects[0].candidate_ids?.length === 2, 'changing the filter saves skips that were waiting');
    check(page.calls.some((c) => c.action === 'scout_candidates' && c.status === 'approved'), 'Approved filter asks for approved candidates');
    const rows = await page.locator('.sc-row').allInnerTexts();
    check(rows.length === 2 && /Open lead/.test(rows[0]) && /Lead removed/.test(rows[1]) && /from the email/.test(rows[1]), 'Approved: Open lead, or Lead removed, and where it was decided');
    await page.locator('.sc-tabs [data-filter=rejected]').click();
    await page.waitForFunction(() => document.querySelector('.sc-row.is-rejected'));
    const sk = await page.locator('.sc-row').allInnerTexts();
    check(/Too big/.test(sk[0]) && /No reason given/.test(sk[1]), 'Skipped: the reason, or No reason given');
    await page.locator('.sc-tabs [data-filter=approved]').focus();
    await page.keyboard.press('ArrowLeft');
    check(await page.locator('.sc-tabs [data-filter=proposed]').getAttribute('aria-selected') === 'true', 'filters work with arrow keys (tablist)');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ empty, loading, error */
  {
    const { ctx, page } = await session({ lists: { proposed: [], approved: [], rejected: [] }, slowList: 900, actions: [] }, { hash: '#home' });
    await page.evaluate(() => { location.hash = '#scout'; });
    await page.waitForSelector('.sc-list[aria-busy=true] .sc-card.is-skel', { timeout: 5000 }).then(() => check(true, 'loading: placeholder cards while the list loads')).catch(() => check(false, 'loading: placeholder cards while the list loads'));
    await page.waitForSelector('.sc-empty[data-empty=proposed]', { timeout: 8000 });
    const t = await page.locator('.sc-empty').innerText();
    check(/Nothing to review/.test(t) && /looks again weekdays at 7 am/.test(t), 'empty: Nothing to review, and when it looks again');
    check(await page.locator('.sc-empty [data-act=run-empty]').isVisible(), 'empty: Run now offered to the owner');
    check(await page.locator('.sc-toolbar').isHidden(), 'empty: no select-all or key hints');
    check(await page.locator('[data-route=scout] .nav-count').first().isHidden(), 'sidebar: no count when nothing waits');
    await shot(page, 'scout-1440-empty');
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ listFail: true });
    check(await page.locator('.sc-empty.is-error').isVisible() && /Could not load the list/.test(await page.locator('.sc-empty.is-error').innerText()), 'error: Could not load the list, with the reason');
    page.C.listFail = false;
    await page.locator('.sc-empty.is-error [data-act=retry]').click();
    await page.waitForSelector('.sc-list > .sc-card:not(.is-skel)');
    await page.waitForTimeout(300);
    const nAfter = await page.locator('.sc-list > .sc-card').count();
    check(nAfter === 4, `error: Try again loads the list (${nAfter})`);
    await ctx.close();
  }

  /* ============================================ settings and Run now (owner) */
  {
    const { ctx, page } = await session();
    const sw = page.locator('.sc-switch input');
    check(await sw.isChecked() && !(await sw.isDisabled()), 'owner: the switch is on and can be changed');
    await page.locator('.sc-switch').click();
    await page.waitForTimeout(400);
    const p1 = page.calls.find((c) => c.action === 'scout_settings' && c.patch);
    check(p1 && JSON.stringify(p1.patch) === '{"scout_enabled":false}', 'switch saves only scout_enabled');
    check(/Off/.test(await page.locator('.sc-switch').innerText()), 'switch reads Off');
    await page.locator('[data-act=edit]').click();
    await page.waitForSelector('#sc-editor:not([hidden])');
    await page.waitForTimeout(120);
    check(await page.locator('[data-act=edit]').getAttribute('aria-expanded') === 'true', 'Brief and schedule expands (aria-expanded)');
    check(await page.evaluate(() => document.activeElement?.name) === 'scout_brief', 'the brief is focused when it opens');
    check(await page.locator('.sc-brief').inputValue() === SETTINGS.scout_brief, 'the brief shows the saved text');
    check(await page.locator('[data-act=save]').isDisabled(), 'Save waits until something changes');
    await shot(page, 'scout-1440-settings-open', page.locator('.sc-panel'));
    await page.locator('.sc-brief').fill('ZZSCOUT test brief, changed: owner-run physios in Sampleville.');
    await page.locator('.sc-side input[type=number]').first().fill('6');
    await page.locator('.sc-day', { hasText: 'Sa' }).click();
    await page.locator('[data-act=save]').click();
    await page.waitForSelector('#sc-editor', { state: 'hidden' });
    const p2 = page.calls.filter((c) => c.action === 'scout_settings' && c.patch)[1];
    check(p2 && p2.patch.scout_brief === 'ZZSCOUT test brief, changed: owner-run physios in Sampleville.' && p2.patch.scout_daily_max === 6 && JSON.stringify(p2.patch.scout_days) === '[1,2,3,4,5,6]' && !('scout_hour' in p2.patch), 'Save sends just what changed (brief, per day, days)');
    check(/Mon, Tue, Wed, Thu, Fri, Sat at 7 am/.test(await page.locator('.sc-panel').innerText()) || /Off\. When on: mon, tue/i.test(await page.locator('.sc-panel').innerText()), 'the schedule line updates');
    // A bad value is caught before saving.
    await page.locator('[data-act=edit]').click();
    await page.locator('.sc-side input[type=number]').first().fill('40');
    await page.locator('[data-act=save]').click();
    check(/1 to 30/.test(await page.locator('.sc-form-err').innerText()), 'per day outside 1 to 30 is explained, not sent');
    await page.locator('[data-act=cancel]').click();

    // Run now: confirm, progress, result.
    await page.locator('.sc-head [data-act=run]').click();
    await page.waitForSelector('.modal');
    const msg = await page.locator('.modal').innerText();
    check(/Look for businesses now/.test(msg) && /Nothing is sent to these businesses/.test(msg) && /US\$0\.13/.test(msg), 'Run now asks first, with the cost and the safety line');
    await page.locator('.modal button[type=submit]').click();
    await page.waitForSelector('.sc-runline .sc-prog');
    check(/Running/.test(await page.locator('.sc-head [data-act=run]').innerText()) && await page.locator('.sc-head [data-act=run]').isDisabled(), 'while running: the button says Running and waits');
    check(/searching the web/i.test(await page.locator('.sc-runline').innerText()), 'progress: what it is doing, and the seconds');
    await shot(page, 'scout-1440-running', page.locator('.sc-panel'));
    await page.waitForSelector('.sc-runline.is-done', { timeout: 8000 });
    const done = await page.locator('.sc-runline').innerText();
    check(/Found 2 businesses that fit/.test(done) && /4 looked at · 2 set aside · US\$0\.12/.test(done), 'result: how many fit, how many were set aside, the cost');
    const run = page.calls.find((c) => c.agent === 'scout');
    check(run && run.count === 6, 'Run now asks for at most 6 (the day limit, capped per run)');
    await page.waitForSelector(`.sc-card[data-id="${U(31)}"]`);
    check(await page.locator(`.sc-card[data-id="${U(31)}"]`).count() === 1, 'the new finds appear in the list');
    await page.locator('.sc-dropped summary').click();
    check(/number not on the cited page/.test(await page.locator('.sc-dropped').innerText()), 'why some were set aside, on request');
    await shot(page, 'scout-1440-run-result', page.locator('.sc-panel'));
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ run: [402, { ok: false, error: 'scout_cap_reached', run_id: null, cost_usd: 0 }], runDelay: 200 });
    await page.locator('.sc-head [data-act=run]').click();
    await page.locator('.modal button[type=submit]').click();
    await page.waitForSelector('.sc-runline.is-bad', { timeout: 5000 });
    check(/budget for this month is used up/.test(await page.locator('.sc-runline').innerText()), 'run refused by the budget: said plainly');
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ spent: 10.5 });
    check(await page.locator('.sc-head [data-act=run]').isDisabled() && /used up/.test(await page.locator('.sc-warn').innerText()), 'over budget: Run now is off and the panel says why');
    await ctx.close();
  }

  /* ============================================ a team member */
  {
    const { ctx, page } = await session({ role: 'member' });
    check(await page.locator('.sc-head [data-act=run]').isHidden(), 'member: no Run now');
    check(await page.locator('.sc-switch input').isDisabled(), 'member: the switch is read-only');
    await page.locator('[data-act=edit]').click();
    check(await page.locator('.sc-brief').isDisabled() && await page.locator('[data-act=save]').isHidden() && /Only the owner/.test(await page.locator('.sc-panel').innerText()), 'member: the brief is read-only, with who can change it');
    check(await page.locator('.sc-list > .sc-card').first().locator('[data-act=approve]').isVisible(), 'member: can still review');
    check(!page.calls.some((c) => c.patch || c.agent === 'scout'), 'member: nothing changed');
    await ctx.close();
  }

  /* ============================================ Today, Agents */
  {
    const { ctx, page } = await session({}, { hash: '#home' });
    await page.waitForSelector('[data-today-scout]');
    const t = await page.locator('[data-today-scout]').innerText();
    check(/4 to review/.test(t) && /ZZSCOUT Example Electrical 1/.test(t) && /And 1 more/.test(t), 'Today: N to review with the newest names');
    check(!/waiting for your approval/.test(await page.locator('.do-card').innerText()), 'Today: the scout is not counted as agent approvals');
    await shot(page, 'scout-today-card', page.locator('[data-today-scout]'));
    await page.locator('[data-today-scout] [data-act=scout-review]').click();
    await page.waitForSelector('[data-scout]');
    check((await page.evaluate(() => location.hash)) === '#scout', 'Today: Review goes to #scout');
    await go(page, '#agents/approvals');
    await page.waitForSelector('[data-scout-link]', { timeout: 8000 });
    check(/4 businesses from the lead scout wait for you/.test(await page.locator('[data-scout-link]').innerText()), 'Agents, Approvals points to the Scout page');
    check(await page.locator('.ag-action[data-kind="lead.add"]').count() === 0, 'Agents, Approvals: no scout card with an Approve that would fail');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================ phone, 390 */
  {
    const { ctx, page } = await session({}, { viewport: { width: 390, height: 844 } });
    check(await noHScroll(page), 'no sideways scroll at 390');
    const b = await page.locator('.sc-list > .sc-card').first().locator('[data-act=approve]').boundingBox();
    check(b && b.height >= 40 && b.width >= 120, 'phone: Approve is a full-size touch target');
    check(await page.locator('.sc-keys').isHidden(), 'phone: no keyboard hints');
    await shot(page, 'scout-390-list');
    await page.locator(`.sc-card[data-id="${U(1)}"] .sc-pick`).check();
    await page.locator(`.sc-card[data-id="${U(2)}"] .sc-pick`).check();
    check(await page.locator('.sc-bulk').isVisible(), 'phone: the selection bar shows');
    check(await noHScroll(page), 'phone: no sideways scroll with the bar');
    await shot(page, 'scout-390-selected');
    await page.locator('[data-act=clear]').click();
    await page.locator('[data-act=edit]').click();
    await page.waitForSelector('#sc-editor:not([hidden])');
    check(await noHScroll(page), 'phone: no sideways scroll with settings open');
    await shot(page, 'scout-390-settings', page.locator('.sc-panel'));
    await page.locator('[data-act=cancel]').click();
    await page.locator(`.sc-card[data-id="${U(1)}"] [data-act=approve]`).click();
    await page.waitForSelector(`.sc-receipt[data-id="${U(1)}"]`);
    check(await noHScroll(page), 'phone: no sideways scroll with a receipt');
    await page.waitForTimeout(400);
    await shot(page, 'scout-390-receipt');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ lists: { proposed: [], approved: [], rejected: [] }, actions: [] }, { viewport: { width: 390, height: 844 } });
    await page.waitForSelector('.sc-empty');
    await shot(page, 'scout-390-empty');
    check(await noHScroll(page), 'phone: empty state fits');
    await ctx.close();
  }

  /* ============================================ reduced motion */
  {
    const { ctx, page } = await session();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator(`.sc-card[data-id="${U(1)}"]`).focus();
    await page.keyboard.press('s');
    check(await page.locator('.sc-timer').isHidden(), 'reduced motion: no moving timer bar');
    await page.keyboard.press('u');
    check(page.errors.length === 0, 'reduced motion: no errors');
    await ctx.close();
  }

  /* ============================================ live, read-only */
  {
    const { ctx, page } = await session({ live: true });
    await page.waitForFunction(() => document.querySelector('.sc-list > .sc-card, .sc-list > .sc-empty'), null, { timeout: 20000 });
    const n = await page.locator('.sc-list > .sc-card').count();
    check(n >= 0 && (n > 0 || await page.locator('.sc-empty').count() === 1), `live: the real queue loads through the read-only doors (${n} to review)`);
    check(await page.locator('.sc-panel .sc-stat').count() === 3 && !(await page.locator('.sc-warn').innerText().catch(() => '')).includes('not reachable'), 'live: status and settings load');
    check(!page.calls.some((c) => c.action === 'scout_decide' || c.patch || c.agent === 'scout'), 'live: nothing decided, changed or run');
    check(page.errors.length === 0, `live: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  fails.push(`threw: ${e.message}`);
}
await browser.close();
console.log(`\n${passes.length} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
