// Settings > Connections: one row per connection (Google Drive, Email and calendar, Text
// messages, Bookings, AI model, and the two not built yet), each with a plain status and its
// one action. Every function call is answered here (statuses and actions are mocked), so no
// connection is changed and nothing is sent. Covers the deep link, the palette entry, the
// link from Agents, and what the owner and a team member each see.
//
//   python3 -m http.server 8185 --bind 127.0.0.1 &
//   BASE=http://127.0.0.1:8185/os/ OS_TEST_PASSWORD=… node os/tests/connections.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8185').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const FAKE_ADDR = ['zz.connections', 'example.org'].join('@');

const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const browser = await chromium.launch();

/**
 * cfg: { role, drive: {...status}, mail: {...status}, sms: {...}|null, ai: {...}|null }
 * Calls are recorded on page.calls as {fn, action}.
 */
async function session(cfg, { viewport = { width: 1440, height: 900 }, hash = '#home' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const calls = [];
  await ctx.route('**/functions/v1/**', (route) => answer(route).catch(() => {}));
  async function answer(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = req.url().split('/functions/v1/')[1].split(/[?/]/)[0];
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* */ }
    calls.push({ fn: name, action: body.action || null });
    if (name === 'hq-login' && (body.action === 'who' || body.action === 'me')) {
      const res = await route.fetch();
      const data = await res.json().catch(() => null);
      if (body.action === 'me' && data?.member && cfg.role) data.member = { ...data.member, role: cfg.role };
      return json(route, res.status(), data);
    }
    if (name === 'agent') {
      if (body.action === 'status' && cfg.ai !== null) return json(route, 200, { configured: true, enabled: true, agents: {}, spent_usd: 1, cap_usd: 25, runs_today: {}, limits: {}, ...(cfg.ai || {}) });
      return json(route, body.action === 'status' ? 503 : 403, { error: 'mocked' });
    }
    if (name === 'sms-send') {
      if (body.action === 'status' && cfg.sms !== null) return json(route, 200, { configured: false, sent_today: 0, daily_cap: 40, window_open: true, ...(cfg.sms || {}) });
      return json(route, 503, { error: 'mocked' });
    }
    if (name === 'ai-assist') return json(route, 200, { configured: true, enabled: true, spent_usd: 0, cap_usd: 5 });
    if (name === 'gdrive') {
      const owner = (cfg.role || 'owner') === 'owner';
      if (body.action === 'status') return json(route, 200, { ok: true, configured: true, connected: false, can_connect: owner, owner_name: 'Tyler', ...(cfg.drive || {}) });
      if (body.action === 'connect_url') return owner ? json(route, 200, { ok: true, url: `${ROOT}/os/?fake-google-signin=1#settings`, expires_in: 600 }) : json(route, 403, { ok: false, error: 'owner_only', message: 'Only the owner can connect Google Drive.' });
      if (body.action === 'disconnect') { cfg.drive = { ...(cfg.drive || {}), connected: false, account: null, needs_reconnect: false }; return json(route, 200, { ok: true, connected: false }); }
      if (body.action === 'mail_status') return json(route, 200, { ok: true, configured: true, connected: false, ...(cfg.mail || {}) });
      if (body.action === 'mail_connect_url') return json(route, 200, { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1&scope=gmail.readonly' });
      if (body.action === 'mail_disconnect') { cfg.mail = { ...(cfg.mail || {}), connected: false, email: null }; return json(route, 200, { ok: true, connected: false }); }
      return json(route, 403, { ok: false, error: 'mocked' });
    }
    return json(route, 403, { ok: false, error: 'mocked' });
  }
  // Google's sign-in page is never reached from a test.
  await ctx.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>fake google</p>' }));
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.calls = calls;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL + hash, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.smsChecked); i++) await new Promise((r) => setTimeout(r, 100)); });
  return { ctx, page };
}
const nav = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector('[data-connections]', { timeout: 15000 }); await page.waitForTimeout(600); };
const row = (page, key) => page.locator(`.con-row[data-conn="${key}"]`);
const rowState = (page, key) => row(page, key).getAttribute('data-state');
const rowText = (page, key) => row(page, key).innerText();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

