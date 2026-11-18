// Wise AI assistant launcher: the "Ask Wise AI" pill at the bottom right (the white owl
// in a navy circle, the label, Ctrl+J), folding to the owl circle on phones, on scroll and
// while open; its working and answer-ready states; the band it keeps free; and its dropdown: the assistant's conversation, its history and quick rows.
// The agent function and the chat tables are always mocked here; nothing is sent and
// no record changes. (The full chat is covered by chat.test.mjs.)
//
//   python3 -m http.server 8186 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/agent-dock.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8186').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
const SHOTS = process.argv[2] || process.env.SHOTS || '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const P = 'ZZDOCK';
const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };

async function session(viewport, { connected = true, reducedMotion = 'no-preference', scale = 1 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion });
  const calls = [];
  await ctx.route('**/functions/v1/agent', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push(body);
    if (body.action === 'status') return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ configured: connected, enabled: connected, agents: { researcher: true, briefing: true, ask: true, doer: true }, spent_usd: 1.2, cap_usd: 25, runs_today: {}, limits: {} }) });
    if (body.agent === 'chat') return new Promise((res) => setTimeout(res, 900)).then(() => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, chat_id: '00000000-0000-4000-8000-0000000000d1', title: 'Invoices this month', message: { id: 777001, role: 'assistant', at: new Date().toISOString(), text: 'Two clients have not been invoiced this month.', steps: [], links: [{ label: 'Income', hash: '#income' }, { label: 'Bad', hash: 'javascript:alert(1)' }] }, changes: [], model: 'claude-sonnet-5-5', cost_usd: 0.01 }) }));
    return r.fulfill({ status: 403, headers: CORS, body: JSON.stringify({ ok: false, error: 'disabled' }) });
  });
  for (const t of ['agent_chats', 'agent_changes', 'agent_memory', 'agent_chat_messages']) {
    await ctx.route(`**/rest/v1/${t}*`, (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill({ status: 200, headers: CORS, body: '[]' })));
  }
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.calls = calls;
  await page.goto(URL, { waitUntil: 'networkidle' });
  return { ctx, page };
}
async function signIn(page) {
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.agents); i++) await new Promise((r) => setTimeout(r, 100)); });
  await page.waitForSelector('.agd-launch', { timeout: 10000 });
}
const ROUTES = ['home', 'leads', 'inbox', 'campaigns', 'bookings', 'pipeline', 'proposals', 'clients', 'projects', 'roi-reports', 'income', 'costs', 'runway', 'playbook', 'library', 'files', 'settings'];
/** Scrolled to the bottom: what readable or clickable things sit under the launcher. */
async function under(page) {
  await page.evaluate(() => { document.scrollingElement.scrollTop = 1e7; });
  await page.waitForTimeout(350);
  await page.evaluate(() => { document.scrollingElement.scrollTop = 1e7; });
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const L = document.querySelector('.agd-launch');
    if (!L || L.hidden || getComputedStyle(L).visibility === 'hidden') return [];
    const R = L.getBoundingClientRect(); const hits = new Set();
    for (let x = R.left + 2; x < R.right - 1; x += 6) for (let y = R.top + 2; y < R.bottom - 1; y += 6) {
      for (const e of document.elementsFromPoint(x, y)) {
        if (L.contains(e) || e === document.documentElement || e === document.body) continue;
        const hit = e.matches('a,button,input,select,textarea,label,[role=button],svg,img') || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (hit) hits.add(`${e.tagName.toLowerCase()}:${(e.textContent || '').trim().slice(0, 24)}`);
      }
    }
    return [...hits].slice(0, 4);
  });
}
const overlap = (a, b) => a && b && !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

