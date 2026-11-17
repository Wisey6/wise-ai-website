// Wise AI OS shell tests: gate, login, routes, leads CRUD, CSV import, board,
// drawer, realtime, and screenshots at 375px and 1280px.
//
//   python3 -m http.server 8101 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=... node os/tests/shell.test.mjs
//   OS_TEST_PIN=... (optional) also unlocks once through the real PIN pad.
//
// Env: BASE (default http://127.0.0.1:8101), SHOTS (screenshot dir, optional).
// Every row this test creates is named "ZZTEST …" and deleted at the end.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8101';
const URL = `${BASE}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const PIN = process.env.OS_TEST_PIN;
const SHOTS = process.env.SHOTS || '';
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
if (!PASSWORD && !PIN) { console.error('Set OS_TEST_PASSWORD (and optionally OS_TEST_PIN).'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const rnd = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const mob = () => `04${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const e164 = (m) => `+61${m.slice(1)}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function signIn(p) {
  const res = await p.evaluate(async ({ email, password }) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { error } = await sb.auth.signInWithPassword({ email, password });
    return error ? error.message : 'ok';
  }, { email: EMAIL, password: PASSWORD });
  if (res !== 'ok') throw new Error(`sign-in failed: ${res}`);
}

async function reloadSignedIn(p) {
  await p.reload({ waitUntil: 'networkidle' });
  await signIn(p);
  await p.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
  await p.mouse.move(900, 500);
  await p.waitForTimeout(700);
}

async function cleanup(p) {
  return p.evaluate(async () => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const a = await sb.from('leads').delete().ilike('business', 'ZZTEST%').select('id');
    const b = await sb.from('events').delete().ilike('summary', '%zztest%').select('id');
    return { leads: a.data?.length ?? a.error?.message, events: b.data?.length ?? b.error?.message };
  });
}

try {
  /* ---------------------------------------------------------------- gate */
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.gate .gate-unlock', { timeout: 15000 });
  check(/\d/.test(await page.locator('.gate-clock').textContent()), 'gate shows a clock');
  check(await page.locator('.gate .pin-input').count() === 0, 'gate rests with no PIN field until the lock is clicked');
  await page.locator('.gate .gate-unlock').click();
  await page.waitForSelector('.gate .pin-input');
  check(await page.evaluate(() => document.activeElement?.classList.contains('pin-input')), 'clicking the lock opens and focuses the PIN field');
  check(await page.locator('.gate .pin-input').getAttribute('inputmode') === 'numeric'
    && await page.locator('.gate .pin-input').getAttribute('type') === 'password', 'PIN field is masked and numeric');
  await page.keyboard.type('a1b-2 c');
  check(await page.locator('.gate .pin-input').inputValue() === '12', 'PIN field accepts numbers only');
  await page.locator('.gate .pin-input').evaluate((n) => { n.value = '12x34'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  check(await page.locator('.gate .pin-input').inputValue() === '1234', 'pasted text is stripped to digits');
  await page.keyboard.press('Escape');
  check(await page.locator('.gate .pin-input').count() === 0 && await page.locator('.gate .gate-unlock').count() === 1, 'Escape returns to the resting lock');
  await page.keyboard.press('7');
  check(await page.locator('.gate .pin-input').inputValue() === '7', 'typing a digit on the resting screen opens the field with it');
  await page.keyboard.press('Backspace');
  check(await page.locator('.gate .pin-input').inputValue() === '', 'Backspace clears the digit');
  await shot(page, 'gate-1280');

  /* --------------------------------------------------------------- login */
  if (PIN) {
    await page.keyboard.type(PIN);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.shell', { timeout: 20000 });
    check(true, 'real PIN pad unlocks through hq-login');
    const dev = await page.evaluate(() => Boolean(localStorage.getItem('wiseos.device')));
    check(dev, 'device token stored after PIN login');
  } else {
    await signIn(page);
    await page.waitForSelector('.shell', { timeout: 20000 });
    check(true, 'password session boots the shell');
  }
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
  check(await page.locator('.gate').count() === 0, 'gate is removed after unlock');

  /* -------------------------------------------------------------- routes */
  for (const r of ['home', 'leads', 'inbox', 'campaigns', 'bookings', 'playbook', 'library', 'settings']) {
    const before = errors.length;
    await page.evaluate((h) => { location.hash = h; }, `#${r}`);
    await page.waitForTimeout(700);
    const ok = await page.locator('#view .page').count();
    const err = await page.locator('#view .err-card').count();
    check(ok > 0 && !err, `#${r} renders`);
    check(errors.length === before, `#${r} has no console errors${errors.length > before ? `: ${errors.slice(before).join(' | ')}` : ''}`);
    if (r === 'home' || r === 'leads') await shot(page, `${r}-1280`);
  }
  check(await page.locator('.nav-item[data-route="settings"].is-active').count() === 1, 'nav marks the active route');

  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('.do-list, .all-clear');
  check(await page.locator('section[aria-labelledby="do-next-h"]').count() === 1, 'Home shows the Do next card');

  /* ----------------------------------------------------- sidebar (dock) */
  const railState = () => page.locator('.rail').getAttribute('data-state');
  const viewX = async () => (await page.locator('#view').boundingBox()).x;
  await page.mouse.move(900, 500);
  await page.waitForTimeout(700);
  check(await railState() === 'dock', 'sidebar starts as the collapsed dock by default');
  check(Math.round((await page.locator('.rail').boundingBox()).width) === 64, 'dock is 64px wide');
  const x0 = await viewX();
  // Brushing past does not open it.
  await page.mouse.move(30, 420);
  await page.mouse.move(900, 500);
  await page.waitForTimeout(350);
  check(await railState() === 'dock', 'brushing past the dock does not expand it');
  // Hover expands as an overlay; the content does not move.
  await page.mouse.move(30, 420);
  await page.waitForTimeout(500);
  check(await railState() === 'peek', 'hovering the dock expands the sidebar');
  check(Math.round((await page.locator('.rail').boundingBox()).width) === 240, 'expanded sidebar is 240px');
  check(Math.abs((await viewX()) - x0) < 1, 'hover expansion overlays the content without shifting it');
  check(await page.locator('.rail-full .nav-group').count() === 5, 'expanded sidebar shows the grouped map');
  await page.mouse.move(900, 500);
  await page.waitForTimeout(120);
  check(await railState() === 'peek', 'sidebar waits before tucking away');
  await page.waitForTimeout(450);
  check(await railState() === 'dock', 'leaving the sidebar tucks it back into the dock');
  // Keyboard focus expands it; Escape tucks it away.
  await page.locator('.rail-full a[data-route="leads"]').focus();
  await page.waitForTimeout(300);
  check(await railState() === 'peek', 'keyboard focus in the sidebar expands it');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.rail-full')).opacity) === '1', 'focused sidebar labels are visible');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check(await railState() === 'dock', 'Escape tucks the sidebar away');
  // Planned items are not navigation.
  const soon = await page.evaluate(() => [...document.querySelectorAll('.rail-full .nav-item.is-soon')].map((n) => ({
    href: n.getAttribute('href'), dis: n.getAttribute('aria-disabled'), tab: n.tabIndex, tag: n.tagName
  })));
  check(soon.length === 1 && soon.every((s) => !s.href && s.dis === 'true' && s.tab === -1 && s.tag === 'SPAN'), `only Agents is planned: dimmed, disabled and not focusable (${soon.length})`);
  const live = await page.evaluate(() => [...document.querySelectorAll('.rail-full a.nav-item[data-route]')].map((n) => n.dataset.route));
  check(['pipeline', 'proposals', 'clients', 'projects', 'roi-reports', 'income', 'costs', 'runway', 'library'].every((r) => live.includes(r)), 'Sell, Deliver, Money and Library are live links in the sidebar');
  await page.mouse.move(30, 420);
  await page.waitForTimeout(500);
  const hashBefore = await page.evaluate(() => location.hash);
  await page.locator('.rail-full .nav-item.is-soon', { hasText: 'Agents' }).click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => location.hash)) === hashBefore, 'clicking a planned section does not navigate');
  const roiHref = await page.locator('.rail-full a.nav-item', { hasText: 'ROI calculator' }).getAttribute('href');
  check(roiHref === '../roi.html', 'ROI calculator links to the public page');
  await page.mouse.move(900, 500);
  await page.waitForTimeout(600);
  // `[` pins and unpins; the choice survives a reload.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('[');
  await page.waitForTimeout(400);
  check(await railState() === 'pinned', '[ pins the sidebar open');
  check((await viewX()) - x0 > 150, `pinned sidebar makes room for the content (${Math.round((await viewX()) - x0)}px)`);
  check(await page.locator('.rail-pin[aria-pressed="true"]').count() === 1, 'pin button reports pressed');
  await reloadSignedIn(page); // sessions are not persisted: sign in again after a reload
  check(await railState() === 'pinned', 'pinned sidebar persists across reload');
  check(await page.evaluate(() => localStorage.getItem('wiseos.nav')) === 'pinned', 'pin choice stored in wiseos.nav');
  await page.locator('.rail-pin').click();
  await page.mouse.move(900, 500);
  await page.waitForTimeout(600);
  check(await railState() === 'dock', 'pin button unpins back to the dock');
  await page.keyboard.press('[');
  await page.waitForTimeout(300);
  await page.keyboard.press('[');
  await page.waitForTimeout(300);
  await reloadSignedIn(page); // sessions are not persisted: sign in again after a reload
  check(await railState() === 'dock', 'unpinned choice persists across reload');
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForSelector('.leads-page');
  await page.locator('.leads-bar input[type=search]').focus();
  await page.keyboard.press('[');
  await page.waitForTimeout(300);
  check(await railState() === 'dock', '[ typed in a text field does not toggle the sidebar');
  await page.fill('.leads-bar input[type=search]', '');
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('.do-list, .all-clear');

  /* ---------------------------------------------------- command palette */
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal [role=combobox]');
  check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'combobox'), 'Ctrl+K opens the palette with the input focused');
  check(await page.locator('.pal-box[role=dialog][aria-modal=true] [role=listbox] [role=option]').count() > 5, 'palette lists sections and actions');
  const palLabels = await page.locator('.pal-opt .pal-label').allTextContents();
  check(['Pipeline', 'Clients', 'Income', 'Library', 'New deal', 'New invoice', 'New library entry'].every((l) => palLabels.includes(l)), 'palette lists the new sections and their actions');
  await page.keyboard.type('camp');
  const firstOpt = await page.locator('.pal-opt.is-sel .pal-label').textContent();
  check(firstOpt === 'Campaigns', `palette filters as you type (${firstOpt})`);
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.classList.contains('pal-input')), 'Tab stays inside the palette');
  await page.fill('.pal-input', 'zzzz-no-such-thing');
  check(await page.locator('.pal-empty:not([hidden])').count() === 1, 'palette shows an empty state');
  await page.fill('.pal-input', '');
  await page.keyboard.type('b');
  const opts = await page.locator('.pal-opt .pal-label').allTextContents();
  const target = opts.indexOf('Bookings');
  for (let i = 0; i < target; i++) await page.keyboard.press('ArrowDown');
  const active = await page.evaluate(() => document.getElementById(document.querySelector('.pal-input').getAttribute('aria-activedescendant'))?.textContent);
  check(target >= 0 && /Bookings/.test(active || ''), 'arrow keys move the active option');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check((await page.evaluate(() => location.hash)) === '#bookings' && await page.locator('.pal').count() === 0, 'Enter navigates and closes the palette');
  // The visible trigger: focus returns to it on Escape.
  await page.locator('.rail-full .nav-search').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pal [role=combobox]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check(await page.locator('.pal').count() === 0, 'Escape closes the palette');
  check(await page.evaluate(() => document.activeElement?.classList.contains('nav-search')), 'focus returns to the search trigger');
  await page.keyboard.press('Escape');
  await page.mouse.move(900, 500);
  await page.waitForTimeout(400);

  /* ------------------------------------------------------------ add lead */
  const tag = rnd();
  const m1 = mob();
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForSelector('.leads-page');
  await page.getByRole('button', { name: 'Add lead' }).first().click();
  await page.waitForSelector('.modal');
  await page.waitForTimeout(150); // let the modal take focus first
  await page.fill('.modal [name=business]', `ZZTEST Plumbing ${tag}`);
  await page.fill('.modal [name=contact_name]', 'Dave Test');
  await page.fill('.modal [name=phone]', m1);
  await page.fill('.modal [name=suburb]', 'Paddington');
  await page.fill('.modal [name=number_source_url]', 'https://example.com/listing');
  await page.fill('.modal [name=hook]', 'saw your reviews mention quick call-backs');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.drawer', { timeout: 10000 });
  check((await page.locator('.drawer .h1').textContent()).includes(`ZZTEST Plumbing ${tag}`), 'add lead opens its drawer');
  const preview = await page.locator('.ld-personal .msg.out').textContent();
  check(preview.length > 10, `drawer previews the first text (${preview.slice(0, 60)}…)`);
  await shot(page, 'drawer-1280');

  /* -------------------------------------------- status change via drawer */
  await page.selectOption('.drawer select[name=status]', 'interested');
  await page.waitForTimeout(1200);
  const st1 = await page.evaluate(async (phone) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { data } = await sb.from('leads').select('status').eq('phone', phone).single();
    return data?.status;
  }, e164(m1));
  check(st1 === 'interested', `status changes via drawer (db: ${st1})`);
  check(await page.locator('.drawer [data-act=create-deal]').count() === 1 && await page.locator('.drawer [data-act=make-client]').count() === 1, 'an interested lead offers Create deal and Make client');

  // ROI estimator writes est_monthly_value and pain.
  await page.click('.roi summary');
  await page.fill('[name=roi-missed]', '4');
  await page.fill('[name=roi-job]', '500');
  await page.fill('[name=roi-close]', '50');
  await page.getByRole('button', { name: 'Use this estimate' }).click();
  await page.waitForTimeout(1200);
  const roi = await page.evaluate(async (phone) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { data } = await sb.from('leads').select('est_monthly_value,pain').eq('phone', phone).single();
    return data;
  }, e164(m1));
  check(Number(roi?.est_monthly_value) === Math.round((4 * 500 * 0.5 * 52) / 12), `ROI estimator saves $/month (${roi?.est_monthly_value})`);
  check(/enquir/.test(roi?.pain || ''), 'ROI estimator writes the pain line');

  // Log a note.
  await page.getByRole('tab', { name: 'Add a note' }).click();
  await page.fill('.drawer [name=log]', 'ZZTEST note from the test');
  await page.locator('.drawer .ld-section').filter({ hasText: 'Conversation' }).getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('.drawer .msg.log', { timeout: 8000 });
  check(true, 'note appears in the thread');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.drawer').count() === 0, 'Escape closes the drawer');

  /* --------------------------------------------- palette finds a lead */
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal [role=combobox]');
  await page.keyboard.type(`Plumbing ${tag}`);
  await page.waitForTimeout(150);
  const leadOpt = page.locator('.pal-group', { hasText: 'Leads' }).locator('.pal-opt', { hasText: `ZZTEST Plumbing ${tag}` });
  check(await leadOpt.count() === 1, 'palette finds a lead by business name');
  await page.fill('.pal-input', m1.slice(4));
  await page.waitForTimeout(150);
  check(await page.locator('.pal-opt', { hasText: `ZZTEST Plumbing ${tag}` }).count() === 1, 'palette finds a lead by phone digits');
  await page.fill('.pal-input', `Dave Test`);
  await page.waitForTimeout(150);
  const idx = (await page.locator('.pal-opt .pal-label').allTextContents()).indexOf(`ZZTEST Plumbing ${tag}`);
  for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.drawer', { timeout: 10000 });
  check(/^#leads\/[0-9a-f-]{36}$/.test(await page.evaluate(() => location.hash)) && (await page.locator('.drawer .h1').textContent()).includes(`ZZTEST Plumbing ${tag}`), 'choosing a lead in the palette opens it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ---------------------------------------------------------- CSV import */
  const mA = mob(); const mB = mob();
  const csv = [
    'Business,Contact,Mobile,Suburb,Listing',
    `ZZTEST Alpha ${tag},Amy,${mA},Ashgrove,`,
    `ZZTEST Bravo ${tag},Ben,"${mB.slice(0, 4)} ${mB.slice(4, 7)} ${mB.slice(7)}",Bardon,`,
    `ZZTEST Landline ${tag},Lou,(07) 3123 4567,Lutwyche,`,
    `ZZTEST Dupe ${tag},Dee,${mA},Doolandella,`,
    `ZZTEST Bad ${tag},Bo,12345,Bulimba,`
  ].join('\n');
  const csvPath = join(tmpdir(), `zztest-${tag}.csv`);
  writeFileSync(csvPath, csv);
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  await page.waitForSelector('.import-drop');
  await page.setInputFiles('#import-file', csvPath);
  await page.waitForSelector('.map-grid');
  check(await page.locator('[name=map-phone]').inputValue() === '2', 'import auto-maps the Mobile column');
  await page.fill('[name=batch-source]', 'https://example.com/zztest-directory');
  await shot(page, 'import-map-1280');
  await page.getByRole('button', { name: 'Check rows' }).click();
  await page.waitForSelector('.report');
  const count = async (k) => Number(await page.locator(`.report-cell[data-k="${k}"] b`).textContent());
  const c = { ready: await count('ready'), landline: await count('landline'), invalid: await count('invalid'), duplicate: await count('duplicate') };
  check(c.ready === 2 && c.landline === 1 && c.invalid === 1 && c.duplicate === 1, `import report counts ${JSON.stringify(c)}`);
  await shot(page, 'import-report-1280');
  await page.getByRole('button', { name: /Import 2 leads/ }).click();
  await page.waitForSelector('.report-cell[data-k="inserted"]', { timeout: 15000 });
  check(await page.locator('.report-cell[data-k="inserted"] b').textContent() === '2', 'import inserts 2 leads');
  await page.getByRole('button', { name: 'View imported leads' }).click();
  await page.waitForTimeout(500);
  check(await page.locator('.leads-table tbody tr').count() === 2, 'the "Just imported" filter shows the batch');

  /* --------------------------------------------------------------- board */
  await page.locator('.chip', { hasText: 'Just imported' }).click(); // clear batch filter
  await page.fill('.leads-bar input[type=search]', `ZZTEST Alpha ${tag}`);
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.waitForSelector('.board');
  const card = page.locator('.board-card', { hasText: `ZZTEST Alpha ${tag}` });
  await card.dragTo(page.locator('.board-col[data-status="replied"]'));
  await page.waitForTimeout(1500);
  const st2 = await page.evaluate(async (phone) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { data } = await sb.from('leads').select('status').eq('phone', phone).single();
    return data?.status;
  }, e164(mA));
  check(st2 === 'replied', `drag on the board changes status (db: ${st2})`);
  check(await page.locator('.board-col[data-status="replied"] .board-card', { hasText: `ZZTEST Alpha ${tag}` }).count() === 1, 'card moved to the Replied column');
  await page.fill('.leads-bar input[type=search]', '');
  await shot(page, 'board-1280');
  await page.getByRole('tab', { name: 'Table' }).click();

  /* ------------------------------------------------------------ realtime */
  const other = await ctx.browser().newContext();
  const p2 = await other.newPage();
  await p2.goto(URL, { waitUntil: 'networkidle' });
  await signIn(p2);
  const mR = mob();
  await page.waitForTimeout(1500);
  await p2.evaluate(async ({ name, phone }) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    await sb.from('leads').insert({ business: name, phone, source: 'manual', number_source_url: 'https://example.com' });
  }, { name: `ZZTEST Realtime ${tag}`, phone: e164(mR) });
  const arrived = await page.locator('.leads-table tbody tr', { hasText: `ZZTEST Realtime ${tag}` }).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check(arrived, 'a row inserted by a second client appears live');
  await other.close();

  /* ---------------------------------------------------------- bulk select */
  await page.fill('.leads-bar input[type=search]', `ZZTEST`);
  await page.waitForTimeout(300);
  await page.locator('.leads-table thead .check').check();
  check(await page.locator('.bulk-bar').count() === 1, 'bulk bar appears on selection');
  await page.locator('.bulk-bar select[name=bulk-status]').selectOption('queued');
  await page.waitForTimeout(1500);
  const queued = await page.evaluate(async () => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { data } = await sb.from('leads').select('status').ilike('business', 'ZZTEST%');
    return data.map((d) => d.status);
  });
  check(queued.length >= 4 && queued.every((s) => s === 'queued'), `bulk set status (${queued.join(',')})`);
  await page.fill('.leads-bar input[type=search]', '');

  /* ---------------------------------------------------------- 375px */
  await page.setViewportSize({ width: 375, height: 780 });
  for (const r of ['home', 'leads']) {
    await page.evaluate((h) => { location.hash = h; }, `#${r}`);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `#${r} has no horizontal scroll at 375px (${overflow})`);
    check(await page.locator('.tabbar').isVisible(), `tab bar visible on #${r} at 375px`);
    await shot(page, `${r}-375`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.lead-card .lead-name-btn').first().click();
  await page.waitForSelector('.drawer');
  await page.waitForTimeout(500);
  await shot(page, 'drawer-375');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More sections' }).click();
  await page.waitForSelector('.more-sheet');
  check(await page.locator('.more-sheet .nav-group').count() === 5, 'More sheet shows the grouped map');
  check(await page.locator('.more-sheet .nav-item.is-soon[href]').count() === 0, 'More sheet planned items are not links');
  const sheetRoutes = await page.$$eval('.more-sheet a.nav-item[data-route]', (ns) => ns.map((n) => n.dataset.route));
  check(['pipeline', 'proposals', 'clients', 'projects', 'roi-reports', 'income', 'costs', 'runway', 'library'].every((r) => sheetRoutes.includes(r)), 'More sheet lists every new section');
  await shot(page, 'more-375');
  await page.locator('.more-sheet a[data-route="settings"]').click();
  await page.waitForTimeout(600);
  check((await page.evaluate(() => location.hash)) === '#settings', 'More sheet navigates');
  await page.getByRole('button', { name: 'Lock' }).first().click().catch(() => {});
} catch (e) {
  fails.push(`exception: ${e.message}`);
  console.log('FAIL exception', e);
  await shot(page, 'failure').catch(() => {});
} finally {
  try {
    const p3 = await (await browser.newContext()).newPage();
    await p3.goto(URL, { waitUntil: 'networkidle' });
    await signIn(p3);
    console.log('cleanup', JSON.stringify(await cleanup(p3)));
  } catch (e) { console.log('cleanup failed', e.message); }
  await browser.close();
}

const relevantErrors = errors.filter((e) => !/favicon/.test(e));
check(relevantErrors.length === 0, `no console errors overall${relevantErrors.length ? `: ${relevantErrors.join(' | ')}` : ''}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