try {
  /* ============================================ owner: nothing set up yet */
  {
    const cfg = { role: 'owner', drive: { configured: false, connected: false }, mail: { configured: true, connected: false }, sms: { configured: false }, ai: { configured: false } };
    const { ctx, page } = await session(cfg, { hash: '#settings/connections' });
    await page.waitForSelector('[data-connections]');
    await page.waitForFunction(() => !document.querySelector('.con-row[data-state="loading"]'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const keys = await page.evaluate(() => [...document.querySelectorAll('.con-row')].map((r) => r.dataset.conn).join(','));
    check(keys === 'drive,mail,sms,cal,ai,stripe,bank', `one row per connection, in order (${keys})`);
    const top = await page.evaluate(() => document.querySelector('[data-sec="connections"]').getBoundingClientRect().top);
    check(top >= -12 && top < 120, `#settings/connections opens at the Connections section (top ${Math.round(top)})`);
    check(await rowState(page, 'drive') === 'needs-setup' && /Needs setup/.test(await rowText(page, 'drive')), 'Drive not set up: Needs setup');
    await row(page, 'drive').locator('[data-act=how]').click();
    const driveSteps = await row(page, 'drive').locator('.con-steps').innerText();
    check(/GOOGLE_CLIENT_ID/.test(driveSteps) && /GOOGLE_CLIENT_SECRET/.test(driveSteps) && /functions\/v1\/gdrive/.test(driveSteps), 'Drive steps name the two Google secrets and the redirect address');
    check(await rowState(page, 'mail') === 'not-connected' && await row(page, 'mail').locator('[data-act=mail-connect]').isVisible(), 'Email not connected: Connect is offered');
    check(/Nothing is sent until you press Send/.test(await rowText(page, 'mail')), 'Email row says plainly what it can do');
    check(await rowState(page, 'sms') === 'needs-setup', 'Text messages not set up: Needs setup');
    const how = row(page, 'sms').locator('[data-act=how]');
    check(await how.getAttribute('aria-expanded') === 'false' && !(await row(page, 'sms').locator('.con-steps').isVisible()), 'steps start folded');
    await how.click();
    check(await how.getAttribute('aria-expanded') === 'true', 'How to set up expands the steps');
    const smsSteps = await row(page, 'sms').locator('.con-steps').innerText();
    check(await row(page, 'sms').locator('.con-steps ol > li').count() === 5, 'Text messages: five numbered steps');
    check(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'Edge Functions', 'Secrets', 'functions/v1/twilio-webhook', 'Australian'].every((t) => smsSteps.includes(t)), 'Text messages steps: the three secrets in Supabase and the webhook address');
    check(/cannot send a text/i.test(await rowText(page, 'sms')), 'Text messages row says the assistant cannot send a text');
    check(await rowState(page, 'cal') === 'needs-setup' || await rowState(page, 'cal') === 'connected', 'Bookings row shows a status');
    check(await rowState(page, 'ai') === 'needs-setup', 'AI model without a key: Needs setup');
    await row(page, 'ai').locator('[data-act=how]').click();
    check(/ANTHROPIC_API_KEY/.test(await row(page, 'ai').locator('.con-steps').innerText()), 'AI steps name the secret');
    check(await row(page, 'ai').locator('a[href="#settings/agents"]').count() === 1, 'AI row links to the Agents settings');
    for (const k of ['stripe', 'bank']) {
      check(await rowState(page, k) === 'not-built' && /Not built yet/.test(await rowText(page, k)) && await row(page, k).locator('button, a, input').count() === 0, `${k}: Not built yet, with no controls`);
    }
    check(/Read-only payouts and invoices/.test(await rowText(page, 'stripe')) && /CommBank CSV import/.test(await rowText(page, 'bank')), 'the not-built rows say what they will be');
    check(await page.locator('[data-connections] input, [data-connections] textarea').count() === 0, 'nothing on the page asks for a key or password');
    check(await page.locator('[data-mail-row]').count() === 1 && await page.locator('[data-moved-mail] a[href="#settings/connections"]').count() === 1, 'one Email and calendar row; Your sign-in points to it');
    const copy = (await page.locator('[data-sec="connections"]').innerText());
    check(!/!/.test(copy), 'no exclamation marks');
    await shot(page, 'connections-owner-setup');
    // Connect for email goes to Google (mocked).
    await Promise.all([page.waitForURL(/accounts\.google\.com/, { timeout: 10000 }), row(page, 'mail').locator('[data-act=mail-connect]').click()]);
    check(page.calls.some((c) => c.action === 'mail_connect_url'), 'Email Connect asks for the person\'s own sign-in link');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }

  /* ============================================ owner: all connected */
  {
    const cfg = { role: 'owner', drive: { configured: true, connected: true, account: { name: 'ZZ Test Business' } }, mail: { configured: true, connected: true, email: FAKE_ADDR, can_read: true, can_draft: true, can_calendar: true }, sms: { configured: true, sent_today: 3, daily_cap: 40 }, ai: {} };
    const { ctx, page } = await session(cfg);
    await page.evaluate(async () => { const m = await window.__mod('api.js'); m.state.bookings = [...m.state.bookings, { id: 'zz-fake', cal_uid: 'zz-fake', starts_at: new Date().toISOString() }]; });
    await nav(page, '#settings/connections');
    await page.waitForFunction(() => document.querySelector('.con-row[data-conn="drive"]')?.dataset.state === 'connected', null, { timeout: 10000 }).catch(() => {});
    check(/Connected as/.test(await rowText(page, 'drive')) && /ZZ Test Business/.test(await rowText(page, 'drive')), 'Drive connected: Connected as the account');
    check(await rowState(page, 'mail') === 'connected' && (await rowText(page, 'mail')).includes(FAKE_ADDR), 'Email connected: shows the address');
    check(await rowState(page, 'sms') === 'connected' && /3 of 40 sent today/.test(await rowText(page, 'sms')), 'Text messages connected: today\'s count');
    check(await rowState(page, 'cal') === 'connected', 'Bookings: connected once a Cal.com booking has arrived');
    check(await rowState(page, 'ai') === 'connected' && /US\$1\.00 of US\$25\.00/.test(await rowText(page, 'ai')), 'AI model: connected, with spend of the cap');
    check(await page.locator('.con-row[data-state="connected"] [data-act=how]').count() === 0, 'connected rows offer no setup steps');
    await shot(page, 'connections-owner-connected');
    // Disconnect Drive: asks first, then shows Not connected with Connect.
    await row(page, 'drive').locator('[data-act=drive-disconnect]').click();
    await page.waitForSelector('.modal');
    check(/Disconnect Google Drive/.test(await page.locator('.modal').innerText()), 'Drive Disconnect asks first');
    await page.click('.modal button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.con-row[data-conn="drive"]')?.dataset.state === 'not-connected', null, { timeout: 10000 }).catch(() => {});
    check(page.calls.some((c) => c.fn === 'gdrive' && c.action === 'disconnect') && await rowState(page, 'drive') === 'not-connected', 'Drive Disconnect calls disconnect and the row shows Not connected');
    await Promise.all([page.waitForURL(/fake-google-signin=1/, { timeout: 10000 }), row(page, 'drive').locator('[data-act=drive-connect]').click()]);
    check(page.calls.some((c) => c.fn === 'gdrive' && c.action === 'connect_url'), 'Drive Connect asks for the sign-in link and goes to it');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }

  /* ============================================ owner: needs reconnecting */
  {
    const cfg = { role: 'owner', drive: { configured: true, connected: true, needs_reconnect: true, account: { name: 'ZZ Test Business' } }, mail: { configured: true, connected: true, needs_reconnect: true, email: FAKE_ADDR }, sms: { configured: true }, ai: {} };
    const { ctx, page } = await session(cfg);
    await nav(page, '#settings/connections');
    await page.waitForFunction(() => document.querySelector('.con-row[data-conn="drive"]')?.dataset.state === 'reconnect', null, { timeout: 10000 }).catch(() => {});
    check(/Needs reconnecting/.test(await rowText(page, 'drive')) && await row(page, 'drive').locator('[data-act=drive-connect]').innerText() === 'Reconnect', 'Drive lapsed: Needs reconnecting, with Reconnect');
    check(await rowState(page, 'mail') === 'reconnect' && /Needs reconnecting/.test(await rowText(page, 'mail')), 'Email lapsed: Needs reconnecting');
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }

  /* ============================================ a team member */
  {
    const cfg = { role: 'member', drive: { configured: true, connected: false, can_connect: false, owner_name: 'Tyler' }, mail: { configured: true, connected: false }, sms: { configured: false }, ai: { configured: false } };
    const { ctx, page } = await session(cfg);
    await nav(page, '#settings/connections');
    await page.waitForFunction(() => document.querySelector('.con-row[data-conn="drive"]')?.dataset.state === 'not-connected', null, { timeout: 10000 }).catch(() => {});
    check(await row(page, 'drive').locator('[data-act=drive-connect], [data-act=drive-disconnect]').count() === 0 && /Only Tyler can connect it/.test(await rowText(page, 'drive')), 'member: Drive has no Connect, and says who can');
    check(await row(page, 'mail').locator('[data-act=mail-connect]').isVisible(), 'member: can connect their own email');
    check(await row(page, 'sms').locator('[data-act=how]').count() === 0 && /can set this up/.test(await rowText(page, 'sms')), 'member: no setup steps for Text messages, says who can');
    check(await row(page, 'ai').locator('[data-act=how]').count() === 0, 'member: no setup steps for the AI model');
    await shot(page, 'connections-member');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }

  /* ============================================ palette and the Agents link */
  {
    const cfg = { role: 'owner', drive: { configured: true, connected: true, account: { name: 'ZZ Test Business' } }, sms: { configured: true }, ai: {} };
    const { ctx, page } = await session(cfg);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.pal [role=combobox]');
    await page.keyboard.type('Connections');
    await page.waitForTimeout(150);
    check(await page.locator('.pal-opt.is-sel .pal-label').innerText() === 'Connections', 'the palette offers Connections');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-connections]', { timeout: 10000 });
    check(await page.evaluate(() => location.hash) === '#settings/connections', 'the palette entry opens #settings/connections');
    await page.evaluate(() => { location.hash = '#agents'; });
    await page.waitForSelector('[data-conn-link]', { timeout: 15000 });
    check(await page.locator('[data-conn-link]').getAttribute('href') === '#settings/connections', 'the Agents page links quietly to Connections');
    await page.click('[data-conn-link]');
    await page.waitForSelector('[data-connections]', { timeout: 10000 });
    check(true, 'the Agents link opens Connections');
    // Phone: rows stack and still read.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390: no horizontal scroll on Connections');
    await shot(page, 'connections-390');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close();
  }
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed', e.stack);
} finally {
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
