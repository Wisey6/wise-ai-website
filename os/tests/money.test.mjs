// Wise AI OS: Money area (Income, Costs, Runway), end to end against the live Supabase
// project, plus the money maths checked against hand-worked numbers.
//
//   python3 -m http.server 8183 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/money.test.mjs [shots-dir]
//
// Every row it creates starts with "ZZMONEY" (or belongs to a ZZMONEY client) and is
// deleted at the end. The settings money columns are restored to their exact values.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8183/os/';
const PASSWORD = process.env.OS_TEST_PASSWORD;
const SHOTS = process.argv[2] || null;
const TAG = 'ZZMONEY';
const SETTINGS_COLS = ['cash_on_hand', 'cash_as_of', 'tax_rate', 'gst_registered', 'monthly_target', 'owner_draw'];
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); if (!cond) console.log('FAIL', msg); };
const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

const browser = await chromium.launch();

async function openApp(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/functions\/v1\/|net::ERR_FAILED/.test(t)) return; // edge functions, not this area
    page.errors.push(t);
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
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
  const mod = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
  // eslint-disable-next-line no-new-func
  return new Function('api', 'arg', `return (${src})(api, arg);`)(mod, a);
}, [fn.toString(), arg]);
const nav = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page', { timeout: 15000 });
  await page.waitForTimeout(400);
};
const submitModal = async (page) => { await page.click('.modal-foot button[type=submit]'); await page.waitForSelector('.modal-backdrop', { state: 'detached' }); await page.waitForTimeout(400); };
const db = (page, table, filter) => api(page, async ({ sb }, [t, f]) => {
  let q = sb.from(t).select('*');
  for (const [k, v] of Object.entries(f)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}, [table, filter]);

const page = await openApp();
let original = null;
let zzClient = null;

try {
  original = await api(page, async ({ sb }, cols) => {
    const { data, error } = await sb.from('settings').select(cols.join(',')).eq('id', 1).single();
    if (error) throw new Error(error.message);
    return data;
  }, SETTINGS_COLS);

  /* ------------------------------------------------- money maths, by hand */
  const u = await page.evaluate(async () => {
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    const today = '2026-11-17';
    const reg = { gst_registered: true, tax_rate: 0.25 };
    const unreg = { gst_registered: false, tax_rate: 0.25 };
    const income = [
      { id: 'a', status: 'paid', amount: 1100, gst: 100, paid_on: '2026-11-05', issued_on: '2026-11-01' },
      { id: 'b', status: 'paid', amount: 2200, gst: 200, paid_on: '2026-10-15', issued_on: '2026-10-01' },
      { id: 'c', status: 'paid', amount: 550, gst: 50, paid_on: '2026-09-30', issued_on: '2026-09-01' },
      { id: 'd', status: 'paid', amount: 3300, gst: 300, paid_on: '2026-08-01', issued_on: '2026-07-20' },
      { id: 'e', status: 'invoiced', amount: 440, gst: 40, issued_on: '2026-10-01', due_on: '2026-10-15' },
      { id: 'f', status: 'invoiced', amount: 880, gst: 80, issued_on: '2026-11-10', due_on: '2026-11-24' },
      { id: 'g', status: 'draft', amount: 1000, gst: 0, issued_on: '2026-11-10' },
      { id: 'h', status: 'void', amount: 5000, gst: 0, issued_on: '2026-11-02', paid_on: '2026-11-03' },
      { id: 'i', status: 'paid', amount: 1100, gst: 100, paid_on: '2026-06-30', issued_on: '2026-06-01' }
    ];
    const costs = [
      { id: 'c1', cadence: 'monthly', amount: 100, started_on: '2026-01-01', active: true, client_id: 'k1' },
      { id: 'c2', cadence: 'yearly', amount: 1200, started_on: '2026-03-01', active: true },
      { id: 'c3', cadence: 'monthly', amount: 50, started_on: '2026-01-01', active: false, ended_on: '2026-10-31' },
      { id: 'c4', cadence: 'monthly', amount: 30, started_on: '2026-12-01', active: true },
      { id: 'c5', cadence: 'one_off', amount: 400, incurred_on: '2026-11-03', active: true },
      { id: 'c6', cadence: 'one_off', amount: 250, incurred_on: '2026-10-20', active: true },
      { id: 'c7', cadence: 'monthly', amount: 20, started_on: '2026-01-01', ended_on: '2026-11-30', active: true },
      { id: 'c8', cadence: 'monthly', amount: 999, active: false }
    ];
    const clients = [
      { id: 'k1', name: 'K1', status: 'active', monthly_value: 2000 },
      { id: 'k2', name: 'K2', status: 'active', monthly_value: 500, archived: true },
      { id: 'k3', name: 'K3', status: 'paused', monthly_value: 900 }
    ];
    const fy = m.fyRange(today);
    const recv = m.receivables(income, today);
    const recvNov = m.receivables(income, today, m.monthRange(today));
    const proj = m.projection({ cash: 1000, clients, income: [...income, { id: 'r', status: 'invoiced', kind: 'retainer', client_id: 'k1', amount: 2200, gst: 200, due_on: '2027-01-10' }], costs, settings: reg, draw: 4300, today, months: 6 });
    const retClients = [
      { id: 'k1', name: 'Zed', status: 'active', monthly_value: 2000 },
      { id: 'k4', name: 'Bee', status: 'active', monthly_value: 300 },
      { id: 'k5', name: 'Ann', status: 'active', monthly_value: 400 },
      { id: 'k6', name: 'Nil', status: 'active', monthly_value: 0 },
      { id: 'k7', name: 'Old', status: 'past', monthly_value: 800 }
    ];
    const retIncome = [
      { client_id: 'k4', kind: 'retainer', status: 'draft', issued_on: '2026-11-02' },
      { client_id: 'k5', kind: 'retainer', status: 'void', issued_on: '2026-11-02' },
      { client_id: 'k1', kind: 'retainer', status: 'paid', issued_on: '2026-10-02' }
    ];
    return {
      fyNov: m.moneyIn(income, reg, fy.from, fy.to),
      nov: m.moneyIn(income, reg, '2026-11-01', '2026-11-30'),
      novUnreg: m.moneyIn(income, unreg, '2026-11-01', '2026-11-30'),
      recv: [recv.total, recv.count, recv.overdue, recv.overdueCount],
      recvNov: [recvNov.total, recvNov.overdue],
      avg: m.averageIn(income, reg, today, 3).average,
      burn: m.monthlyBurn(costs, today),
      octR: m.recurringForMonth(costs, '2026-10'), novR: m.recurringForMonth(costs, '2026-11'), decR: m.recurringForMonth(costs, '2026-12'),
      q: m.quarterToDate(income, costs, reg, today),
      ms: m.monthSoFar(income, costs, reg, today),
      top: m.biggestRecurring(costs, today, 3).map((c) => c.id),
      rwBurn: m.runway({ cash: 10000, avgIn: 1833.33, burn: 220, draw: 4300 }),
      rwOk: m.runway({ cash: 10000, avgIn: 5000, burn: 220, draw: 4300 }),
      rwEven: m.runway({ cash: 10000, avgIn: 4520, burn: 220, draw: 4300 }),
      proj: proj.rows.slice(0, 2).map((r) => [r.key, r.retainers, r.receivables, r.in, r.out, r.close]), zero: proj.zeroKey,
      due: m.dueRetainers(retClients, retIncome, today).map((c) => c.name),
      inv: m.retainerInvoice({ id: 'k1', name: 'K1', monthly_value: 2000 }, reg, today, 'INV-0007'),
      invUnreg: m.retainerInvoice({ id: 'k1', name: 'K1', monthly_value: 2000 }, unreg, today, 'INV-0007'),
      no: m.suggestInvoiceNo([{ invoice_no: 'INV-0009' }, { invoice_no: 'INV-12' }, { invoice_no: 'X' }]),
      nos: m.nextInvoiceNos([], 3),
      fy1: m.fyRange('2026-06-30'), fy2: m.fyRange('2026-07-01'),
      qr: m.quarterRange('2026-11-17'), qr2: m.quarterRange('2027-02-03'),
      roll: [m.addMonthsToDate('2026-01-31', 1), m.rollNextDue({ cadence: 'yearly', next_due: '2024-02-29' }), m.rollNextDue({ cadence: 'monthly', next_due: '2026-12-15' })],
      tax0: m.taxSetAside(0.25, 1000, 1500),
      gst: [m.suggestGst(1100, reg), m.suggestGst(1000, reg), m.suggestGst(1100, unreg)],
      margin: m.clientMargins(clients, costs, today),
      due2: [m.dueState({ next_due: '2026-11-16' }, today), m.dueState({ next_due: '2026-11-24' }, today), m.dueState({ next_due: '2026-11-25' }, today)]
    };
  });
  check(u.fyNov.net === 6500 && u.fyNov.gst === 650 && u.fyNov.gross === 7150 && u.fyNov.count === 4, `FY money in = 6500 net / 650 GST (${u.fyNov.net}/${u.fyNov.gst})`);
  check(u.nov.net === 1000 && u.novUnreg.net === 1100 && u.novUnreg.gst === 0, 'GST excluded only when registered (1000 vs 1100)');
  check(JSON.stringify(u.recv) === '[1320,2,440,1]' && JSON.stringify(u.recvNov) === '[880,0]', `receivables 1320, overdue 440 (${u.recv})`);
  check(u.avg === 1833.33, `average of Aug/Sep/Oct = 5500/3 = 1833.33 (${u.avg})`);
  check(u.burn === 220 && u.octR === 270 && u.novR === 220 && u.decR === 230, `burn 220; Oct 270, Nov 220, Dec 230 (${u.burn} ${u.octR} ${u.novR} ${u.decR})`);
  check(u.q.from === '2026-10-01' && u.q.revenue === 3000 && u.q.gst === 300 && u.q.costs === 1140 && u.q.tax === 465, `quarter: rev 3000, costs 490+650=1140, tax 25% of 1860 = 465 (${u.q.revenue}, ${u.q.costs}, ${u.q.tax})`);
  check(u.ms.in === 1000 && u.ms.out === 620 && u.ms.net === 380, `month so far 1000 in, 220+400 out, 380 net (${JSON.stringify(u.ms)})`);
  check(JSON.stringify(u.top) === '["c1","c2","c7"]', `biggest three ${u.top}`);
  check(u.rwBurn.need === 4520 && u.rwBurn.shortfall === 2686.67 && near(u.rwBurn.months, 10000 / 2686.67, 1e-9), `runway 10000 / 2686.67 = 3.72 months (${u.rwBurn.months})`);
  check(!u.rwOk.burning && u.rwOk.months === null && u.rwOk.spare === 480, `not burning: 480 to spare (${u.rwOk.spare})`);
  check(!u.rwEven.burning && u.rwEven.months === null && u.rwEven.spare === 0, 'exact break-even is not burning, never infinity');
  check(JSON.stringify(u.proj) === JSON.stringify([['2026-12', 2000, 1200, 3200, 4530, -330], ['2027-01', 0, 2000, 2000, 4530, -2860]]) && u.zero === '2026-12',
    `projection Dec: 1000+3200-4530=-330, Jan: retainer invoice replaces retainer, -2860 (${JSON.stringify(u.proj)})`);
  check(JSON.stringify(u.due) === '["Ann","Zed"]', `due retainers skip drafted, zero, past; include voided (${u.due})`);
  check(u.inv.amount === 2200 && u.inv.gst === 200 && u.inv.due_on === '2026-12-01' && u.inv.status === 'draft' && u.inv.kind === 'retainer' && u.inv.description === 'K1 retainer, November 2026' && u.invUnreg.amount === 2000 && u.invUnreg.gst === 0, 'retainer invoice: 2000 + 10% GST, due +14 days');
  check(u.no === 'INV-0013' && JSON.stringify(u.nos) === '["INV-0001","INV-0002","INV-0003"]', `invoice numbers (${u.no})`);
  check(u.fy1.from === '2025-07-01' && u.fy1.to === '2026-06-30' && u.fy2.from === '2026-07-01', 'Australian FY boundaries');
  check(u.qr.to === '2026-12-31' && u.qr2.from === '2027-01-01' && u.qr2.to === '2027-03-31', 'BAS quarter boundaries');
  check(JSON.stringify(u.roll) === '["2026-02-28","2025-02-28","2027-01-15"]', `next-due rolling clamps month ends (${u.roll})`);
  check(u.tax0 === 0 && JSON.stringify(u.gst) === '[100,90.91,0]', 'tax floor 0; GST 1/11');
  check(u.margin.length === 1 && u.margin[0].value === 2000 && u.margin[0].cost === 100 && u.margin[0].margin === 1900 && near(u.margin[0].pct, 0.95), 'client margin 2000 - 100 = 1900 (95%)');
  check(JSON.stringify(u.due2) === '["overdue","soon","later"]', 'next due flags');

  /* ---------------------------------------------- render before test data */
  const emptyish = await api(page, ({ state }) => !state.income.length && !state.costs.length);
  for (const r of ['income', 'costs', 'runway']) {
    const before = page.errors.length;
    await nav(page, r);
    const ok = await page.evaluate(() => !!document.querySelector('#view .page') && !document.querySelector('#view .err-card'));
    check(ok && page.errors.length === before, `#${r} renders cleanly before test data`);
    if (SHOTS && emptyish) {
      await page.mouse.move(1000, 20);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/money-${r}-empty-1440.png`, fullPage: true });
    }
  }
  if (emptyish) {
    const now = await api(page, ({ state }) => ({ inc: state.income.length, cst: state.costs.length, ret: state.clients.some((c) => c.status === 'active' && !c.archived && Number(c.monthly_value) > 0) }));
    await nav(page, 'income');
    if (!now.inc) check(await page.isVisible('text=No invoices yet'), 'income empty state');
    await nav(page, 'costs');
    if (!now.cst) check(await page.isVisible('text=No costs yet'), 'costs empty state');
    if (Number(original.cash_on_hand) === 0 && !now.ret && !now.inc && !now.cst) {
      await nav(page, 'runway');
      check(await page.isVisible('text=Three things to enter first'), 'runway empty state with three steps');
    }
    if (SHOTS) {
      const p390 = await openApp({ width: 390, height: 844 });
      for (const r of ['income', 'costs', 'runway']) { await nav(p390, r); await p390.mouse.move(200, 400); await p390.screenshot({ path: `${SHOTS}/money-${r}-empty-390.png`, fullPage: true }); }
      await p390.context().close();
    }
  }

  /* ------------------------------------------------------------- seed */
  zzClient = await api(page, async ({ saveRow }) => saveRow('clients', { name: 'ZZMONEY Retainer Co', status: 'active', monthly_value: 1500, contact_name: 'Test' }));
  await page.waitForTimeout(300);

  /* ------------------------------------------------ income: add via UI */
  await nav(page, 'income/new');
  await page.waitForSelector('.modal');
  check(await page.textContent('.modal .h2') === 'Add invoice', '#income/new opens the add form');
  const suggested = await page.inputValue('.modal input[name=invoice_no]');
  const expectNo = await page.evaluate(async () => {
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    return m.suggestInvoiceNo(state.income);
  });
  check(/^INV-\d{4}$/.test(suggested) && suggested === expectNo, `invoice number suggested (${suggested})`);
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const issuedV = await page.inputValue('.modal input[name=issued_on]');
  const dueV = await page.inputValue('.modal input[name=due_on]');
  const plus14 = await page.evaluate((t) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 14); return d.toISOString().slice(0, 10); }, today);
  check(issuedV === today && dueV === plus14, `issued today, due +14 (${issuedV}, ${dueV})`);
  await page.selectOption('.modal select[name=client_id]', zzClient.id);
  await page.fill('.modal input[name=description]', `${TAG} Website build`);
  await page.fill('.modal input[name=amount]', '3300');
  await page.fill('.modal input[name=invoice_no]', `${TAG}-1`);
  await submitModal(page);
  let [inv] = await db(page, 'income', { description: `${TAG} Website build` });
  check(inv && Number(inv.amount) === 3300 && inv.client_id === zzClient.id && inv.status === 'invoiced' && inv.due_on === plus14, 'invoice added through the form is in the database');

  // edit via deep link
  await nav(page, `income/${inv.id}`);
  await page.waitForSelector('.modal');
  check(await page.textContent('.modal .h2') === 'Edit invoice', '#income/<id> opens that invoice');
  await page.fill('.modal input[name=amount]', '3520');
  await page.fill('.modal textarea[name=notes]', 'Deposit taken <b>not html</b>');
  await submitModal(page);
  [inv] = await db(page, 'income', { id: inv.id });
  check(Number(inv.amount) === 3520 && inv.notes.includes('<b>'), 'edit saved');
  check(await page.isVisible(`tr[data-id="${inv.id}"] a[href="#clients/${zzClient.id}"]`), 'invoice client links to #clients/<id>');

  // mark paid
  await page.click(`tr[data-id="${inv.id}"] button:has-text("Mark paid")`);
  await page.waitForSelector('.modal input[name=paid_on]');
  check(await page.inputValue('.modal input[name=paid_on]') === today, 'mark paid defaults to today');
  await submitModal(page);
  [inv] = await db(page, 'income', { id: inv.id });
  check(inv.status === 'paid' && inv.paid_on === today, 'marked paid with paid_on today');

  // overdue invoice: issued 30 days ago, due follows
  const ago30 = await page.evaluate((t) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10); }, today);
  await page.click('button:has-text("Add invoice")');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[name=description]', `${TAG} Late one`);
  await page.fill('.modal input[name=amount]', '440');
  await page.fill('.modal input[name=issued_on]', ago30);
  await page.dispatchEvent('.modal input[name=issued_on]', 'change');
  await submitModal(page);
  let [late] = await db(page, 'income', { description: `${TAG} Late one` });
  check(late && late.due_on < today, `due date follows issue date (${late && late.due_on})`);
  const lateRow = await page.textContent(`tr[data-id="${late.id}"]`);
  check(/Overdue/.test(lateRow) && /16 days late/.test(lateRow), `overdue shown with days late (${lateRow.replace(/\s+/g, ' ').slice(0, 120)})`);

  // header numbers against the maths on the live state
  const kp = await page.evaluate(async () => {
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const t = m.todayIso();
    const r = m.monthRange(t);
    const fmt = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Math.round(n));
    return {
      want: [fmt(m.moneyIn(state.income, state.settings, r.from, r.to).net), fmt(m.receivables(state.income, t, r).overdue)],
      got: [document.querySelector('[data-kpi=in] .money-kpi-value').textContent, document.querySelector('[data-kpi=overdue] .money-kpi-value').textContent]
    };
  });
  check(JSON.stringify(kp.want) === JSON.stringify(kp.got), `income header matches the maths (${kp.got})`);

  // void, then delete
  await page.click(`tr[data-id="${late.id}"] button[aria-label^="Void"]`);
  await submitModal(page);
  [late] = await db(page, 'income', { id: late.id });
  check(late.status === 'void', 'void through the UI');
  await page.click(`tr[data-id="${late.id}"] button[aria-label^="Delete"]`);
  await submitModal(page);
  check((await db(page, 'income', { id: late.id })).length === 0, 'delete through the UI (after confirm)');

  // filters
  await page.selectOption('select[aria-label=Status]', 'paid');
  await page.waitForTimeout(200);
  const paidRows = await page.$$eval('.money-invoices tbody tr', (rs) => rs.length);
  const paidWant = await api(page, ({ state }) => state.income.filter((r) => r.status === 'paid').length);
  check(paidRows === paidWant, `status filter shows paid only (${paidRows})`);
  // CSV export of the filtered list
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
  const csv = readFileSync(await dl.path(), 'utf8');
  check(csv.startsWith('invoice_no,description,client') && csv.includes(`${TAG} Website build`) && !csv.includes('Late one'), 'CSV export of the filtered list');
  await page.selectOption('select[aria-label=Status]', 'all');

  // raise retainers
  await page.click('button:has-text("Raise retainers")');
  await page.waitForSelector('.money-checklist');
  const listed = await page.$$eval('.money-check-row', (rs) => rs.map((r) => r.textContent));
  check(listed.some((t) => t.includes('ZZMONEY Retainer Co') && t.includes('$1,500')), 'retainer list shows the active client and amount first');
  for (const box of await page.$$('.money-check-row')) {
    const txt = await box.textContent();
    if (!txt.includes(TAG)) await (await box.$('input')).uncheck();
  }
  await submitModal(page);
  const ret = await db(page, 'income', { client_id: zzClient.id, kind: 'retainer' });
  check(ret.length === 1 && Number(ret[0].amount) === 1500 && ret[0].status === 'draft' && ret[0].issued_on === today && /^INV-\d{4}$/.test(ret[0].invoice_no), 'retainer drafted once, for the monthly value');
  const again = await api(page, async ({ state }) => {
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    return m.dueRetainers(state.clients, state.income, m.todayIso()).some((c) => c.name.startsWith('ZZMONEY'));
  });
  check(!again, 'client no longer due a retainer this month');
  await page.click(`tr[data-id="${ret[0].id}"] button:has-text("Mark sent")`);
  await page.waitForTimeout(500);
  check((await db(page, 'income', { id: ret[0].id }))[0].status === 'invoiced', 'draft marked sent');

  /* ------------------------------------------------------- costs via UI */
  await nav(page, 'costs/new');
  await page.waitForSelector('.modal');
  check(await page.textContent('.modal .h2') === 'Add a cost', '#costs/new opens the add form');
  await page.fill('.modal input[name=name]', `${TAG} Twilio`);
  await page.fill('.modal input[name=vendor]', 'Twilio');
  await page.fill('.modal input[name=amount]', '60');
  await page.fill('.modal input[name=category]', 'Telephony');
  await page.selectOption('.modal select[name=client_id]', zzClient.id);
  await submitModal(page);
  await page.click('button:has-text("Add cost")');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[name=name]', `${TAG} Insurance`);
  await page.fill('.modal input[name=amount]', '1200');
  await page.selectOption('.modal select[name=cadence]', 'yearly');
  await page.fill('.modal input[name=category]', 'Insurance');
  await page.fill('.modal input[name=next_due]', await page.evaluate((t) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); }, today));
  await submitModal(page);
  await page.click('button:has-text("One-off purchase")');
  await page.waitForSelector('.modal');
  check(await page.isHidden('.modal input[name=next_due]'), 'one-off form hides recurring fields');
  await page.fill('.modal input[name=name]', `${TAG} Laptop`);
  await page.fill('.modal input[name=amount]', '2000');
  await page.fill('.modal input[name=category]', 'Other');
  await submitModal(page);
  const costRows = await api(page, async ({ sb }) => (await sb.from('costs').select('*').like('name', 'ZZMONEY%')).data);
  const tw = costRows.find((c) => c.name === `${TAG} Twilio`);
  const ins = costRows.find((c) => c.name === `${TAG} Insurance`);
  const lap = costRows.find((c) => c.name === `${TAG} Laptop`);
  check(tw && ins && lap && tw.cadence === 'monthly' && tw.client_id === zzClient.id && tw.started_on === today && ins.cadence === 'yearly' && lap.cadence === 'one_off' && lap.incurred_on === today && lap.started_on === null,
    'three costs saved with the right cadence and dates');
  const ck = await page.evaluate(async () => {
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const fmt = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Math.round(n));
    return { want: fmt(m.monthlyBurn(state.costs, m.todayIso())), got: document.querySelector('[data-kpi=burn] .money-kpi-value').textContent, wantY: fmt(m.monthlyBurn(state.costs, m.todayIso()) * 12), gotY: document.querySelector('[data-kpi=yearly] .money-kpi-value').textContent };
  });
  check(ck.want === ck.got && ck.wantY === ck.gotY, `burn header matches the maths (${ck.got}, ${ck.gotY})`);
  const insRow = await page.textContent(`tr[data-id="${ins.id}"]`);
  check(insRow.includes('$100') && /2 days overdue/.test(insRow), `yearly shows $100/mo and overdue next due (${insRow.replace(/\s+/g, ' ').slice(0, 100)})`);
  check(await page.isVisible('tbody[data-category="telephony"]') && await page.isVisible('tbody[data-category="insurance"]'), 'recurring grouped by category');
  const serve = await page.textContent(`tr[data-client="${zzClient.id}"]`);
  check(serve.includes('$1,500') && serve.includes('$60') && serve.includes('$1,440') && serve.includes('96%'), `cost to serve: 1500 - 60 = 1440, 96% (${serve.replace(/\s+/g, ' ')})`);
  // paid: roll next due a year on
  await page.click(`tr[data-id="${ins.id}"] button:has-text("Paid")`);
  await page.waitForTimeout(600);
  const insAfter = (await db(page, 'costs', { id: ins.id }))[0];
  check(insAfter.next_due > today, `next due rolled on (${insAfter.next_due})`);
  // stop, then restart
  await page.click(`tr[data-id="${tw.id}"] button[aria-label^="Stop"]`);
  await page.waitForSelector('.modal input[name=ended_on]');
  await submitModal(page);
  let twAfter = (await db(page, 'costs', { id: tw.id }))[0];
  check(twAfter.active === false && twAfter.ended_on === today, 'stop sets active false and ended_on today');
  check(!(await page.isVisible('.money-serve')), 'cost to serve hides when no running linked cost');
  await page.click('.money-details > summary:has-text("Stopped")');
  await page.click(`tr[data-id="${tw.id}"] button:has-text("Restart")`);
  await page.waitForTimeout(600);
  twAfter = (await db(page, 'costs', { id: tw.id }))[0];
  check(twAfter.active === true && twAfter.ended_on === null, 'restart clears ended_on');
  // edit via deep link
  await nav(page, `costs/${tw.id}`);
  await page.waitForSelector('.modal');
  check(await page.textContent('.modal .h2') === 'Edit cost', '#costs/<id> opens that cost');
  await page.fill('.modal input[name=amount]', '75');
  await submitModal(page);
  check(Number((await db(page, 'costs', { id: tw.id }))[0].amount) === 75, 'cost edit saved');
  // delete one-off
  await page.click(`tr[data-id="${lap.id}"] button[aria-label^="Delete"]`);
  await submitModal(page);
  check((await db(page, 'costs', { id: lap.id })).length === 0, 'one-off deleted after confirm');
  const [cdl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
  const ccsv = readFileSync(await cdl.path(), 'utf8');
  check(ccsv.startsWith('name,vendor,category,cadence,amount,per_month') && ccsv.includes(`${TAG} Insurance,,Insurance,Yearly,1200,100`), 'costs CSV export');

  /* --------------------------------------------- seed history for runway */
  await api(page, async ({ saveRow }, [cid, tag]) => {
    const d = new Date();
    const iso = (y, m, day) => { const x = new Date(Date.UTC(y, m, day)); return x.toISOString().slice(0, 10); };
    const amounts = [4200, 3800, 5100, 2900, 6100, 4700, 5600, 3900, 6400, 5200, 7100];
    for (let i = 1; i <= amounts.length; i += 1) {
      const paid = iso(d.getFullYear(), d.getMonth() - i, 12);
      await saveRow('income', { client_id: cid, description: `${tag} Month ${i} work`, amount: amounts[i - 1], kind: i % 2 ? 'retainer' : 'one_off', status: 'paid', issued_on: iso(d.getFullYear(), d.getMonth() - i, 2), due_on: iso(d.getFullYear(), d.getMonth() - i, 16), paid_on: paid, invoice_no: `${tag}-H${i}` });
    }
    await saveRow('costs', { name: `${tag} Claude API`, vendor: 'Anthropic', category: 'AI and APIs', amount: 180, cadence: 'monthly', started_on: iso(d.getFullYear() - 1, 0, 1) });
    await saveRow('costs', { name: `${tag} Xero`, vendor: 'Xero', category: 'Accounting', amount: 70, cadence: 'monthly', started_on: iso(d.getFullYear() - 1, 0, 1) });
    await saveRow('costs', { name: `${tag} Google Workspace`, vendor: 'Google', category: 'Software', amount: 26, cadence: 'monthly', started_on: iso(d.getFullYear() - 1, 0, 1) });
    await saveRow('costs', { name: `${tag} Domain`, vendor: 'VentraIP', category: 'Software', amount: 30, cadence: 'yearly', started_on: iso(d.getFullYear() - 1, 0, 1) });
    await saveRow('costs', { name: `${tag} Course`, vendor: 'Course', category: 'Other', amount: 450, cadence: 'one_off', incurred_on: iso(d.getFullYear(), d.getMonth() - 1, 8) });
  }, [zzClient.id, TAG]);
  await page.waitForTimeout(500);

  /* ------------------------------------------------------- runway via UI */
  await nav(page, 'runway');
  await page.fill('#rw-cash_on_hand', '12345');
  await page.press('#rw-cash_on_hand', 'Tab');
  await page.waitForTimeout(900);
  let s1 = (await db(page, 'settings', { id: 1 }))[0];
  check(Number(s1.cash_on_hand) === 12345 && (s1.cash_as_of === today || s1.cash_as_of === original.cash_as_of), 'cash on hand saved to settings');
  await page.fill('#rw-owner_draw', '4300');
  await page.press('#rw-owner_draw', 'Tab');
  await page.waitForTimeout(700);
  const rw = await page.evaluate(async () => {
    const r = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/runway.js'));
    const m = await import(document.querySelector('script[type=module]').src.replace('app.js', 'views/money-math.js'));
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const w = r.workings(state, state.settings, m.todayIso());
    return { burning: w.rw.burning, months: w.rw.months, spare: w.rw.spare, need: w.rw.need, avg: w.avg.average, burn: w.burn,
      big: document.querySelector('.money-answer-big').textContent, line: document.querySelector('.money-answer-line').textContent,
      needTxt: document.querySelector('[data-fig=need] .money-fig-value').textContent, rows: document.querySelectorAll('.money-proj tbody tr').length,
      hasHow: [...document.querySelectorAll('[data-fig]')].every((n) => n.querySelector('.money-how')) };
  });
  const fmt0 = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Math.round(n));
  check(rw.burning ? rw.big === (rw.months >= 24 ? `${(rw.months / 12).toFixed(1)} years` : `${rw.months.toFixed(1)} months`) : rw.big === 'Not burning' && rw.line.includes(`${fmt0(rw.spare)} to spare`), `runway answer matches the maths (${rw.big} ${rw.line})`);
  check(rw.needTxt === `${fmt0(rw.need)}/mo` && rw.rows === 6 && rw.hasHow, `break-even ${rw.needTxt}, 6 projection rows, every figure has a how line`);
  check(!/Infinity|NaN/.test(await page.textContent('#view')), 'no Infinity or NaN anywhere on runway');
  // what if, live
  await page.fill('#rw-wi-add', '20000');
  await page.waitForTimeout(150);
  check(await page.textContent('[data-wi=runway]') === 'Not burning', 'what-if: adding $20,000/mo means not burning');
  await page.fill('#rw-wi-add', '');
  // GST toggle saves and changes revenue
  await page.check('#rw-gst');
  await page.waitForTimeout(900);
  s1 = (await db(page, 'settings', { id: 1 }))[0];
  check(s1.gst_registered === true, 'GST registered saved');
  await page.fill('#rw-tax_rate', '30');
  await page.press('#rw-tax_rate', 'Tab');
  await page.waitForTimeout(900);
  s1 = (await db(page, 'settings', { id: 1 }))[0];
  check(Number(s1.tax_rate) === 0.3, `tax rate 30% saved as 0.3 (${s1.tax_rate})`);
  // force a zero month: small cash, big draw
  await page.fill('#rw-cash_on_hand', '100');
  await page.fill('#rw-owner_draw', '30000');
  await page.waitForTimeout(200);
  check(await page.isVisible('.money-proj tr.is-zero') && /Cash runs out in/.test(await page.textContent('#view')), 'projection highlights the month cash hits zero (live, before saving)');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);

  check(page.errors.length === 0, `no console errors in the run (${page.errors.slice(0, 3).join(' | ')})`);

  /* -------------------------------------- 390px + screenshots, populated */
  await api(page, async ({ sb }, o) => { await sb.from('settings').update({ ...o, cash_on_hand: 18400, gst_registered: false, owner_draw: 4300, tax_rate: 0.25 }).eq('id', 1); }, original);
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const p = await openApp(vp);
    for (const r of ['income', 'costs', 'runway']) {
      await nav(p, r);
      if (r === 'income') await p.click('.money-details > summary').catch(() => {});
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (vp.width === 390) check(over <= 0, `#${r} at 390px has no horizontal scroll (${over}px)`);
      check(p.errors.length === 0, `#${r} populated at ${vp.width} renders without console errors`);
      await p.mouse.move(Math.round(vp.width * 0.6), 20);
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await p.waitForTimeout(400);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/money-${r}-${vp.width}.png`, fullPage: true });
    }
    if (SHOTS && vp.width === 1440) {
      await nav(p, 'income/new'); await p.waitForSelector('.modal'); await p.screenshot({ path: `${SHOTS}/money-income-form-1440.png` }); await p.keyboard.press('Escape');
      await nav(p, 'costs/new'); await p.waitForSelector('.modal'); await p.screenshot({ path: `${SHOTS}/money-costs-form-1440.png` }); await p.keyboard.press('Escape');
    }
    await p.context().close();
  }
} catch (e) {
  fails.push(`threw: ${e.stack || e.message}`);
} finally {
  /* -------------------------------------------------------------- cleanup */
  try {
    await api(page, async ({ sb }, [o, tag, cid]) => {
      if (cid) await sb.from('income').delete().eq('client_id', cid);
      await sb.from('income').delete().like('description', `${tag}%`);
      await sb.from('costs').delete().like('name', `${tag}%`);
      await sb.from('clients').delete().like('name', `${tag}%`);
      if (o) await sb.from('settings').update(o).eq('id', 1);
    }, [original, TAG, zzClient && zzClient.id]);
    const left = await api(page, async ({ sb }, tag) => {
      const a = await sb.from('income').select('id', { count: 'exact', head: true }).like('description', `${tag}%`);
      const b = await sb.from('costs').select('id', { count: 'exact', head: true }).like('name', `${tag}%`);
      const c = await sb.from('clients').select('id', { count: 'exact', head: true }).like('name', `${tag}%`);
      return a.count + b.count + c.count;
    }, TAG);
    check(left === 0, `cleanup left ${left} ZZMONEY rows`);
    if (original) {
      const now = await api(page, async ({ sb }, cols) => (await sb.from('settings').select(cols.join(',')).eq('id', 1).single()).data, SETTINGS_COLS);
      check(JSON.stringify(now) === JSON.stringify(original), `settings restored exactly (${JSON.stringify(now)})`);
    }
  } catch (e) { fails.push(`cleanup threw: ${e.message}`); }
  await browser.close();
}

console.log(`\n${passes.length} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
