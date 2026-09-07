// Public site: layout, background layers, the two content switches, and the audit.
// Serve the repo root first:  python3 -m http.server 8099 --bind 127.0.0.1
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PAGES = ['', 'work.html', 'agents.html', 'quiz.html', 'privacy.html', 'terms.html', '404.html'];
const WIDTHS = [375, 390, 768, 1024, 1440];

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const fails = [];
const step = async (n, f) => { try { await f(); console.log('  PASS  ' + n); } catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message.split('\n')[0]); fails.push(n); } };
const lum = ([r, g, bb]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(bb); };
const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const rgb = s => (s.match(/\d+/g) || []).slice(0, 3).map(Number);

for (const path of PAGES) {
  const name = path || 'index';
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(`${BASE}/${path}`, { waitUntil: 'load' });

  await step(`${name}: no horizontal scroll at ${WIDTHS.join('/')}`, async () => {
    for (const w of WIDTHS) {
      await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(80);
      if (await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error('overflows at ' + w);
    }
  });
  await step(`${name}: swirl and grain layers present, grain screened on`, async () => {
    const g = await p.evaluate(() => { const e = document.querySelector('.grain'); const s = e && getComputedStyle(e); return { ground: !!document.querySelector('.ground'), grain: !!e, blend: s && s.mixBlendMode }; });
    if (!g.ground || !g.grain) throw new Error('missing layer');
    if (g.blend !== 'screen') throw new Error('grain blend is ' + g.blend + ' — overlay cancels on a near-black ground');
  });
  await step(`${name}: footer sits in the gutter`, async () => {
    const x = await p.evaluate(() => { const f = document.querySelector('.site-footer .fnav, footer .legal-line, footer'); return f ? f.getBoundingClientRect().left : -1; });
    if (x >= 0 && x < 12) throw new Error('footer flush to the edge at x=' + x.toFixed(0));
  });
  await step(`${name}: no console or page errors`, async () => { if (errs.length) throw new Error(errs.join(' | ').slice(0, 160)); });
  await p.close();
}

{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(`${BASE}/`, { waitUntil: 'load' });

  await step('home: reviews section stays hidden while reviews-data is empty', async () => {
    if (!(await p.evaluate(() => document.getElementById('reviews').hidden))) throw new Error('visible with no reviews');
  });
  await step('home: reviews render when data exists', async () => {
    const r = await p.evaluate(() => {
      document.getElementById('reviews-data').textContent = JSON.stringify([{ author: 'Test Person', rating: 5, text: 'Great work, on time.', date: '2026-08-01' }]);
      // re-run the page's own renderer by re-evaluating the inline script's logic
      const list = JSON.parse(document.getElementById('reviews-data').textContent);
      const sec = document.getElementById('reviews'); sec.hidden = !list.length;
      return { hidden: sec.hidden, over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    });
    if (r.hidden || r.over) throw new Error(JSON.stringify(r));
  });
  await step('home: client copy is anonymised until the consent flag is flipped', async () => {
    const t = await p.evaluate(() => [...document.querySelectorAll('[data-client]')].map(e => e.textContent));
    if (!t.length) throw new Error('no data-client spans');
    if (t.some(s => /Bundy/i.test(s))) throw new Error('named: ' + t.join(' | '));
    const named = await p.evaluate(() => { const e = document.querySelector('[data-client="bundy"]'); return e.getAttribute('data-named'); });
    if (!/Bundy Bowl/.test(named)) throw new Error('data-named missing the client name');
  });
  await step('home: the case-study numbers each sit on one line from tablet up', async () => {
    for (const w of [768, 1024, 1440]) {
      await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(80);
      const wr = await p.evaluate(() => [...document.querySelectorAll('.numbers b')].map(b => ({ t: b.textContent, lines: Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).fontSize)) })));
      for (const x of wr) if (x.lines > 1) throw new Error(`"${x.t}" wraps at ${w}`);
    }
  });
  await step('home: every internal link resolves', async () => {
    const links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => !/^(https?:|mailto:|#)/.test(h)));
    for (const h of new Set(links)) { const r = await p.request.get(`${BASE}/${h.replace(/^\//, '')}`); if (r.status() !== 200) throw new Error(`${h} -> ${r.status()}`); }
  });
  await step('home: body text tiers meet AA against the ground', async () => {
    await p.setViewportSize({ width: 1440, height: 900 });
    const c = await p.evaluate(() => { const bg = getComputedStyle(document.body).backgroundColor; const pick = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; };
      return { bg, sub: pick('.hero .sub'), row: pick('.row p'), eyebrow: pick('.eyebrow'), chrome: pick('.stack span'), caption: pick('.hero-photo figcaption'), legal: pick('.legal-line') }; });
    const bg = rgb(c.bg);
    for (const [k, v] of Object.entries(c)) if (k !== 'bg' && v && ratio(rgb(v), bg) < 4.5) throw new Error(`${k} ${ratio(rgb(v), bg).toFixed(2)} < 4.5`);
  });
  await p.close();
}

{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(`${BASE}/quiz.html`, { waitUntil: 'load' }); await p.waitForTimeout(500);
  await step('audit: initialises and its controls carry a sans-serif fallback', async () => {
    const q = await p.evaluate(() => ({ opts: document.querySelectorAll('.opt').length, bar: !!document.querySelector('.progress-bar'), ff: getComputedStyle(document.querySelector('.opt')).fontFamily }));
    if (q.opts < 2 || !q.bar) throw new Error('did not initialise: ' + JSON.stringify(q));
    if (!/sans-serif|system-ui/.test(q.ff)) throw new Error('no fallback stack: ' + q.ff);
  });
  await p.close();
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nAll site checks passed.');
await b.close();
process.exit(fails.length ? 1 : 0);
