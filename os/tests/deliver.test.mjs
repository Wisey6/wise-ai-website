// Wise AI OS: Deliver (Clients, Projects, ROI reports), end to end against the live
// Supabase project. Every row it creates carries "ZZDELIV" and is deleted at the end.
//
//   python3 -m http.server 8182 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/deliver.test.mjs [shots-dir]
//
// BASE overrides the URL. Other agents test against the same database at the same time,
// so nothing here assumes a table is empty and only ZZDELIV rows are ever touched.
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8182/os/';
const PASSWORD = process.env.OS_TEST_PASSWORD;
const SHOTS = process.argv[2] || null;
const P = 'ZZDELIV';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const browser = await chromium.launch();
const pages = [];

async function openApp(viewport = { width: 1440, height: 900 }, hash = '', setup = null) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/functions\/v1\/|net::ERR_FAILED/.test(t)) return; // edge functions, not ours
    page.errors.push(t);
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  await page.goto(BASE + hash);
  await page.evaluate(async (pw) => {
    const { sb } = await window.__mod('api.js');
    const { error } = await sb.auth.signInWithPassword({ email: 'hq@wise-ai.au', password: pw });
    if (error) throw new Error(error.message);
  }, PASSWORD);
  await page.waitForFunction(async () => (await window.__mod('api.js')).state.loaded, null, { timeout: 20000 });
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 20000 });
  await page.mouse.move(viewport.width / 2, viewport.height - 10);
  pages.push(page);
  return page;
}

/** Go to a route and wait for a selector that only that screen has. */
async function nav(page, hash, sel) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  if (sel) await page.waitForSelector(sel, { timeout: 15000 });
  await page.waitForTimeout(350);
}

