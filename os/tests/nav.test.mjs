// Wise AI OS left navigation: open by default on wide screens and steady under the pointer;
// folded to an icon strip on request (remembered), where each group icon shows its pages in
// a flyout right beside it and no icon ever moves; folded by default from 761px to 1099px;
// phones keep the tab bar. Also: the command bar stays centred in the main area.
//
//   python3 -m http.server 8185 --bind 127.0.0.1 &
//   BASE=http://127.0.0.1:8185/os/ OS_TEST_PASSWORD=… node os/tests/nav.test.mjs [shots-dir]
//
// Edge function actions are mocked; status reads pass through. Nothing is written.
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

const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const READS = new Set(['status', 'mail_status']);

const browser = await chromium.launch();

async function session(viewport, { storage = null, hash = '#home' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  // The agent costs money: always answered here. Other functions: status reads pass, actions are refused here.
  await ctx.route('**/functions/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* */ }
    if (/\/functions\/v1\/agent\b/.test(req.url())) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ configured: true, enabled: true, agents: { researcher: true, briefing: true, ask: true, doer: true }, spent_usd: 1, cap_usd: 25, runs_today: {}, limits: {} }) });
    }
    if (READS.has(body.action)) return route.continue();
    return route.fulfill({ status: 403, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'mocked' }) });
  });
  await ctx.addInitScript((s) => {
    window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p));
    if (s && !sessionStorage.getItem('__seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); }
  }, storage);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL + hash, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me); i++) await new Promise((r) => setTimeout(r, 100)); });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const railState = (page) => page.locator('.rail').getAttribute('data-state');
const rect = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
const rects = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); }).join('|'), sel);
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500); };
const flyVisible = (page, g) => page.evaluate((g) => { const f = document.querySelector(`.rail-fly[data-fly="${g}"]`); return Boolean(f && !f.hidden && f.getBoundingClientRect().width > 0); }, g);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
async function barCentred(page, tag) {
  const l = await rect(page, '.agd-launch');
  const m = await rect(page, '.main');
  check(l && m && Math.abs((l.x + l.w / 2) - (m.x + m.w / 2)) < 4, `${tag}: the command bar is centred in the main area (${l && Math.round(l.x + l.w / 2)} vs ${m && Math.round(m.x + m.w / 2)})`);
}

