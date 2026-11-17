// Wise AI OS: Sell (Pipeline + Proposals), end to end against the live Supabase project.
// Every row it creates starts with "ZZSELL" and is deleted at the end.
//
//   python3 -m http.server 8181 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/sell.test.mjs [shots-dir]
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = process.env.BASE_ROOT || 'http://127.0.0.1:8181/';
const BASE = `${ROOT}os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const SHOTS = process.argv[2] || null;
const TAG = 'ZZSELL';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); if (!cond) console.log('FAIL', msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const browser = await chromium.launch();
// Views owned by other agents (clients, projects) may not exist yet; their load errors are not ours.
const foreign = /views\/(clients|projects|roi-reports|income|costs|runway|library)\.js|functions\/v1\/|net::ERR_FAILED|Failed to fetch dynamically imported module/;

/* A stand-in for the ai-assist edge function, so tests never call (or pay for) the real AI.
   mock.status → the status reply; mock.next[task] → {status, body} for the next call of that task. */
async function mockAi(ctx, mock) {
  await ctx.route('**/functions/v1/ai-assist', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    let body = {};
    try { body = req.postDataJSON() || {}; } catch { body = {}; }
    if (body.action === 'status') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(mock.status) });
    mock.calls.push(body);
    const r = mock.next[body.task] || { status: 500, body: { ok: false, error: 'ai_error' } };
    return route.fulfill({ status: r.status, headers: cors, body: JSON.stringify(r.body) });
  });
}

async function openApp(viewport = { width: 1440, height: 900 }, aiMock = null) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  if (aiMock) await mockAi(ctx, aiMock);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!foreign.test(t) && !/404 \(File not found\)/.test(t)) page.errors.push(t);
  });
  page.on('pageerror', (e) => { if (!foreign.test(e.message)) page.errors.push(`pageerror: ${e.message}`); });
  await page.goto(BASE);
  await page.evaluate(async (pw) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { error } = await sb.auth.signInWithPassword({ email: 'hq@wise-ai.au', password: pw });
    if (error) throw new Error(error.message);
  }, PASSWORD);
  await page.waitForFunction(async () => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.loaded, null, { timeout: 20000 });
  return page;
}
const api = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
  // eslint-disable-next-line no-new-func
  return (new Function('m', 'a', `return (${src})(m, a)`))(m, a);
}, [fn.toString(), arg]);
const db = (page, table, filter) => api(page, async (m, [t, f]) => {
  let q = m.sb.from(t).select('*');
  for (const [k, v] of Object.entries(f)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}, [table, filter]);
const nav = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  await page.waitForTimeout(450);
};
const shot = async (page, name, full = false) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/sell-${name}.png`, fullPage: full }); };
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const localToday = (page) => page.evaluate(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }));
async function cleanup(page) {
  await api(page, async (m, tag) => {
    const like = `${tag}%`;
    await m.sb.from('proposals').delete().like('title', like);
    await m.sb.from('projects').delete().like('name', like);
    await m.sb.from('deals').delete().like('title', like);
    await m.sb.from('clients').delete().like('name', like);
    await m.sb.from('leads').delete().like('business', like);
  }, TAG);
}