const db = (page, fn, arg) => page.evaluate(fn, arg);
/** Poll the database (through the page's client) until fn(arg) returns a truthy value. */
async function waitDb(page, fn, arg, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const shot = async (page, name, full = true) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/deliver-${name}.png`, fullPage: full }); };
const text = (page, sel) => page.locator(sel).first().innerText();

const ids = {};
const page = await openApp();
const T0 = await page.evaluate(async () => (await window.__mod('views/roi-reports.js')).today());
const addD = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

try {
  /* ============================================ calculations, by hand */
  const u = await page.evaluate(async (T0) => {
    const R = await window.__mod('views/roi-reports.js');
    const C = await window.__mod('views/clients.js');
    const PJ = await window.__mod('views/projects.js');
    const add = (k, n) => R.addDays(k, n);
    const m1 = { label: 'Missed calls a week', before: 12, after: 3, unit: '', value_per_unit: 150, better: 'lower', per: 'week' };
    const m2 = { label: 'Jobs booked', before: 5, after: 9, unit: 'jobs', value_per_unit: 400, better: 'higher', per: 'period' };
    const m3 = { label: 'Complaints', before: 10, after: 12, unit: '', value_per_unit: 50, better: 'lower', per: 'period' };
    const m4 = { label: 'Half filled', before: 4, after: '', value_per_unit: 100 };
    const m5 = { label: 'Daily', before: 2, after: 3, value_per_unit: 10, better: 'higher', per: 'day' };
    const base = { period_start: '2026-10-01', period_end: '2026-10-31', metrics: [m1, m2], hours_saved: 20, hourly_value: 60, revenue_gained: 2000, cost_saved: 300, fee: 1500 };
    const tot = R.reportTotals(base);
    const below = R.reportTotals({ period_start: '2026-10-01', period_end: '2026-10-31', metrics: [], hours_saved: 10, hourly_value: 50, fee: 1500 });
    const nofee = R.reportTotals({ revenue_gained: 100, fee: 0 });
    const dup = R.duplicateReport({ ...base, client_id: null });
    const t = R.today();
    const st = {
      clients: [], messages: [], bookings: [],
      income: [{ client_id: 'c1', status: 'invoiced', amount: 1650, due_on: add(t, -5), id: 'i1' }, { client_id: 'c1', status: 'paid', amount: 1500, id: 'i2' }, { client_id: 'c1', status: 'invoiced', amount: 500, due_on: add(t, 9), id: 'i3' }],
      projects: [], tasks: [], roi_reports: []
    };
    const oldClient = { id: 'c1', name: 'Old', status: 'active', started_on: add(t, -60), notes: '' };
    const p1 = C.clientPrompts(oldClient, st).map((p) => p.id);
    const f1 = C.clientFacts(oldClient, st);
    const st2 = {
      clients: [], messages: [], bookings: [], income: [],
      projects: [{ id: 'p', client_id: 'c2', status: 'active', archived: false }], tasks: [],
      roi_reports: [{ client_id: 'c2', status: 'sent', sent_on: add(t, -10), created_at: new Date().toISOString() }]
    };
    const happy = { id: 'c2', name: 'Happy', status: 'active', started_on: add(t, -200), notes: `${add(t, -3)} · Call: all good\nPrefers texts` };
    const p2 = C.clientPrompts(happy, st2).map((p) => p.id);
    const newbie = C.clientPrompts({ id: 'c3', name: 'New', status: 'active', started_on: t }, { ...st2, roi_reports: [], projects: [] }).map((p) => p.id);
    const roster = C.rosterTotals([
      { status: 'active', monthly_value: 1500 }, { status: 'active', monthly_value: 2500 }, { status: 'paused', monthly_value: 900 },
      { status: 'active', monthly_value: 700, archived: true }, { status: 'past', monthly_value: 300 }]);
    const sorted = PJ.sortMyTasks([
      { id: 'a', due_on: null, priority: 'high', sort: 0, created_at: '1' },
      { id: 'b', due_on: add(t, 2), priority: 'low', sort: 0, created_at: '1' },
      { id: 'c', due_on: add(t, 2), priority: 'high', sort: 0, created_at: '1' },
      { id: 'd', due_on: add(t, -1), priority: 'medium', sort: 0, created_at: '1' },
      { id: 'e', due_on: null, priority: 'medium', sort: 0, created_at: '1' }]).map((x) => x.id).join('');
    return {
      lm: R.lastMonth('2026-11-17'), lmJan: R.lastMonth('2026-01-05'), lmLeap: R.lastMonth('2024-03-10'),
      np: R.nextPeriod('2026-10-01', '2026-10-31'), npDec: R.nextPeriod('2026-12-01', '2026-12-31'), npOdd: R.nextPeriod('2026-10-05', '2026-10-18'),
      days: R.periodDays('2026-10-01', '2026-10-31'), label: R.periodLabel('2026-10-01', '2026-10-31'), label2: R.periodLabel('2026-10-05', '2026-10-18'),
      c1: R.metricCalc(m1, 31), c2: R.metricCalc(m2, 31), c3: R.metricCalc(m3, 31), c4: R.metricCalc(m4, 31), c5: R.metricCalc(m5, 31),
      tot, below, nofee, line: R.returnLine(tot.multiple), lineBelow: R.returnLine(below.multiple),
      dup: { start: dup.period_start, end: dup.period_end, m: dup.metrics, fee: dup.fee, hours: dup.hours_saved, hourly: dup.hourly_value },
      p1, p2, newbie, paid: f1.paid, unpaid: f1.unpaid, overdue: f1.overdue.length, roster, sorted,
      lastContact: C.clientFacts(happy, st2).lastContact
    };
  }, T0);
  check(u.lm.start === '2026-10-01' && u.lm.end === '2026-10-31', `default period is last calendar month (${JSON.stringify(u.lm)})`);
  check(u.lmJan.start === '2025-12-01' && u.lmJan.end === '2025-12-31' && u.lmLeap.end === '2024-02-29', 'last month across a year end and a leap February');
  check(u.np.start === '2026-11-01' && u.np.end === '2026-11-30' && u.npDec.start === '2027-01-01' && u.npDec.end === '2027-01-31', 'next period after a whole month is the next calendar month');
  check(u.npOdd.start === '2026-10-19' && u.npOdd.end === '2026-11-01', `next period after 14 days is the next 14 days (${JSON.stringify(u.npOdd)})`);
  check(u.days === 31 && u.label === 'October 2026' && /5 Oct – 18 Oct 2026/.test(u.label2), `period days and labels (${u.days}, ${u.label}, ${u.label2})`);
  // 12 → 3 missed calls a week, lower is better: 9 fewer × $150 × 31/7 weeks = $5,978.57
  check(u.c1.gain === 9 && near(u.c1.value, 9 * 150 * 31 / 7) && u.c1.change === '9 fewer' && u.c1.good && Math.round(u.c1.pct) === 75, `weekly metric value 9 × $150 × 31/7 = ${u.c1.value}`);
  check(u.c2.gain === 4 && u.c2.value === 1600 && u.c2.change === 'Up 4 jobs', `period metric 4 more jobs × $400 = ${u.c2.value} (${u.c2.change})`);
  check(u.c3.value === -100 && u.c3.bad && u.c3.change === '2 more', 'a change the wrong way is a negative value, shown');
  check(u.c4.value === 0 && !u.c4.filled, 'a half-filled row counts nothing');
  check(near(u.c5.value, 1 * 10 * 31), `daily metric × 31 days = ${u.c5.value}`);
  // 5,978.5714 + 1,600 + 20 h × $60 + 2,000 + 300 = 11,078.5714; fee 1,500 → net 9,578.57; 7.3857×
  check(near(u.tot.total, 5978.571428571428 + 1600 + 1200 + 2000 + 300) && near(u.tot.net, u.tot.total - 1500) && near(u.tot.multiple, u.tot.total / 1500) && u.tot.verdict === 'positive',
    `report totals by hand (total ${u.tot.total.toFixed(2)}, net ${u.tot.net.toFixed(2)}, ${u.tot.multiple.toFixed(4)}×)`);
  check(u.line === '$7.38 back for every $1', `return line rounds down (${u.line})`);
  check(u.below.total === 500 && near(u.below.multiple, 1 / 3) && u.below.verdict === 'below' && u.lineBelow === '$0.33 back for every $1', 'a return below 1 is flagged as below');
  check(u.nofee.verdict === 'nofee' && u.nofee.multiple === null, 'no fee means no return multiple');
  check(u.dup.start === '2026-11-01' && u.dup.end === '2026-11-30' && u.dup.m[0].before === 3 && u.dup.m[0].after === null && u.dup.m[1].before === 9
    && u.dup.m[0].better === 'lower' && u.dup.m[0].per === 'week' && u.dup.hours === 0 && u.dup.hourly === 60, `duplicate carries last "after" into "before" (${JSON.stringify(u.dup.m)})`);
  check(JSON.stringify(u.p1) === JSON.stringify(['overdue', 'report', 'idle', 'contact']), `all four look-after prompts when true (${u.p1})`);
  check(u.p2.length === 0, `no prompts for a looked-after client (${u.p2})`);
  check(JSON.stringify(u.newbie) === JSON.stringify(['idle']), `a brand-new client is not nagged for a report or contact (${u.newbie})`);
  check(u.paid === 1500 && u.unpaid === 2150 && u.overdue === 1, 'lifetime paid, unpaid and overdue by hand');
  check(u.lastContact === addD(T0, -3), 'last contact read from the dated contact log');
  check(u.roster.active === 2 && u.roster.mrr === 4000 && u.roster.avg === 2000, `roster numbers: 2 active, $4,000 MRR, $2,000 average (${JSON.stringify(u.roster)})`);
  check(u.sorted === 'dcbae', `My tasks order: overdue, then date, then priority, undated last (${u.sorted})`);

  /* ============================================== empty states */
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const e = await openApp(vp);
    await e.evaluate(async () => {
      const { state, notify } = await window.__mod('api.js');
      for (const t of ['clients', 'projects', 'tasks', 'roi_reports']) state[t].splice(0);
      notify();
    });
    for (const [r, sel] of [['clients', '.empty-title'], ['projects', '.empty-title'], ['projects/tasks', '.empty-title'], ['roi-reports', '.empty-title']]) {
      const before = e.errors.length;
      await nav(e, r, sel);
      const t = await text(e, '#view .empty-title');
      const ov = await e.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(Boolean(t) && e.errors.length === before && ov <= 0, `#${r} empty state at ${vp.width}px: "${t}"`);
      await shot(e, `empty-${r.replace('/', '-')}-${vp.width}`);
    }
    await e.context().close();
  }

  /* ============================================== clients: create */
  await nav(page, 'clients/new', '.modal input[name=name]');
  await page.fill('.modal input[name=name]', `${P} Harbour Plumbing`);
  await page.fill('.modal input[name=contact_name]', 'Dana Reed');
  await page.fill('.modal input[name=phone]', '0412 000 111');
  await page.fill('.modal input[name=email]', 'dana@example.com');
  await page.fill('.modal input[name=suburb]', 'Manly');
  await page.fill('.modal input[name=industry]', 'Plumbing');
  await page.fill('.modal input[name=monthly_value]', '1500');
  await page.fill('.modal input[name=started_on]', addD(T0, -60));
  await page.click('.modal-foot button[type=submit]');
  await page.waitForFunction(() => /^#clients\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  ids.client = await page.evaluate(() => location.hash.split('/')[1]);
  const crow = await waitDb(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('clients').select('*').eq('id', id).maybeSingle(); return data; }, ids.client, 'client row');
  check(crow.name === `${P} Harbour Plumbing` && Number(crow.monthly_value) === 1500 && crow.phone === '+61412000111' && crow.status === 'active' && crow.started_on === addD(T0, -60), `client created through the form (${crow.phone}, ${crow.monthly_value})`);
  await page.waitForSelector('.cl-h1');
  check((await text(page, '.cl-h1')) === `${P} Harbour Plumbing`, 'new client opens on its own page');

  // edit in place
  await page.fill('[data-fk="c-contact_name"]', 'Dana Reid');
  await page.press('[data-fk="c-contact_name"]', 'Tab');
  await waitDb(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('clients').select('contact_name').eq('id', id).single(); return data.contact_name === 'Dana Reid'; }, ids.client, 'contact edit');
  check(true, 'details edit in place and save on change');
  const hasCall = await page.evaluate(() => !!document.querySelector('.cl-contact a[href="tel:+61412000111"]') && !!document.querySelector('.cl-contact a[href^="mailto:dana@example.com"]'));
  check(hasCall, 'call and email actions on the client page');

  // prompts before any work
  let promptIds = await page.$$eval('.cl-prompt', (ns) => ns.map((n) => n.dataset.prompt));
  check(['report', 'idle', 'contact'].every((x) => promptIds.includes(x)) && !promptIds.includes('overdue'), `prompts for a client with nothing logged (${promptIds})`);

  // seed invoices (income rows with our prefix) to check the money
  await db(page, async ({ id, P, T0 }) => {
    const { sb, loadAll } = await window.__mod('api.js');
    const add = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    for (const row of [
      { client_id: id, description: `${P} September retainer`, amount: 1500, status: 'paid', kind: 'retainer', invoice_no: 'ZZD-001', issued_on: add(T0, -50), due_on: add(T0, -36), paid_on: add(T0, -40) },
      { client_id: id, description: `${P} October retainer`, amount: 1650, status: 'invoiced', kind: 'retainer', invoice_no: 'ZZD-002', issued_on: add(T0, -24), due_on: add(T0, -10) },
      { client_id: id, description: `${P} Setup`, amount: 500, status: 'invoiced', kind: 'one_off', invoice_no: 'ZZD-003', issued_on: add(T0, -3), due_on: add(T0, 11) },
      { client_id: id, description: `${P} Draft`, amount: 999, status: 'draft', kind: 'one_off' }
    ]) {
      const { error } = await sb.from('income').insert(row);
      if (error) throw new Error(error.message);
    }
    await loadAll();
  }, { id: ids.client, P, T0 });
  await page.waitForSelector('.cl-prompt[data-prompt=overdue]', { timeout: 10000 });
  const money1 = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.cl-page .dl-kpis [data-k]')].map((n) => [n.dataset.k, n.textContent])));
  const overdueSub = await page.locator('.cl-page .dl-kpis .kpi', { hasText: 'Unpaid' }).locator('.kpi-sub').innerText();
  check(money1.retainer === '$1,500' && money1.paid === '$1,500' && money1.unpaid === '$2,150' && overdueSub === '$1,650 overdue', `client money summary (${JSON.stringify(money1)}, ${overdueSub})`);
  const overdueText = await text(page, '.cl-prompt[data-prompt=overdue]');
  check(overdueText.includes('ZZD-002') && overdueText.includes('$1,650') && overdueText.includes('10 days ago') && await page.locator('.cl-prompt[data-prompt=overdue] a').getAttribute('href') === `#income/${await db(page, async (P) => { const { state } = await window.__mod('api.js'); return state.income.find((i) => i.invoice_no === 'ZZD-002' && i.description.startsWith(P)).id; }, P)}`,
    `overdue prompt names the invoice and links to it (${overdueText.replace(/\n/g, ' ')})`);

  // log contact from the prompt
  await page.click('.cl-prompt[data-prompt=contact] button');
  await page.waitForSelector('.modal input[name=text]');
  await page.fill('.modal input[name=text]', 'Went through the October numbers');
  await page.click('.modal-foot button[type=submit]');
  const notes = await waitDb(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('clients').select('notes').eq('id', id).single(); return data.notes; }, ids.client, 'contact log');
  check(notes.startsWith(`${T0} · Call: Went through the October numbers`), `contact logged to the top of the notes (${notes})`);
  await page.waitForFunction(() => !document.querySelector('.cl-prompt[data-prompt=contact]'), null, { timeout: 8000 });
  check(true, 'contact prompt clears once contact is logged');

  // roster numbers
  await nav(page, 'clients', `tr[data-id="${ids.client}"]`);
  const row = await page.evaluate((id) => Object.fromEntries([...document.querySelectorAll(`tr[data-id="${id}"] [data-k]`)].map((n) => [n.dataset.k, n.textContent])), ids.client);
  check(row.mrr === '$1,500' && row.paid === '$1,500' && row.unpaid === '$2,150' && row.report === 'None yet', `roster row (${JSON.stringify(row)})`);
  const head = await page.evaluate(async () => {
    const { state } = await window.__mod('api.js');
    const act = state.clients.filter((c) => !c.archived && c.status === 'active');
    const mrr = act.reduce((s, c) => s + Number(c.monthly_value || 0), 0);
    const fmt = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Math.round(n));
    const shown = Object.fromEntries([...document.querySelectorAll('.dl-kpis [data-k]')].map((n) => [n.dataset.k, n.textContent]));
    return { shown, want: { active: String(act.length), mrr: fmt(mrr), avg: fmt(act.length ? mrr / act.length : 0) } };
  });
  check(head.shown.active === head.want.active && head.shown.mrr === head.want.mrr && head.shown.avg === head.want.avg, `roster header matches an independent sum (${JSON.stringify(head.shown)})`);
  await page.fill('.dl-bar input[type=search]', 'harbour plumb');
  await page.waitForTimeout(200);
  check(await page.locator(`tr[data-id="${ids.client}"]`).count() === 1, 'roster search finds the client');
  await page.click('.dl-chips button:has-text("Past")');
  check(await page.locator(`tr[data-id="${ids.client}"]`).count() === 0, 'status filter hides an active client under Past');
  await page.click('.dl-chips button:has-text("All")');
  await page.fill('.dl-bar input[type=search]', '');

  /* ============================================== projects */
  await nav(page, `projects/new/${ids.client}`, '.modal input[name=name]');
  check(await page.inputValue('.modal select[name=client_id]') === ids.client, 'new project from a client starts with that client');
  await page.fill('.modal input[name=name]', `${P} Missed-call text-back`);
  await page.fill('.modal input[name=due_on]', addD(T0, -2));
  await page.fill('.modal input[name=value]', '2400');
  await page.click('.modal-foot button[type=submit]');
  await page.waitForFunction(() => /^#projects\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  ids.project = await page.evaluate(() => location.hash.split('/')[1]);
  await page.waitForSelector('.dl-qa input[name=new-task]');
  for (const t of ['Set up the number', 'Write the replies', 'Test with Dana']) {
    await page.fill('.dl-qa input[name=new-task]', `${P} ${t}`);
    await page.press('.dl-qa input[name=new-task]', 'Enter');
    await page.waitForFunction((t) => [...document.querySelectorAll('.dl-task-title')].some((n) => n.textContent === t), `${P} ${t}`, { timeout: 10000 });
  }
  const tcount = await waitDb(page, async (pid) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('id,client_id').eq('project_id', pid); return data.length === 3 && data.every((x) => x.client_id) ? data : null; }, ids.project, 'three tasks');
  check(tcount.length === 3 && tcount.every((x) => x.client_id === ids.client), 'quick add (type and Enter) creates tasks carrying the client');
  check((await text(page, '.dl-headsub .dl-progress-n')) === '0/3', 'progress starts at 0/3');
  check(await page.locator('.dl-headsub .dl-warn').count() === 1, 'an overdue project due date is amber');

  const taskLoc = (t) => page.locator('li.dl-task', { has: page.locator('.dl-task-title', { hasText: t }) });
  await taskLoc(`${P} Set up the number`).locator('input[type=checkbox]').check();
  const doneRow = await waitDb(page, async (P) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('state,done_at').eq('title', `${P} Set up the number`).single(); return data.state === 'done' && data.done_at ? data : null; }, P, 'task done');
  check(Boolean(doneRow.done_at), 'checking a task off sets done_at');
  await page.waitForFunction(() => document.querySelector('.dl-headsub .dl-progress-n')?.textContent === '1/3', null, { timeout: 8000 });
  check(true, 'progress moves to 1/3');

  await taskLoc(`${P} Write the replies`).locator('.dl-next').click();
  await waitDb(page, async (P) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('state').eq('title', `${P} Write the replies`).single(); return data.state === 'doing'; }, P, 'task started');
  check(true, 'one click moves a task from To do to In progress');
  await page.waitForSelector(`.dl-tgroup[data-state=doing] .dl-task-title:text("${P} Write the replies")`);

  await taskLoc(`${P} Test with Dana`).locator('.dl-task-title').click();
  await page.fill('.dl-task-edit', `${P} Test with Dana on site`);
  await page.press('.dl-task-edit', 'Enter');
  await waitDb(page, async (P) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('id').eq('title', `${P} Test with Dana on site`); return data.length === 1; }, P, 'inline title edit');
  check(true, 'inline edit of a task title');
  await taskLoc(`${P} Test with Dana on site`).locator('select[name=priority]').selectOption('high');
  await taskLoc(`${P} Test with Dana on site`).locator('input[type=date]').fill(addD(T0, 1));
  await waitDb(page, async ({ P, d }) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('priority,due_on').eq('title', `${P} Test with Dana on site`).single(); return data.priority === 'high' && data.due_on === d; }, { P, d: addD(T0, 1) }, 'priority and due date');
  check(true, 'priority and due date save from the row');

  // reorder within To do
  await page.fill('.dl-qa input[name=new-task]', `${P} Hand over`);
  await page.press('.dl-qa input[name=new-task]', 'Enter');
  await page.waitForFunction((t) => [...document.querySelectorAll('.dl-tgroup[data-state=todo] .dl-task-title')].map((n) => n.textContent).join('|') === t, `${P} Test with Dana on site|${P} Hand over`, { timeout: 10000 });
  await taskLoc(`${P} Hand over`).locator('button[aria-label^="Move up"]').click();
  await page.waitForFunction((t) => [...document.querySelectorAll('.dl-tgroup[data-state=todo] .dl-task-title')].map((n) => n.textContent).join('|') === t, `${P} Hand over|${P} Test with Dana on site`, { timeout: 10000 });
  const order = await db(page, async (pid) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('title,sort').eq('project_id', pid).eq('state', 'todo').order('sort'); return data.map((x) => x.title); }, ids.project);
  check(order[0] === `${P} Hand over`, `reorder within a group is saved (${order})`);
  await shot(page, 'project-1440');

  // delete a task through the UI
  await taskLoc(`${P} Hand over`).locator('.dl-del').click();
  await page.click('.modal-foot button[type=submit]');
  await waitDb(page, async (P) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('id').eq('title', `${P} Hand over`); return data.length === 0; }, P, 'task delete');
  check(true, 'delete a task (with confirm)');

  // My tasks
  await nav(page, 'projects/tasks', '.dl-qa');
  await page.selectOption('.dl-qa select', ids.client);
  await page.fill('.dl-qa input[type=date]', T0);
  await page.fill('.dl-qa input[name=new-task]', `${P} Send Dana the October invoice`);
  await page.press('.dl-qa input[name=new-task]', 'Enter');
  await page.waitForFunction((t) => [...document.querySelectorAll('.dl-tgroup[data-bucket=Today] .dl-task-title')].some((n) => n.textContent === t), `${P} Send Dana the October invoice`, { timeout: 10000 });
  const loose = await db(page, async (P) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('tasks').select('project_id,client_id,due_on').eq('title', `${P} Send Dana the October invoice`).single(); return data; }, P);
  check(loose.project_id === null && loose.client_id === ids.client && loose.due_on === T0, 'a loose task (no project, with a client) from My tasks');
  await page.selectOption('.dl-bar select', ids.client);
  await page.waitForTimeout(250);
  const mine = await page.$$eval('.dl-tasks-wrap .dl-task-title', (ns) => ns.map((n) => n.textContent));
  check(JSON.stringify(mine) === JSON.stringify([`${P} Send Dana the October invoice`, `${P} Test with Dana on site`, `${P} Write the replies`]), `My tasks filtered by client, sorted by due date then priority (${mine})`);
  check(await page.locator('.dl-task-ctx a[href^="#projects/"]').count() >= 1, 'My tasks links each task to its project');
  await shot(page, 'mytasks-1440');

  // overview
  await nav(page, 'projects', `.dl-pline[data-id="${ids.project}"]`);
  const pl = await page.locator(`.dl-pline[data-id="${ids.project}"]`).innerText();
  check(pl.includes('1/3') && pl.includes('$2,400') && pl.includes('Overdue') && await page.locator(`.dl-group[data-status=active] .dl-pline[data-id="${ids.project}"]`).count() === 1, `overview row under Active (${pl.replace(/\n/g, ' ')})`);
  await shot(page, 'projects-1440');

  // client page: something is in progress now
  await nav(page, `clients/${ids.client}`, '.cl-h1');
  promptIds = await page.$$eval('.cl-prompt', (ns) => ns.map((n) => n.dataset.prompt));
  check(!promptIds.includes('idle') && promptIds.includes('report') && promptIds.includes('overdue'), `prompts after starting work (${promptIds})`);

  // marking done offers the ROI report
  await nav(page, `projects/${ids.project}`, '.dl-qa');
  await page.click('.page-head button:has-text("Mark done")');
  await page.waitForSelector('.modal .h2:text("Project done")');
  check((await text(page, '.modal')).includes('2 tasks still open'), 'done dialog mentions open tasks');
  await page.click('.modal-foot button:has-text("Write the ROI report")');
  await page.waitForFunction((cid) => location.hash === `#roi-reports/new/${cid}`, ids.client, { timeout: 10000 });
  check(await db(page, async (pid) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('projects').select('status').eq('id', pid).single(); return data.status; }, ids.project) === 'done', 'Mark done saves the project and offers "Write the ROI report"');

  /* ============================================== ROI report editor */
  await page.waitForSelector('.rr-editor');
  check(await page.inputValue('input[name=fee]') === '1500', 'fee defaults to the client retainer');
  check(await page.inputValue('input[name=period_start]') === '2026-10-01' || T0 < '2026-11-01', 'period defaults to last calendar month');
  await page.fill('input[name=period_start]', '2026-10-01');
  await page.fill('input[name=period_end]', '2026-10-31');
  await page.fill('input[name=m-label-0]', 'Missed calls a week');
  await page.fill('input[name=m-before-0]', '12');
  await page.fill('input[name=m-after-0]', '3');
  await page.fill('input[name=m-vpu-0]', '150');
  await page.selectOption('select[name=m-better-0]', 'lower');
  await page.selectOption('select[name=m-per-0]', 'week');
  await page.click('button:has-text("Add a result")');
  await page.fill('input[name=m-label-1]', 'Jobs booked');
  await page.fill('input[name=m-before-1]', '5');
  await page.fill('input[name=m-after-1]', '9');
  await page.fill('input[name=m-unit-1]', 'jobs');
  await page.fill('input[name=m-vpu-1]', '400');
  await page.fill('input[name=hours_saved]', '20');
  await page.fill('input[name=hourly_value]', '60');
  await page.fill('input[name=revenue_gained]', '2000');
  await page.fill('input[name=cost_saved]', '300');
  await page.fill('textarea[name=next_steps]', 'Add after-hours booking\nTurn on review requests');
  await page.waitForFunction(() => /^#roi-reports\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  ids.report = await page.evaluate(() => location.hash.split('/')[1]);
  await page.waitForFunction(() => document.querySelector('.rr-save')?.textContent === 'Saved', null, { timeout: 15000 });
  const rr = await waitDb(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('*').eq('id', id).single(); return data.cost_saved == 300 && data.next_steps ? data : null; }, ids.report, 'report autosave');
  check(rr.client_id === ids.client && rr.title.includes(P) && rr.period_start === '2026-10-01' && rr.period_end === '2026-10-31' && Number(rr.fee) === 1500
    && Number(rr.hours_saved) === 20 && Number(rr.hourly_value) === 60 && Number(rr.revenue_gained) === 2000 && rr.status === 'draft'
    && rr.metrics.length === 2 && rr.metrics[0].before === 12 && rr.metrics[0].after === 3 && rr.metrics[0].better === 'lower' && rr.metrics[0].per === 'week' && rr.metrics[1].unit === 'jobs',
  `autosaved draft has every field (${rr.title})`);
  const verdict = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.rr-sum [data-k]')].map((n) => [n.dataset.k, n.textContent])));
  check(verdict.metrics === '$7,579' && verdict.hours === '$1,200' && verdict.extra === '$2,300' && verdict.total === '$11,079' && verdict.fee === '$1,500' && verdict.net === '$9,579' && verdict.multiple === '$7.38 back for every $1',
    `editor totals match the hand-worked figures (${JSON.stringify(verdict)})`);
  const calc0 = await text(page, '.rr-m[data-i="0"] .rr-m-calc');
  check(calc0.includes('9 fewer') && calc0.includes('$5,979') && calc0.includes('75%'), `row shows the change and its value (${calc0})`);
  const doc = await page.evaluate(() => ({
    kpis: [...document.querySelectorAll('.rr-doc-kpi')].map((k) => `${k.querySelector('.rr-doc-k').textContent}=${k.querySelector('.rr-doc-v').textContent}`),
    name: document.querySelector('.rr-doc-h1').textContent,
    rows: document.querySelectorAll('.rr-doc-table tbody tr').length,
    net: document.querySelector('.rr-doc-sum .is-net dd')?.textContent,
    next: [...document.querySelectorAll('.rr-doc-list li')].map((l) => l.textContent),
    logo: document.querySelector('.rr-doc-logo')?.getAttribute('src')
  }));
  check(doc.name === `${P} Harbour Plumbing` && doc.kpis[0] === 'Value delivered=$11,079' && doc.kpis[1] === 'Return=7.3×' && doc.kpis[2] === 'Net gain=$9,579' && doc.kpis[3] === 'Hours saved=20'
    && doc.rows === 2 && doc.net === '$9,579' && doc.next.length === 2 && doc.logo === '../logo.svg', `document preview (${JSON.stringify(doc)})`);
  await page.waitForFunction(() => document.querySelector('.rr-doc-logo')?.naturalWidth > 0, null, { timeout: 8000 });
  check(true, 'wordmark loads in the document');

  // typed text survives a live update from elsewhere
  const other = await openApp();
  const SUMMARY = 'Dana now catches nine more calls a week. The phone gets answered even when the team is on the tools, and four extra jobs came from it.';
  await page.click('textarea[name=summary]');
  await page.keyboard.type(SUMMARY.slice(0, 50), { delay: 3 });
  await other.evaluate(async ({ id }) => {
    const { sb } = await window.__mod('api.js');
    await sb.from('clients').update({ industry: 'Plumbing and gas' }).eq('id', id);
  }, { id: ids.client });
  await page.waitForFunction(async (id) => (await window.__mod('api.js')).state.clients.find((c) => c.id === id)?.industry === 'Plumbing and gas', ids.client, { timeout: 15000 });
  await page.keyboard.type(SUMMARY.slice(50), { delay: 3 });
  const kept = await page.evaluate(() => ({ v: document.querySelector('textarea[name=summary]').value, f: document.activeElement?.name }));
  check(kept.v === SUMMARY && kept.f === 'summary', 'typing in the report survives a live update from another device');
  await other.context().close();
  await waitDb(page, async ({ id, s }) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('summary').eq('id', id).single(); return data.summary === s; }, { id: ids.report, s: SUMMARY }, 'summary autosave');
  check(true, 'summary autosaved');

  // honest below-1 warning
  await page.fill('input[name=fee]', '50000');
  await page.waitForSelector('.rr-warn');
  const low = await page.evaluate(() => ({ warn: document.querySelector('.rr-warn').textContent, boast: document.querySelector('.rr-doc').textContent.includes('back for every'), ret: [...document.querySelectorAll('.rr-doc-k')].some((k) => k.textContent === 'Return') }));
  check(low.warn.includes('Below the fee') && low.warn.includes('$0.22') && !low.boast && !low.ret, `return below 1 warns Tyler and the document makes no claim (${low.warn.slice(0, 80)})`);
  await shot(page, 'roi-below-1440');
  await page.fill('input[name=fee]', '1500');
  await page.waitForFunction(() => !document.querySelector('.rr-warn'));
  await page.waitForFunction(() => document.querySelector('.rr-save')?.textContent === 'Saved', null, { timeout: 15000 });

  // copy as text
  await page.click('button:has-text("Copy as text")');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('Value delivered: $11,079') && clip.includes('That is $7.38 back for every $1.') && clip.includes('- Missed calls a week: 12 → 3 (9 fewer), worth about $5,979')
    && clip.includes('- Jobs booked: 5 jobs → 9 jobs (up 4 jobs), worth about $1,600') && clip.includes('Hi Dana,') && clip.includes('tyler@wise-ai.au'), 'copy as text gives a plain email body');
  await shot(page, 'roi-editor-1440');

  // print: only the document, one A4 page
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({
    editor: getComputedStyle(document.querySelector('.rr-editor')).display,
    rail: getComputedStyle(document.querySelector('.rail')).display,
    head: getComputedStyle(document.querySelector('.rr-head')).display,
    doc: document.querySelector('.rr-doc').getBoundingClientRect().width
  }));
  check(pr.editor === 'none' && pr.rail === 'none' && pr.head === 'none' && Math.round(pr.doc) === 794, `print media shows only the document at A4 width (${JSON.stringify(pr)})`);
  await shot(page, 'roi-print-media', false);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(pageCount === 1, `report prints to one PDF page (${pageCount})`);
  if (SHOTS) writeFileSync(`${SHOTS}/deliver-roi-report.pdf`, pdf);
  await page.emulateMedia({ media: 'screen' });

  // mark as sent
  await page.click('button[data-act=sent]');
  await waitDb(page, async ({ id, t }) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('status,sent_on').eq('id', id).single(); return data.status === 'sent' && data.sent_on === t; }, { id: ids.report, t: T0 }, 'mark sent');
  check(true, 'mark as sent sets status and sent_on to today');

  // duplicate for next period
  await page.click('button[data-act=duplicate]');
  await page.waitForFunction((id) => /^#roi-reports\/[0-9a-f-]{36}$/.test(location.hash) && !location.hash.endsWith(id), ids.report, { timeout: 15000 });
  ids.report2 = await page.evaluate(() => location.hash.split('/')[1]);
  const d2 = await db(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('*').eq('id', id).single(); return data; }, ids.report2);
  check(d2.period_start === '2026-11-01' && d2.period_end === '2026-11-30' && d2.metrics[0].before === 3 && d2.metrics[0].after === null && d2.metrics[1].before === 9
    && d2.status === 'draft' && d2.title.includes('November 2026') && Number(d2.fee) === 1500, `duplicate for next period (${d2.title}, before ${d2.metrics.map((m) => m.before)})`);
  await page.waitForSelector('input[name=m-before-0]');
  check(await page.inputValue('input[name=m-before-0]') === '3' && await page.inputValue('input[name=m-after-0]') === '', 'duplicate opens with last month’s after as before');
  // delete it through the UI
  await page.click('.rr-actions button[aria-label="Delete this report"]');
  await page.click('.modal-foot button[type=submit]');
  await page.waitForFunction(() => location.hash === '#roi-reports', null, { timeout: 10000 });
  await waitDb(page, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('id').eq('id', id); return data.length === 0; }, ids.report2, 'report delete');
  check(true, 'delete a report (with confirm)');

  // list
  await page.waitForSelector(`tr[data-id="${ids.report}"]`);
  const lrow = await page.locator(`tr[data-id="${ids.report}"]`).innerText();
  check(lrow.includes('October 2026') && lrow.includes('$11,079') && lrow.includes('7.3×') && lrow.includes('Sent'), `report list row (${lrow.replace(/\s+/g, ' ')})`);
  await shot(page, 'roi-list-1440');

  // client page after a report: story and prompts
  await nav(page, `clients/${ids.client}`, '.cl-story');
  promptIds = await page.$$eval('.cl-prompt', (ns) => ns.map((n) => n.dataset.prompt));
  check(!promptIds.includes('report') && promptIds.includes('overdue'), `report prompt clears once a report is sent (${promptIds})`);
  const story = await page.$$eval('.cl-story li', (ns) => ns.map((n) => n.textContent));
  const want = ['Became a client', 'Paid $1,500', 'Invoiced $1,650', 'Project started', 'ROI report sent: October 2026', 'Call: Went through'];
  check(want.every((w) => story.some((s) => s.includes(w))) && !story.some((s) => s.includes('$999')), `story so far has invoices, payment, project, report, contact; not drafts (${story.length} events)`);
  const dates = await page.$$eval('.cl-story .cl-story-date', (ns) => ns.map((n) => n.textContent));
  check(dates.length > 3, 'story is dated');
  check(await page.locator('.dl-rlist a[href="#roi-reports/' + ids.report + '"]').count() === 1, 'client page lists the ROI report');
  check(await page.locator(`.dl-plist a[href="#projects/${ids.project}"]`).count() === 1, 'client page lists the project');
  await shot(page, 'client-1440');

  /* ============================================== deep links, 390px, shots */
  const routes = [
    ['clients', `tr[data-id="${ids.client}"]`], [`clients/${ids.client}`, '.cl-story'], ['projects', '.dl-groups'], [`projects/${ids.project}`, '.dl-task'],
    ['projects/tasks', '.dl-task'], ['roi-reports', '.rr-table'], [`roi-reports/${ids.report}`, '.rr-doc'], [`roi-reports/new/${ids.client}`, '.rr-doc']
  ];
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const pg = await openApp(vp);
    for (const [r, sel] of routes) {
      await nav(pg, r, sel);
      const ov = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(ov <= 0, `#${r} at ${vp.width}px has no horizontal scroll (${ov})`);
      await shot(pg, `${r.replace(/[0-9a-f-]{36}/, 'id').replace(/\//g, '-')}-${vp.width}`);
    }
    check(pg.errors.length === 0, `no console errors at ${vp.width}px (${pg.errors.join(' | ')})`);
    await pg.context().close();
  }
  for (const [r, sel] of [[`clients/${ids.client}`, '.cl-h1'], [`projects/${ids.project}`, '.dl-task'], [`roi-reports/${ids.report}`, '.rr-doc'], ['projects/tasks', '.dl-tasks-wrap']]) {
    const dl = await openApp({ width: 1280, height: 800 }, `#${r}`);
    await dl.waitForSelector(sel, { timeout: 15000 });
    check(await dl.evaluate((r) => location.hash === `#${r}`, r), `deep link #${r.replace(/[0-9a-f-]{36}/, '<id>')} opens directly`);
    await dl.context().close();
  }


  /* ============================================== AI draft (mocked: never calls the real AI) */
  const mock = { status: { configured: true, enabled: true, spent_usd: 0.42, cap_usd: 20 }, mode: 'ok', bodies: [] };
  const DRAFT1 = { summary: 'Dana’s phones are answered now. Nine more calls a week get caught, and [check: number of new reviews] reviews came in.', next_steps: ['Add after-hours booking', 'Ask happy customers for reviews'] };
  const DRAFT2 = { summary: 'October was a strong month. Missed calls fell from 12 to 3 a week.', next_steps: 'Add after-hours booking\nTurn on review requests' };
  const routeAi = async (ctx, m) => {
    await ctx.route('**/functions/v1/ai-assist', async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = route.request().postDataJSON() || {};
      const json = (status, obj) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
      if (body.action === 'status') return json(200, m.status);
      m.bodies.push(body);
      if (m.mode === 'cap') return json(402, { ok: false, error: 'cap_reached' });
      await new Promise((r) => setTimeout(r, 600));
      return json(200, { ok: true, result: m.mode === 'ok' ? DRAFT1 : DRAFT2, cost_usd: 0.004, spent_usd: 0.43 });
    });
  };
  const ap = await openApp({ width: 1440, height: 900 }, '', (ctx) => routeAi(ctx, mock));
  await nav(ap, `roi-reports/new/${ids.client}`, '.rr-editor');
  await ap.waitForSelector('button[data-act=ai]', { timeout: 10000 });
  check(true, 'AI button shows when AI is configured and enabled');
  await ap.fill('input[name=m-label-0]', 'Missed calls a week');
  await ap.fill('input[name=m-before-0]', '12');
  await ap.fill('input[name=m-after-0]', '3');
  await ap.fill('input[name=hours_saved]', '20');
  await ap.fill('input[name=hourly_value]', '60');
  await ap.waitForFunction(() => /^#roi-reports\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  ids.report3 = await ap.evaluate(() => location.hash.split('/')[1]);
  // error: budget used up
  mock.mode = 'cap';
  await ap.click('button[data-act=ai]');
  await ap.waitForSelector('.toast.is-bad:has-text("AI budget is used up")', { timeout: 10000 });
  check(await ap.inputValue('textarea[name=summary]') === '', 'cap_reached shows the ready-made message and leaves the fields alone');
  // success into empty fields: no confirm, busy while it works
  mock.mode = 'ok';
  await ap.fill('input[name=ai_notes]', 'Dana loves the after-hours texts');
  await ap.click('button[data-act=ai]');
  await ap.waitForSelector('button[data-act=ai].is-busy', { timeout: 3000 });
  check(true, 'AI button shows a busy state while drafting');
  await ap.waitForFunction((s) => document.querySelector('textarea[name=summary]').value === s, DRAFT1.summary, { timeout: 15000 });
  check(await ap.inputValue('textarea[name=next_steps]') === 'Add after-hours booking\nAsk happy customers for reviews', 'draft fills summary and next steps (list joined one per line)');
  const sent1 = mock.bodies.at(-1);
  check(sent1.task === 'roi_summary' && sent1.context.client === `${P} Harbour Plumbing` && sent1.context.period === 'October 2026' && sent1.context.notes === 'Dana loves the after-hours texts'
    && sent1.context.numbers.hours_saved === 20 && sent1.context.numbers.total_value === 1200 && sent1.context.numbers.fee === 1500 && sent1.context.numbers.return_multiple === 0.8
    && sent1.context.metrics[0].label === 'Missed calls a week' && sent1.context.metrics[0].before === 12, `AI request carries client, period, numbers, metrics, notes (${JSON.stringify(sent1.context.numbers)})`);
  await waitDb(ap, async ({ id, s }) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('summary').eq('id', id).single(); return data.summary === s; }, { id: ids.report3, s: DRAFT1.summary }, 'AI draft autosave');
  check(true, 'autosave picks up the AI draft');
  // [check: blocks sending
  await ap.click('button[data-act=sent]');
  await ap.waitForSelector('.toast.is-warn:has-text("number of new reviews")', { timeout: 8000 });
  await ap.waitForTimeout(800);
  check(await db(ap, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('status').eq('id', id).single(); return data.status; }, ids.report3) === 'draft', 'Mark as sent is blocked while a [check: marker remains, and says what to fill in');
  await shot(ap, 'roi-ai-1440');
  // replace confirmation: cancel keeps text, replace swaps it
  mock.mode = 'ok2';
  await ap.click('button[data-act=ai]');
  await ap.waitForSelector('.modal .h2:text("Replace what is there?")');
  await ap.click('.modal-foot button:has-text("Cancel")');
  await ap.waitForTimeout(400);
  check(await ap.inputValue('textarea[name=summary]') === DRAFT1.summary && mock.bodies.length === 2, 'cancelling the replace confirmation keeps typed text and makes no call');
  await ap.click('button[data-act=ai]');
  await ap.waitForSelector('.modal .h2:text("Replace what is there?")');
  await ap.click('.modal-foot button[type=submit]');
  await ap.waitForFunction((s) => document.querySelector('textarea[name=summary]').value === s, DRAFT2.summary, { timeout: 15000 });
  check(true, 'confirming replaces the words with the new draft');
  await ap.waitForFunction(() => document.querySelector('.rr-save')?.textContent === 'Saved', null, { timeout: 15000 });
  await ap.click('button[data-act=sent]');
  await waitDb(ap, async (id) => { const { sb } = await window.__mod('api.js'); const { data } = await sb.from('roi_reports').select('status').eq('id', id).single(); return data.status === 'sent'; }, ids.report3, 'send after markers cleared');
  check(true, 'Mark as sent works once no [check: marker remains');
  check(ap.errors.length === 0, `no console errors with AI mocked (${ap.errors.join(' | ')})`);
  await ap.context().close();
  // hidden when not configured, or switched off
  for (const st of [{ configured: false, enabled: false, spent_usd: 0, cap_usd: 20 }, { configured: true, enabled: false, spent_usd: 0, cap_usd: 20 }]) {
    const off = { status: st, mode: 'ok', bodies: [] };
    const hp = await openApp({ width: 1440, height: 900 }, '', (ctx) => routeAi(ctx, off));
    await nav(hp, `roi-reports/${ids.report3}`, '.rr-editor');
    await hp.waitForTimeout(500);
    check(await hp.locator('button[data-act=ai]').count() === 0 && await hp.locator('input[name=ai_notes]').count() === 0, `AI control renders nothing when ${st.configured ? 'switched off' : 'not configured'}`);
    await hp.context().close();
  }

  /* ============================================== delete the client */
  await nav(page, `clients/${ids.client}`, '.cl-h1');
  await page.click(`.page-head button[aria-label^="Delete"]`);
  const confirmText = await text(page, '.modal .confirm-text');
  check(confirmText.includes('2 ROI reports') && confirmText.includes('1 project') && confirmText.includes('3 invoices') === false && confirmText.includes('4 invoices'), `delete says what goes with it (${confirmText})`);
  await page.click('.modal-foot button[type=submit]');
  await page.waitForFunction(() => location.hash === '#clients', null, { timeout: 10000 });
  const gone = await waitDb(page, async ({ c, r }) => {
    const { sb } = await window.__mod('api.js');
    const a = await sb.from('clients').select('id').eq('id', c);
    const b = await sb.from('roi_reports').select('id').eq('id', r);
    return a.data.length === 0 && b.data.length === 0 ? true : null;
  }, { c: ids.client, r: ids.report }, 'client delete');
  check(gone, 'client deleted through the UI, and their ROI report with them');
  check(page.errors.length === 0, `no console errors in the main run (${page.errors.join(' | ')})`);
} catch (err) {
  fails.push(`exception: ${err.stack || err.message}`);
  try { await shot(page, 'failure', false); } catch { /* */ }
} finally {
  try {
    const left = await page.evaluate(async (P) => {
      const { sb } = await window.__mod('api.js');
      await sb.from('roi_reports').delete().ilike('title', `%${P}%`);
      await sb.from('tasks').delete().like('title', `${P}%`);
      await sb.from('projects').delete().like('name', `${P}%`);
      await sb.from('income').delete().like('description', `${P}%`);
      await sb.from('clients').delete().like('name', `${P}%`);
      const counts = {};
      for (const [t, col, pat] of [['roi_reports', 'title', `%${P}%`], ['tasks', 'title', `${P}%`], ['projects', 'name', `${P}%`], ['income', 'description', `${P}%`], ['clients', 'name', `${P}%`]]) {
        const { count } = await sb.from(t).select('id', { count: 'exact', head: true }).ilike(col, pat);
        counts[t] = count;
      }
      return counts;
    }, P);
    check(Object.values(left).every((n) => n === 0), `cleanup left no ${P} rows (${JSON.stringify(left)})`);
  } catch (e) { fails.push(`cleanup failed: ${e.message}`); }
  await browser.close();
}

for (const p of passes) console.log(`  ok  ${p}`);
for (const f of fails) console.log(`FAIL  ${f}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
