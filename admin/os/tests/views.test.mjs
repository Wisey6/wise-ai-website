// Wise AI OS: Inbox, Campaigns, Bookings, Playbook and Settings, end to end against the
// live Supabase project. Creates its own rows (tagged), and deletes them at the end.
//
//   python3 -m http.server 8102 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node admin/os/tests/views.test.mjs [shots-dir]
//
// BASE overrides the URL. Errors from edge functions that are not deployed yet are
// reported separately and do not fail the run (they come from the shared data layer).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8102/admin/os/';
const PASSWORD = process.env.OS_TEST_PASSWORD;
const SHOTS = process.argv[2] || null;
const TAG = 'zz-views-auto';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); };

const browser = await chromium.launch();

async function openApp(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.errors = [];
  page.fnErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    // A function that is not deployed fails CORS preflight; the browser logs it.
    if (/functions\/v1\/|net::ERR_FAILED/.test(t)) page.fnErrors.push(t); else page.errors.push(t);
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(async (pw) => {
    const { sb } = await import('./js/api.js');
    const { error } = await sb.auth.signInWithPassword({ email: 'hq@wise-ai.au', password: pw });
    if (error) throw new Error(error.message);
  }, PASSWORD);
  await page.waitForFunction(async () => (await import('./js/api.js')).state.loaded, null, { timeout: 20000 });
  return page;
}

const sql = (page, fn, arg) => page.evaluate(fn, arg);
const nav = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view > .page:not([aria-busy])', { timeout: 15000 });
  if (/^inbox\/./.test(hash)) await page.waitForSelector('.inbox-msg, .inbox-none', { timeout: 15000 });
  await page.waitForTimeout(500);
};

const page = await openApp();
let ids = {};
let originalCap = null;

