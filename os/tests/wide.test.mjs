// Wise AI OS on wide screens (3440x1440 ultrawide, 2560x1080): every main route fills
// the width without a horizontal page scroll, reading text keeps its measure, Today
// shows four columns at 3440, and 1440 laptops are unchanged in spirit.
//
//   python3 -m http.server 8186 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… node os/tests/wide.test.mjs [shots-dir]
//
// Rows it creates are named "ZZWIDE …" and deleted at the end.
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
const P = 'ZZWIDE';
const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const DOCK = 64;

const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
async function session(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.route('**/functions/v1/agent', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ configured: true, enabled: true, agents: { researcher: true, briefing: true, ask: true, doer: true }, spent_usd: 0, cap_usd: 25, runs_today: {}, limits: {} }) })));
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me); i++) await new Promise((r) => setTimeout(r, 100)); });
  return { ctx, page };
}

const { ctx: c0, page: p0 } = await session({ width: 1440, height: 900 });
const ids = await p0.evaluate(async (P) => {
  const m = await window.__mod('api.js');
  const c = await m.saveRow('clients', { name: `${P} Harbour Dental`, status: 'active', monthly_value: 900 });
  const pr = await m.saveRow('projects', { name: `${P} Website rebuild`, client_id: c.id, status: 'active', value: 4800 });
  let i = 0;
  for (const t of ['Brief and sitemap', 'Homepage copy', 'Booking form', 'Clinic photos']) await m.saveRow('tasks', { title: `${P} ${t}`, project_id: pr.id, client_id: c.id, sort: ++i * 10 });
  const d = await m.saveRow('deals', { title: `${P} Coastal Physio`, stage: 'proposal', value: 3500, next_step: 'Call', next_step_on: new Date().toISOString().slice(0, 10) });
  const pm = await window.__mod('views/proposals.js');
  const prop = await pm.createProposalFromDeal(d);
  const lead = await m.saveLead(null, { business: `${P} Smith Plumbing`, status: 'replied', source: 'manual' });
  await m.sb.from('messages').insert({ lead_id: lead.id, channel: 'sms', direction: 'in', status: 'received', body: 'Hi, thanks for the text. We do miss a lot of calls when the team is on site. What would it cost to set up?' });
  return { client: c.id, project: pr.id, proposal: prop.id, lead: lead.id };
}, P);
await c0.close();

const ROUTES = [
  ['home', '#home', '.do-card', 'fill'], ['leads', '#leads', '.leads-bar', 'fill'], ['pipeline', '#pipeline', '.pipe-page', 'fill'],
  ['inbox', `#inbox/${ids.lead}`, '.inbox-thread', 'fill'], ['clients', '#clients', '.cl-table', 'fill'], ['client', `#clients/${ids.client}`, '.cl-h1', 'fill'],
  ['projects', '#projects', '.dl-groups', 'fill'], ['project', `#projects/${ids.project}`, '.dl-task', 'fill'], ['tasks', '#projects/tasks', '.dl-people', 'fill'],
  ['income', '#income', '.money-body', 'fill'], ['costs', '#costs', '.money-body', 'fill'], ['runway', '#runway', '.money-body', 'fill'],
  ['agents', '#agents', '.ag-main', 'fill'], ['library', '#library', '.lib-head', 'fill'], ['proposal', `#proposals/${ids.proposal}`, '.prop-sheet', 'fill'],
  ['settings', '#settings', '[data-sec=team]', 'any'], ['playbook', '#playbook', '.play-body', 'read'], ['bookings', '#bookings', '.page', 'any'], ['campaigns', '#campaigns', '.page', 'any']
];
const READING = '.play-body, .lib-doc, .prop-sheet, .pdoc-intro, .inbox-msg, .ag-turn.is-a, .money-how, .home-hero .lede, .camp-intro';

