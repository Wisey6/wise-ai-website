// Wise AI command bar: a small "Ask Wise AI" pill centred at the bottom that widens into a
// long bar you type into; the conversation stacks above it; a reply that lands while it is
// closed shows briefly above the pill; clicking off folds it back to the pill.
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

async function session(viewport, { connected = true, reducedMotion = 'no-preference', scale = 1, replyMs = 900 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion });
  const calls = [];
  await ctx.route('**/functions/v1/agent', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push(body);
    if (body.action === 'status') return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ configured: connected, enabled: connected, agents: { researcher: true, briefing: true, ask: true, doer: true }, spent_usd: 1.2, cap_usd: 25, runs_today: {}, limits: {} }) });
    if (body.agent === 'chat') return new Promise((res) => setTimeout(res, replyMs)).then(() => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, chat_id: '00000000-0000-4000-8000-0000000000d1', title: 'Invoices this month', message: { id: 777001, role: 'assistant', at: new Date().toISOString(), text: 'Two clients have not been invoiced this month.', steps: [], links: [{ label: 'Income', hash: '#income' }, { label: 'Bad', hash: 'javascript:alert(1)' }] }, changes: [], model: 'claude-sonnet-5-5', cost_usd: 0.01 }) }));
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

const nav = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500); };
const box = (page, sel) => page.locator(sel).first().boundingBox();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `bar-${name}.png`) }); };

