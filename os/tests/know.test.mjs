// Wise AI OS: Library, the whole-business Today, the palette, the leads drawer
// hand-offs, Settings (business details + old HQ console import), end to end against
// the live Supabase project. Every row it creates starts with "ZZKNOW" (or carries
// "ZZKNOW" in its notes) and is deleted at the end.
//
//   python3 -m http.server 8184 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8184/os/ node os/tests/know.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8184/os/';
const PASSWORD = process.env.OS_TEST_PASSWORD;
const SHOTS = process.argv[2] || null;
const P = 'ZZKNOW';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TAG = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch();
const API = "document.querySelector('script[type=module]').src.replace('app.js', 'api.js')";
const mod = (p) => `document.querySelector('script[type=module]').src.replace('app.js', '${p}')`;

/* The AI is never called for real from tests (it costs money): ai-assist is mocked. */
const aiCalls = [];
async function mockAi(ctx) {
  await ctx.route('**/functions/v1/ai-assist', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* */ }
    aiCalls.push(body);
    let data;
    if (body.action === 'status') data = { configured: true, enabled: true, spent_usd: 0.0042, cap_usd: 5 };
    else if (body.task === 'hook' && String(body.context?.notes || '').trim()) {
      data = { ok: true, cost_usd: 0.0006, spent_usd: 0.0048, result: { options: ['Saw a few reviews say calls go unanswered while you are on the tools.', 'Noticed your Google reviews mention slow call-backs on busy days.'], ask: '' } };
    } else if (body.task === 'hook') {
      data = { ok: true, cost_usd: 0.0003, spent_usd: 0.0051, result: { options: [], ask: 'Have a look at their Google reviews and note one thing customers mention.' } };
    } else data = { ok: false, error: 'bad_request' };
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  });
}

async function openApp(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] });
  await mockAi(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (/functions\/v1\/|net::ERR_FAILED|Failed to load resource/.test(t)) return; // edge functions / other agents' missing modules
    page.errors.push(t);
  });
  page.on('pageerror', (e) => {
    // Other agents' views may be mid-write: a failing route module is theirs, not ours.
    if (/views\/(pipeline|proposals|clients|projects|roi-reports|income|costs|runway)\.js/.test(e.stack || '')) return;
    page.errors.push(`pageerror: ${e.message}`);
  });
  await page.goto(BASE);
  await page.evaluate(async (pw) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { error } = await sb.auth.signInWithPassword({ email: 'hq@wise-ai.au', password: pw });
    if (error) throw new Error(error.message);
  }, PASSWORD);
  await page.waitForFunction(async () => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.loaded, null, { timeout: 20000 });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
  await page.mouse.move(viewport.width - 60, 500);
  return page;
}
const nav = async (page, hash, wait = 600) => {
  await page.evaluate((h) => { location.hash = h; }, `#${hash}`);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  await page.waitForTimeout(wait);
};
const db = (page, fn, arg) => page.evaluate(fn, arg);
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.mouse.move((page.viewportSize()?.width || 1440) - 60, 500);
  await page.evaluate(() => document.activeElement?.closest?.('.rail') && document.activeElement.blur());
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `know-${name}.png`) });
};

const page = await openApp();
let settingsBefore = null;

