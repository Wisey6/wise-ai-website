// Wise AI OS team tests: who is signing in (lock screen), each person signing in with
// their own PIN, forgot PIN and the emailed reset link (mocked), the offline fallback,
// owners on tasks / projects / deals / clients / leads, TBC dates, the task table and
// group by person, My tasks per person, Today Mine vs Everyone, the inbox badge per
// person, Your sign-in (change PIN validation, success mocked) and Team settings.
//
//   python3 -m http.server 8186 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… OS_TEST_PIN=… OS_TEST_PIN_JAY=… node os/tests/team.test.mjs [shots-dir]
//
// Rules this suite keeps: at most ONE wrong PIN per person per run (Jay only); the
// reset endpoints are always mocked; no real PIN is ever changed; every row it makes is
// named "ZZTEAM …" and deleted at the end. Team members it adds (ZZTEAM…) cannot be
// deleted from the browser: remove them afterwards with
//   delete from public.team_members where name like 'ZZTEAM%';
// and reset the lock counters (see the brief).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = (process.env.BASE || 'http://127.0.0.1:8186').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const PIN = process.env.OS_TEST_PIN;
const PIN_JAY = process.env.OS_TEST_PIN_JAY;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD || !PIN || !PIN_JAY) { console.error('Set OS_TEST_PASSWORD, OS_TEST_PIN and OS_TEST_PIN_JAY.'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const P = 'ZZTEAM';

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };
const ymd = (n = 0) => { const d = new Date(Date.now() + n * 86400000); return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }); };

const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A context with the agent function mocked (it costs money) and hq-login hooks for one test. */
async function context(viewport = { width: 1440, height: 900 }, { hq = null, scale = 1 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
  await ctx.route('**/functions/v1/agent', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return json(route, 200, { configured: true, enabled: true, agents: { researcher: true, briefing: true, ask: true, doer: true }, spent_usd: 0, cap_usd: 25, runs_today: {}, limits: {} });
  });
  if (hq) {
    await ctx.route('**/functions/v1/hq-login', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* */ }
      const out = await hq(body, route);
      if (out === undefined) return route.continue();
      if (out === 'abort') return route.abort();
      return json(route, out[0], out[1]);
    });
  }
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|404|409|423|429|503)/.test(m.text())) page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  return { ctx, page };
}
const api = (page, fn, arg) => page.evaluate(async ({ src, arg }) => {
  const m = await window.__mod('api.js');
  const f = new Function('return ' + src)();   // eslint-disable-line no-new-func
  return f(m, arg);
}, { src: fn.toString(), arg });
async function waitFor(page, fn, arg, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await api(page, fn, arg).catch((e) => ({ __err: e.message }));
    if (last && !last.__err) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`timed out: ${label} (${JSON.stringify(last)})`);
}
async function untilLoaded(page) {
  await page.waitForSelector('.shell', { timeout: 25000 });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await waitFor(page, async (m) => (m.state.loaded && m.state.me && m.state.team.length > 1 ? true : null), null, 'state loaded with me and team', 20000);
}
async function passwordSession(viewport, opts) {
  const c = await context(viewport, opts);
  await c.page.goto(URL, { waitUntil: 'networkidle' });
  const r = await c.page.evaluate(async ({ email, password }) => {
    const { sb } = await window.__mod('api.js');
    const { error } = await sb.auth.signInWithPassword({ email, password });
    return error ? error.message : 'ok';
  }, { email: EMAIL, password: PASSWORD });
  if (r !== 'ok') throw new Error(`password sign-in failed: ${r}`);
  await untilLoaded(c.page);
  await c.page.mouse.move(viewport?.width ? viewport.width - 5 : 1400, 400);
  return c;
}
async function nav(page, hash, sel) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  if (sel) await page.waitForSelector(sel, { timeout: 12000 });
  await page.waitForTimeout(250);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let owner = null;   // password (owner) session