let clientId = null;
try {
  /* -------------------------------------------------- lock screen, then sign in */
  const { ctx, page } = await session({ width: 1440, height: 900 });
  check(await page.locator('.gate').count() === 1 && await page.locator('.agd-launch').count() === 0, 'no launcher on the lock screen');
  await signIn(page);
  const L = page.locator('.agd-launch');
  check(await L.getAttribute('aria-label') === 'Ask Wise AI' && await L.getAttribute('aria-expanded') === 'false', 'launcher present after sign-in, named "Ask Wise AI"');
  check(await page.locator('.agd-launch .agd-orb .agd-mark .agd-owl img').count() === 1, 'the white owl sits in the navy circle');
  check((await page.locator('.agd-label').innerText()) === 'Ask Wise AI' && /^(Ctrl J|⌘J)$/.test(await page.locator('.agd-kbd').innerText()), `it says "Ask Wise AI" and shows its shortcut (${await page.locator('.agd-kbd').innerText()})`);
  check((await L.getAttribute('aria-keyshortcuts')).includes('Control+J') && await page.locator('#agd-tip[role=tooltip]').count() === 1 && await L.getAttribute('aria-describedby') === 'agd-tip', 'shortcut and tooltip are announced');
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.agd-ring')).animationName);
  check(/agd-breathe/.test(anim), `at rest a soft ring breathes (${anim})`);
  const lb = await L.boundingBox();
  check(lb.x + lb.width > 1440 - 40 && lb.y + lb.height > 900 - 40 && Math.round(lb.height) === 48 && lb.width > 140, `a pill at the bottom right (${Math.round(lb.x)},${Math.round(lb.y)} ${Math.round(lb.width)}x${Math.round(lb.height)})`);
  const bg = await L.evaluate((n) => [getComputedStyle(n).backgroundColor, getComputedStyle(n.querySelector('.agd-mark')).backgroundColor]);
  check(bg[0] === 'rgb(255, 255, 255)' && bg[1] === 'rgb(11, 30, 77)', `paper pill, navy circle (${bg})`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'closed-1440.png') });

  // open / close: click, Escape, '.', outside click, link
  await L.click();
  await page.waitForSelector('.agd-panel.is-in');
  check(await L.getAttribute('aria-expanded') === 'true' && await page.locator('.agd-panel[role=region][aria-labelledby=agd-title]').isVisible(), 'click opens a labelled panel; aria-expanded true');
  await page.waitForTimeout(300);
  const ob = await L.boundingBox(); const pnb = await page.locator('.agd-panel').boundingBox();
  check(Math.round(ob.width) <= 50 && await L.getAttribute('aria-label') === 'Close Wise AI', `open: it folds to the owl circle and reads "Close Wise AI" (${Math.round(ob.width)}px)`);
  check(pnb.y + pnb.height <= ob.y && pnb.x + pnb.width >= ob.x + ob.width - 1, 'the dropdown opens above it, aligned right');
  check(await page.locator('.agd-panel .cx.is-dock .cx-input').count() === 1 && await page.locator('.agd-panel [data-chat-empty]').isVisible(), 'the panel is the assistant: an empty conversation and a composer');
  check((await page.locator('.agd-for').innerText()) === 'New conversation', 'the header names the conversation');
  await page.keyboard.press('Escape');
  check(await page.locator('.agd-panel').isHidden() && await page.evaluate(() => document.activeElement?.classList.contains('agd-launch')), 'Escape closes and focus returns to the launcher');
  await page.locator('#view').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.mouse.click(700, 600);
  await page.keyboard.press('.');
  await page.waitForSelector('.agd-panel.is-in');
  check(true, 'the "." key opens it');
  await page.keyboard.press('Control+j');
  check(await page.locator('.agd-panel').isHidden(), 'Ctrl+J closes it');
  await page.keyboard.press('Control+j');
  check(await page.locator('.agd-panel').isVisible(), 'Ctrl+J opens it');
  await page.mouse.click(400, 700);
  check(await page.locator('.agd-panel').isHidden(), 'a click outside closes it');
  await L.press('Enter');
  check(await page.locator('.agd-panel').isVisible(), 'Enter on the launcher opens it');
  await L.focus(); await L.press('Space');
  check(await page.locator('.agd-panel').isHidden(), 'Space toggles it closed');
  // typing "." in a text field does not open it
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForSelector('.leads-bar input[type=search]');
  await page.fill('.leads-bar input[type=search]', '');
  await page.locator('.leads-bar input[type=search]').type('a.b');
  check(await page.locator('.agd-panel').isHidden() || !(await page.locator('.agd-panel').count()), 'typing "." in a field does not open it');
  await page.keyboard.press('Control+j');
  check(await page.locator('.agd-panel').isVisible(), 'Ctrl+J works from inside a field');
  await page.keyboard.press('Escape');
  await page.fill('.leads-bar input[type=search]', '');

  // Talk to it through the panel, mocked: the reply, its hub link only, the launcher busy meanwhile
  await L.click();
  await page.fill('.agd-panel .cx-input', 'Which clients have not been invoiced?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check(await L.evaluate((n) => n.classList.contains('is-busy')), 'while the assistant works the launcher says so (is-busy)');
  await page.waitForSelector('.agd-panel .cx-link');
  check((await page.locator('.agd-panel .cx-msg.is-agent .cx-text').innerText()).includes('Two clients'), 'the reply shows in the panel');
  check(await page.locator('.agd-panel .cx-link').count() === 1 && await page.locator('.agd-panel .cx-link').getAttribute('href') === '#income', 'hub links only (an unsafe link is dropped)');
  check(page.calls.some((c) => c.agent === 'chat' && c.message.startsWith('Which clients')), 'the message went to the (mocked) assistant');
  check((await page.locator('.agd-for').innerText()) === 'Invoices this month', 'the header takes the conversation title');
  // a typed draft survives a live update
  await page.fill('.agd-panel .cx-input', 'Make a task');
  await page.evaluate(async () => { const m = await window.__mod('api.js'); m.notify(); });
  await page.waitForTimeout(200);
  check(await page.locator('.agd-panel .cx-input').inputValue() === 'Make a task', 'typed text is kept through live updates');
  await page.fill('.agd-panel .cx-input', '');
  await page.click('[data-act=agd-history]');
  const quick = await page.$$eval('.agd-quick [data-quick]', (ns) => ns.map((n) => n.dataset.quick));
  check(JSON.stringify(quick) === JSON.stringify(['approvals', 'briefing', 'memory', 'research', 'agents']), `quick rows under the history (${quick})`);
  check((await page.locator('.agd-meta').innerText()).includes('Tyler') && /US\$1\.2\d of US\$25\.00/.test(await page.locator('.agd-meta').innerText()), 'who it works for and this month\'s spend');
  check(!page.calls.some((c) => c.agent === 'briefing'), 'the briefing never runs by itself');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'open-1440.png') });
  await page.click('[data-quick=agents]');
  await page.waitForFunction(() => location.hash === '#agents');
  check(await page.locator('.agd-panel').isHidden(), 'following a link inside closes the panel');

  // working while closed, then "Answer ready" until it is opened
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForTimeout(300);
  await L.click();
  await page.click('[data-act=agd-new]');
  await page.fill('.agd-panel .cx-input', 'And last month?');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(await L.getAttribute('data-state') === 'working' && (await page.locator('.agd-label').innerText()) === 'Working on it' && /working/.test(await L.getAttribute('aria-label')), 'closed while it works: "Working on it", a turning ring');
  const ring = await page.evaluate(() => getComputedStyle(document.querySelector('.agd-ring')).animationName);
  check(/agd-turn/.test(ring), `the ring turns while it works (${ring})`);
  await page.waitForFunction(() => document.querySelector('.agd-launch').dataset.state === 'ready', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  check(await L.evaluate((n) => n.classList.contains('is-ready')) && (await page.locator('.agd-label').innerText()) === 'Answer ready' && /answer ready/.test(await L.getAttribute('aria-label')) && await page.locator('.agd-dot').evaluate((n) => getComputedStyle(n).transform !== 'matrix(0, 0, 0, 0, 0, 0)'), 'a reply that lands while closed: "Answer ready" with a dot');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ready-1440.png') });
  await L.click();
  await page.waitForSelector('.agd-panel.is-in');
  check(await L.getAttribute('data-state') === 'open', 'opening it clears "Answer ready"');
  await page.keyboard.press('Escape');
  check(await L.getAttribute('data-state') === 'idle' && (await page.locator('.agd-label').innerText()) === 'Ask Wise AI', 'and it is back to "Ask Wise AI"');

  // folds to the owl circle while scrolling down a long page, opens again on the way up; tooltip when folded
  await page.evaluate(() => { location.hash = '#playbook'; });
  await page.waitForTimeout(700);
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 900); await page.waitForTimeout(400);
  check(await L.evaluate((n) => n.classList.contains('is-folded')) && Math.round((await L.boundingBox()).width) <= 50, 'scrolling down folds it to the owl circle');
  await L.hover(); await page.waitForTimeout(700);
  check(await page.locator('.agd-tip').evaluate((n) => getComputedStyle(n).opacity === '1') && /Ask Wise AI/.test(await page.locator('.agd-tip').innerText()), 'folded: hovering shows a tooltip with its name and shortcut');
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -400); await page.waitForTimeout(400);
  check(!(await L.evaluate((n) => n.classList.contains('is-folded'))), 'scrolling up brings the label back');

  // on the Agents page the assistant is the page: the launcher steps aside
  await page.evaluate(() => { location.hash = '#agents'; });
  await page.waitForSelector('.cx.is-page .cx-input');
  check(await L.isHidden(), 'hidden on the Agents page');
  await page.keyboard.press('Control+j');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cx-input') && !!document.activeElement.closest('.cx.is-page')), 'there Ctrl+J goes to the page’s own composer');
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForTimeout(300);
  check(await L.isVisible(), 'and it is back on the next page');

  // badge from proposed actions (state only; nothing written)
  await page.evaluate(async () => { const m = await window.__mod('api.js'); m.state.agent_actions.unshift({ id: 'zzdock-1', status: 'proposed', kind: 'note.add', payload: {} }, { id: 'zzdock-2', status: 'proposed', kind: 'note.add', payload: {} }); m.notify(); });
  await page.waitForTimeout(200);
  const before = await page.evaluate(async () => (await window.__mod('views/agents.js')).pendingActions().length);
  check(await page.locator('.agd-count').isVisible() && Number(await page.locator('.agd-count').innerText()) === before, `the launcher shows the approvals count (${before})`);
  await page.evaluate(async () => { const m = await window.__mod('api.js'); m.state.agent_actions = m.state.agent_actions.filter((a) => !String(a.id).startsWith('zzdock')); m.notify(); });

  // hidden behind modals and the palette; toasts start below it
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal');
  check(!(await L.isVisible()), 'hidden while the palette is open');
  await page.keyboard.press('Escape');
  const toastTop = await page.evaluate(() => { const t = document.querySelector('.toast-wrap'); return t ? parseFloat(getComputedStyle(t).top) : 0; });
  check(toastTop < lb.y - 200, `toasts stay at the top, clear of the launcher (${toastTop}px)`);

  // no overlap with each page's primary header button (an existing client, if any; nothing is created)
  const existingClient = await page.evaluate(async () => { const m = await window.__mod('api.js'); return m.state.clients[0]?.id || null; });
  for (const [vp, label] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 3440, height: 1440 }, '3440']]) {
    await page.setViewportSize(vp);
    for (const [hash, sel] of [['#home', '.home-hero .btn-primary'], ['#leads', '.page-head .btn-primary'], ...(existingClient ? [[`#clients/${existingClient}`, '.page-head .btn-primary']] : [])]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector(sel, { timeout: 10000 });
      await page.waitForTimeout(300);
      const a = await page.locator('.agd-launch').boundingBox();
      const b = await page.locator(sel).first().boundingBox();
      check(!overlap(a, b), `${label} ${hash.split('/')[0]}: the launcher clears the header button`);
    }
    if (label === '3440') {
      const a = await page.locator('.agd-launch').boundingBox();
      check(a.x + a.width > 3440 - 40 && a.y + a.height > 1440 - 40, '3440: stays at the bottom right of the viewport');
      if (SHOTS) { await page.screenshot({ path: join(SHOTS, 'closed-3440.png') }); await page.locator('.agd-launch').click(); await page.waitForSelector('.agd-panel.is-in'); await page.waitForTimeout(400); await page.screenshot({ path: join(SHOTS, 'open-3440.png') }); await page.keyboard.press('Escape'); }
    }
  }
  // every route, scrolled to the end: nothing readable or clickable is left under it
  for (const [vp, label] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 3440, height: 1440 }, '3440']]) {
    await page.setViewportSize(vp);
    const bad = [];
    for (const r of ROUTES) {
      await page.evaluate((h) => { location.hash = h; }, `#${r}`);
      await page.waitForTimeout(600);
      const u = await under(page);
      if (u.length) bad.push(`${r}: ${u.join(', ')}`);
    }
    check(!bad.length, `${label}: on every page the end of the page clears the launcher ${bad.join(' | ')}`);
  }
  check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
  await ctx.close();

  /* -------------------------------------------------- not connected */
  {
    const { ctx: c2, page: p2 } = await session({ width: 1440, height: 900 }, { connected: false });
    await signIn(p2);
    await p2.click('.agd-launch');
    await p2.waitForSelector('.agd-panel.is-in');
    check(await p2.locator('[data-agd-off]').count() === 1 && /not connected/.test(await p2.locator('[data-agd-off]').innerText()), 'not connected: one calm line');
    check(await p2.locator('[data-agd-off] a[href="#settings"]').count() === 1 && await p2.locator('.agd-panel textarea').count() === 0, 'a link to Settings and no dead controls');
    await c2.close();
  }

  /* -------------------------------------------------- reduced motion */
  {
    const { ctx: c3, page: p3 } = await session({ width: 1440, height: 900 }, { reducedMotion: 'reduce' });
    await signIn(p3);
    const a = await p3.evaluate(() => getComputedStyle(document.querySelector('.agd-ring')).animationName);
    check(a === 'none', `reduced motion: the ring holds still (${a})`);
    await c3.close();
  }

  /* -------------------------------------------------- phones */
  {
    const { ctx: c4, page: p4 } = await session({ width: 390, height: 844 }, { scale: 2 });
    await signIn(p4);
    const a = await p4.locator('.agd-launch').boundingBox();
    const tab = await p4.locator('.tabbar').boundingBox();
    check(Math.round(a.width) === 52 && Math.round(a.height) === 52 && a.y + a.height <= tab.y && a.x + a.width > 390 - 30, `390: the owl circle alone, 52px, bottom right above the tab bar (${Math.round(a.x)},${Math.round(a.y)} ${Math.round(a.width)}px)`);
    check(await p4.locator('.agd-launch').getAttribute('aria-label') === 'Ask Wise AI', '390: still named "Ask Wise AI"');
    const bad = [];
    for (const r of ROUTES) {
      await p4.evaluate((h) => { location.hash = h; }, `#${r}`);
      await p4.waitForTimeout(600);
      const u = await under(p4);
      if (u.length) bad.push(`${r}: ${u.join(', ')}`);
    }
    check(!bad.length, `390: on every page the end of the page clears the launcher ${bad.join(' | ')}`);
    await p4.evaluate(() => { location.hash = '#home'; document.scrollingElement.scrollTop = 0; });
    await p4.waitForTimeout(500);
    if (SHOTS) await p4.screenshot({ path: join(SHOTS, 'closed-390.png') });
    await p4.click('.agd-launch');
    await p4.waitForSelector('.agd-panel.is-in');
    await p4.waitForTimeout(350);
    const pb = await p4.locator('.agd-panel').boundingBox();
    check(pb.width >= 388 && pb.y + pb.height <= tab.y + 1, `390: the panel is a full-width sheet above the tab bar (${JSON.stringify(pb)} tab ${tab.y})`);
    check(await p4.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390: no horizontal scroll');
    if (SHOTS) await p4.screenshot({ path: join(SHOTS, 'open-390.png') });
    await p4.keyboard.press('Escape');
    check(await p4.locator('.agd-panel').isHidden(), '390: Escape closes the sheet');
    check(p4.errors.length === 0, `390: no page errors ${p4.errors.join(' | ')}`);
    await c4.close();
  }
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed', e.stack);
} finally {
  if (clientId) {
    const { ctx, page } = await session({ width: 1280, height: 800 });
    await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
    const r = await page.evaluate(async (P) => { const { sb } = await window.__mod('api.js'); return (await sb.from('clients').delete().like('name', `${P}%`).select('id')).data?.length; }, P);
    console.log('cleanup clients', r);
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