try {
  /* ============================================================ pure logic */
  const lib = await page.evaluate(async (m) => {
    const L = await import(eval(m));
    const blocks = L.parseBlocks('Intro line\nsecond\n\n# Head\n- a\n- b\n1. one\n2. two\n## Sub\ntext **bold** end');
    const frag = document.createElement('div');
    frag.append(...L.formatBody('<img src=x onerror=alert(1)> and **<b>strong</b>**'));
    const cs = L.parseCaseStudy('Client: Acme Plumbing\nThe problem: missed calls\nWhat we built: an SMS responder\nThe result in numbers: 12 more jobs a month\n\n## What happened\nIt went well.');
    return {
      types: blocks.map((b) => b.type), p0: blocks[0].text, ul: blocks[2].items, ol: blocks[3].items, h2: blocks[4].text,
      inline: L.parseInline('a **b** c **d'),
      xss: !frag.querySelector('img') && !frag.querySelector('b') && frag.querySelector('strong')?.textContent === '<b>strong</b>',
      urls: [L.safeUrl('javascript:alert(1)'), L.safeUrl('example.com/x'), L.safeUrl('http://a.b/c'), L.safeUrl('ftp://x.y'), L.safeUrl('')],
      tags: L.parseTags(' Sales, calls,sales ,, '),
      cs: cs.fields.map((f) => `${f.label}=${f.value}`), csRest: cs.rest,
      tpl: L.parseCaseStudy(L.CASE_TEMPLATE).fields.length,
      filt: L.filterEntries([
        { id: 1, title: 'B', body: 'x', tags: [], updated_at: '2026-01-02' },
        { id: 2, title: 'A', body: 'needle', tags: [], pinned: true, updated_at: '2026-01-01' },
        { id: 3, title: 'C', body: '', tags: ['needle'], updated_at: '2026-01-03' },
        { id: 4, title: 'needle', archived: true }
      ], { q: 'needle' }).map((e) => e.id),
      starters: L.STARTERS.map((s) => s.title)
    };
  }, mod('views/library.js'));
  check(JSON.stringify(lib.types) === JSON.stringify(['p', 'h1', 'ul', 'ol', 'h2', 'p']), `formatter blocks ${lib.types}`);
  check(lib.p0 === 'Intro line\nsecond' && lib.ul.length === 2 && lib.ol.join('|') === 'one|two' && lib.h2 === 'Sub', 'formatter keeps paragraph lines, list items and headings');
  check(JSON.stringify(lib.inline) === JSON.stringify([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c **d' }]), 'bold parses; an unclosed ** stays literal');
  check(lib.xss, 'formatter renders markup in a body as text, never HTML');
  check(JSON.stringify(lib.urls) === JSON.stringify([null, 'https://example.com/x', 'http://a.b/c', null, null]), `links: http/https only ${JSON.stringify(lib.urls)}`);
  check(JSON.stringify(lib.tags) === JSON.stringify(['sales', 'calls']), 'tags are trimmed, lower-cased and de-duplicated');
  check(lib.cs.join('|') === 'Client=Acme Plumbing|The problem=missed calls|What we built=an SMS responder|The result in numbers=12 more jobs a month' && lib.csRest.startsWith('## What happened'), 'case study header parses from the body');
  check(lib.tpl === 4, 'case study template carries the four header fields');
  check(JSON.stringify(lib.filt) === JSON.stringify([2, 3]), `search covers body and tags, pinned first, archived hidden (${lib.filt})`);
  check(lib.starters.length === 5 && lib.starters.includes('Discovery call questions') && lib.starters.includes('Offboarding and handover'), 'five starter entries');

  const biz = await page.evaluate(async (m) => {
    const H = await import(eval(m));
    const today = '2026-11-18';
    const state = {
      settings: { monthly_target: 10000 },
      clients: [
        { id: 'c1', name: 'Alpha', status: 'active', monthly_value: 1000, started_on: '2026-09-01' },
        { id: 'c2', name: 'Bravo', status: 'active', monthly_value: 500, started_on: '2026-11-01' },
        { id: 'c3', name: 'Charlie', status: 'paused', monthly_value: 900 },
        { id: 'c4', name: 'Delta', status: 'active', monthly_value: 700, archived: true }
      ],
      deals: [
        { id: 'd1', title: 'X', stage: 'qualified', value: 3000, monthly_value: 200, next_step: 'Call', next_step_on: '2026-11-15' },
        { id: 'd2', title: 'Y', stage: 'proposal', value: 2000, next_step: '' },
        { id: 'd3', title: 'Z', stage: 'won', value: 9999 },
        { id: 'd4', title: 'W', stage: 'negotiation', value: 500, next_step: 'Send', next_step_on: '2026-11-25' }
      ],
      proposals: [
        { id: 'p1', title: 'P', status: 'sent', sent_on: '2026-11-10', recipient_business: 'Acme' },
        { id: 'p2', title: 'Q', status: 'sent', sent_on: '2026-11-15' },
        { id: 'p3', title: 'R', status: 'accepted', sent_on: '2026-10-01' }
      ],
      tasks: [
        { id: 't1', title: 'T1', state: 'todo', due_on: '2026-11-17' },
        { id: 't2', title: 'T2', state: 'doing', due_on: '2026-11-18' },
        { id: 't3', title: 'T3', state: 'done', due_on: '2026-11-01' },
        { id: 't4', title: 'T4', state: 'todo', due_on: '2026-11-30' }
      ],
      roi_reports: [{ client_id: 'c2', sent_on: '2026-11-10' }],
      income: [
        { id: 'i1', client_id: 'c1', amount: 1100, status: 'invoiced', due_on: '2026-11-10', invoice_no: 'WA-1' },
        { id: 'i2', client_id: 'c1', amount: 1000, status: 'paid', paid_on: '2026-11-05', kind: 'retainer', issued_on: '2026-11-01' },
        { id: 'i3', amount: 400, status: 'paid', paid_on: '2026-10-30' },
        { id: 'i4', amount: 250, status: 'invoiced', due_on: '2026-12-01' },
        { id: 'i5', amount: 300, status: 'paid', paid_on: '2026-11-12', kind: 'one_off' }
      ]
    };
    const d = H.businessDoNext(state, today);
    const n = H.businessNumbers(state, today);
    const keys = (a) => a.map((i) => i.key);
    return {
      urgent: keys(d.urgent), soon: keys(d.soon), later: keys(d.later),
      hrefs: [...d.urgent, ...d.soon, ...d.later].map((i) => i.href),
      invTitle: d.urgent[0].title, invSub: d.urgent[0].sub, taskTitle: d.urgent[1].title, roiSub: d.later.find((i) => i.key === 'roi-c1')?.sub,
      n, since: H.daysSince('2026-09-01', today),
      empty: H.businessNumbers({ clients: [], deals: [], income: [], settings: {} }, today).hasData,
      emptyItems: Object.values(H.businessDoNext({}, today)).flat().length
    };
  }, mod('views/home.js'));
  check(JSON.stringify(biz.urgent) === JSON.stringify(['inv-i1', 'tasks', 'deal-d1']), `urgent: overdue invoice, tasks, overdue next step (${biz.urgent})`);
  check(JSON.stringify(biz.soon) === JSON.stringify(['prop-p1']), `proposal sent 8 days ago (not 3) needs a follow-up (${biz.soon})`);
  check(JSON.stringify(biz.later) === JSON.stringify(['deal-step-d2', 'retainer-c2', 'roi-c1']), `later: no next step, unbilled retainer, ROI report due (${biz.later})`);
  check(JSON.stringify(biz.hrefs) === JSON.stringify(['#income/i1', '#projects/tasks', '#pipeline/d1', '#proposals/p1', '#pipeline/d2', '#income', '#roi-reports/new/c1']), `do-next deep links ${biz.hrefs}`);
  check(biz.invTitle === 'Chase $1,100 from Alpha' && biz.invSub === 'Invoice WA-1 was due 8 days ago', `invoice wording (${biz.invTitle} / ${biz.invSub})`);
  check(biz.taskTitle === '1 task overdue, 1 task due today', `task wording (${biz.taskTitle})`);
  check(biz.since === 78 && biz.roiSub === 'A client for 78 days with no report yet', `ROI report gap 1 Sep → 18 Nov = 78 days (${biz.roiSub})`);
  check(biz.n.pipeline === 5500 && biz.n.pipelineMonthly === 200 && biz.n.openDeals === 3, `open pipeline 3000+2000+500 = 5500 (+200/mo) (${biz.n.pipeline})`);
  check(biz.n.mrr === 1500 && biz.n.activeClients === 2, `MRR counts active, unarchived clients: 1000+500 (${biz.n.mrr})`);
  check(biz.n.moneyIn === 1300 && biz.n.targetPct === 13, `money in this month 1000+300 = 1300, 13% of 10,000 (${biz.n.moneyIn}, ${biz.n.targetPct}%)`);
  check(biz.n.unpaid === 1350 && biz.n.unpaidCount === 2 && biz.n.overdue === 1, `unpaid 1100+250 = 1350, one overdue (${biz.n.unpaid})`);
  check(biz.empty === false && biz.emptyItems === 0, 'empty stage 2 tables add nothing to Today');

  const imp = await page.evaluate(async (m) => {
    const S = await import(eval(m));
    const data = {
      settings: { quitLine: 4300 },
      clients: [
        { id: 'c_k1', name: 'Bowl', code: '1001', status: 'active', mrr: 190, contact: 'Jo', email: 'jo@example.com', location: 'Brisbane', started: '2026-03-01', notes: 'Bookings bot' },
        { id: 'c_k2', name: 'Prospect', status: 'prospect' },
        { id: 'c_k3', name: 'Old', status: 'past', archived: true }
      ],
      deals: [
        { id: 'd_k1', name: 'Quote calc', clientId: 'c_k1', stage: 'lead', value: 1900, probability: 50, nextAction: 'Send proposal', due: '2026-12-01' },
        { id: 'd_k2', name: 'Chatbot', clientId: 'c_k2', stage: 'won', value: 800 }
      ],
      projects: [{ id: 'p_k1', name: 'Website', clientId: 'c_k1', status: 'blocked', start: '2026-10-01', due: '2026-12-15' }],
      tasks: [
        { id: 't_k1', title: 'Review copy', projectId: 'p_k1', clientId: 'c_k1', status: 'review', priority: 'high', due: '2026-11-20' },
        { id: 't_k2', title: 'Set up DNS', projectId: 'p_k1', status: 'done', priority: 'urgent' }
      ],
      income: [
        { id: 'i_k1', clientId: 'c_k1', type: 'retainer', amount: 190, status: 'paid', date: '2026-10-01', invoice: 'INV-1', paidVia: 'Stripe' },
        { id: 'i_k2', clientId: 'c_k1', type: 'audit', amount: 500, status: 'unbilled', date: '2026-11-01' }
      ],
      expenses: [{ id: 'x_k1', item: 'Rego', vendor: 'ASIC', category: 'Govt / registration', amount: 42, date: '2026-02-01', deductible: 'yes' }],
      subscriptions: [{ id: 's_k1', item: 'Claude', amount: 300, cycle: 'quarterly', category: 'AI / tooling', nextDue: '2026-12-01', status: 'active' }],
      library: [{ id: 'l_k1', title: 'Standards', kind: 'standard', path: 'https://example.com/std', tags: 'eng, quality', notes: 'Read before a build' }],
      outputs: [{ id: 'o_k1', title: 'Proposal doc', kind: 'proposal', status: 'sent', clientId: 'c_k1', path: 'drive/proposal.pdf' }]
    };
    const read = S.readHqExport(data).data;
    const plan = S.planHqImport(read, {});
    const planNoArch = S.planHqImport(read, {}, { includeArchived: false });
    let n = 0;
    const saved = [];
    const res = await S.runHqImport(plan, async (table, row) => { const r = { ...row, id: `new-${++n}` }; saved.push({ table, ...r }); return r; });
    const by = (t, f, v) => saved.find((r) => r.table === t && r[f] === v);
    // A second run sees the markers and imports nothing.
    const existing = {};
    for (const r of saved) (existing[r.table] ||= []).push(r);
    const again = S.planHqImport(read, existing);
    // Duplicate by name maps onto the existing row.
    const dupPlan = S.planHqImport(read, { clients: [{ id: 'existing-bowl', name: 'bowl', notes: '' }] });
    let k = 0;
    const dupSaved = [];
    await S.runHqImport(dupPlan, async (table, row) => { const r = { ...row, id: `x-${++k}` }; dupSaved.push({ table, ...r }); return r; });
    return {
      enc: S.readHqExport({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 1, salt: 'a', iv: 'b', ct: 'c' }).error,
      shape: S.readHqExport({ hello: 1 }).error,
      counts: Object.fromEntries(plan.steps.map((s) => [s.key, s.toImport])),
      noArch: planNoArch.steps.find((s) => s.key === 'clients').toImport,
      inserted: res.inserted, errors: res.errors,
      client: by('clients', 'name', 'Bowl'), prospect: by('clients', 'name', 'Prospect'),
      deal: by('deals', 'title', 'Quote calc'), won: by('deals', 'title', 'Chatbot'),
      project: by('projects', 'name', 'Website'), task: by('tasks', 'title', 'Review copy'), task2: by('tasks', 'title', 'Set up DNS'),
      inc1: saved.find((r) => r.table === 'income' && r.invoice_no === 'INV-1'), inc2: saved.find((r) => r.table === 'income' && r.amount === 500),
      exp: by('costs', 'name', 'Rego'), sub: by('costs', 'name', 'Claude'), lib: by('library', 'title', 'Standards'), out: by('library', 'title', 'Proposal doc'),
      againTotal: again.steps.reduce((t, s) => t + s.toImport, 0), againPrev: again.previous,
      notes: plan.notes.length,
      dupDealClient: dupSaved.find((r) => r.title === 'Quote calc')?.client_id, dupClients: dupSaved.filter((r) => r.table === 'clients').length,
      usd: [S.usd(0), S.usd(0.0042), S.usd(0.016), S.usd(1.234)],
      sum: S.summariseAiUsage([{ task: 'hook', cost_usd: 0.001 }, { task: 'proposal', cost_usd: 0.05 }, { task: 'hook', cost_usd: 0.002 }]),
      capBad: S.validateSettings({ ai_monthly_cap_usd: 600 }),
      v: [S.validateSettings({ abn: '123' }), S.validateSettings({ abn: '51 824 753 556' }), S.validateSettings({ tax_rate: 1 }), S.validateSettings({ business_name: ' ' }), S.formatAbn('51824753556')]
    };
  }, mod('views/settings.js'));
  check(imp.enc === 'encrypted' && imp.shape === 'shape', 'import refuses the encrypted envelope and unknown files');
  check(JSON.stringify(imp.counts) === JSON.stringify({ clients: 3, deals: 2, projects: 1, tasks: 2, income: 2, expenses: 1, subscriptions: 1, library: 1, outputs: 1 }), `import plan counts ${JSON.stringify(imp.counts)}`);
  check(imp.noArch === 2, 'unticking archived leaves the archived client out');
  check(!imp.errors.length && Object.values(imp.inserted).reduce((a, b) => a + b, 0) === 14, `runs 14 inserts (${JSON.stringify(imp.inserted)})`);
  check(imp.client.contact_name === 'Jo' && imp.client.suburb === 'Brisbane' && imp.client.monthly_value === 190 && imp.client.started_on === '2026-03-01' && /Client ID 1001/.test(imp.client.notes) && imp.client.tags.includes('hq-import'), 'client fields map');
  check(imp.prospect.status === 'paused' && imp.prospect.tags.includes('prospect'), 'prospect becomes a paused client tagged prospect');
  check(imp.deal.stage === 'qualified' && imp.deal.client_id === imp.client.id && imp.deal.probability === 50 && imp.deal.next_step === 'Send proposal' && imp.deal.next_step_on === '2026-12-01', 'old lead stage → qualified, linked to the new client id');
  check(imp.won.stage === 'won' && imp.won.client_id === imp.prospect.id && imp.won.probability === 100, 'won deal maps and links');
  check(imp.project.status === 'waiting' && imp.project.client_id === imp.client.id && imp.project.started_on === '2026-10-01', 'blocked project → waiting, linked');
  check(imp.task.project_id === imp.project.id && imp.task.client_id === imp.client.id && imp.task.state === 'review' && imp.task.priority === 'high', 'task keeps its project and client');
  check(imp.task2.state === 'done' && imp.task2.priority === 'medium' && imp.task2.done_at, 'unknown priority falls back to medium; done gets done_at');
  check(imp.inc1.status === 'paid' && imp.inc1.paid_on === '2026-10-01' && imp.inc1.kind === 'retainer' && imp.inc1.client_id === imp.client.id && /Stripe/.test(imp.inc1.notes), 'paid retainer income maps');
  check(imp.inc2.status === 'draft' && imp.inc2.kind === 'one_off' && imp.inc2.paid_on === null, 'unbilled income → draft');
  check(imp.exp.cadence === 'one_off' && imp.exp.category === 'government' && imp.exp.incurred_on === '2026-02-01', 'expense → one-off cost');
  check(imp.sub.cadence === 'monthly' && imp.sub.amount === 100 && imp.sub.category === 'software' && imp.sub.next_due === '2026-12-01', `quarterly $300 subscription → $100 a month (${imp.sub.amount})`);
  check(imp.lib.url === 'https://example.com/std' && imp.lib.tags.join(',') === 'eng,quality,hq-import' && imp.lib.kind === 'standard', 'library entry maps with link and tags');
  check(imp.out.kind === 'template' && imp.out.client_id === imp.client.id && /Where it lives: drive\/proposal.pdf/.test(imp.out.body), 'outputs come across as library entries');
  check(imp.againTotal === 0 && imp.againPrev === 14, `a second import finds the markers and imports nothing (${imp.againTotal}, ${imp.againPrev} seen)`);
  check(imp.dupClients === 2 && imp.dupDealClient === 'existing-bowl', 'skip duplicates by name points links at the existing record');
  check(imp.notes >= 4, `preview explains what does not map cleanly (${imp.notes} notes)`);
  check(JSON.stringify(imp.usd) === JSON.stringify(['US$0.00', 'under 1 cent', 'US$0.02', 'US$1.23']), `AI spend reads in cents (${imp.usd})`);
  check(imp.sum.count === 3 && Math.abs(imp.sum.cost - 0.053) < 1e-9 && imp.sum.rows[0].task === 'proposal' && imp.sum.rows[1].count === 2, 'AI usage summarises by task');
  check(Boolean(imp.capBad), 'an AI cap over US$500 is refused');
  check(imp.v[0] && !imp.v[1] && imp.v[2] && imp.v[3] && imp.v[4] === '51 824 753 556', 'business settings validation (ABN, tax, name)');

  /* ============================================================ library UI */
  const libEmpty = await page.evaluate(async () => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.library.length === 0);
  const before0 = page.errors.length;
  await nav(page, 'library');
  check(await page.locator('.page.lib').count() === 1 && !(await page.locator('#view .err-card').count()), '#library renders');
  if (libEmpty) {
    check(await page.locator('[data-act=starters]').count() === 1, 'empty library offers “Add starter entries”');
    await shot(page, 'library-empty-1440');
  }
  check(page.errors.length === before0, `#library has no console errors ${page.errors.slice(before0).join(' | ')}`);

  // Starter content (prefixed for the test) goes in and reads as documents.
  const starters = await page.evaluate(async ({ m, P }) => (await import(eval(m))).addStarters(`${P} `).then((rows) => rows.map((r) => r.id)), { m: mod('views/library.js'), P });
  check(starters.length === 5, 'starter entries insert');
  await nav(page, `library/${starters[0]}`);
  check((await page.locator('.lib-title').textContent()) === `${P} Discovery call questions`, 'deep link opens a starter entry');
  check(await page.locator('.lib-body .lib-h').count() >= 4 && await page.locator('.lib-body .lib-ol li').count() >= 2 && await page.locator('.lib-body strong').count() >= 1, 'starter renders headings, numbered steps and bold');
  check(await page.locator('.lib-item.is-active').count() === 1, 'the open entry is marked in the list');
  await shot(page, 'library-doc-1440');

  // Create through the UI with autosave.
  await nav(page, 'library/new');
  await page.waitForSelector('.lib-edit');
  const title = `${P} Pricing notes ${TAG}`;
  await page.fill('.lib-edit [name=title]', title);
  await page.fill('.lib-edit [name=tags]', 'Pricing, Sales');
  await page.fill('.lib-edit [name=body]', 'Lead with the return.\n\n# Packages\n- Starter\n- Growth\n1. Call\n2. Proposal\n**Never** discount without a reason.');
  await page.waitForFunction(() => document.querySelector('.lib-save')?.dataset.state === 'saved', null, { timeout: 10000 });
  check(/^#library\/[0-9a-f-]{36}$/.test(await page.evaluate(() => location.hash)), 'first autosave gives the new entry its own address');
  const newId = (await page.evaluate(() => location.hash)).split('/')[1];
  let row = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('library').select('*').eq('id', id).single()).data, newId);
  check(row?.title === title && row.tags.join(',') === 'pricing,sales' && row.body.includes('# Packages'), 'autosaved row is in the database');

  // Typing is never lost: a realtime change arrives mid-edit.
  await page.click('.lib-edit [name=body]');
  await page.keyboard.press('End');
  await page.keyboard.type(' Typing while', { delay: 5 });
  const other = await openApp();
  await other.evaluate(async (t) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { error } = await sb.from('library').insert({ title: t, kind: 'research' });
    if (error) throw new Error(error.message);
  }, `${P} Realtime ${TAG}`);
  await page.waitForSelector(`.lib-item:has-text("${P} Realtime ${TAG}")`, { timeout: 15000 });
  const kept = await page.evaluate(() => ({ v: document.querySelector('.lib-edit [name=body]').value, f: document.activeElement?.name }));
  check(kept.v.endsWith('reason. Typing while') && kept.f === 'body', 'editor keeps text and focus while a live update lands');
  await other.close();

  // Bad link refused, good link kept.
  await page.fill('.lib-edit [name=url]', 'javascript:alert(1)');
  await page.waitForFunction(() => document.querySelector('.lib-save')?.dataset.state === 'warn', null, { timeout: 10000 });
  row = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('library').select('url,body').eq('id', id).single()).data, newId);
  check(row.url === null && row.body.endsWith('Typing while'), 'a javascript: link is not saved (the rest is)');
  await page.fill('.lib-edit [name=url]', 'https://example.com/pricing');
  await page.waitForFunction(() => document.querySelector('.lib-save')?.dataset.state === 'saved', null, { timeout: 10000 });
  await shot(page, 'library-edit-1440');
  await page.click('[data-act=done]');
  await page.waitForSelector('.lib-doc-head');
  const link = page.locator('.lib-meta-link[target=_blank]');
  check(await link.getAttribute('href') === 'https://example.com/pricing' && /noopener/.test(await link.getAttribute('rel')), 'link opens in a new tab with noopener');
  check(await page.locator('.lib-body .lib-ul li').count() === 2 && await page.locator('.lib-body .lib-ol li').count() === 2 && (await page.locator('.lib-body strong').first().textContent()) === 'Never', 'read mode formats the body');

  // Copy, pin, archive.
  await page.click('[data-act=copy]');
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  check(clip && clip.startsWith('Lead with the return.'), 'copy puts the body on the clipboard');
  await page.click('[data-act=pin]');
  await page.waitForFunction(async (id) => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.library.find((e) => e.id === id)?.pinned === true, newId, { timeout: 10000 });
  await page.waitForTimeout(300);
  const firstTitle = await page.locator('.lib-item .lib-item-title').first().textContent();
  check(firstTitle === title || (await page.locator('.lib-item').first().locator('.lib-pin').count()) === 1, 'pinned entries sit first');
  await page.fill('.lib-search', `pricing ${TAG}`.split(' ')[0]);
  await page.waitForTimeout(200);
  check(await page.locator(`.lib-item:has-text("${title}")`).count() === 1, 'search finds by tag/body');
  await page.fill('.lib-search', '');
  await page.click('[data-act=archive]');
  await page.waitForFunction(async (id) => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.library.find((e) => e.id === id)?.archived === true, newId, { timeout: 10000 });
  // Realtime echoes of the earlier pin can land after the archive; give the list a moment to settle.
  const left = await page.waitForFunction((t) => ![...document.querySelectorAll('.lib-item-title')].some((n) => n.textContent === t), title, { timeout: 8000 }).then(() => true).catch(() => false);
  check(left, 'archived entries leave the list');
  await page.click('.lib-arch-toggle');
  await page.waitForTimeout(200);
  check(await page.locator(`.lib-item:has-text("${title}")`).count() === 1, 'the Archived toggle shows them');
  await page.click('.lib-arch-toggle');
  await page.click('[data-act=archive]'); // restore
  await page.waitForTimeout(500);

  // Case study template.
  await nav(page, 'library/new');
  await page.fill('.lib-edit [name=title]', `${P} Case study ${TAG}`);
  await page.selectOption('.lib-edit [name=kind]', 'case_study');
  const tpl = await page.inputValue('.lib-edit [name=body]');
  check(tpl.startsWith('Client: \nThe problem: '), 'choosing Case study inserts the template');
  await page.fill('.lib-edit [name=body]', tpl.replace('Client: ', 'Client: Harbour Dental').replace('The result in numbers: ', 'The result in numbers: 9 extra bookings in the first month') + 'They answer every call now.');
  await page.waitForFunction(() => document.querySelector('.lib-save')?.dataset.state === 'saved', null, { timeout: 10000 });
  await page.click('[data-act=done]');
  await page.waitForSelector('.lib-case');
  check((await page.locator('.lib-case-row.is-result dd').textContent()) === '9 extra bookings in the first month' && await page.locator('.lib-case-row').count() === 4, 'case study shows its structured header');
  await shot(page, 'library-case-1440');
  const caseId = (await page.evaluate(() => location.hash)).split('/')[1];

  // Delete with confirm.
  await page.click('[data-act=delete]');
  await page.waitForSelector('.modal');
  await page.click('.modal-foot button[type=submit]');
  await page.waitForFunction(() => location.hash === '#library', null, { timeout: 10000 });
  const gone = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('library').select('id').eq('id', id)).data.length, caseId);
  check(gone === 0, 'delete (after confirm) removes the row');
  await nav(page, 'library/00000000-0000-0000-0000-000000000000');
  check(await page.locator('.lib-doc .empty-title').textContent() === 'That entry is not here', 'unknown entry id shows a calm not-found');

  /* ============================================================ Today */
  const seed = await db(page, async ({ P, TAG }) => {
    const { saveRow, state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const day = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
    const client = await saveRow('clients', { name: `${P} Client ${TAG}`, status: 'active', monthly_value: 1200, started_on: day(60) });
    const deal = await saveRow('deals', { title: `${P} Deal ${TAG}`, client_id: client.id, stage: 'proposal', value: 4000, next_step: 'Call back', next_step_on: day(2) });
    const prop = await saveRow('proposals', { title: `${P} Proposal ${TAG}`, client_id: client.id, status: 'sent', sent_on: day(8), recipient_business: `${P} Client ${TAG}` });
    const task = await saveRow('tasks', { title: `${P} Task ${TAG}`, client_id: client.id, due_on: day(1) });
    const inv = await saveRow('income', { description: `${P} invoice ${TAG}`, client_id: client.id, amount: 990, status: 'invoiced', invoice_no: `${P}-${TAG}`, issued_on: day(30), due_on: day(9) });
    return { client: client.id, deal: deal.id, prop: prop.id, task: task.id, inv: inv.id, otherTasks: state.tasks.length };
  }, { P, TAG });
  await nav(page, 'home', 900);
  check(await page.locator('.kpi-strip.biz [data-biz=pipeline]').count() === 1 && await page.locator('.kpi-strip.biz [data-biz=mrr]').count() === 1
    && await page.locator('.kpi-strip.biz [data-biz=in]').count() === 1 && await page.locator('.kpi-strip.biz [data-biz=unpaid]').count() === 1, 'Today shows the business number strip once there is data');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'home-top-1440');
  if (await page.locator('.do-more').count()) { await page.click('.do-more'); await page.waitForTimeout(200); }
  const keys = await page.$$eval('.do-item', (ns) => ns.map((n) => ({ k: n.dataset.key, h: n.querySelector('.do-link')?.getAttribute('href') })));
  const has = (k, h) => keys.some((x) => x.k === k && x.h === h);
  check(has(`inv-${seed.inv}`, `#income/${seed.inv}`), 'Do next: overdue invoice → #income/<id>');
  check(has(`deal-${seed.deal}`, `#pipeline/${seed.deal}`), 'Do next: overdue next step → #pipeline/<id>');
  check(has(`prop-${seed.prop}`, `#proposals/${seed.prop}`), 'Do next: proposal waiting 8 days → #proposals/<id>');
  check(keys.some((x) => (x.k === `task-${seed.task}` || x.k === 'tasks') && x.h === '#projects/tasks'), 'Do next: overdue task → #projects/tasks');
  check(has(`roi-${seed.client}`, `#roi-reports/new/${seed.client}`), 'Do next: client with no ROI report in 35 days → #roi-reports/new/<id>');
  check(keys.some((x) => (x.k === `retainer-${seed.client}` || x.k === 'retainers') && x.h === '#income'), 'Do next: retainer not invoiced this month → #income');
  const order = keys.map((x) => x.k);
  check(order.indexOf(`inv-${seed.inv}`) < order.indexOf(`prop-${seed.prop}`) && order.indexOf(`prop-${seed.prop}`) < order.indexOf(`roi-${seed.client}`), 'Do next stays ordered by urgency');
  await shot(page, 'home-1440');

  /* ============================================================ palette */
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal [role=combobox]');
  await page.keyboard.type(`${P} Client ${TAG}`);
  await page.waitForTimeout(200);
  check(await page.locator('.pal-group', { hasText: 'Clients' }).locator('.pal-opt', { hasText: `${P} Client ${TAG}` }).count() === 1, 'palette finds clients');
  await page.fill('.pal-input', `${P} Deal ${TAG}`);
  await page.waitForTimeout(150);
  check(await page.locator('.pal-group', { hasText: 'Deals' }).locator('.pal-opt', { hasText: `${P} Deal ${TAG}` }).count() === 1, 'palette finds deals');
  await page.fill('.pal-input', `${P} Discovery`);
  await page.waitForTimeout(150);
  const libOpt = page.locator('.pal-group', { hasText: 'Library' }).locator('.pal-opt', { hasText: `${P} Discovery call questions` });
  check(await libOpt.count() === 1, 'palette finds library entries');
  await libOpt.click();
  await page.waitForTimeout(400);
  check(await page.evaluate(() => location.hash) === `#library/${starters[0]}`, 'choosing a library result opens its deep link');
  for (const [label, hash] of [['New deal', '#pipeline/new'], ['New library entry', '#library/new'], ['New invoice', '#income/new'], ['Add cost', '#costs/new'], ['New ROI report', '#roi-reports/new'], ['New client', '#clients/new'], ['New project', '#projects/new'], ['New proposal', '#proposals/new']]) {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.pal [role=combobox]');
    await page.keyboard.type(label);
    await page.waitForTimeout(100);
    const idx = (await page.locator('.pal-opt .pal-label').allTextContents()).indexOf(label);
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
    // Record where the palette sends us (the target view may then open its own form).
    await page.evaluate(() => { window.__hashes = []; window.addEventListener('hashchange', () => window.__hashes.push(location.hash), { once: true }); });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check(idx >= 0 && (await page.evaluate(() => window.__hashes[0])) === hash, `palette action “${label}” → ${hash}`);
    for (let i = 0; i < 3 && await page.locator('.modal-backdrop, .drawer').count(); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
    await nav(page, 'library', 300);
  }
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal [role=combobox]');
  const goTo = await page.locator('.pal-group', { hasText: 'Go to' }).locator('.pal-label').allTextContents();
  check(['Pipeline', 'Proposals', 'Clients', 'Projects', 'ROI reports', 'Income', 'Costs', 'Runway', 'Library'].every((l) => goTo.includes(l)), 'Go to lists every new section');
  await page.keyboard.press('Escape');

  /* ============================================================ leads drawer */
  const leadId = await db(page, async ({ P, TAG }) => {
    const { saveLead } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    return (await saveLead(null, { business: `${P} Lead ${TAG}`, contact_name: 'Kim Know', status: 'interested', source: 'manual', pain: 'Missed calls on site' })).id;
  }, { P, TAG });
  await nav(page, `leads/${leadId}`);
  await page.waitForSelector('.drawer');
  check(await page.locator('.drawer [data-act=create-deal]').count() === 1 && await page.locator('.drawer [data-act=make-client]').count() === 1, 'interested lead offers Create deal and Make client');
  await shot(page, 'lead-drawer-1440');
  await page.click('.drawer [data-act=create-deal]');
  await page.waitForFunction(() => /^#pipeline\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 10000 });
  const dealId = (await page.evaluate(() => location.hash)).split('/')[1];
  const deal = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('deals').select('*').eq('id', id).single()).data, dealId);
  check(deal?.lead_id === leadId && deal.title === `${P} Lead ${TAG}` && deal.stage === 'qualified', 'Create deal opens a qualified deal for the lead and goes to it');
  await nav(page, `leads/${leadId}`);
  await page.waitForSelector('.drawer');
  check(await page.locator(`.drawer a[data-act=open-deal][href="#pipeline/${dealId}"]`).count() === 1, 'a lead with a deal links to it instead');
  await page.click('.drawer [data-act=make-client]');
  await page.waitForFunction(() => /^#clients\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 10000 });
  const clientId = (await page.evaluate(() => location.hash)).split('/')[1];
  const cl = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('clients').select('*').eq('id', id).single()).data, clientId);
  check(cl?.lead_id === leadId && cl.name === `${P} Lead ${TAG}`, 'Make client creates the client from the lead and goes to it');
  await nav(page, `leads/${leadId}`);
  await page.waitForSelector('.drawer');
  check(await page.locator(`.drawer a[data-act=open-client][href="#clients/${clientId}"]`).count() === 1, 'a lead with a client links to it instead');
  await page.keyboard.press('Escape');
  const newLead = await db(page, async ({ P, TAG }) => {
    const { saveLead } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    return (await saveLead(null, { business: `${P} Cold ${TAG}`, status: 'new', source: 'manual' })).id;
  }, { P, TAG });
  await nav(page, `leads/${newLead}`);
  await page.waitForSelector('.drawer');
  check(await page.locator('.drawer [data-act=create-deal]').count() === 0, 'a new lead does not offer the hand-offs yet');

  // AI: suggest a personal line from Tyler's own observation (mocked endpoint).
  check(await page.locator('.drawer [data-act=ai-hook]').count() === 1, 'AI on: the drawer offers “Suggest a personal line”');
  await page.click('.drawer [data-act=ai-hook]');
  await page.fill('.drawer [name=ai-notes]', '');
  await page.click('.drawer [data-act=ai-suggest]');
  await page.waitForSelector('.drawer .ld-ai-ask', { timeout: 10000 });
  check(/Google reviews/.test(await page.locator('.drawer .ld-ai-ask').textContent()) && await page.locator('.drawer [data-act=ai-pick]').count() === 0, 'with nothing observed, the AI asks what to look at instead of inventing a line');
  await page.fill('.drawer [name=ai-notes]', 'Reviews say they are hard to reach on site');
  await page.click('.drawer [data-act=ai-suggest]');
  await page.waitForSelector('.drawer [data-act=ai-pick]', { timeout: 10000 });
  const hookCall = aiCalls.filter((c) => c.task === 'hook').pop();
  check(hookCall?.context?.notes === 'Reviews say they are hard to reach on site' && hookCall.context.lead.business === `${P} Cold ${TAG}`, 'the hook request carries the lead and the observation');
  const opts = await page.locator('.drawer [data-act=ai-pick]').allTextContents();
  await page.locator('.drawer [data-act=ai-pick]').first().click();
  await page.waitForTimeout(200);
  check(await page.inputValue('.drawer [name=hook]') === opts[0], 'picking a suggestion fills the empty personal line');
  await page.locator('.drawer [data-act=ai-pick]').nth(1).click();
  await page.waitForSelector('.modal');
  await page.click('.modal-foot button[type=submit]');
  await page.waitForTimeout(200);
  check(await page.inputValue('.drawer [name=hook]') === opts[1], 'replacing an existing line asks first');
  const savedHook = await db(page, async (id) => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('leads').select('hook').eq('id', id).single()).data.hook, newLead);
  check(!savedHook, 'a suggestion is not saved until Tyler saves it');
  await shot(page, 'lead-ai-1440');
  await page.evaluate(async () => { const a = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js')); a.state.ai = { ...a.state.ai, enabled: false }; a.notify(); });
  await page.waitForTimeout(300);
  check(await page.locator('.drawer [data-act=ai-hook]').count() === 0, 'AI switched off: the button disappears');
  await page.evaluate(async () => { const a = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js')); a.state.ai = { ...a.state.ai, enabled: true }; a.notify(); });
  await page.keyboard.press('Escape');

  /* ============================================================ settings */
  settingsBefore = await db(page, async () => {
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const s = state.settings;
    return { business_name: s.business_name, abn: s.abn, gst_registered: s.gst_registered, tax_rate: s.tax_rate, monthly_target: s.monthly_target, owner_draw: s.owner_draw, proposal_terms: s.proposal_terms, ai_enabled: s.ai_enabled, ai_monthly_cap_usd: s.ai_monthly_cap_usd };
  });
  await nav(page, 'settings');
  check(await page.locator('input[name=business_name]').count() === 1 && await page.locator('input[name=gst_registered]').count() === 1 && await page.locator('textarea[name=proposal_terms]').count() === 1, 'Settings has the Business group');
  check(await page.inputValue('input[name=tax_rate]') === String(Math.round(Number(settingsBefore.tax_rate) * 10000) / 100), 'tax rate shows as a percentage');
  await page.fill('input[name=monthly_target]', String(Number(settingsBefore.monthly_target) + 1));
  await page.fill('input[name=tax_rate]', '27.5');
  await page.fill('input[name=abn]', '51824753556');
  await page.click('.set-savebar button[type=submit]');
  await page.waitForFunction(async (v) => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.settings.monthly_target == v, Number(settingsBefore.monthly_target) + 1, { timeout: 10000 });
  const saved = await db(page, async () => (await (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).sb.from('settings').select('monthly_target,tax_rate,abn').eq('id', 1).single()).data);
  check(Number(saved.monthly_target) === Number(settingsBefore.monthly_target) + 1 && Number(saved.tax_rate) === 0.275 && saved.abn === '51 824 753 556', `business settings save (${JSON.stringify(saved)})`);
  await page.fill('input[name=abn]', '123');
  await page.click('.set-savebar button[type=submit]');
  await page.waitForTimeout(600);
  const abn2 = await db(page, async () => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.settings.abn);
  check(abn2 === '51 824 753 556', 'a short ABN is refused');
  await db(page, async (s) => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).saveSettings(s), settingsBefore);
  check(await page.locator('a[data-legacy]').textContent().then((t) => /retire/i.test(t)), 'legacy link says the old console can be retired');

  // AI drafting group.
  await nav(page, 'library', 200);
  await nav(page, 'settings');
  check(await page.locator('[data-ai-status=connected]').count() === 1, 'AI group shows Connected');
  check((await page.locator('[data-ai-spend]').textContent()) === 'under 1 cent of US$5.00', `AI spend vs cap (${await page.locator('[data-ai-spend]').textContent()})`);
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('.set-ai')?.textContent || ''), null, { timeout: 10000 });
  check(await page.locator('.set-ai-usage').count() === 1 || /No drafts yet/.test(await page.locator('.set-ai').textContent()), 'this month’s usage by task is shown');
  check(/small, fast model/.test(await page.locator('.set-ai-notes').textContent()) && /without you reading it/.test(await page.locator('.set-ai-notes').textContent()), 'AI group says which model does what and that nothing is sent unread');
  await page.fill('input[name=ai_monthly_cap_usd]', String(Number(settingsBefore.ai_monthly_cap_usd ?? 5) + 1));
  await page.click('.set-savebar button[type=submit]');
  await page.waitForFunction(async (v) => Number((await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.settings.ai_monthly_cap_usd) === v, Number(settingsBefore.ai_monthly_cap_usd ?? 5) + 1, { timeout: 10000 });
  check(true, 'AI monthly cap saves');
  await shot(page, 'settings-ai-1440');
  await db(page, async (s) => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).saveSettings(s), settingsBefore);

  // Import through the UI.
  const fixture = {
    meta: { version: 1, updated: '2026-11-01' }, settings: { quitLine: 4300 },
    clients: [{ id: `c_${TAG}a`, name: `${P} Bowl ${TAG}`, status: 'active', mrr: 190 }, { id: `c_${TAG}b`, name: `${P} Old ${TAG}`, status: 'past', archived: true }],
    deals: [{ id: `d_${TAG}`, name: `${P} Quote ${TAG}`, clientId: `c_${TAG}a`, stage: 'lead', value: 1900, probability: 40, nextAction: 'Send proposal' }],
    projects: [{ id: `p_${TAG}`, name: `${P} Website ${TAG}`, clientId: `c_${TAG}a`, status: 'shipped' }],
    tasks: [{ id: `t_${TAG}`, title: `${P} Task import ${TAG}`, projectId: `p_${TAG}`, status: 'todo' }],
    income: [{ id: `i_${TAG}`, clientId: `c_${TAG}a`, type: 'retainer', amount: 190, status: 'paid', date: '2026-10-01', notes: `${P} import ${TAG}` }],
    expenses: [{ id: `x_${TAG}`, item: `${P} Rego ${TAG}`, amount: 42, date: '2026-02-01', category: 'Other' }],
    subscriptions: [{ id: `s_${TAG}`, item: `${P} Hosting ${TAG}`, amount: 30, cycle: 'monthly', category: 'Domain / hosting', status: 'active' }],
    library: [{ id: `l_${TAG}`, title: `${P} Standards ${TAG}`, kind: 'standard', tags: 'eng', notes: 'Read first' }],
    outputs: []
  };
  const fx = join(tmpdir(), `zzknow-hq-${TAG}.json`);
  writeFileSync(fx, JSON.stringify(fixture));
  const enc = join(tmpdir(), `zzknow-hq-${TAG}.enc.json`);
  writeFileSync(enc, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 310000, salt: 'AAAA', iv: 'BBBB', ct: 'CCCC' }));
  await page.setInputFiles('#hq-import-file', enc);
  await page.waitForSelector('.imp .callout.is-warn');
  check(/plain JSON/i.test(await page.locator('.imp .callout.is-warn').textContent()), 'an encrypted backup is explained, not imported');
  await page.setInputFiles('#hq-import-file', fx);
  await page.waitForSelector('.imp-table');
  const n = async (k) => Number(await page.locator(`.imp-table tr[data-step="${k}"] td[data-n=import]`).textContent());
  check(await n('clients') === 2 && await n('deals') === 1 && await n('tasks') === 1 && await n('subscriptions') === 1, 'preview counts what will import');
  await page.locator('input[name=imp-archived]').uncheck();
  await page.waitForTimeout(150);
  check(await n('clients') === 1, 'unticking archived updates the preview');
  await shot(page, 'settings-import-1440');
  await page.click('[data-act=import]');
  await page.waitForSelector('.modal');
  await page.click('.modal-foot button[type=submit]');
  await page.waitForSelector('[data-imp=done]', { timeout: 30000 });
  const got = await db(page, async ({ P, TAG }) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const one = async (t, f, v) => (await sb.from(t).select('*').eq(f, v)).data;
    return {
      clients: await one('clients', 'name', `${P} Bowl ${TAG}`), old: await one('clients', 'name', `${P} Old ${TAG}`),
      deal: (await one('deals', 'title', `${P} Quote ${TAG}`))[0], project: (await one('projects', 'name', `${P} Website ${TAG}`))[0],
      task: (await one('tasks', 'title', `${P} Task import ${TAG}`))[0], income: (await sb.from('income').select('*').ilike('notes', `%${P} import ${TAG}%`)).data,
      costs: (await sb.from('costs').select('*').ilike('name', `${P}%${TAG}`)).data, lib: (await one('library', 'title', `${P} Standards ${TAG}`))[0]
    };
  }, { P, TAG });
  const c0 = got.clients[0];
  check(got.clients.length === 1 && got.old.length === 0, 'import inserted the client and left the archived one out');
  check(got.deal?.client_id === c0.id && got.deal.stage === 'qualified' && got.project?.client_id === c0.id && got.project.status === 'done' && got.task?.project_id === got.project.id, 'imported links point at the new ids');
  check(got.income.length === 1 && got.income[0].client_id === c0.id && got.income[0].kind === 'retainer' && got.costs.length === 2 && got.lib?.tags.includes('hq-import'), 'income, costs and library came across');
  await page.click('.imp button:has-text("Import another file")');
  await page.setInputFiles('#hq-import-file', fx);
  await page.waitForSelector('.imp-table');
  check(await page.locator('[data-imp=previous]').count() === 1 && await page.locator('[data-act=import]').isDisabled(), 'a second import is detected and offers nothing to add');
  await shot(page, 'settings-import-again-1440');

  /* ============================================================ phones */
  const phone = await openApp({ width: 390, height: 844 });
  for (const r of ['library', `library/${starters[0]}`, `library/${newId}`, 'library/new', 'home', 'settings']) {
    await nav(phone, r, 900);
    const ov = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(ov <= 0, `#${r} has no horizontal scroll at 390px (${ov})`);
    if (SHOTS) await shot(phone, `${r.replace(/\/.*/, (m) => (m.length > 10 ? '-doc' : m.replace('/', '-')))}-390`);
  }
  await nav(phone, `library/${starters[0]}`);
  check(await phone.locator('.lib-side').isHidden() && await phone.locator('.lib-back').isVisible(), 'phone library goes list → entry with a back link');
  await phone.getByRole('button', { name: 'More sections' }).click();
  await phone.waitForSelector('.more-sheet');
  const sheet = await phone.$$eval('.more-sheet a.nav-item[data-route]', (ns) => ns.map((n) => n.dataset.route));
  check(['pipeline', 'proposals', 'clients', 'projects', 'roi-reports', 'income', 'costs', 'runway', 'library'].every((r) => sheet.includes(r)), 'phone More sheet lists every new section');
  check(phone.errors.length === 0, `no console errors at 390px ${phone.errors.join(' | ')}`);
  await phone.close();
  if (SHOTS) {
    const wide = await openApp({ width: 1440, height: 900 });
    await nav(wide, 'library', 900);
    await shot(wide, 'library-1440');
    await wide.close();
  }
  check(page.errors.length === 0, `no console errors in the main run ${page.errors.join(' | ')}`);
  check(aiCalls.every((c) => c.action === 'status' || c.task === 'hook'), 'every AI call in the run went to the mock');
} catch (err) {
  fails.push(`exception: ${err.stack || err.message}`);
  console.log('FAIL exception', err);
} finally {
  try {
    const left = await page.evaluate(async ({ P, settingsBefore }) => {
      const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
      const like = `${P}%`;
      if (settingsBefore) await sb.from('settings').update(settingsBefore).eq('id', 1);
      const clientIds = ((await sb.from('clients').select('id').ilike('name', like)).data || []).map((c) => c.id);
      await sb.from('income').delete().or(`description.ilike.${P}*,notes.ilike.*${P}*`);
      if (clientIds.length) await sb.from('income').delete().in('client_id', clientIds);
      await sb.from('tasks').delete().ilike('title', like);
      await sb.from('proposals').delete().ilike('title', like);
      await sb.from('projects').delete().ilike('name', like);
      await sb.from('deals').delete().ilike('title', like);
      await sb.from('costs').delete().ilike('name', like);
      await sb.from('library').delete().ilike('title', like);
      await sb.from('clients').delete().ilike('name', like);
      await sb.from('leads').delete().ilike('business', like);
      const count = async (t, f) => (await sb.from(t).select('id', { count: 'exact', head: true }).ilike(f, like)).count;
      return {
        clients: await count('clients', 'name'), deals: await count('deals', 'title'), projects: await count('projects', 'name'), tasks: await count('tasks', 'title'),
        proposals: await count('proposals', 'title'), costs: await count('costs', 'name'), library: await count('library', 'title'), leads: await count('leads', 'business'),
        income: (await sb.from('income').select('id', { count: 'exact', head: true }).or(`description.ilike.${P}*,notes.ilike.*${P}*`)).count
      };
    }, { P, settingsBefore });
    console.log('cleanup left', JSON.stringify(left));
    check(Object.values(left).every((v) => v === 0), 'cleanup removed every ZZKNOW row');
  } catch (e) { fails.push(`cleanup failed: ${e.message}`); }
  await browser.close();
}

console.log(`\n${passes.length} passed, ${fails.length} failed`);
for (const f of fails) console.log(`FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