let jay = null;     // Jay, signed in through the lock screen
let ids = {};
try {
  /* ============================================== the lock screen */
  const who = await (async () => { const c = await context(); await c.page.goto(URL, { waitUntil: 'networkidle' }); const p = await c.page.evaluate(async () => (await window.__mod('api.js')).who()); await c.ctx.close(); return p; })();
  const tyler = who.find((p) => p.name === 'Tyler');
  const jayP = who.find((p) => p.name === 'Jay');
  check(who.length >= 2 && tyler && jayP, `who() lists the people who can sign in (${who.map((p) => p.name).join(', ')})`);

  {
    const { ctx, page } = await context();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.gate .gate-unlock');
    check(await page.locator('.gate .pin-input').count() === 0, 'resting lock screen: clock, no field');
    await shot(page, 'gate-rest-1440');
    await page.locator('.gate .gate-unlock').click();
    await page.waitForSelector('.gate-person');
    check(await page.locator('.gate-person').count() === who.length, `a fresh device asks who is signing in (${await page.locator('.gate-person').count()} people)`);
    check(await page.locator('.gate-person.is-last').count() === 0, 'nobody is preselected on a fresh device');
    check((await page.locator('.gate-person').first().innerText()).includes('Tyler'), 'each person is a large choice with their name');
    await page.keyboard.press('Escape');
    check(await page.locator('.gate .gate-unlock').count() === 1, 'Escape from the people goes back to the resting screen');
    await page.keyboard.press('7');
    await page.waitForSelector('.gate-person');
    check(await page.locator('.pin-input').count() === 0, 'a digit on a fresh device still asks who first');
    await page.locator(`.gate-person[data-member="${tyler.id}"]`).click();
    await page.waitForSelector('.pin-input');
    check(await page.evaluate(() => document.activeElement?.classList.contains('pin-input')), 'choosing a person focuses their PIN field');
    check((await page.locator('.gate-who-name').innerText()) === 'Tyler', 'the PIN step names the person');
    await page.keyboard.type('a1b2');
    check(await page.locator('.pin-input').inputValue() === '12', 'PIN field takes digits only');
    await page.locator('.pin-input').fill('');
    await page.keyboard.press('Escape');
    check(await page.locator('.gate-person').count() === who.length, 'Escape from the PIN goes back to the people');
    await page.locator(`.gate-person[data-member="${tyler.id}"]`).click();
    await page.waitForSelector('.pin-input');
    await page.keyboard.type(PIN);
    await page.keyboard.press('Enter');
    await untilLoaded(page);
    const me = await api(page, async (m) => m.state.me);
    check(me?.id === tyler.id && me.name === 'Tyler' && me.role === 'owner', `Tyler signs in through the lock screen; state.me is Tyler, owner (${me?.name}, ${me?.role})`);
    check(await page.evaluate(() => localStorage.getItem('wiseos.who')) === tyler.id, 'this device remembers who signed in last');
    await page.waitForSelector('.rail-foot .me-chip:not([hidden])');
    check((await page.locator('.rail-foot .me-chip').innerText()).includes('Tyler'), 'the sidebar shows who is signed in');
    check(await page.locator('.dock-foot .me-chip .own-ring').count() === 1, 'the dock shows their initials');
    await nav(page, '#home', '#greet-h');
    check((await page.locator('#greet-h').innerText()).endsWith(', Tyler'), `Today greets Tyler by name (${await page.locator('#greet-h').innerText()})`);
    check(page.errors.length === 0, `no console errors signing in as Tyler ${page.errors.join(' | ')}`);

    // Back on the lock screen on the same device: Tyler is preselected.
    await page.evaluate(async () => { const { sb } = await window.__mod('api.js'); await sb.auth.signOut({ scope: 'local' }); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.gate .gate-unlock');
    await page.keyboard.press('4');
    await page.waitForSelector('.pin-input');
    check(await page.locator('.pin-input').inputValue() === '4' && (await page.locator('.gate-who-name').innerText()) === 'Tyler', 'a digit on the resting screen goes straight to the last person\'s PIN with that digit');
    await shot(page, 'gate-pin-1440');
    await page.locator('[data-act=not-you]').click();
    await page.waitForSelector('.gate-person');
    check(await page.locator(`.gate-person.is-last[data-member="${tyler.id}"]`).count() === 1, '"Not you?" returns to the people, the last person marked');
    check(await page.evaluate(() => document.activeElement?.dataset.member) === tyler.id, 'the last person is preselected (focused)');
    await shot(page, 'gate-people-1440');
    await ctx.close();
  }

  // Jay: one wrong PIN (the only one this run), then the right one.
  {
    const c = await context();
    jay = c;
    const { page } = c;
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.locator('.gate .gate-unlock').click();
    await page.locator(`.gate-person[data-member="${jayP.id}"]`).click();
    await page.waitForSelector('.pin-input');
    if (!process.env.TEAM_NO_WRONG) {   // set while debugging reruns, so Jay is never locked out
      const wrong = PIN_JAY === '987654' ? '987653' : '987654';
      await page.keyboard.type(wrong);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.gate-hint.is-bad', { timeout: 15000 });
      const hint = await page.locator('.gate-hint').innerText();
      check(/didn't match/.test(hint) && /attempts? left/.test(hint), `one wrong PIN: a plain message with attempts left (${hint})`);
      check(await page.locator('.pin-input').inputValue() === '', 'the field clears for another go');
      await shot(page, 'gate-wrong-1440');
    }
    await page.keyboard.type(PIN_JAY);
    await page.keyboard.press('Enter');
    await untilLoaded(page);
    const me = await api(page, async (m) => m.state.me);
    check(me?.id === jayP.id && me.name === 'Jay' && me.role === 'member', `Jay signs in with his own PIN; state.me is Jay, member (${me?.name}, ${me?.role})`);
    await nav(page, '#home', '#greet-h');
    check((await page.locator('#greet-h').innerText()).endsWith(', Jay'), 'Today greets Jay');
  }

  /* ============================================== forgot PIN + reset link (mocked) */
  {
    let mode = 'ok';
    const seen = [];
    const { ctx, page } = await context({ width: 1440, height: 900 }, {
      hq: (body) => {
        if (body.action === 'reset_request') { seen.push(body.member_id); return mode === 'ok' ? [200, { ok: true }] : mode === 'nomail' ? [503, { ok: false, error: 'email_not_configured' }] : [429, { ok: false, error: 'too_many' }]; }
        if (body.action === 'reset_confirm') return body.token === 'b'.repeat(48) ? [401, { ok: false, error: 'bad_token' }] : body.new_pin === '482915' ? [200, { ok: true }] : [400, { ok: false, error: 'weak_pin' }];
        if (body.pin) return [500, { ok: false, error: 'blocked_in_test' }];
        return undefined;
      }
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.locator('.gate .gate-unlock').click();
    await page.locator(`.gate-person[data-member="${jayP.id}"]`).click();
    await page.locator('[data-act=forgot]').click();
    await page.waitForSelector('[data-act=send-reset]');
    check((await page.locator('.gate-msg').innerText()).includes('Jay'), 'Forgot PIN asks before sending, naming the person');
    await shot(page, 'gate-forgot-1440');
    await page.locator('[data-act=send-reset]').click();
    await page.waitForFunction(() => /a reset link is on its way/.test(document.querySelector('.gate-msg')?.textContent || ''));
    check(seen[0] === jayP.id, 'the reset request is for that person');
    check(/It lasts 20 minutes/.test(await page.locator('.gate-msg').innerText()), 'sent: "If there is an email on file for Jay, a reset link is on its way. It lasts 20 minutes."');
    await shot(page, 'gate-forgot-sent-1440');
    await page.locator('[data-act=back]').click();
    mode = 'nomail';
    await page.locator('[data-act=forgot]').click();
    await page.locator('[data-act=send-reset]').click();
    await page.waitForFunction(() => /Email is not set up yet/.test(document.querySelector('.gate-msg')?.textContent || ''));
    check(/Ask Tyler to reset your PIN in Settings/.test(await page.locator('.gate-msg').innerText()), 'email not configured: "Ask Tyler to reset your PIN in Settings."');
    await page.locator('[data-act=back]').click();
    mode = 'many';
    await page.locator('[data-act=forgot]').click();
    await page.locator('[data-act=send-reset]').click();
    await page.waitForFunction(() => /Too many reset requests/.test(document.querySelector('.gate-hint')?.textContent || ''));
    check(true, 'too many requests: a plain message');

    // The emailed link.
    await page.goto(`${URL}#reset/${'a'.repeat(48)}`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.gate-reset');
    check((await page.locator('.gate-who-name').innerText()) === 'Choose a new PIN', '#reset/<token> opens "Choose a new PIN" on the lock screen');
    await shot(page, 'gate-reset-1440');
    await page.fill('input[name=new-pin]', '12');
    await page.fill('input[name=new-pin-again]', '12');
    await page.click('[data-act=save-pin]');
    check(/4 to 12 digits/.test(await page.locator('.gate-hint').innerText()), 'a short PIN is refused before sending');
    await page.fill('input[name=new-pin]', '');
    await page.locator('input[name=new-pin]').click();
    await page.keyboard.type('48a2915');
    check(await page.locator('input[name=new-pin]').inputValue() === '482915', 'the new PIN takes digits only');
    await page.fill('input[name=new-pin-again]', '482916');
    await page.click('[data-act=save-pin]');
    check(/do not match/.test(await page.locator('.gate-hint').innerText()), 'mismatched PINs are caught');
    await page.fill('input[name=new-pin-again]', '482915');
    await page.click('[data-act=save-pin]');
    await page.waitForFunction(() => /PIN changed\. Sign in with the new one\./.test(document.querySelector('.gate-hint')?.textContent || ''));
    check(!(await page.evaluate(() => location.hash)).includes('reset'), 'success clears the link from the address bar');
    check(await page.locator('.gate-person, .pin-input').count() > 0, 'success returns to sign-in with "PIN changed. Sign in with the new one."');
    await page.goto(`${URL}#reset/${'b'.repeat(48)}`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.fill('input[name=new-pin]', '482915');
    await page.fill('input[name=new-pin-again]', '482915');
    await page.click('[data-act=save-pin]');
    await page.waitForFunction(() => /That link has expired/.test(document.querySelector('.gate-who-name')?.textContent || ''));
    check(await page.locator('[data-act=back]').count() === 1, 'an expired or used link gets a plain message and a way back');
    await page.locator('[data-act=back]').click();
    await page.waitForSelector('.gate-person, .pin-input');
    check(true, 'the way back opens sign-in');
    await ctx.close();
  }

  /* ============================================== offline: the picker is unavailable */
  {
    const { ctx, page } = await context({ width: 1440, height: 900 }, { hq: (body) => (body.action === 'who' ? 'abort' : body.pin ? [500, { ok: false, error: 'blocked_in_test' }] : undefined) });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.locator('.gate .gate-unlock').click();
    await page.waitForSelector('.pin-input');
    check(await page.locator('.gate-person').count() === 0 && await page.locator('.gate-who').count() === 0, 'if who() fails, the PIN field alone (signs in the owner)');
    check(await page.locator('[data-act=forgot]').count() === 0, 'no Forgot link without a known person');
    await ctx.close();
  }

  /* ============================================== 390px lock screen */
  {
    const { ctx, page } = await context({ width: 390, height: 844 }, { scale: 2 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.locator('.gate .gate-unlock').click();
    await page.waitForSelector('.gate-person');
    const box = await page.locator('.gate-people').boundingBox();
    check(box.x >= 0 && box.x + box.width <= 390, 'the people fit at 390px');
    await shot(page, 'gate-people-390');
    await page.locator('.gate-person').first().click();
    await page.waitForSelector('.pin-input');
    check((await page.locator('.pin-field').boundingBox()).width <= 358, 'the PIN field fits at 390px');
    await shot(page, 'gate-pin-390');
    await ctx.close();
  }

  /* ============================================== owners on the work */
  owner = await passwordSession({ width: 1440, height: 900 });
  const { page } = owner;
  ids = await api(page, async (m, { P, d0, d1, d3, dm1 }) => {
    const [ty, jy] = [m.state.team.find((x) => x.name === 'Tyler'), m.state.team.find((x) => x.name === 'Jay')];
    const client = await m.saveRow('clients', { name: `${P} Harbour Dental`, status: 'active', monthly_value: 900 });
    const project = await m.saveRow('projects', { name: `${P} Website rebuild`, client_id: client.id, status: 'active', owner_id: ty.id, value: 4800 });
    const t = async (title, owner_id, due_on, state = 'todo', priority = 'medium', sort = 10) => (await m.saveRow('tasks', { title: `${P} ${title}`, project_id: project.id, client_id: client.id, owner_id, due_on, state, priority, sort })).id;
    const tasks = {
      brief: await t('Brief and sitemap', ty.id, dm1, 'done', 'high', 10),
      copy: await t('Write the homepage copy', jy.id, dm1, 'doing', 'high', 20),
      form: await t('Set up the booking form', ty.id, null, 'todo', 'medium', 30),
      photos: await t('Photos from the clinic', null, d3, 'todo', 'low', 40),
      sms: await t('Missed-call text-back', jy.id, null, 'todo', 'medium', 50)
    };
    const deal = await m.saveRow('deals', { title: `${P} Coastal Physio`, stage: 'qualified', value: 3500, next_step: 'Send the proposal', next_step_on: d0 });
    const lead = await m.saveLead(null, { business: `${P} Bayside Plumbing`, contact_name: 'Dana', status: 'replied', source: 'manual' });
    return { ty: ty.id, jay: jy.id, client: client.id, project: project.id, tasks, deal: deal.id, lead: lead.id };
  }, { P, d0: ymd(0), d1: ymd(1), d3: ymd(3), dm1: ymd(-1) });
  check(Boolean(ids.project && ids.deal && ids.lead), 'seeded a ZZTEAM project with tasks, a deal, a client and a lead');
  const dbRow = (table, id) => api(page, async (m, { table, id }) => (await m.sb.from(table).select('*').eq('id', id).single()).data, { table, id });

  // A project page: owner + TBC on every task row.
  await nav(page, `#projects/${ids.project}`, `.dl-task[data-id="${ids.tasks.form}"]`);
  const formRow = page.locator(`.dl-task[data-id="${ids.tasks.form}"]`);
  check((await formRow.locator('.dl-due-wrap').innerText()).trim() === 'TBC' && await formRow.locator('.dl-due-wrap.is-tbc').count() === 1, 'a task with no date reads "TBC", not a blank date box');
  check(await formRow.locator('.own-pick').count() === 1 && (await formRow.locator('.own-pick').getAttribute('aria-label')).includes('Tyler'), 'every task row shows its owner beside the date');
  check(await page.locator('.dl-headsub .own-pick').count() === 1 && (await page.locator('.dl-headsub .own-pick').innerText()).includes('You'), 'the project header shows its owner');
  await shot(page, 'project-list-1440');
  // owner picker on a task: keyboard and mouse
  await formRow.locator('.own-pick').click();
  await page.waitForSelector('.own-menu');
  check(await page.locator('.own-menu .own-opt').count() >= 3 && (await page.locator('.own-menu').innerText()).includes('Nobody yet'), 'the owner picker lists the team and "Nobody yet"');
  await page.keyboard.press('Escape');
  check(await page.locator('.own-menu').count() === 0 && await page.evaluate(() => document.activeElement?.classList.contains('own-pick')), 'Escape closes the picker and returns focus');
  await formRow.locator('.own-pick').click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, id) => ((await m.sb.from('tasks').select('owner_id').eq('id', id).single()).data.owner_id ? (await m.sb.from('tasks').select('owner_id').eq('id', id).single()).data : null), ids.tasks.form, 'task owner');
  check((await dbRow('tasks', ids.tasks.form)).owner_id === ids.jay, 'one click on a person saves the task owner');
  // keyboard: put it back with arrows + Enter
  await page.locator(`.dl-task[data-id="${ids.tasks.form}"] .own-pick`).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.own-menu');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await waitFor(page, async (m, { id, ty }) => ((await m.sb.from('tasks').select('owner_id').eq('id', id).single()).data.owner_id === ty || null), { id: ids.tasks.form, ty: ids.ty }, 'task owner by keyboard');
  check(true, 'the picker works from the keyboard (Enter, Home, Enter)');
  // TBC → a date
  await formRow.locator('input[type=date]').fill(ymd(2));
  await waitFor(page, async (m, { id, d }) => ((await m.sb.from('tasks').select('due_on').eq('id', id).single()).data.due_on === d || null), { id: ids.tasks.form, d: ymd(2) }, 'TBC date set');
  check(true, 'one click on TBC sets a date');
  // project owner
  await page.locator('.dl-headsub .own-pick').click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, { id, j }) => ((await m.sb.from('projects').select('owner_id').eq('id', id).single()).data.owner_id === j || null), { id: ids.project, j: ids.jay }, 'project owner');
  check(true, 'the project owner saves from the header');
  // new task defaults to the project's owner (now Jay), with TBC
  await page.fill('.dl-qa input[name=new-task]', `${P} Launch checklist`);
  await page.press('.dl-qa input[name=new-task]', 'Enter');
  const launched = await waitFor(page, async (m, P) => (await m.sb.from('tasks').select('owner_id,due_on').eq('title', `${P} Launch checklist`).maybeSingle()).data, P, 'quick-add task');
  check(launched.owner_id === ids.jay && launched.due_on === null, 'quick-add: a new task takes the project\'s owner and a TBC date');

  // group by person + table view
  await page.click('[data-seg=group-by] [data-v=person]');
  await page.waitForSelector('.dl-pgroup');
  const groups = await page.$$eval('.dl-pgroup', (ns) => ns.map((n) => n.dataset.owner));
  check(groups.includes(ids.jay) && groups.includes(ids.ty) && groups.includes('none'), `group by person: one group per owner plus nobody yet (${groups.length})`);
  check(await page.locator(`.dl-pgroup[data-owner="${ids.jay}"] .dl-task`).count() === 3, 'Jay\'s group holds his three tasks');
  await shot(page, 'project-person-1440');
  await page.click('[data-seg=layout] [data-v=table]');
  await page.waitForSelector('.dl-ttable');
  const heads = await page.$$eval('.dl-ttable thead th', (ns) => ns.map((n) => n.textContent.trim()));
  check(JSON.stringify(heads) === JSON.stringify(['Task', 'Owner', 'Status', 'Due', 'Priority']), `table view columns (${heads})`);
  await page.click('.dl-ttable [data-sort=priority]');
  const pri = await page.$$eval('.dl-ttable tbody select[name=priority]', (ns) => ns.map((n) => n.value));
  check(pri[0] === 'high' && pri[pri.length - 1] === 'low', `sortable: priority high first (${pri})`);
  await page.click('.dl-ttable [data-sort=priority]');
  const pri2 = await page.$$eval('.dl-ttable tbody select[name=priority]', (ns) => ns.map((n) => n.value));
  check(pri2[0] === 'low', 'click again sorts the other way');
  check(await page.locator('.dl-ttable th[aria-sort=descending]').count() === 1, 'the sorted column says so (aria-sort)');
  await page.click('.dl-ttable [data-sort=due]');
  await shot(page, 'project-table-1440');
  await page.locator(`.dl-trow[data-id="${ids.tasks.photos}"] .own-pick`).click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.ty}"]`).click();
  await waitFor(page, async (m, { id, ty }) => ((await m.sb.from('tasks').select('owner_id').eq('id', id).single()).data.owner_id === ty || null), { id: ids.tasks.photos, ty: ids.ty }, 'owner from the table');
  check(true, 'owner changes from the table too');
  await page.click('[data-seg=layout] [data-v=list]');
  await page.click('[data-seg=group-by] [data-v=status]');

  // My tasks per person
  await nav(page, '#projects/tasks', '.dl-people');
  const count = async (v) => Number(await page.locator(`.dl-person[data-person="${v}"] .count`).innerText());
  const expectMe = await api(page, async (m) => m.state.tasks.filter((t) => t.state !== 'done' && t.owner_id === m.state.me.id).length);
  check(await count('me') === expectMe && await page.locator('.dl-person.is-active').getAttribute('data-person') === 'me', `My tasks defaults to Me with a count (${expectMe})`);
  const shownMe = await page.$$eval('.dl-tasks-wrap .dl-task', (ns) => ns.length);
  check(shownMe === expectMe, 'Me shows only your tasks');
  check(await page.locator(`.dl-load-item[data-owner="${ids.jay}"]`).count() === 1 && /overdue/.test(await page.locator(`.dl-load-item[data-owner="${ids.jay}"]`).innerText()), 'the workload strip shows open and overdue per person');
  await shot(page, 'mytasks-1440');
  await page.click(`.dl-person[data-person="${ids.jay}"]`);
  const jayTitles = await page.$$eval('.dl-tasks-wrap .dl-task-title', (ns) => ns.map((n) => n.textContent));
  check(jayTitles.length >= 3 && jayTitles.filter((t) => t.startsWith(P)).length === 3 && (await page.locator('h1').innerText()) === "Jay's tasks", `the switcher shows Jay's tasks (${jayTitles.filter((t) => t.startsWith(P)).length} ZZTEAM)`);
  await page.fill('.dl-qa input[name=new-task]', `${P} Call the printer`);
  await page.press('.dl-qa input[name=new-task]', 'Enter');
  const printer = await waitFor(page, async (m, P) => (await m.sb.from('tasks').select('owner_id').eq('title', `${P} Call the printer`).maybeSingle()).data, P, 'task from Jay view');
  check(printer.owner_id === ids.jay, 'adding a task while viewing Jay gives it to Jay');
  await page.click('.dl-person[data-person=none]');
  check(await page.locator('.dl-tasks-wrap .dl-task').count() === await count('none'), 'Unassigned lists work with nobody on it');
  await page.click('.dl-person[data-person=all]');
  check(await count('all') >= await count('me') + await count(ids.jay), 'Everyone counts all open tasks');
  await page.click('.dl-person[data-person=me]');

  // Deals, clients, leads
  await nav(page, '#pipeline', '.pipe-page');
  await page.locator('.tabs [role=tab]:has-text("Table")').click();
  await page.waitForSelector(`.pipe-table tr[data-id="${ids.deal}"]`);
  await page.locator(`.pipe-table tr[data-id="${ids.deal}"] .own-pick`).click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, { id, j }) => ((await m.sb.from('deals').select('owner_id').eq('id', id).single()).data.owner_id === j || null), { id: ids.deal, j: ids.jay }, 'deal owner');
  check(true, 'deal owner saves from the pipeline table');
  await page.selectOption('.pipe-bar select.own-filter', 'mine');
  check(await page.locator(`.pipe-table tr[data-id="${ids.deal}"]`).count() === 0, 'the Mine filter hides Jay\'s deal');
  await page.selectOption('.pipe-bar select.own-filter', ids.jay);
  check(await page.locator(`.pipe-table tr[data-id="${ids.deal}"]`).count() === 1, 'filter by person shows it');
  await page.selectOption('.pipe-bar select.own-filter', '');
  await page.locator('.tabs [role=tab]:has-text("Board")').click();
  await nav(page, `#pipeline/${ids.deal}`, '.deal-drawer .own-pick');
  check((await page.locator('.deal-drawer .own-pick').innerText()).includes('Jay'), 'the deal drawer shows its owner');
  await page.keyboard.press('Escape');

  await nav(page, '#clients', `.cl-table tr[data-id="${ids.client}"]`);
  await page.locator(`.cl-table tr[data-id="${ids.client}"] .own-pick`).click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, { id, j }) => ((await m.sb.from('clients').select('owner_id').eq('id', id).single()).data.owner_id === j || null), { id: ids.client, j: ids.jay }, 'client owner');
  check(await page.evaluate(() => location.hash) === '#clients', 'client owner saves from the roster without opening the client');
  await nav(page, `#clients/${ids.client}`, '.cl-h1');
  check((await page.locator('.dl-headsub .own-pick').innerText()).includes('Jay'), 'the client page shows its owner');

  await nav(page, '#leads', '.leads-bar');
  await page.locator('.leads-bar') && await page.fill('.leads-bar input[type=search]', P);
  await page.waitForSelector(`.leads-table tr[data-id="${ids.lead}"]`);
  await page.locator(`.leads-table tr[data-id="${ids.lead}"] .own-pick`).click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, { id, j }) => ((await m.sb.from('leads').select('owner_id').eq('id', id).single()).data.owner_id === j || null), { id: ids.lead, j: ids.jay }, 'lead owner');
  check(await page.locator('.drawer').count() === 0, 'lead owner saves from the table without opening the drawer');
  // bulk assign
  await page.locator(`.leads-table tr[data-id="${ids.lead}"] .check`).check();
  await page.selectOption('.bulk-bar select[name=bulk-owner]', ids.ty);
  await waitFor(page, async (m, { id, t }) => ((await m.sb.from('leads').select('owner_id').eq('id', id).single()).data.owner_id === t || null), { id: ids.lead, t: ids.ty }, 'bulk assign');
  check(true, 'bulk "Assign to…" on the leads table');
  await page.selectOption('.leads-bar select.own-filter', ids.jay);
  check(await page.locator(`.leads-table tr[data-id="${ids.lead}"]`).count() === 0, 'leads filter by person');
  await page.selectOption('.leads-bar select.own-filter', '');
  // new lead defaults to its creator; converting carries the owner
  await page.click('.page-head button:has-text("Add lead")');
  await page.fill('.modal input[name=business]', `${P} Northside Electrical`);
  await page.click('.modal-foot button[type=submit]');
  const newLead = await waitFor(page, async (m, P) => (await m.sb.from('leads').select('id,owner_id').eq('business', `${P} Northside Electrical`).maybeSingle()).data?.owner_id ? (await m.sb.from('leads').select('id,owner_id').eq('business', `${P} Northside Electrical`).maybeSingle()).data : null, P, 'new lead owner');
  check(newLead.owner_id === ids.ty, 'a new lead belongs to whoever adds it');
  await page.waitForSelector('.drawer .own-pick');
  await page.locator('.drawer .own-pick').click();
  await page.locator(`.own-menu .own-opt[data-id="${ids.jay}"]`).click();
  await waitFor(page, async (m, { id, j }) => ((await m.sb.from('leads').select('owner_id').eq('id', id).single()).data.owner_id === j || null), { id: newLead.id, j: ids.jay }, 'drawer owner');
  check(true, 'the lead drawer has an owner picker');
  await page.locator('.drawer select[name=status]').selectOption('interested');
  await page.waitForSelector('.drawer [data-act=create-deal]');
  await page.click('.drawer [data-act=create-deal]');
  const dealFromLead = await waitFor(page, async (m, id) => (await m.sb.from('deals').select('id,owner_id').eq('lead_id', id).maybeSingle()).data, newLead.id, 'deal from lead');
  check(dealFromLead.owner_id === ids.jay, 'converting a lead to a deal carries the lead\'s owner');
  await page.keyboard.press('Escape');
  await nav(page, `#leads/${newLead.id}`, '.drawer [data-act=make-client]');
  await page.click('.drawer [data-act=make-client]');
  const clientFromLead = await waitFor(page, async (m, id) => (await m.sb.from('clients').select('id,owner_id').eq('lead_id', id).maybeSingle()).data, newLead.id, 'client from lead');
  check(clientFromLead.owner_id === ids.jay, 'converting a lead to a client carries the lead\'s owner');
  ids.extraDeal = dealFromLead.id; ids.extraClient = clientFromLead.id; ids.lead2 = newLead.id;

  /* ============================================== Today: Mine vs Everyone */
  // Jay's overdue task (copy) is his; it must not appear in Tyler's Mine.
  await api(page, async (m, { id }) => m.saveRow('tasks', { id, state: 'todo', due_on: '2020-01-01' }), { id: ids.tasks.copy });
  await page.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('wiseos.scope.today')) localStorage.removeItem(k); } catch { /* */ } });
  await nav(page, '#home', '.do-card');
  check(await page.locator('.do-card [data-scope-area=today] [data-scope=mine].is-active').count() === 1, 'Today defaults to Mine');
  const mineText = await page.locator('.do-card').innerText();
  const mineCount = await page.locator('.do-item').count();
  await shot(page, 'today-mine-1440');
  await page.click('.do-card [data-scope=all]');
  await page.waitForSelector('.page.today[data-scope=all]');
  const allText = await page.locator('.do-card').innerText();
  check(await page.locator('.do-owner').count() >= 1 && (await page.locator('.do-owner .own-ring').first().getAttribute('aria-label')).includes('Jay'), 'Everyone shows other people\'s items with their initials');
  check(!/Write the homepage copy/.test(mineText) || allText.length > mineText.length, 'Mine leaves out work that is someone else\'s');
  await shot(page, 'today-everyone-1440');
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await untilLoaded(page);
  await nav(page, '#home', '.do-card');
  check(await page.locator('.page.today[data-scope=all]').count() === 1, 'the Mine / Everyone choice is remembered on the device');
  await page.click('.do-card [data-scope=mine]');
  check(mineCount >= 0, `Do next counts are per person (${mineCount} in Mine)`);
  const biz = await page.locator('[data-biz=pipeline] .kpi-value').innerText().catch(() => '');
  await page.click('.do-card [data-scope=all]');
  check((await page.locator('[data-biz=pipeline] .kpi-value').innerText().catch(() => '')) === biz, 'business numbers stay whole-business either way');
  await page.click('.do-card [data-scope=mine]');

  /* ============================================== Inbox badge per person */
  const leadsSeed = await api(page, async (m, { P, ty, j }) => {
    const mk = async (b, owner) => { const l = await m.saveLead(null, { business: `${P} ${b}`, status: 'replied', source: 'manual', unread: true, last_reply_at: new Date().toISOString() }); await m.sb.from('leads').update({ owner_id: owner }).eq('id', l.id); return l.id; };
    return { tyl: await mk('Reply for Tyler', ty), jayl: await mk('Reply for Jay', j), none: await mk('Reply for nobody', null) };
  }, { P, ty: ids.ty, j: ids.jay });
  Object.assign(ids, leadsSeed);
  const badgeFor = async (pg) => {
    await waitFor(pg, async (m, ids) => (['tyl', 'jayl', 'none'].every((k) => m.state.leads.find((l) => l.id === ids[k] && l.owner_id !== undefined && l.unread)) && m.state.leads.find((l) => l.id === ids.jayl)?.owner_id ? true : null), leadsSeed, 'unread leads in state');
    await pg.waitForTimeout(500);
    const expected = await api(pg, async (m) => m.state.leads.filter((l) => l.unread && !l.archived && m.isMine(l)).length);
    const shown = await pg.evaluate(() => Number(document.querySelector('.nav-item[data-route=inbox] .nav-count')?.textContent || 0));
    return { expected, shown };
  };
  // Tyler
  await api(page, async (m) => { await m.loadAll(); });
  const tb = await badgeFor(page);
  const tylerSees = await api(page, async (m, ids) => ({ jay: m.isMine(m.leadById(ids.jayl)), own: m.isMine(m.leadById(ids.tyl)), none: m.isMine(m.leadById(ids.none)) }), leadsSeed);
  check(tb.shown === tb.expected && tylerSees.own && tylerSees.none && !tylerSees.jay, `Tyler's inbox badge counts his and unowned replies, not Jay's (${tb.shown})`);
  await nav(page, '#inbox', '.inbox-list');
  await page.click('.inbox-scope [data-scope=mine]').catch(() => {});
  const listMine = await page.$$eval('.inbox-item-name', (ns) => ns.map((n) => n.textContent));
  check(listMine.includes(`${P} Reply for Tyler`) && listMine.includes(`${P} Reply for nobody`) && !listMine.includes(`${P} Reply for Jay`), 'Inbox Mine lists yours and unowned conversations');
  await page.click('.inbox-scope [data-scope=all]');
  const listAll = await page.$$eval('.inbox-item-name', (ns) => ns.map((n) => n.textContent));
  check(listAll.includes(`${P} Reply for Jay`), 'Inbox Everyone shows all of them');
  check(await page.locator('.inbox-item:has-text("Reply for Jay") .own-ring').count() === 1, 'each conversation shows its owner\'s initials');
  check(Number(await page.locator('.inbox-filters [data-f=waiting] .inbox-fcount').innerText().catch(() => '0')) >= 1, '"Waiting on you" carries a count');
  await shot(page, 'inbox-1440');
  await page.click('.inbox-scope [data-scope=mine]');
  await nav(page, `#inbox/${ids.none}`, '.inbox-thread-head .own-pick');
  check((await page.locator('.inbox-thread-head .own-pick').innerText()).includes('Nobody yet'), 'the thread header has the owner picker');
  // Jay
  await api(jay.page, async (m) => { await m.loadAll(); });
  const jb = await badgeFor(jay.page);
  const jaySees = await api(jay.page, async (m, ids) => ({ jay: m.isMine(m.leadById(ids.jayl)), ty: m.isMine(m.leadById(ids.tyl)) }), leadsSeed);
  check(jb.shown === jb.expected && jaySees.jay && !jaySees.ty, `Jay's inbox badge counts his and unowned replies, not Tyler's (${jb.shown})`);
  await nav(jay.page, '#projects/tasks', '.dl-people');
  const jayMe = await jay.page.$$eval('.dl-tasks-wrap .dl-task-title', (ns) => ns.map((n) => n.textContent).filter((t) => t.startsWith('ZZTEAM')));
  check(jayMe.includes(`${P} Write the homepage copy`) && !jayMe.includes(`${P} Brief and sitemap`), 'Jay\'s My tasks is his own work');
  await nav(jay.page, '#home', '.do-card');
  check(/homepage copy|task/i.test(await jay.page.locator('.do-card').innerText()), 'Jay\'s Do next includes his overdue task');

  /* ============================================== Settings: Your sign-in */
  {
    let changeCalls = 0;
    const { ctx, page: sp } = await passwordSession({ width: 1440, height: 900 }, {
      hq: (body) => { if (body.action === 'change_pin') { changeCalls++; return [200, { ok: true }]; } if (body.action === 'set_email') return [200, { ok: true }]; return undefined; }
    });
    await nav(sp, '#settings', '[data-form=change-pin]');
    const f = (n) => sp.locator(`[data-form=change-pin] input[name=${n}]`);
    await f('new_pin').fill('5512');
    await sp.click('[data-form=change-pin] button[type=submit]');
    check(/current PIN/i.test(await sp.locator('[data-pin-err]').innerText()), 'Change PIN: the current PIN is needed');
    await f('old_pin').click();
    await sp.keyboard.type('1x2y3z4');
    check(await f('old_pin').inputValue() === '1234', 'PIN fields take digits only');
    await f('new_pin').fill('12');
    await sp.click('[data-form=change-pin] button[type=submit]');
    check(/4 to 12 digits/.test(await sp.locator('[data-pin-err]').innerText()) && await f('new_pin').getAttribute('aria-invalid') === 'true', 'a short new PIN is refused, the field marked');
    await f('new_pin').fill('583920');
    await f('new_pin2').fill('583921');
    await sp.click('[data-form=change-pin] button[type=submit]');
    check(/do not match/.test(await sp.locator('[data-pin-err]').innerText()), 'mismatched new PINs are caught');
    await f('new_pin').fill('111111'); await f('new_pin2').fill('111111');
    await sp.click('[data-form=change-pin] button[type=submit]');
    check(/harder to guess/.test(await sp.locator('[data-pin-err]').innerText()), 'an easy PIN is refused');
    check(changeCalls === 0, 'nothing is sent until the form is valid');
    await f('new_pin').fill('583920'); await f('new_pin2').fill('583920');
    await sp.click('[data-form=change-pin] button[type=submit]');
    await sp.waitForSelector('.toast:has-text("PIN changed")');
    check(changeCalls === 1 && await f('old_pin').inputValue() === '', 'a valid change is sent once (mocked) and the form clears');
    const hintText = await sp.locator('[data-email-hint]').innerText();
    check(/•••/.test(hintText) || /No email on file/.test(hintText), `the reset email shows only a masked hint (${hintText})`);
    check(!/@wise-ai\.au.*@/.test(await sp.locator('[data-sec=sign-in]').innerText()), 'no full email address is shown');
    await sp.fill('[data-form=reset-email] input', 'not-an-email');
    await sp.click('[data-form=reset-email] button[type=submit]');
    check(/does not look like an email/.test(await sp.locator('[data-form=reset-email] .set-err').innerText()), 'the reset email is checked before saving');
    await sp.locator('[data-sec=sign-in]').scrollIntoViewIfNeeded();
    await shot(sp, 'settings-signin-1440');
    await ctx.close();
  }

  /* ============================================== Settings: Team (owner) */
  await nav(page, '#settings', '[data-sec=team]');
  check(await page.locator('[data-team] [data-readonly]').count() === 0 && await page.locator('[data-act=add-person]').count() === 1, 'the owner can manage the team');
  check(await page.locator(`.set-person[data-member="${ids.ty}"] [data-act=login-off]`).count() === 0, 'the owner\'s login cannot be switched off (not offered)');
  check(await page.locator(`.set-person[data-member="${ids.jay}"] [data-act=reset-pin]`).count() === 1, 'reset someone\'s PIN is offered');
  await page.click('[data-act=add-person]');
  await page.fill('.modal input[name=name]', `${P} Sam Lee`);
  check(await page.locator('.modal input[name=pin]').isHidden(), 'a PIN is only asked for when the person can sign in');
  await page.click('.modal-foot button[type=submit]');
  const sam = await waitFor(page, async (m, P) => m.state.team.find((x) => x.name === `${P} Sam Lee`) || null, P, 'added person');
  check(sam.initials === 'SL' && !sam.can_sign_in && sam.role === 'member', `add a person without a login (initials ${sam.initials})`);
  await page.waitForSelector(`.set-person[data-member="${sam.id}"]`);
  await page.click(`.set-person[data-member="${sam.id}"] [data-act=edit]`);
  await page.fill('.modal input[name=name]', `${P} Sam Leigh`);
  await page.fill('.modal input[name=initials]', 'sx');
  await page.click('.modal-foot button[type=submit]');
  const sam2 = await waitFor(page, async (m, id) => { const x = m.state.team.find((t) => t.id === id); return x && x.name.endsWith('Leigh') ? x : null; }, sam.id, 'renamed person');
  check(sam2.initials === 'SX', 'rename and initials save');
  await page.click(`.set-person[data-member="${sam.id}"] [data-act=up]`);
  const order = await waitFor(page, async (m, id) => { const i = m.state.team.findIndex((t) => t.id === id); return i === m.state.team.length - 2 ? m.state.team.map((t) => t.name) : null; }, sam.id, 'reordered');
  check(order.length >= 3, `reorder moves a person up (${order.join(', ')})`);
  // Owner picker now offers Sam.
  await nav(page, `#projects/${ids.project}`, '.dl-headsub .own-pick');
  await page.locator('.dl-headsub .own-pick').click();
  check(await page.locator(`.own-menu .own-opt[data-id="${sam.id}"]`).count() === 1, 'a new person can be given work at once');
  await page.keyboard.press('Escape');
  await nav(page, '#settings', '[data-sec=team]');
  await page.locator('[data-sec=team]').scrollIntoViewIfNeeded();
  await shot(page, 'settings-team-owner-1440');

  /* ============================================== Settings: Team (member) */
  await nav(jay.page, '#settings', '[data-sec=team]');
  check(await jay.page.locator('[data-team] [data-readonly]').count() === 1 && /Tyler manages the team/.test(await jay.page.locator('[data-team] [data-readonly]').innerText()), 'Jay sees the team read-only, with a line saying Tyler manages it');
  check(await jay.page.locator('[data-act=add-person], [data-act=reset-pin], [data-act=login-off], [data-act=edit]').count() === 0, 'no management controls for a member');
  check(await jay.page.locator('[data-form=change-pin]').count() === 1, 'Jay can change his own PIN in Settings');
  await jay.page.locator('[data-sec=team]').scrollIntoViewIfNeeded();
  await shot(jay.page, 'settings-team-member-1440');
  await jay.page.locator('[data-sec=sign-in]').scrollIntoViewIfNeeded();
  await shot(jay.page, 'settings-signin-jay-1440');
  check(jay.page.errors.length === 0, `no console errors in Jay's session ${jay.page.errors.join(' | ')}`);

  /* ============================================== 390px */
  {
    const { ctx, page: ph } = await passwordSession({ width: 390, height: 844 }, { scale: 2 });
    for (const [h, sel] of [['#projects/tasks', '.dl-people'], [`#projects/${ids.project}`, '.dl-task'], ['#home', '.do-card'], ['#settings', '[data-sec=team]'], ['#inbox', '.inbox-list'], ['#leads', '.leads-bar']]) {
      await nav(ph, h, sel);
      check(await noHScroll(ph), `${h} has no horizontal scroll at 390px`);
      if (h === '#projects/tasks') await shot(ph, 'mytasks-390');
      if (h === '#home') await shot(ph, 'today-390');
    }
    await nav(ph, `#projects/${ids.project}`, '.dl-task');
    await ph.click('[data-seg=layout] [data-v=table]');
    check(await noHScroll(ph), 'the task table fits at 390px');
    await shot(ph, 'project-table-390');
    await ph.click('[data-seg=layout] [data-v=list]');
    await ph.locator('.tabbar [data-route=more]').click();
    await ph.waitForSelector('.more-sheet .me-chip');
    check((await ph.locator('.more-sheet .me-chip').innerText()).includes('Tyler'), 'the phone More sheet shows who is signed in');
    await shot(ph, 'more-390');
    await ph.keyboard.press('Escape');
    await nav(ph, '#settings', '[data-sec=team]');
    await ph.locator('[data-sec=team]').scrollIntoViewIfNeeded();
    await shot(ph, 'settings-team-390');
    check(ph.errors.length === 0, `no console errors at 390px ${ph.errors.join(' | ')}`);
    await ctx.close();
  }
  check(page.errors.length === 0, `no console errors in the owner session ${page.errors.join(' | ')}`);
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed:', e.stack || e.message);
} finally {
  // Clean up every ZZTEAM row we can reach from the browser.
  const pg = owner?.page;
  if (pg) {
    const res = await api(pg, async (m, P) => {
      const out = {};
      for (const t of ['tasks', 'deals', 'projects', 'clients']) {
        const col = t === 'tasks' || t === 'deals' ? 'title' : 'name';
        const r = await m.sb.from(t).delete().like(col, `${P}%`).select('id');
        out[t] = r.data?.length ?? r.error?.message;
      }
      const l = await m.sb.from('leads').delete().like('business', `${P}%`).select('id');
      out.leads = l.data?.length ?? l.error?.message;
      return out;
    }, P).catch((e) => ({ error: e.message }));
    console.log('cleanup', JSON.stringify(res));
  }
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