try {
  /* ---- desktop */
  {
    const { ctx, page } = await session({ width: 1440, height: 900 });
    check(await page.locator('.agd-launch').count() === 0, 'no bar on the lock screen');
    await signIn(page);
    await nav(page, '#leads');
    const l = await box(page, '.agd-launch');
    const mid = l.x + l.width / 2;
    const main = await box(page, '.main');
    check(Math.abs(mid - (main.x + main.width / 2)) < 40 && l.y + l.height > 900 - 70 && l.width < 280, `rest: a small pill centred at the bottom (${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.width)}x${Math.round(l.height)})`);
    check((await page.locator('.agd-launch').innerText()).includes('Ask Wise AI'), 'it says "Ask Wise AI"');
    check(await page.locator('.agd-panel').isHidden(), 'no conversation showing at rest');
    await shot(page, 'rest-1440');

    await page.keyboard.press('Control+j');
    await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-input');
    await page.waitForTimeout(450);
    const fe = await page.evaluate(() => document.activeElement?.classList.contains('cx-input') && !!document.activeElement.closest('.agd-dock'));
    check(fe, 'Ctrl+J opens it with the cursor in the bar');
    const bar = await box(page, '.agd-dock .cx-composer');
    check(bar.width >= 600 && bar.width <= 760 && Math.abs(bar.x + bar.width / 2 - mid) < 40 && bar.y + bar.height > 900 - 70, `open: a long bar in the same place (${Math.round(bar.width)} wide)`);
    await shot(page, 'open-empty-1440');

    await page.keyboard.type('Which clients have not been invoiced?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.agd-dock .cx-msg.is-you');
    check(await page.locator('.agd-dock .cx-msg.is-you').count() === 1, 'the message shows at once');
    await page.waitForSelector('.agd-dock .cx-msg.is-agent', { timeout: 8000 });
    const sheet = await box(page, '.agd-panel');
    const bar2 = await box(page, '.agd-dock .cx-composer');
    check(sheet.y + sheet.height <= bar2.y + 2 && Math.abs(sheet.width - bar2.width) < 24, 'the conversation stacks above the bar, same width');
    check(sheet.height <= 900 * 0.62, `only the recent part shows (${Math.round(sheet.height)}px)`);
    check(page.calls.some((c) => c.agent === 'chat'), 'one chat call went to the (mocked) function');
    await shot(page, 'open-convo-1440');

    await page.fill('.agd-dock .cx-input', 'half typed');
    await page.mouse.click(820, 70);
    await page.waitForTimeout(500);
    const l2 = await box(page, '.agd-launch');
    check(await page.locator('.agd-panel').isHidden() && l2 && l2.width < 280, 'clicking off folds it back to the small pill');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-msg.is-agent');
    check((await page.inputValue('.agd-dock .cx-input')) === 'half typed', 'reopening: the conversation is there and the typed text is kept');

    // a reply that lands while closed shows briefly above the pill
    await page.fill('.agd-dock .cx-input', 'And the total?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.mouse.click(820, 70);
    await page.waitForSelector('.agd-peek.is-in', { timeout: 8000 });
    const pk = await box(page, '.agd-peek');
    const l3 = await box(page, '.agd-launch');
    check(pk.y + pk.height <= l3.y + 2 && (await page.locator('.agd-peek-text').innerText()).length > 5, 'a reply that lands while closed shows above the pill');
    await shot(page, 'peek-1440');
    await page.click('.agd-peek');
    await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-msg.is-agent');
    await page.waitForTimeout(400);
    check(await page.locator('.agd-peek').isHidden(), 'clicking it opens the conversation');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check(await page.locator('.agd-panel').isHidden(), 'Escape closes it');

    // never over the inbox reply area
    await nav(page, '#inbox');
    const inbox = await box(page, '.page.inbox');
    const l4 = await box(page, '.agd-launch');
    check(inbox.y + inbox.height <= l4.y + 1, 'the inbox ends above the pill');
    await nav(page, '#agents');
    check(await page.locator('.agd-dock').isHidden(), 'hidden on the Agents page, where the chat is the page');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  /* ---- motion: the pill → bar shape, the reveal, the reader's place, the status line */
  {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { replyMs: 4600 });
    await signIn(page);
    await nav(page, '#leads');
    // the bar morphs from the pill: mid-way the bar is laid out at full width (nothing reflows)
    // and its skin is clipped to something between the pill and the bar
    const mid = await page.evaluate(async () => {
      document.querySelector('.agd-launch').click();
      await new Promise((r) => setTimeout(r, 90));
      const skin = document.querySelector('.agd-dock .agd-skin-edge');
      const clip = skin ? getComputedStyle(skin).clipPath : '';
      const w = document.querySelector('.agd-dock .cx-box')?.getBoundingClientRect().width || 0;
      return { clip, w, morphing: document.querySelector('.agd-dock').classList.contains('is-morphing') };
    });
    const left = Number((/inset\(\S+ (\S+)px/.exec(mid.clip) || [])[1] || 0);
    check(mid.morphing && mid.w > 600 && left > 4 && left < (mid.w - 200) / 2, `open: one shape grows out of the pill (mid-way: bar ${Math.round(mid.w)} wide, skin inset ${Math.round(left)}px)`);
    await page.waitForFunction(() => !document.querySelector('.agd-dock').classList.contains('is-morphing'), null, { timeout: 2000 });
    check(await page.evaluate(() => document.querySelector('.agd-dock').dataset.presence) === 'listening', 'the owl listens while the bar has the cursor');
    // fill the conversation so it scrolls
    for (const q of ['First question', 'Second question', 'Third question']) {
      await page.fill('.agd-dock .cx-input', q);
      await page.keyboard.press('Enter');
      await page.waitForFunction((n) => document.querySelectorAll('.agd-dock .cx-msg.is-agent').length >= n, ['First question', 'Second question', 'Third question'].indexOf(q) + 1, { timeout: 9000 });
    }
    // the working line: a fixed-width clock, the words do not move as it ticks
    await page.fill('.agd-dock .cx-input', 'A fourth');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.agd-dock .cx-working');
    check(await page.evaluate(() => document.querySelector('.agd-dock').dataset.presence) === 'thinking', 'the owl shows it is thinking while it works');
    const w1 = await page.evaluate(() => { const t = document.querySelector('.agd-dock .cx-working-text').getBoundingClientRect(); return { x: t.x, clock: document.querySelector('.agd-dock .cx-working-time').textContent }; });
    // the reader scrolls up to read while it works
    await page.evaluate(() => { document.querySelector('.agd-dock .cx-scroll').scrollTop = 0; });
    await page.waitForTimeout(2300);
    const w2 = await page.evaluate(() => { const t = document.querySelector('.agd-dock .cx-working-text').getBoundingClientRect(); return { x: t.x, clock: document.querySelector('.agd-dock .cx-working-time').textContent }; });
    check(w1.clock !== w2.clock && Math.abs(w1.x - w2.x) < 0.5 && /^\d:\d\d$/.test(w2.clock), `the status line ticks without shifting (${w1.clock} → ${w2.clock}, x ${w1.x.toFixed(1)} → ${w2.x.toFixed(1)})`);
    await page.waitForFunction(() => document.querySelectorAll('.agd-dock .cx-msg.is-agent').length >= 4, null, { timeout: 9000 });
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => { const s = document.querySelector('.agd-dock .cx-scroll'); return { top: s.scrollTop, gap: s.scrollHeight - s.scrollTop - s.clientHeight, chip: !document.querySelector('.agd-dock .cx-newchip').hidden }; });
    check(kept.top < 24 && kept.gap > 200 && kept.chip, `a reply that lands while you read further up does not pull you down; a "New reply" chip shows (scrollTop ${Math.round(kept.top)})`);
    // the words came in progressively and all of them arrive
    const rev = await page.evaluate(() => { const m = [...document.querySelectorAll('.agd-dock .cx-msg.is-agent')].pop(); const ws = [...m.querySelectorAll('.cx-text .cx-w')]; return { n: ws.length, text: m.querySelector('.cx-text').innerText }; });
    await page.waitForTimeout(900);
    const done = await page.evaluate(() => { const m = [...document.querySelectorAll('.agd-dock .cx-msg.is-agent')].pop(); return [...m.querySelectorAll('.cx-text .cx-w')].every((w) => getComputedStyle(w).opacity === '1'); });
    check(rev.n >= 5 && done && /Two clients have not been invoiced this month\./.test(rev.text), `the reply is revealed word by word and completes (${rev.n} words)`);
    await page.click('.agd-dock .cx-newchip');
    await page.waitForTimeout(700);
    const bottom = await page.evaluate(() => { const s = document.querySelector('.agd-dock .cx-scroll'); return { gap: s.scrollHeight - s.scrollTop - s.clientHeight, chip: !document.querySelector('.agd-dock .cx-newchip').hidden }; });
    check(bottom.gap < 4 && !bottom.chip, 'the chip takes you to the newest reply and goes');
    check(page.errors.length === 0, `motion: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  /* ---- reduced motion: fades only, nothing moves */
  {
    const { ctx, page } = await session({ width: 1440, height: 900 }, { reducedMotion: 'reduce' });
    await signIn(page);
    await nav(page, '#leads');
    const moved = await page.evaluate(async () => {
      const seen = new Set();
      const look = () => {
        for (const a of document.getAnimations()) {
          const kf = a.effect?.getKeyframes?.() || [];
          if (a.playState === 'running' && kf.some((k) => (k.transform && k.transform !== 'none' && !/^translate\(-50%, ?0(px)?\)$/.test(k.transform)) || k.clipPath)) seen.add(`${a.animationName || a.effect.target?.className || '?'}:${kf.map((k) => k.transform || k.clipPath).join('>')}`);
        }
      };
      document.querySelector('.agd-launch').click();
      for (let i = 0; i < 20; i++) { look(); await new Promise((r) => requestAnimationFrame(r)); }
      return [...seen];
    });
    check(moved.length === 0, `reduced motion: opening moves nothing, it fades (${moved.join(' | ') || 'no transforms'})`);
    await page.fill('.agd-dock .cx-input', 'Reduced');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.agd-dock .cx-msg.is-agent', { timeout: 8000 });
    const rm = await page.evaluate(() => ({
      words: document.querySelectorAll('.agd-dock .cx-w').length,
      you: getComputedStyle(document.querySelector('.agd-dock .cx-msg.is-you')).animationName,
      ring: getComputedStyle(document.querySelector('.agd-dock .agd-bar-orb .agd-arc')).animationName
    }));
    check(rm.words === 0 && /^(none|mo-fade)$/.test(rm.you) && rm.ring === 'none', `reduced motion: the reply is there at once, arrivals fade, nothing turns (${JSON.stringify(rm)})`);
    await ctx.close();
  }
  /* ---- phone */
  {
    const { ctx, page } = await session({ width: 390, height: 844 });
    await signIn(page);
    await nav(page, '#leads');
    const tab = await box(page, '.tabbar, .dock-tabs, nav.tabs, .mnav');
    const l = await box(page, '.agd-launch');
    check(!tab || l.y + l.height <= tab.y + 1, '390: the pill sits above the tab bar');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-input');
    await page.waitForTimeout(450);
    const bar = await box(page, '.agd-dock .cx-composer');
    const hs = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(bar.width >= 340 && !hs, '390: the bar is full width, no sideways scroll');
    await shot(page, 'open-390');
    check(page.errors.length === 0, `390: no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  /* ---- ultrawide */
  {
    const { ctx, page } = await session({ width: 3440, height: 1440 });
    await signIn(page);
    await nav(page, '#leads');
    await page.click('.agd-launch');
    await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-input');
    await page.waitForTimeout(450);
    const bar = await box(page, '.agd-dock .cx-composer');
    const main = await box(page, '.main');
    check(bar.width <= 760 && Math.abs(bar.x + bar.width / 2 - (main.x + main.width / 2)) < 60, '3440: the bar stays a centred bar, not stretched');
    await shot(page, 'open-3440');
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