try {
  for (const vp of [{ width: 3440, height: 1440 }, { width: 2560, height: 1080 }]) {
    const { ctx, page } = await session(vp);
    const tag = `${vp.width}`;
    for (const [name, hash, sel, kind] of ROUTES) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector(sel, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      const m = await page.evaluate((READING) => {
        const pg = document.querySelector('#view .page');
        const wide = [...document.querySelectorAll(READING)].filter((n) => n.offsetParent).map((n) => Math.round(n.getBoundingClientRect().width));
        return { w: Math.round(pg.getBoundingClientRect().width), sw: document.documentElement.scrollWidth, read: Math.max(0, ...wide) };
      }, READING);
      check(m.sw <= vp.width + 1, `${tag} ${name}: no horizontal page scroll`);
      if (kind === 'fill') check(m.w >= 0.85 * (vp.width - DOCK), `${tag} ${name}: the page uses the width (${m.w}px of ${vp.width - DOCK})`);
      check(m.read <= 900, `${tag} ${name}: reading text keeps its measure (widest ${m.read}px)`);
      if (SHOTS && vp.width === 3440) await page.screenshot({ path: join(SHOTS, `${name}-${tag}.png`) });
    }
    await page.evaluate(() => { location.hash = '#home'; });
    await page.waitForSelector('.today-grid');
    await page.waitForTimeout(400);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.today-grid')).gridTemplateColumns.split(' ').length);
    if (vp.width === 3440) {
      check(cols === 4, `3440 Today shows four columns (${cols})`);
      const strips = await page.evaluate(() => [...document.querySelectorAll('.page.today > .kpi-strip')].map((n) => Math.round(n.getBoundingClientRect().top)));
      check(strips.length < 2 || strips[0] === strips[1], 'the number strips sit on one row');
    } else check(cols >= 3, `2560 Today shows at least three columns (${cols})`);
    // boards: all columns side by side, no scroll inside
    await page.evaluate(() => { location.hash = '#leads'; });
    await page.waitForSelector('.leads-bar');
    await page.click('.leads-bar [role=tab]:has-text("Board")');
    await page.waitForSelector('.board');
    const board = await page.evaluate(() => { const b = document.querySelector('.board'); return { sw: b.scrollWidth, cw: b.clientWidth }; });
    check(board.sw <= board.cw + 1, `${tag} leads board: every column visible, no sideways scroll`);
    await page.click('.leads-bar [role=tab]:has-text("Table")');
    // drawers keep their width
    await page.evaluate(() => { location.hash = '#pipeline'; });
    await page.waitForSelector('.pipe-page');
    const pb = await page.evaluate(() => { const b = document.querySelector('.pipe-board'); return b ? { sw: b.scrollWidth, cw: b.clientWidth } : { sw: 0, cw: 0 }; });
    check(pb.sw <= pb.cw + 1, `${tag} pipeline board: no sideways scroll`);
    // palette stays centred at its width
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.pal', { timeout: 5000 }).catch(() => {});
    const pal = await page.evaluate(() => { const n = document.querySelector('.pal-box'); const r = n?.getBoundingClientRect(); return r ? { w: r.width, mid: r.left + r.width / 2 } : null; });
    check(pal && pal.w <= 720 && Math.abs(pal.mid - window_mid(vp.width)) < 80, `${tag} the palette stays centred at its width`);
    await page.keyboard.press('Escape');
    check(page.errors.length === 0, `${tag} no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }
  // Laptop and phone: still fine.
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { ctx, page } = await session(vp);
    for (const [name, hash, sel] of ROUTES) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector(sel, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(250);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${vp.width} ${name}: no horizontal page scroll`);
    }
    await ctx.close();
  }
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log('FAIL crashed', e.stack);
} finally {
  const { ctx, page } = await session({ width: 1280, height: 800 });
  const res = await page.evaluate(async (P) => {
    const m = await window.__mod('api.js');
    const out = {};
    const props = await m.sb.from('proposals').delete().like('title', `${P}%`).select('id'); out.proposals = props.data?.length;
    for (const [t, col] of [['income', 'description'], ['tasks', 'title'], ['deals', 'title'], ['projects', 'name'], ['clients', 'name'], ['leads', 'business']]) {
      const r = await m.sb.from(t).delete().like(col, `${P}%`).select('id'); out[t] = r.data?.length ?? r.error?.message;
    }
    return out;
  }, P);
  console.log('cleanup', JSON.stringify(res));
  await ctx.close();
  await browser.close();
  console.log(`\n${passes.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
}
function window_mid(w) { return (w + DOCK) / 2; }