const page = await openApp();
const ids = {};
try {
  await cleanup(page); // leftovers from an aborted run
  const today = await localToday(page);
  const addD = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

  /* ------------------------------------------------------------ maths */
  const unit = await page.evaluate(async (td) => {
    const src = document.querySelector('script[type=module]').src;
    const pl = await import(src.replace('app.js', 'views/pipeline.js'));
    const pr = await import(src.replace('app.js', 'views/proposals.js'));
    const deals = [
      { stage: 'qualified', value: 4000, monthly_value: 0, probability: 30, next_step: 'Call', next_step_on: '2026-11-20' },
      { stage: 'proposal', value: 2000, monthly_value: 500, probability: 50, next_step: '' },
      { stage: 'won', value: 3000, monthly_value: 200, probability: 100, closed_on: '2026-11-03' },
      { stage: 'won', value: 1000, monthly_value: 0, probability: 100, closed_on: '2026-10-01' },
      { stage: 'lost', value: 9000, monthly_value: 0, probability: 0, closed_on: '2026-11-04' },
      { stage: 'qualified', value: 99999, monthly_value: 999, probability: 90, archived: true }
    ];
    const s = pl.pipelineStats(deals, '2026-11-17');
    const flags = [
      pl.dealFlag({ stage: 'qualified', next_step: '' }, '2026-11-17'),
      pl.dealFlag({ stage: 'qualified', next_step: 'x', next_step_on: '2026-11-16' }, '2026-11-17'),
      pl.dealFlag({ stage: 'qualified', next_step: 'x', next_step_on: '2026-11-17' }, '2026-11-17'),
      pl.dealFlag({ stage: 'won', next_step: '' }, '2026-11-17')
    ];
    const r = pr.roiCompute({ enq: 12, miss: 25, job: 850, close: 40, hrs: 5, rate: 60 }, { oneOff: 4500, monthly: 300 });
    const tot = pr.proposalTotals({ line_items: [{ amount: 4500, recurring: false }, { amount: 300, recurring: true }, { amount: '500', recurring: false }] }, { gst_registered: true });
    const tot2 = pr.proposalTotals({ line_items: [{ amount: 4500, recurring: false }] }, { gst_registered: false });
    return {
      s, flags, r, tot, tot2,
      n1: pr.suggestNumber([{ number: 'WA-2026-007' }, { number: 'WA-2026-002' }, { number: 'WA-2025-010' }], '2026'),
      n2: pr.suggestNumber([], '2026'),
      exp: [pr.effectiveStatus({ status: 'sent', valid_until: '2026-11-16' }, td), pr.effectiveStatus({ status: 'sent', valid_until: '2026-11-17' }, '2026-11-17'), pr.effectiveStatus({ status: 'draft', valid_until: '2020-01-01' }, td)]
    };
  }, today);
  const s = unit.s;
  check(s.open === 2 && s.oneOff === 6000 && s.monthly === 500, `open deals and value (${s.open}, ${s.oneOff}, ${s.monthly})`);
  check(near(s.wOneOff, 2200) && near(s.wMonthly, 250) && near(s.wRecurringYear, 3000) && near(s.weighted, 5200), `weighted value: 4000×30% + 2000×50% = 2200 one-off; 500×50%×12 = 3000; total 5200 (${s.weighted})`);
  check(s.wonMonth === 1 && s.wonMonthOneOff === 3000 && s.wonMonthMonthly === 200, 'won this month counts November closes only');
  check(s.won === 2 && s.lost === 1 && near(s.winRate, 2 / 3), `win rate 2 ÷ (2 + 1) (${s.winRate})`);
  check(JSON.stringify(unit.flags) === JSON.stringify(['none', 'overdue', null, null]), `stall flags ${JSON.stringify(unit.flags)}`);
  const r = unit.r;
  check(near(r.missedPerMonth, 13) && near(r.jobsLost, 5.2) && near(r.revMonth, 4420) && near(r.adminMonth, 1300) && near(r.halfMonth, 2860) && near(r.halfYear, 34320),
    `ROI by hand: 12×25%×52/12 = 13 missed; ×40% = 5.2 jobs; ×$850 = $4,420; 5h×$60×52/12 = $1,300; half = $2,860 (${r.halfMonth})`);
  check(near(r.firstYearCost, 8100) && near(r.paybackMonths, 8100 / 2860) && near(r.firstYearNet, 34320 - 8100), `payback ($4,500 + $300×12) ÷ $2,860 = ${r.paybackMonths.toFixed(3)} months`);
  check(unit.tot.oneOff === 5000 && unit.tot.monthly === 300 && near(unit.tot.gstOneOff, 500) && near(unit.tot.gstMonthly, 30) && near(unit.tot.oneOffInc, 5500) && unit.tot2.gstOneOff === 0 && !unit.tot2.gst, 'line totals and GST only when registered');
  check(unit.n1 === 'WA-2026-008' && unit.n2 === 'WA-2026-001', `proposal numbers (${unit.n1}, ${unit.n2})`);
  check(JSON.stringify(unit.exp) === JSON.stringify(['expired', 'sent', 'draft']), `expired only when sent and past valid-until ${JSON.stringify(unit.exp)}`);

  // Same inputs through the public calculator.
  {
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(`${ROOT}roi.html`);
    const pub = await p2.evaluate(() => window.WiseROI.compute({ enq: 12, miss: 25, job: 850, close: 40, hrs: 5, rate: 60 }));
    const keys = ['missedPerMonth', 'jobsLost', 'revMonth', 'revYear', 'adminMonth', 'halfMonth', 'halfYear'];
    check(keys.every((k) => near(pub[k], r[k])), `ROI agrees with /roi.js on every figure (${keys.map((k) => `${k} ${pub[k]}`).join(', ')})`);
    await p2.context().close();
  }

  /* ------------------------------------------------------------ render, before our data */
  for (const route of ['pipeline', 'proposals']) {
    const before = page.errors.length;
    await nav(page, route);
    const ok = await page.evaluate(() => !!document.querySelector('#view .page') && !document.querySelector('#view .err-card'));
    check(ok && page.errors.length === before, `#${route} renders cleanly before test data`);
  }
  const othersDeals = (await api(page, async (m) => m.state.deals.length));
  const othersProps = (await api(page, async (m) => m.state.proposals.length));
  if (!othersDeals) {
    await nav(page, 'pipeline');
    check(await page.isVisible('.pipe-page .empty .btn-primary'), 'empty pipeline shows one clear first action');
    await shot(page, 'pipeline-empty-1440');
  }
  if (!othersProps) {
    await nav(page, 'proposals');
    check(await page.isVisible('.prop-list-page .empty .btn-primary'), 'empty proposals list shows one clear first action');
    await shot(page, 'proposals-empty-1440');
  }

  /* ------------------------------------------------------------ seed a warm lead */
  ids.lead = (await api(page, async (m, tag) => {
    const { data, error } = await m.sb.from('leads').insert({ business: `${tag} Harbour Plumbing`, contact_name: 'Dave Harbour', status: 'replied', source: 'manual', suburb: 'Wynnum', pain: 'Calls come in while Dave is on the tools and about one in five never gets a call back.' }).select().single();
    if (error) throw new Error(error.message);
    if (!m.state.leads.some((l) => l.id === data.id)) m.state.leads.unshift(data); m.notify();
    return data.id;
  }, TAG));

  /* ------------------------------------------------------------ create a deal through the UI */
  await nav(page, 'pipeline/new');
  await page.waitForSelector('.modal [name=title]');
  await page.selectOption('.modal [name=lead_id]', ids.lead);
  check((await page.inputValue('.modal [name=title]')) === `${TAG} Harbour Plumbing`, 'choosing a lead names the deal');
  await page.fill('.modal [name=title]', `${TAG} Harbour missed-call system`);
  await page.fill('.modal [name=value]', '4500');
  await page.fill('.modal [name=monthly_value]', '300');
  await page.fill('.modal [name=probability]', '30');
  await page.fill('.modal [name=expected_close]', addD(21));
  await page.click('.modal-foot .btn-primary');
  await page.waitForSelector('.deal-drawer .h1');
  let rows = await db(page, 'deals', { title: `${TAG} Harbour missed-call system` });
  ids.deal = rows[0]?.id;
  check(rows.length === 1 && rows[0].lead_id === ids.lead && Number(rows[0].value) === 4500 && Number(rows[0].monthly_value) === 300 && rows[0].stage === 'qualified' && rows[0].next_step === 'Intro call',
    'new deal saved with lead, values, stage and a default next step');
  check(await page.evaluate((id) => location.hash === `#pipeline/${id}`, ids.deal), 'open drawer is a deep link');

  /* edit: next step overdue */
  await page.fill('.deal-drawer [name=next_step]', `Call Dave about the quote`);
  await page.fill('.deal-drawer [name=next_step_on]', addD(-1));
  await page.dispatchEvent('.deal-drawer [name=next_step_on]', 'input');
  check(await page.isVisible('.deal-drawer .deal-next-sec .callout.is-warn'), 'overdue next step is flagged in the drawer');
  await page.fill('.deal-drawer textarea[name=notes]', 'Wants it before Christmas.');
  await page.click('.deal-drawer .drawer-foot .btn-primary');
  await page.waitForTimeout(900);
  rows = await db(page, 'deals', { id: ids.deal });
  check(rows[0].next_step === 'Call Dave about the quote' && rows[0].next_step_on === addD(-1) && rows[0].notes === 'Wants it before Christmas.', 'drawer edits saved');
  await page.evaluate(() => { document.querySelector('.deal-drawer .drawer-body').scrollTop = 0; });
  await page.waitForTimeout(3800);
  await shot(page, 'deal-drawer-1440');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => location.hash === '#pipeline'), 'closing the drawer clears the deep link');
  check(await page.isVisible(`.deal-card[data-id="${ids.deal}"] .deal-next.is-flag`), 'overdue next step shows amber on the card');

  /* a second deal with no next step, moved by drag */
  ids.deal2 = await api(page, async (m, tag) => (await m.saveRow('deals', { title: `${tag} Bayside Dental reminders`, stage: 'qualified', value: 1200, probability: 30 })).id, TAG);
  await page.waitForTimeout(400);
  check(await page.isVisible(`.deal-card[data-id="${ids.deal2}"].is-flagged`), 'deal with no next step is flagged on the board');
  await page.dragAndDrop(`.deal-card[data-id="${ids.deal2}"] .deal-open`, '.pipe-col[data-stage="negotiation"]');
  await page.waitForTimeout(1200);
  rows = await db(page, 'deals', { id: ids.deal2 });
  check(rows[0].stage === 'negotiation' && rows[0].probability === 70, `drag to Negotiation saved (stage ${rows[0].stage}, ${rows[0].probability}%)`);

  /* header numbers include ours */
  const kpi = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sell-kpi')].map((c) => [c.dataset.k, c.querySelector('.kpi-value').textContent])));
  const st = await api(page, async (m) => {
    const pl = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/pipeline.js'));
    return pl.pipelineStats(m.state.deals);
  });
  check(kpi.weighted === new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Math.round(st.weighted)) && Number(kpi.open) === st.open, `header shows weighted ${kpi.weighted} and ${kpi.open} open`);

  /* table toggle */
  await page.click('.pipe-bar .tab:has-text("Table")');
  await page.waitForTimeout(300);
  check(await page.isVisible(`.pipe-table tr[data-id="${ids.deal}"]`), 'table view lists the deal');
  await shot(page, 'pipeline-table-1440');
  await page.click('.pipe-bar .tab:has-text("Board")');
  await page.waitForTimeout(300);
  await shot(page, 'pipeline-board-1440');

  /* lost via the drawer's stage select (the touch path) */
  await nav(page, `pipeline/${ids.deal2}`);
  await page.waitForSelector('.deal-drawer select[name=stage]');
  await page.selectOption('.deal-drawer select[name=stage]', 'lost');
  await page.waitForSelector('.modal textarea[name=lost_reason]');
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(300);
  check(await page.isVisible('.modal textarea[name=lost_reason]'), 'lost needs a reason');
  await page.fill('.modal textarea[name=lost_reason]', 'Went with a cheaper quote');
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(1000);
  rows = await db(page, 'deals', { id: ids.deal2 });
  check(rows[0].stage === 'lost' && rows[0].lost_reason === 'Went with a cheaper quote' && rows[0].closed_on === today && rows[0].probability === 0, 'lost saved with reason and close date');
  check(await page.isVisible('.deal-drawer textarea[name=lost_reason]'), 'drawer shows the lost outcome');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.isVisible('.pipe-tally-item[data-stage="lost"]'), 'won and lost show as a tally');
  await page.click('.pipe-tally .link-btn:has-text("Show won and lost")');
  await page.waitForTimeout(300);
  check(await page.isVisible(`.pipe-col[data-stage="lost"] .deal-card[data-id="${ids.deal2}"]`), 'toggle shows the lost column');
  await page.click('.pipe-tally .link-btn:has-text("Hide won and lost")');

  /* ------------------------------------------------------------ write a proposal from the deal */
  await nav(page, `pipeline/${ids.deal}`);
  await page.waitForSelector('.deal-drawer .ld-actions .btn-primary');
  await page.click('.deal-drawer .ld-actions .btn-primary');
  await page.waitForSelector('.prop-editor', { timeout: 10000 });
  await page.waitForTimeout(600);
  ids.prop = await page.evaluate(() => location.hash.split('/')[1]);
  rows = await db(page, 'proposals', { id: ids.prop });
  const p0 = rows[0];
  check(p0 && p0.deal_id === ids.deal && p0.lead_id === ids.lead && /^WA-\d{4}-\d{3}$/.test(p0.number) && p0.line_items.length === 2 && p0.valid_until === addD(14) && p0.status === 'draft',
    `proposal created from the deal (${p0?.number}, ${p0?.line_items?.length} lines, valid ${p0?.valid_until})`);
  check(p0.recipient_business === `${TAG} Harbour Plumbing` && p0.recipient_name === 'Dave Harbour' && /one in five/.test(p0.problem || ''), 'recipient and problem prefilled from the lead');
  rows = await db(page, 'deals', { id: ids.deal });
  check(rows[0].stage === 'proposal' && rows[0].probability === 50, 'writing a proposal moves a qualified deal to Proposal');

  /* edit the proposal */
  await page.fill('.prop-editor textarea[name=solution]', 'A text-back that replies within a minute when a call is missed.\n\n- Missed-call text-back\n- Online booking link');
  await page.click('.prop-editor .btn:has-text("Add scope item")');
  await page.fill('.prop-editor [name=scope-title-0]', 'Booking link');
  await page.fill('.prop-editor [name=scope-detail-0]', 'Customers pick a time themselves.');
  await page.click('.prop-editor .btn:has-text("Add scope item")');
  await page.fill('.prop-editor [name=scope-title-1]', 'Missed-call text-back');
  await page.fill('.prop-editor [name=scope-detail-1]', 'Every missed call gets a text inside a minute.');
  await page.click('.prop-scope-row[data-i="1"] [aria-label="Move up"]');
  await page.check(`#roi-on-${ids.prop}`);
  for (const [k, v] of Object.entries({ enq: 12, miss: 25, job: 850, close: 40, hrs: 5, rate: 60 })) await page.fill(`.prop-editor [name=roi-${k}]`, String(v));
  await page.waitForSelector('.prop-saved[data-state="saved"]', { timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.waitForSelector('.prop-saved[data-state="saved"]', { timeout: 10000 });
  rows = await db(page, 'proposals', { id: ids.prop });
  const p1 = rows[0];
  check(p1.scope.map((x) => x.title).join('|') === 'Missed-call text-back|Booking link', `scope saved in the new order (${p1.scope.map((x) => x.title).join(', ')})`);
  check(p1.roi.include === true && near(p1.roi.results.halfMonth, 2860) && near(p1.roi.results.paybackMonths, 8100 / 2860) && p1.roi.inputs.job === 850, `ROI inputs and results stored (half ${p1.roi.results.halfMonth}, payback ${p1.roi.results.paybackMonths?.toFixed(2)})`);
  const docText = await page.textContent('.prop-sheet');
  check(docText.includes('$2,860') && docText.includes('2.8 months') && docText.includes(`Proposal for${TAG} Harbour Plumbing`) && docText.includes('tyler@wise-ai.au'), 'preview shows the working, payback, recipient and contact');
  check(docText.indexOf('What it is costing you now') < docText.indexOf('What I will build') && docText.indexOf('What I will build') < docText.indexOf('What is included')
    && docText.indexOf('What is included') < docText.indexOf('What it is worth to you') && docText.indexOf('What it is worth to you') < docText.indexOf('Investment')
    && docText.indexOf('Investment') < docText.indexOf('Terms') && docText.indexOf('Terms') < docText.indexOf('Next step'), 'document sections in order');
  check(await page.isVisible('.prop-sheet .pdoc-list li'), 'lines starting with "- " become a list');

  /* typed text survives live updates */
  await page.click('.prop-editor textarea[name=problem]');
  await page.keyboard.press('End');
  await page.keyboard.type(' Typing while data changes.');
  await api(page, async (m, id) => { await m.saveRow('deals', { id, notes: 'Live update while typing' }); }, ids.deal2);
  await api(page, async (m) => { m.notify(); });
  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => ({ v: document.querySelector('.prop-editor textarea[name=problem]').value, f: document.activeElement?.name }));
  check(kept.v.endsWith('Typing while data changes.') && kept.f === 'problem', 'typed text and focus survive a live update');
  await page.waitForSelector('.prop-saved[data-state="saved"]', { timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot(page, 'proposal-editor-1440');

  /* copy as text */
  await page.click('.prop-actions .btn:has-text("Copy as text")');
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.startsWith(`Proposal for ${TAG} Harbour Plumbing`) && clip.includes('WHAT IT IS WORTH TO YOU') && clip.includes('Fixing half of that, a month: $2,860') && !/<[a-z]/i.test(clip), 'copy as text gives a plain email version');

  /* print: only the document, A4 */
  await page.emulateMedia({ media: 'print' });
  const printView = await page.evaluate(() => ({
    editor: getComputedStyle(document.querySelector('.prop-editor')).display,
    top: getComputedStyle(document.querySelector('.prop-top')).display,
    rail: document.querySelector('.rail') ? getComputedStyle(document.querySelector('.rail')).display : 'none',
    doc: getComputedStyle(document.querySelector('.pdoc')).display
  }));
  check(printView.editor === 'none' && printView.top === 'none' && printView.rail === 'none' && printView.doc !== 'none', 'print stylesheet shows only the document');
  if (SHOTS) {
    await page.pdf({ path: `${SHOTS}/sell-proposal.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
    const pdf = fs.readFileSync(`${SHOTS}/sell-proposal.pdf`, 'latin1');
    const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
    check(pages >= 1 && pages <= 4, `proposal prints to ${pages} A4 page(s)`);
  }
  await page.emulateMedia({ media: 'screen' });

  /* status flow: sent → accepted → deal won → client + project */
  await page.click('.prop-actions .btn[data-status="sent"]');
  await page.waitForTimeout(900);
  rows = await db(page, 'proposals', { id: ids.prop });
  check(rows[0].status === 'sent' && rows[0].sent_on === today, 'mark as sent sets sent_on');
  await page.click('.prop-actions .btn[data-status="accepted"]');
  await page.waitForSelector('.modal-foot .btn-primary:has-text("Move to Won")', { timeout: 8000 });
  await page.click('.modal-foot .btn-primary:has-text("Move to Won")');
  await page.waitForSelector('.modal [name=closed_on]', { timeout: 8000 });
  check(await page.isChecked('.modal [name=make_client]') && await page.isChecked('.modal [name=start_project]'), 'won offers to make a client and start a project');
  await page.click('.modal-foot .btn-primary');
  await page.waitForFunction(() => location.hash.startsWith('#projects/'), null, { timeout: 15000 });
  ids.project = await page.evaluate(() => location.hash.split('/')[1]);
  rows = await db(page, 'proposals', { id: ids.prop });
  check(rows[0].status === 'accepted' && rows[0].decided_on === today, 'accepted sets decided_on');
  const deal = (await db(page, 'deals', { id: ids.deal }))[0];
  const client = deal.client_id ? (await db(page, 'clients', { id: deal.client_id }))[0] : null;
  const project = (await db(page, 'projects', { id: ids.project }))[0];
  const lead = (await db(page, 'leads', { id: ids.lead }))[0];
  check(deal.stage === 'won' && deal.closed_on === today && deal.probability === 100, 'deal moved to Won with a close date');
  check(client && client.lead_id === ids.lead && client.name === `${TAG} Harbour Plumbing` && Number(client.monthly_value) === 300 && lead.status === 'won', 'client made from the lead (leadToClient) and linked');
  check(project && project.deal_id === ids.deal && project.client_id === client?.id && Number(project.value) === 4500, 'project started, linked to client and deal, and opened');
  ids.client = client?.id;

  /* expired, list, filter */
  ids.old = await api(page, async (m, [tag, d]) => (await m.saveRow('proposals', { title: `${tag} Old quote`, number: 'WA-1999-001', status: 'sent', sent_on: d, valid_until: d, line_items: [{ label: 'Set-up', amount: 900, recurring: false }] })).id, [TAG, addD(-30)]);
  await nav(page, 'proposals');
  const listRow = await page.textContent(`.prop-table tr[data-id="${ids.old}"]`);
  check(/Expired/.test(listRow) && /\$900/.test(listRow), 'a sent proposal past valid-until lists as Expired');
  await page.click('.leads-chips .chip:has-text("Expired")');
  await page.waitForTimeout(200);
  check(await page.isVisible(`.prop-table tr[data-id="${ids.old}"]`) && !(await page.isVisible(`.prop-table tr[data-id="${ids.prop}"]`)), 'status filter narrows the list');
  await page.click('.leads-chips .chip:has-text("All")');
  await shot(page, 'proposals-1440');

  /* new blank proposal via #proposals/new, then delete it through the UI */
  await nav(page, 'proposals/new');
  await page.waitForSelector('.modal [name=deal_id]');
  await page.selectOption('.modal [name=deal_id]', '');
  await page.fill('.modal [name=title]', `${TAG} Blank proposal`);
  await page.click('.modal-foot .btn-primary');
  await page.waitForSelector('.prop-editor');
  ids.blank = await page.evaluate(() => location.hash.split('/')[1]);
  check((await db(page, 'proposals', { id: ids.blank })).length === 1, '#proposals/new creates a draft and opens it');
  await page.click('.prop-danger .btn.is-danger');
  await page.click('.modal-foot .btn-danger');
  await page.waitForFunction(() => location.hash === '#proposals', null, { timeout: 8000 });
  check((await db(page, 'proposals', { id: ids.blank })).length === 0, 'proposal deleted through the UI');

  /* deep link to the editor */
  await nav(page, `proposals/${ids.prop}`);
  check((await page.inputValue('.prop-editor [name=title]')) === `${TAG} Harbour missed-call system`, 'deep link opens the proposal editor');

  /* archive + delete a deal through the UI */
  await nav(page, `pipeline/${ids.deal2}`);
  await page.waitForSelector('.deal-drawer');
  await page.click('.deal-drawer .drawer-foot .btn:has-text("Archive")');
  await page.waitForTimeout(800);
  check((await db(page, 'deals', { id: ids.deal2 }))[0].archived === true, 'deal archived');
  await page.click('.deal-drawer .drawer-foot .btn.is-danger');
  await page.click('.modal-foot .btn-danger');
  await page.waitForTimeout(900);
  check((await db(page, 'deals', { id: ids.deal2 })).length === 0, 'deal deleted through the UI after confirm');

  /* win rate shows once something is closed */
  await nav(page, 'pipeline');
  check(await page.isVisible('.sell-kpi[data-k="rate"]'), 'win rate shows when there are closed deals');
  check(page.errors.length === 0, `no console errors at 1440 (${page.errors.slice(0, 3).join(' | ')})`);

  /* ------------------------------------------------------------ AI drafting (mocked) */
  const mock = { status: { configured: true, enabled: true, spent_usd: 0.4, cap_usd: 20 }, next: {}, calls: [] };
  const aiPage = await openApp({ width: 1440, height: 900 }, mock);
  for (let i = 0; i < 40 && !(await api(aiPage, async (m) => Boolean(m.state.ai))); i++) await aiPage.waitForTimeout(250);
  check(await api(aiPage, async (m) => Boolean(m.state.ai?.configured)), `mocked AI status reaches state.ai (${JSON.stringify(await api(aiPage, async (m) => m.state.ai))}, calls ${mock.calls.length})`);
  const seed = await api(aiPage, async (m, tag) => {
    const lead = (await m.sb.from('leads').insert({ business: `${tag} Coorparoo Physio`, contact_name: 'Mia Chen', phone: '+61400000781', status: 'replied', source: 'manual', pain: 'Front desk misses calls at lunch.', hook: 'Reviews say booking is slow.' }).select().single()).data;
    const deal = await m.saveRow('deals', { title: `${tag} Coorparoo booking`, lead_id: lead.id, stage: 'proposal', notes: 'Two physios, about 40 enquiries a week, mostly phone.' });
    const prop = await m.saveRow('proposals', { title: `${tag} Coorparoo booking`, deal_id: deal.id, lead_id: lead.id, status: 'draft', recipient_name: 'Mia Chen', recipient_business: `${tag} Coorparoo Physio`, problem: 'My own words about the problem.', scope: [], line_items: [{ label: 'Set-up', amount: 2000, recurring: false }], roi: { include: false, inputs: {} }, terms: 'Standard terms.', valid_until: '2099-01-01' });
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    await m.sb.from('messages').insert({ lead_id: lead.id, channel: 'sms', direction: 'out', status: 'manual', body: 'Hi Mia, Tyler from Wise AI here. Do you lose calls over lunch?', created_at: ago(60) });
    await m.sb.from('messages').insert({ lead_id: lead.id, channel: 'sms', direction: 'in', status: 'received', body: 'Yes all the time. What would it cost?', created_at: ago(5) });
    if (!m.state.leads.some((l) => l.id === lead.id)) m.state.leads.unshift(lead);
    m.notify();
    return { lead: lead.id, deal: deal.id, prop: prop.id };
  }, TAG);
  Object.assign(ids, { aiLead: seed.lead, aiDeal: seed.deal, aiProp: seed.prop });

  // Proposal: open the panel, notes prefilled
  await nav(aiPage, `proposals/${seed.prop}`);
  await aiPage.click('.prop-ai-btn');
  const notes = await aiPage.inputValue('.prop-ai textarea[name=ai-notes]');
  check(notes.includes('40 enquiries a week') && notes.includes('misses calls at lunch') && notes.includes('booking is slow'), 'AI notes prefilled from the deal notes and the lead pain and hook');
  await shot(aiPage, 'proposal-ai-panel-1440');
  // error path
  mock.next.proposal = { status: 402, body: { ok: false, error: 'cap_reached' } };
  await aiPage.click('.prop-ai .btn-primary');
  await aiPage.waitForSelector('.toast.is-bad:has-text("budget is used up")', { timeout: 8000 });
  check((await aiPage.inputValue('.prop-editor textarea[name=problem]')) === 'My own words about the problem.', 'cap_reached shows the message and changes nothing');
  check(mock.calls.at(-1)?.task === 'proposal' && mock.calls.at(-1)?.context?.recipient?.business === `${TAG} Coorparoo Physio` && !('roi' in (mock.calls.at(-1)?.context || {})), 'proposal call sends recipient and notes, and no roi when the block is off');
  // success, with replace confirmation: cancel first, then replace
  mock.next.proposal = { status: 200, body: { ok: true, cost_usd: 0.01, result: {
    problem: 'About one in four calls at lunch goes unanswered.', solution: 'A text-back for missed calls and online booking for [check: which clinic software].',
    scope: [{ title: 'Missed-call text-back', detail: 'Replies in a minute.' }, { title: 'Online booking', detail: 'Linked to [check: booking system].' }] } } };
  await aiPage.click('.prop-ai .btn-primary');
  await aiPage.waitForSelector('.modal h2:has-text("Replace what is there?")', { timeout: 8000 });
  await aiPage.click('.modal-foot .btn-ghost');
  await aiPage.waitForTimeout(300);
  check((await aiPage.inputValue('.prop-editor textarea[name=problem]')) === 'My own words about the problem.', 'declining the replace keeps typed text');
  await aiPage.click('.prop-ai .btn-primary');
  await aiPage.waitForSelector('.modal h2:has-text("Replace what is there?")', { timeout: 8000 });
  await aiPage.click('.modal-foot .btn-primary');
  await aiPage.waitForTimeout(400);
  check((await aiPage.inputValue('.prop-editor textarea[name=problem]')).startsWith('About one in four') && (await aiPage.inputValue('.prop-editor [name=scope-title-1]')) === 'Online booking', 'draft fills problem, solution and scope after confirming');
  check(/2 \[check: …\] items to fill/.test(await aiPage.textContent('.prop-checks')) && await aiPage.isVisible('.prop-editor textarea[name=solution].has-check'), 'editor counts and highlights the [check: …] items');
  await aiPage.waitForSelector('.prop-saved[data-state="saved"]', { timeout: 10000 });
  await aiPage.waitForTimeout(500);
  let pr = (await db(aiPage, 'proposals', { id: seed.prop }))[0];
  check(pr.problem.startsWith('About one in four') && pr.scope.length === 2 && pr.status === 'draft', 'autosave picked up the draft; nothing sent');
  await aiPage.evaluate(() => window.scrollTo(0, 0));
  await shot(aiPage, 'proposal-ai-checks-1440');
  await aiPage.click('.prop-actions .btn[data-status="sent"]');
  await aiPage.waitForSelector('.toast.is-bad:has-text("Not sent")', { timeout: 8000 });
  await aiPage.waitForTimeout(500);
  check((await db(aiPage, 'proposals', { id: seed.prop }))[0].status === 'draft', '[check: …] blocks Mark as sent');
  await aiPage.fill('.prop-editor textarea[name=solution]', 'A text-back for missed calls and online booking through Cliniko.');
  await aiPage.fill('.prop-editor [name=scope-detail-1]', 'Linked to Cliniko.');
  await aiPage.waitForSelector('.prop-saved[data-state="saved"]', { timeout: 10000 });
  check(!(await aiPage.isVisible('.prop-checks .callout')), 'filling the items clears the warning');
  await aiPage.click('.prop-actions .btn[data-status="sent"]');
  await aiPage.waitForTimeout(1200);
  check((await db(aiPage, 'proposals', { id: seed.prop }))[0].status === 'sent', 'once filled, Mark as sent works');

  // Inbox: suggest replies
  await nav(aiPage, `inbox/${seed.lead}`);
  await aiPage.waitForSelector('.inbox-msg.is-in');
  await aiPage.waitForSelector('.inbox-ai-btn', { timeout: 8000 });
  check(await aiPage.isVisible('.inbox-ai-btn'), 'Suggest replies shows when the latest message is inbound');
  mock.next.reply = { status: 200, body: { ok: true, cost_usd: 0.004, result: { options: ['Hi Mia, it depends on the set-up. Can I call you tomorrow?', 'Good question. Most clinics start around $2,000. Want to book 15 minutes?'] } } };
  await aiPage.click('.inbox-ai-btn');
  await aiPage.waitForSelector('.inbox-ai-opt', { timeout: 8000 });
  const sent = mock.calls.at(-1);
  check(sent.task === 'reply' && sent.context.thread.length === 2 && sent.context.thread[1].from === 'them' && sent.context.lead.business === `${TAG} Coorparoo Physio`, 'reply call sends the thread oldest first with us/them');
  await shot(aiPage, 'inbox-ai-1440');
  await aiPage.click('.inbox-ai-opt >> nth=0');
  check((await aiPage.inputValue('.inbox-input')).startsWith('Hi Mia, it depends'), 'picking a suggestion fills an empty reply box');
  await aiPage.click('.inbox-ai-opt >> nth=1');
  await aiPage.waitForSelector('.modal h2:has-text("Replace what is there?")', { timeout: 5000 });
  await aiPage.click('.modal-foot .btn-ghost');
  await aiPage.waitForTimeout(300);
  check((await aiPage.inputValue('.inbox-input')).startsWith('Hi Mia, it depends'), 'typed text is kept unless the operator replaces it');
  await aiPage.click('.inbox-ai-opt >> nth=1');
  await aiPage.click('.modal-foot .btn-primary');
  await aiPage.waitForTimeout(300);
  check((await aiPage.inputValue('.inbox-input')).startsWith('Good question'), 'replace swaps in the second suggestion (nothing sent)');
  mock.next.reply = { status: 402, body: { ok: false, error: 'cap_reached' } };
  await aiPage.click('.inbox-ai-btn');
  await aiPage.waitForSelector('.toast.is-bad:has-text("budget is used up")', { timeout: 8000 });
  check(true, 'reply cap_reached shows the message');
  await api(aiPage, async (m, id) => { await m.addMessage({ lead_id: id, channel: 'sms', direction: 'in', status: 'received', body: 'Also, do you do weekends?' }); }, seed.lead);
  await aiPage.waitForFunction(() => document.querySelector('.inbox-ai')?.hidden === true, null, { timeout: 8000 }).catch(() => {});
  check(await aiPage.evaluate(() => document.querySelector('.inbox-ai').hidden), 'suggestions disappear when a new message arrives');
  await api(aiPage, async (m, id) => { await m.addMessage({ lead_id: id, channel: 'sms', direction: 'out', status: 'manual', body: 'Yes, Saturdays.' }); }, seed.lead);
  await aiPage.waitForTimeout(800);
  check(!(await aiPage.isVisible('.inbox-ai-btn')), 'Suggest replies hides when the latest message is ours');
  const aiErrs = aiPage.errors.filter((e) => !/status of 402/.test(e)); // the mocked cap_reached reply is a 402 on purpose
  check(aiErrs.length === 0, `no console errors with AI on (${aiErrs.slice(0, 3).join(' | ')})`);
  await aiPage.context().close();

  // AI on, phone
  const aiPhone = await openApp({ width: 390, height: 844 }, mock);
  await api(aiPhone, async (m, id) => { await m.addMessage({ lead_id: id, channel: 'sms', direction: 'in', status: 'received', body: 'Can you send the price?' }); }, seed.lead);
  await nav(aiPhone, `inbox/${seed.lead}`);
  await aiPhone.waitForSelector('.inbox-ai-btn', { timeout: 8000 });
  mock.next.reply = { status: 200, body: { ok: true, result: { options: ['Sure Mia, it is $2,000 to set up. I will email the proposal today.', 'Happy to. Can I call you at 2 to walk you through it?'] } } };
  await aiPhone.click('.inbox-ai-btn');
  await aiPhone.waitForSelector('.inbox-ai-opt');
  check(await noHScroll(aiPhone), 'inbox suggestions fit at 390px');
  await shot(aiPhone, 'inbox-ai-390');
  await nav(aiPhone, `proposals/${seed.prop}`);
  await aiPhone.click('.prop-ai-btn');
  await aiPhone.waitForTimeout(300);
  check(await noHScroll(aiPhone), 'proposal AI panel fits at 390px');
  await shot(aiPhone, 'proposal-ai-panel-390');
  await aiPhone.context().close();

  // AI not configured: no buttons at all
  const off = await openApp({ width: 1440, height: 900 }, { status: { configured: false, enabled: false, spent_usd: 0, cap_usd: 20 }, next: {}, calls: [] });
  await api(off, async (m, id) => { await m.addMessage({ lead_id: id, channel: 'sms', direction: 'in', status: 'received', body: 'Hello?' }); }, seed.lead);
  await nav(off, `proposals/${seed.prop}`);
  check(!(await off.isVisible('.prop-ai-btn')), 'Draft with AI is not rendered when AI is not configured');
  await nav(off, `inbox/${seed.lead}`);
  await off.waitForSelector('.inbox-msg.is-in');
  await off.waitForTimeout(500);
  check(!(await off.isVisible('.inbox-ai-btn')), 'Suggest replies is not rendered when AI is not configured');
  await off.context().close();

  /* ------------------------------------------------------------ 390 px */
  const phone = await openApp({ width: 390, height: 844 });
  for (const [route, name] of [['pipeline', 'pipeline-390'], [`pipeline/${ids.deal}`, 'deal-drawer-390'], ['proposals', 'proposals-390'], [`proposals/${ids.prop}`, 'proposal-editor-390']]) {
    await nav(phone, route);
    if (route.startsWith('pipeline/')) await phone.waitForSelector('.deal-drawer');
    check(await noHScroll(phone), `#${route} has no horizontal scroll at 390px`);
    await shot(phone, name);
    if (route === `proposals/${ids.prop}`) {
      await phone.evaluate(() => document.querySelector('.prop-preview').scrollIntoView());
      await shot(phone, 'proposal-preview-390');
    }
    if (route.startsWith('pipeline/')) { await phone.keyboard.press('Escape'); await phone.waitForTimeout(300); }
  }
  await nav(phone, 'pipeline');
  await phone.click('.pipe-bar .tab:has-text("Table")');
  await phone.waitForTimeout(300);
  check(await noHScroll(phone) && (await phone.isVisible(".pipe-cards .deal-card") || await phone.isVisible(".pipe-content .empty")), 'pipeline table collapses to cards (or a calm empty state) at 390px');
  await phone.click('.pipe-bar .tab:has-text("Board")');
  check(phone.errors.length === 0, `no console errors at 390 (${phone.errors.slice(0, 3).join(' | ')})`);
  await phone.context().close();
} catch (e) {
  fails.push(`threw: ${e.stack || e.message}`);
  console.log(e);
  await shot(page, 'failure');
} finally {
  await cleanup(page);
  const left = await api(page, async (m, tag) => {
    const like = `${tag}%`;
    const c = async (t, col) => (await m.sb.from(t).select('id').like(col, like)).data.length;
    return { proposals: await c('proposals', 'title'), deals: await c('deals', 'title'), projects: await c('projects', 'name'), clients: await c('clients', 'name'), leads: await c('leads', 'business') };
  }, TAG);
  check(Object.values(left).every((v) => v === 0), `all ${TAG} rows deleted ${JSON.stringify(left)}`);
  await browser.close();
}

console.log(`\n${passes.length} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL:', f);
process.exit(fails.length ? 1 : 0);