try {
  /* ============================================================== 1440 */
  {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { hash: '#leads' });
    check(await railState(page) === 'open', '1440: the sidebar is open by default');
    const rail = await rect(page, '.rail');
    check(Math.round(rail.w) === 240, `1440: open sidebar is a fixed 240px (${Math.round(rail.w)})`);
    check(await page.locator('.rail-full .nav-group').count() === 5, '1440: the open list shows every group');
    check(await page.locator('.rail-full a.nav-item[data-route="leads"][aria-current="page"]').count() === 1, '1440: the current page is marked');
    check(await page.locator('.rail-full .nav-sub > .icon').count() === 0 && await page.locator('.rail-full .nav-group-label .icon').count() === 5, '1440: group headings carry the icons, page rows are clean text');
    await page.waitForSelector('.rail-full .me-chip:not([hidden])', { timeout: 10000 }).catch(() => {});
    const foot = await page.evaluate(() => ({ me: document.querySelectorAll('.rail-full .rail-foot .me-chip:not([hidden])').length, conn: document.querySelectorAll('.rail-full .rail-foot .conn').length, lock: document.querySelectorAll('.rail-full .rail-foot .btn-lock').length }));
    check(foot.me === 1 && foot.conn === 1 && foot.lock === 1, `1440: the sign-in block (who, Live, Lock) is kept (${JSON.stringify(foot)})`);
    check(await page.locator('.rail-full .nav-search').isVisible(), '1440: the search / jump to entry is there');
    const last = await rect(page, '.rail-full a.nav-item[data-route="settings"]');
    check(last && last.b <= 900, `1440: the whole map fits a 900px-tall screen (Settings ends at ${last && Math.round(last.b)})`);
    await page.waitForSelector('.agd-launch');
    await barCentred(page, '1440 open');
    await shot(page, 'nav-1440-open');

    // Nothing moves on hover in the open state.
    const before = await rects(page, '.rail, .rail-full .nav-item, .rail-full .nav-group-label, #view');
    for (const [x, y] of [[30, 420], [120, 200], [100, 600], [60, 800], [200, 100]]) { await page.mouse.move(x, y, { steps: 4 }); await page.waitForTimeout(150); }
    await page.waitForTimeout(500);
    check(await rects(page, '.rail, .rail-full .nav-item, .rail-full .nav-group-label, #view') === before, '1440: hovering the open sidebar moves nothing');
    check(await railState(page) === 'open' && await page.locator('.rail-fly:not([hidden])').count() === 0, '1440: hovering the open sidebar does not expand or fly out anything');

    // Collapse with the control; the choice is kept.
    const viewX0 = (await rect(page, '#view')).x;
    await page.click('.rail-toggle');
    await page.waitForTimeout(400);
    check(await railState(page) === 'collapsed', '1440: the collapse control folds the sidebar');
    check(Math.round((await rect(page, '.rail')).w) === 64, '1440: folded it is the 64px icon strip');
    check((await rect(page, '#view')).x < viewX0 - 100, '1440: the content takes the room back');
    check(await page.evaluate(() => localStorage.getItem('wiseos.sidebar')) === 'collapsed', '1440: the choice is stored in wiseos.sidebar');
    check(await page.evaluate(() => document.activeElement?.matches('.dock-expand')), '1440: focus moves to the expand control');
    await page.mouse.move(900, 500);
    await page.waitForTimeout(300);
    await barCentred(page, '1440 collapsed');
    await go(page, '#pipeline');
    await go(page, '#home');
    check(await railState(page) === 'collapsed', '1440: still folded after moving between pages');

    // Folded: hover a group icon → its flyout, right beside it, nothing moves.
    const icons0 = await rects(page, '.rail-dock .dock-item');
    const grow = await rect(page, '.dock-area[data-area="Grow"]');
    await page.mouse.move(grow.x + grow.w / 2, grow.y + grow.h / 2, { steps: 3 });
    await page.waitForTimeout(80);
    check(!(await flyVisible(page, 'Grow')), 'folded: a short intent delay before the flyout opens');
    await page.waitForTimeout(250);
    check(await flyVisible(page, 'Grow'), 'folded: hovering Grow shows its flyout');
    const box = await rect(page, '.rail-fly[data-fly="Grow"] .rail-fly-box');
    const fly = await rect(page, '.rail-fly[data-fly="Grow"]');
    check(fly.x <= grow.r + 1 && box.x >= 60 && box.x <= 72 && Math.abs(box.y - grow.y) < 16, `folded: the flyout sits right beside the Grow icon (box ${Math.round(box.x)},${Math.round(box.y)}; icon ${Math.round(grow.r)},${Math.round(grow.y)})`);
    const flyText = await page.locator('.rail-fly[data-fly="Grow"]').innerText();
    check(/Grow/i.test(flyText) && ['Leads', 'Inbox', 'Campaigns', 'Bookings'].every((t) => flyText.includes(t)), 'folded: the flyout names the group and lists its pages');
    check(await rects(page, '.rail-dock .dock-item') === icons0 && Math.round((await rect(page, '.rail')).w) === 64, 'folded: no icon moves and the strip does not widen');
    check(await page.getAttribute('.dock-area[data-area="Grow"]', 'aria-expanded') === 'true', 'folded: the icon reports its flyout open');
    await shot(page, 'nav-1440-flyout');
    // Diagonal travel to the last page passes over the Sell icon: the flyout stays.
    const bookings = await rect(page, '.rail-fly[data-fly="Grow"] a[data-route="bookings"]');
    const sell = await rect(page, '.dock-area[data-area="Sell"]');
    const from = [grow.x + grow.w / 2, grow.y + grow.h / 2 + 8];
    const to = [bookings.x + 30, bookings.y + bookings.h / 2];
    const N = 10;
    for (let i = 1; i <= N; i++) { await page.mouse.move(from[0] + (to[0] - from[0]) * i / N, from[1] + (to[1] - from[1]) * i / N); await page.waitForTimeout(16); }
    await page.waitForTimeout(250);
    check(await flyVisible(page, 'Grow') && !(await flyVisible(page, 'Sell')), `folded: moving diagonally into the flyout keeps it open (path crosses Sell at y ${Math.round(sell.y)})`);
    // A click on a page in the flyout goes there.
    await page.click('.rail-fly[data-fly="Grow"] a[data-route="campaigns"]');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => location.hash) === '#campaigns' && !(await flyVisible(page, 'Grow')), 'folded: clicking a page in the flyout goes there and closes it');
    check(await page.locator('.dock-area[data-area="Grow"].is-active').count() === 1, 'folded: the Grow icon is lit on a Grow page');
    // Leaving closes it.
    await page.mouse.move(900, 500);
    await page.locator('.dock-area[data-area="Money"]').hover();
    await page.waitForTimeout(350);
    check(await flyVisible(page, 'Money'), 'folded: hovering Money shows its flyout');
    await page.mouse.move(900, 500, { steps: 3 });
    await page.waitForTimeout(500);
    check(!(await flyVisible(page, 'Money')), 'folded: leaving closes the flyout');
    // Escape closes it.
    await page.locator('.dock-area[data-area="Know"]').hover();
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check(!(await flyVisible(page, 'Know')), 'folded: Escape closes the flyout');
    // Clicking a group icon goes to its first page.
    await page.click('.dock-area[data-area="Money"]');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => location.hash) === '#income', 'folded: clicking a group icon goes to its first page');
    // Single-page items show a tooltip, not a flyout.
    await page.mouse.move(900, 500);
    await page.waitForTimeout(300);
    await page.locator('.rail-dock .dock-item[data-route="home"]').hover();
    await page.waitForTimeout(450);
    check(await page.locator('.rail-tip:not([hidden])').innerText().catch(() => '') === 'Today' && await page.locator('.rail-fly:not([hidden])').count() === 0, 'folded: Today shows a tooltip only');
    await page.mouse.move(900, 500);
    await page.waitForTimeout(200);

    // Keyboard: arrows move along the strip, Enter opens a flyout, arrows move inside it.
    await page.keyboard.press('Shift');
    await page.locator('.rail-dock .dock-item[data-route="home"]').focus();
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.dataset.area) === 'Grow', 'keyboard: ArrowDown moves to the next icon');
    check(await flyVisible(page, 'Grow'), 'keyboard: focusing a group icon shows its flyout');
    await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.activeElement?.dataset.route) === 'leads', 'keyboard: Tab goes into the open flyout');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.dataset.area) === 'Sell', 'keyboard: on to Sell');
    await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.activeElement?.dataset.route) === 'pipeline' && await flyVisible(page, 'Sell'), 'keyboard: Enter opens the flyout at its first page');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.dataset.route) === 'proposals', 'keyboard: ArrowDown moves inside the flyout');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.activeElement?.dataset.area) === 'Sell' && !(await flyVisible(page, 'Sell')), 'keyboard: Escape closes it and returns to the icon');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => location.hash) === '#proposals', 'keyboard: Enter on a page goes there');

    // `[` opens it again; the choice is kept.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('[');
    await page.waitForTimeout(400);
    check(await railState(page) === 'open' && await page.evaluate(() => localStorage.getItem('wiseos.sidebar')) === 'open', '[ opens the sidebar and remembers it');
    await page.keyboard.press('[');
    await page.waitForTimeout(300);
    check(page.errors.length === 0, `1440: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  /* ---- the folded choice survives a new visit; the old key does not carry over */
  {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { storage: { 'wiseos.sidebar': 'collapsed' } });
    check(await railState(page) === 'collapsed', 'a folded choice is kept on the next visit');
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { storage: { 'wiseos.nav': 'dock' } });
    check(await railState(page) === 'open', 'the old "collapsed by default" setting does not carry over: open');
    await ctx.close();
  }

  /* ============================================================== 3440 */
  {
    const { ctx, page } = await session({ width: 3440, height: 1440 });
    check(await railState(page) === 'open', '3440: open by default');
    await page.waitForSelector('.today-grid');
    await page.waitForTimeout(400);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.today-grid')).gridTemplateColumns.split(' ').length);
    check(cols === 4, `3440: Today still shows four columns beside the open sidebar (${cols})`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '3440: no horizontal scroll');
    await page.waitForSelector('.agd-launch');
    await barCentred(page, '3440 open');
    await go(page, '#inbox');
    const inbox = await rect(page, '.page.inbox');
    check(inbox && inbox.b <= 1440 && inbox.x >= 240, `3440: the inbox fits beside the open sidebar (${inbox && Math.round(inbox.x)}..${inbox && Math.round(inbox.b)})`);
    await page.keyboard.press('[');
    await page.waitForTimeout(400);
    await barCentred(page, '3440 collapsed');
    await page.keyboard.press('[');
    check(page.errors.length === 0, `3440: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ============================================================== 1024 */
  {
    const { ctx, page } = await session({ width: 1024, height: 768 }, { storage: { 'wiseos.sidebar': 'open' } });
    check(await railState(page) === 'collapsed', '1024: the strip with flyouts is the default');
    const icons0 = await rects(page, '.rail-dock .dock-item');
    await page.locator('.dock-area[data-area="Deliver"]').hover();
    await page.waitForTimeout(350);
    check(await flyVisible(page, 'Deliver') && await rects(page, '.rail-dock .dock-item') === icons0, '1024: hovering shows the flyout and nothing moves');
    await page.mouse.move(700, 400);
    await page.waitForTimeout(400);
    await page.waitForSelector('.agd-launch');
    await barCentred(page, '1024 collapsed');
    await page.keyboard.press('[');
    await page.waitForTimeout(400);
    check(await railState(page) === 'open', '1024: [ opens it for now');
    check(await page.evaluate(() => localStorage.getItem('wiseos.sidebar')) === 'open', '1024: opening here does not change the wide-screen choice');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '1024: open, still no horizontal scroll');
    check(page.errors.length === 0, `1024: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* =============================================================== 390 */
  {
    const { ctx, page } = await session({ width: 390, height: 844 });
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.rail')).display) === 'none', '390: no sidebar');
    check(await page.locator('.tabbar').isVisible() && await page.locator('.tabbar .tab-item').count() === 5, '390: the bottom tab bar is unchanged');
    await page.click('.tabbar [data-route="more"]');
    await page.waitForSelector('.more-sheet');
    check(await page.locator('.more-sheet .nav-group').count() === 5, '390: More opens the full sheet');
    check(page.errors.length === 0, `390: no page errors ${page.errors.join(' | ')}`);
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