try {
  /* ---------------------------------------------------------- pure logic */
  const unit = await page.evaluate(async () => {
    const pb = await import('./js/views/playbook.js');
    const cp = await import('./js/views/campaigns.js');
    const f = pb.funnel({ perDay: 20, days: 20, delivered: 95, reply: 8, positive: 35, booked: 50, showed: 75, closed: 30, deal: 3000 });
    const n = pb.needed(15000, { perDay: 20, days: 20, delivered: 95, reply: 8, positive: 35, booked: 50, showed: 75, closed: 30, deal: 3000 });
    const zero = pb.needed(15000, { reply: 0 });
    return {
      texts: f.texts, closed: f.closed, revenue: f.revenue,
      deals: n.deals, texts2: Math.ceil(n.texts), perDay: Math.ceil(n.perDay), zero,
      s160: cp.smsSegments('a'.repeat(160)).segments, s161: cp.smsSegments('a'.repeat(161)).segments,
      s306: cp.smsSegments('a'.repeat(306)).segments, s307: cp.smsSegments('a'.repeat(307)).segments,
      ext: cp.smsSegments('{'.repeat(80)).segments, ucs: cp.smsSegments(`It’s ${'a'.repeat(66)}`),
      fin1: cp.finalBody('Hi there', { sender_name: 'Wise AI', optout_text: 'Reply STOP to opt out' }, false),
      fin2: cp.finalBody('Hi from wise ai, text STOP anytime', { sender_name: 'Wise AI', optout_text: 'Reply STOP to opt out' }, false),
      fin4: cp.finalBody('We help you stop losing jobs.  Wise AI', { sender_name: 'Wise AI', optout_text: 'Reply STOP to opt out' }, false),
      fin3: cp.finalBody('Hi there', { sender_name: 'Wise AI', optout_text: 'Reply STOP to opt out' }, true),
      block: [
        cp.coldBlocker({ status: 'new', phone: '+61400000001', source: 'import', number_source_url: 'x', hook: 'h' }, { suppressed: new Set(), requireHook: true }),
        cp.coldBlocker({ status: 'new', phone: '+61400000001', source: 'import', number_source_url: '', hook: 'h' }, { suppressed: new Set(), requireHook: true }),
        cp.coldBlocker({ status: 'new', phone: '+61400000001', source: 'import', number_source_url: 'x', hook: '' }, { suppressed: new Set(), requireHook: true }),
        cp.coldBlocker({ status: 'new', phone: '+61400000001', source: 'import', number_source_url: 'x', hook: '' }, { suppressed: new Set(), requireHook: false }),
        cp.coldBlocker({ status: 'new', phone: '+61733330000', source: 'website', hook: 'h' }, { suppressed: new Set(), requireHook: true }),
        cp.coldBlocker({ status: 'new', phone: '+61400000001', source: 'website', hook: 'h' }, { suppressed: new Set(['+61400000001']), requireHook: true }),
        cp.coldBlocker({ status: 'contacted', phone: '+61400000001', source: 'website', hook: 'h' }, { suppressed: new Set(), requireHook: true })
      ]
    };
  });
  check(unit.texts === 400 && Math.abs(unit.closed - 1.197) < 1e-9 && Math.round(unit.revenue) === 3591, `funnel forward maths (${unit.texts}, ${unit.closed}, ${unit.revenue})`);
  check(unit.deals === 5 && unit.texts2 === 1671 && unit.perDay === 84 && unit.zero === null, `funnel backwards maths (${unit.deals}, ${unit.texts2}, ${unit.perDay})`);
  check(unit.s160 === 1 && unit.s161 === 2 && unit.s306 === 2 && unit.s307 === 3, 'GSM-7 segment boundaries 160/153');
  check(unit.ext === 1, 'GSM extension characters count double');
  check(unit.ucs.encoding === 'UCS-2' && unit.ucs.segments === 2, `curly quote switches to UCS-2 (${unit.ucs.chars} chars, ${unit.ucs.segments})`);
  check(unit.fin1 === 'Hi there - Wise AI Reply STOP to opt out' && unit.fin2 === 'Hi from wise ai, text STOP anytime' && unit.fin3 === 'Hi there' && unit.fin4 === 'We help you stop losing jobs. Wise AI Reply STOP to opt out', 'sender + opt-out rules match sms-send');
  check(JSON.stringify(unit.block) === JSON.stringify([null, 'no_number_source', 'no_hook', null, 'not_au_mobile', 'suppressed', 'status']), `cold eligibility rules ${JSON.stringify(unit.block)}`);

  /* ---------------------------------------------------- empty-ish render */
  for (const r of ['inbox', 'campaigns/batch', 'campaigns/followups', 'campaigns/sequence', 'campaigns/campaigns', 'bookings', 'playbook', 'settings']) {
    const before = page.errors.length;
    await nav(page, r);
    const ok = await page.evaluate(() => !!document.querySelector('#view .page') && !document.querySelector('#view .err-card'));
    check(ok && page.errors.length === before, `#${r} renders cleanly before test data`);
  }

  /* ------------------------------------------------------------ seed */
  ids = await sql(page, async (TAG) => {
    const { sb, state } = await import('./js/api.js');
    const camp = state.campaigns[0]?.id || null;
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    const rows = [
      { business: 'ZZ Auto Plumbing', contact_name: 'Sam Auto', phone: '+61400000201', suburb: 'Redcliffe', industry: 'plumbing', source: 'import', number_source_url: 'https://example.com/a', status: 'new', campaign_id: camp, hook: 'Saw your reviews mention it is hard to get through on the phone.', est_monthly_value: 2400, tags: [TAG] },
      { business: 'ZZ Auto Dental', contact_name: 'Priya Auto', phone: '+61400000202', suburb: 'Wynnum', source: 'import', number_source_url: 'https://example.com/b', status: 'replied', campaign_id: camp, hook: 'h', unread: true, last_reply_at: ago(1), last_contacted_at: ago(24), tags: [TAG] },
      { business: 'ZZ Auto Booked', contact_name: 'Alex Auto', phone: '+61400000203', source: 'manual', number_source_url: 'https://example.com/c', status: 'booked', campaign_id: camp, last_reply_at: ago(48), tags: [TAG] }
    ];
    const data = [];
    for (const row of rows) {   // one at a time: a multi-row insert nulls keys a row leaves out
      const r = await sb.from('leads').insert(row).select('id,business').single();
      if (r.error) throw new Error(r.error.message);
      data.push(r.data);
    }
    const by = Object.fromEntries(data.map((r) => [r.business, r.id]));
    const m = await sb.from('messages').insert([
      { lead_id: by['ZZ Auto Dental'], direction: 'out', channel: 'sms', body: 'Hi Priya, Tyler from Wise AI. Reply STOP to opt out', status: 'delivered', created_at: ago(24) },
      { lead_id: by['ZZ Auto Dental'], direction: 'in', channel: 'sms', body: '<img src=x onerror=alert(1)> how much?', status: 'received', created_at: ago(1) }
    ]);
    if (m.error) throw new Error(m.error.message);
    const b = await sb.from('bookings').insert([
      { lead_id: by['ZZ Auto Booked'], cal_uid: `${TAG}-past`, title: 'Intro call', starts_at: ago(24), ends_at: ago(23.75), attendee_name: 'Alex Auto', status: 'booked', meeting_url: 'javascript:alert(1)' },
      { lead_id: by['ZZ Auto Dental'], cal_uid: `${TAG}-next`, title: 'Intro call', starts_at: ago(-26), ends_at: ago(-26.25), attendee_name: 'Priya Auto', status: 'booked', meeting_url: 'https://meet.example.com/x' }
    ]);
    if (b.error) throw new Error(b.error.message);
    return { plumbing: by['ZZ Auto Plumbing'], dental: by['ZZ Auto Dental'], booked: by['ZZ Auto Booked'] };
  }, TAG);
  await page.waitForFunction(async (id) => (await import('./js/api.js')).state.leads.some((l) => l.id === id), ids.booked, { timeout: 10000 });
  await page.evaluate(async () => (await import('./js/api.js')).loadAll());

  /* ------------------------------------------------- inbox: live + send */
  await page.waitForFunction(async () => (await import('./js/api.js')).state.connection === 'live', null, { timeout: 15000 });
  await nav(page, `inbox/${ids.dental}`);
  await page.waitForSelector('.inbox-msg.is-in');
  const inboundText = await page.textContent('.inbox-msg.is-in .inbox-bubble');
  const injected = await page.evaluate(() => !!document.querySelector('.inbox-msgs img'));
  check(inboundText.includes('<img src=x') && !injected, 'inbound SMS rendered as text, not HTML');
  const DRAFT = 'Thanks Priya, it depends on call volume. Typing this while a reply arrives';
  await page.click('.inbox-input');
  await page.keyboard.type(DRAFT, { delay: 2 });

  const other = await openApp();
  await other.evaluate(async (id) => {
    const { sb } = await import('./js/api.js');
    const { error } = await sb.from('messages').insert({ lead_id: id, direction: 'in', channel: 'sms', body: 'Also, do you work weekends?', status: 'received' });
    if (error) throw new Error(error.message);
  }, ids.dental);
  await page.waitForFunction(() => [...document.querySelectorAll('.inbox-bubble')].some((b) => b.textContent.includes('weekends')), null, { timeout: 15000 });
  const kept = await page.evaluate(() => ({ v: document.querySelector('.inbox-input').value, focus: document.activeElement?.classList.contains('inbox-input') }));
  check(kept.v === DRAFT, 'inbox keeps typed text when a message arrives from another client');
  check(kept.focus, 'inbox keeps focus in the reply box during live updates');
  await other.close();

  // Quick replies + preview render variables
  await page.evaluate(() => { const t = document.querySelector('.inbox-input'); t.value += ' {first_name}'; t.dispatchEvent(new Event('input')); });
  const prev = await page.textContent('.inbox-preview');
  check(prev.includes('Priya') && !prev.includes('{first_name}'), 'composer previews rendered variables');
  await page.evaluate(() => { const t = document.querySelector('.inbox-input'); t.value = t.value.replace(' {first_name}', ''); t.dispatchEvent(new Event('input')); });

  const sms = await page.evaluate(async () => (await import('./js/api.js')).state.sms);
  const manualBtn = sms?.configured ? 'button:has-text("Sent from my phone")' : 'button:has-text("Copy & mark sent")';
  await page.click(manualBtn);
  await page.waitForFunction(() => document.querySelector('.inbox-input').value === '', null, { timeout: 15000 });
  const sent = await page.evaluate(async (id) => {
    const { sb } = await import('./js/api.js');
    const { data } = await sb.from('messages').select('body,status,direction').eq('lead_id', id).eq('direction', 'out').order('created_at', { ascending: false }).limit(1);
    return { row: data[0], clip: await navigator.clipboard.readText().catch(() => null) };
  }, ids.dental);
  check(sent.row && sent.row.status === 'manual' && sent.row.body === DRAFT, `inbox manual send recorded (${JSON.stringify(sent.row)})`);
  check(sent.clip === DRAFT, 'inbox manual send copied the exact text');
  await page.waitForFunction((d) => [...document.querySelectorAll('.inbox-msg.is-out')].some((m) => m.textContent.includes(d.slice(0, 20)) && m.textContent.includes('Sent from phone')), DRAFT, { timeout: 15000 });
  check(true, 'manual message appears in the thread as "Sent from phone"');

  // Status change is one click
  await page.click('.inbox-thread-actions button:has-text("Interested")');
  await page.waitForFunction(async (id) => (await import('./js/api.js')).state.leads.find((l) => l.id === id)?.status === 'interested', ids.dental, { timeout: 10000 });
  check(true, 'one-click status change from the thread');
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/inbox-thread-1280.png` });
  }

  /* --------------------------------------------- batch flow, manual mode */
  await nav(page, 'campaigns/batch');
  await page.waitForSelector('.camp-elig-num');
  // Only our plumbing lead should be needed; narrow to it by setting count to the eligible list and unticking others.
  await page.click('button:has-text("Review messages")');
  await page.waitForSelector('.camp-msg');
  const items = await page.$$eval('.camp-msg', (ns) => ns.map((n) => n.querySelector('.camp-msg-who strong').textContent));
  for (let i = 0; i < items.length; i++) {
    if (items[i] !== 'ZZ Auto Plumbing') await page.locator('.camp-msg').nth(i).locator('input[type=checkbox]').uncheck();
  }
  const idx = items.indexOf('ZZ Auto Plumbing');
  check(idx >= 0, 'eligible lead appears in the batch review');
  const ta = page.locator('.camp-msg').nth(idx).locator('textarea');
  const rendered = await ta.inputValue();
  check(rendered.includes('Hi Sam') && rendered.includes('hard to get through') && /STOP/.test(rendered) && rendered.includes('Wise AI'), 'batch preview is rendered with hook, sender and opt-out');
  const EDITED = `${rendered.replace('Hi Sam', 'Hi Sam, quick one')}`;
  await ta.fill(EDITED);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/batch-review-1280.png`, fullPage: true });
  await page.click('button:has-text("from my phone")');
  await page.waitForSelector('.camp-step');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/batch-step-1280.png`, fullPage: true });
  const stepText = await page.locator('.camp-step textarea').inputValue();
  check(stepText === EDITED, 'step-through carries the edited text');
  await page.click('button:has-text("Sent, next")');
  await page.waitForSelector('.camp-step-done', { timeout: 15000 });
  const batchRow = await page.evaluate(async (id) => {
    const { sb } = await import('./js/api.js');
    const m = await sb.from('messages').select('body,status,template_id').eq('lead_id', id);
    const l = await sb.from('leads').select('status,sequence_step,next_followup_at,last_contacted_at').eq('id', id).single();
    return { m: m.data, l: l.data };
  }, ids.plumbing);
  check(batchRow.m.length === 1 && batchRow.m[0].status === 'manual' && batchRow.m[0].body === EDITED.trim() && batchRow.m[0].template_id, `batch manual send recorded with edited body (${JSON.stringify(batchRow.m)})`);
  check(batchRow.l.status === 'contacted' && batchRow.l.sequence_step === 1 && batchRow.l.next_followup_at && batchRow.l.last_contacted_at, `lead advanced in the sequence (${JSON.stringify(batchRow.l)})`);

  /* ------------------------------------------------------- bookings */
  await nav(page, 'bookings');
  const bk = await page.evaluate(() => ({
    up: document.querySelectorAll('.book-days .book-item').length,
    jsLink: [...document.querySelectorAll('.book-item a')].some((a) => a.getAttribute('href')?.startsWith('javascript')),
    outcome: !!document.querySelector('.book-oc')
  }));
  check(bk.up >= 1 && !bk.jsLink && bk.outcome, `bookings list upcoming, refuses javascript: links, offers outcomes (${JSON.stringify(bk)})`);
  const pastRow = page.locator('.book-item', { hasText: 'Alex Auto' });
  await pastRow.locator('button:has-text("Won")').click();
  await page.waitForFunction(async (id) => (await import('./js/api.js')).state.leads.find((l) => l.id === id)?.status === 'won', ids.booked, { timeout: 10000 });
  check(true, 'mark outcome (won) updates the lead');

  /* ------------------------------------------------------- playbook */
  await nav(page, 'playbook');
  const setNum = async (k, v) => { await page.fill(`#play-calc-${k}`, String(v)); };
  await setNum('perDay', 30); await setNum('days', 20); await setNum('delivered', 100); await setNum('reply', 10);
  await setNum('positive', 50); await setNum('booked', 50); await setNum('showed', 80); await setNum('closed', 25);
  await setNum('deal', 4000); await setNum('target', 20000);
  // 600 texts → 600 → 60 → 30 → 15 → 12 → 3 sales → $12,000. Target $20k → 5 deals → 20 held → 25 booked → 50 → 100 → 1000 texts → 50/day.
  const calc = await page.evaluate(() => ({
    rev: document.querySelector('.play-rev .kpi-value').textContent,
    nums: [...document.querySelectorAll('.play-funnel-num')].map((n) => n.textContent),
    need: [...document.querySelectorAll('.play-need-list strong')].map((n) => n.textContent)
  }));
  check(calc.rev === '$12,000', `calculator revenue ${calc.rev}`);
  check(JSON.stringify(calc.nums) === JSON.stringify(['600', '600', '60', '30', '15', '12', '3']), `calculator funnel ${calc.nums}`);
  check(JSON.stringify(calc.need) === JSON.stringify(['20', '25', '50', '100', '1,000', '50']), `calculator working back ${calc.need}`);
  await page.evaluate(() => { try { localStorage.removeItem('wiseos.calc'); } catch { /* */ } });

  /* ------------------------------------------------------- settings */
  originalCap = await page.evaluate(async () => (await import('./js/api.js')).state.settings.daily_cap);
  await nav(page, 'settings');
  await page.fill('input[name=daily_cap]', String(originalCap + 1));
  await page.click('.set-savebar button[type=submit]');
  await page.waitForFunction(async (v) => (await import('./js/api.js')).state.settings.daily_cap === v, originalCap + 1, { timeout: 10000 });
  const fresh = await openApp();
  await nav(fresh, 'settings');
  const reloaded = await fresh.inputValue('input[name=daily_cap]');
  check(Number(reloaded) === originalCap + 1, `settings save and reload (${reloaded})`);
  // Bad opt-out text is refused
  await fresh.fill('input[name=optout_text]', 'Bye');
  await fresh.click('.set-savebar button[type=submit]');
  await fresh.waitForTimeout(600);
  const opt = await fresh.evaluate(async () => (await import('./js/api.js')).state.settings.optout_text);
  check(/STOP/.test(opt), 'opt-out text without STOP is refused');
  await fresh.close();

  /* ---------------------------------------------- screenshots + layout */
  for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
    const p = await openApp(vp);
    for (const r of ['inbox', `inbox/${ids.dental}`, 'campaigns/batch', 'campaigns/followups', 'campaigns/sequence', 'campaigns/campaigns', 'bookings', 'playbook', 'settings']) {
      await nav(p, r);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(ov <= 0, `#${r} at ${vp.width}px has no horizontal scroll (${ov})`);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/${vp.width}-${r.replace(/\/.*/, (m) => (m.length > 12 ? '_thread' : m.replace('/', '_')))}.png`, fullPage: vp.width > 400 && !r.startsWith('inbox') });
    }
    if (vp.width === 375) {
      await nav(p, 'inbox');
      const listOnly = await p.evaluate(() => getComputedStyle(document.querySelector('.inbox-thread')).display === 'none');
      await nav(p, `inbox/${ids.dental}`);
      const threadOnly = await p.evaluate(() => getComputedStyle(document.querySelector('.inbox-side')).display === 'none' && !!document.querySelector('.inbox-back'));
      check(listOnly && threadOnly, 'phone inbox goes list → thread with a back button');
    }
    check(p.errors.length === 0, `no console errors at ${vp.width}px (${p.errors.join(' | ')})`);
    await p.close();
  }
  check(page.errors.length === 0, `no console errors in the main run (${page.errors.join(' | ')})`);
  if (page.fnErrors.length) console.log(`note: ${page.fnErrors.length} browser errors from edge functions that are not reachable yet`);
} catch (err) {
  fails.push(`exception: ${err.stack || err.message}`);
} finally {
  // Clean up everything this run created, and restore settings.
  try {
    await page.evaluate(async ({ TAG, cap }) => {
      const { sb } = await import('./js/api.js');
      await sb.from('bookings').delete().like('cal_uid', `${TAG}%`);
      await sb.from('leads').delete().contains('tags', [TAG]);
      await sb.from('suppressions').delete().in('phone', ['+61400000201', '+61400000202', '+61400000203']);
      if (cap !== null) await sb.from('settings').update({ daily_cap: cap }).eq('id', 1);
    }, { TAG, cap: originalCap });
  } catch (e) { fails.push(`cleanup failed: ${e.message}`); }
  await browser.close();
}

for (const p of passes) console.log(`  ok  ${p}`);
for (const f of fails) console.log(`FAIL  ${f}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
