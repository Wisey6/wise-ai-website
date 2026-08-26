import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8177';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PASS='interrupt-test-pass';
const b = await chromium.launch({ executablePath: CHROME, args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1440,height:1000} });
const fails=[];
p.on('pageerror', e => fails.push('PAGEERROR: '+e.message));
await p.goto(`${BASE}/admin/`, { waitUntil:'load' });
await p.fill('#passcode',PASS); await p.fill('#confirm',PASS);
await p.click('.gate button[type=submit]');
await p.waitForSelector('.shell');
await p.waitForFunction(() => document.documentElement.classList.contains('js-motion'), { timeout:6000 });

// seed enough to render every surface
await p.click('a[href="#clients"]'); await p.waitForTimeout(300);
await p.click('.empty button'); await p.waitForSelector('.modal');
await p.fill('input[name=name]','Interruptco');
await p.selectOption('select[name=status]','active');
await p.fill('input[name=mrr]','900');
await p.click('.modal button[type=submit]'); await p.waitForTimeout(400);

// hammer the router so entrances are cut off mid-flight, repeatedly
const routes = ['#overview','#pipeline','#clients','#work','#money','#outputs','#library','#settings'];
for (let pass = 0; pass < 3; pass++) {
  for (const r of routes) {
    await p.evaluate((h) => { location.hash = h; }, r);
    await p.waitForTimeout(35);            // far shorter than the 0.42s entrance
  }
}
await p.waitForTimeout(1200);

const stuck = await p.evaluate(() => {
  const bad = [];
  for (const n of document.querySelectorAll('.stat, .card, .col, .lib-card')) {
    const cs = getComputedStyle(n);
    if (parseFloat(cs.opacity) < 0.95 || cs.visibility === 'hidden') {
      bad.push(`${n.className.split(' ')[0]} opacity=${cs.opacity} visibility=${cs.visibility}`);
    }
  }
  return bad;
});
console.log('elements left hidden after 24 interrupted entrances:', stuck.length ? stuck : 'none');
if (stuck.length) fails.push(`${stuck.length} element(s) stuck hidden: ${stuck.slice(0,3).join('; ')}`);

// and the KPI figures must be real numbers, not frozen mid-count
await p.evaluate(() => { location.hash = '#overview'; });
await p.waitForTimeout(60);
await p.evaluate(() => { location.hash = '#money'; });   // cut the count-up off
await p.waitForTimeout(60);
await p.evaluate(() => { location.hash = '#overview'; });
await p.waitForTimeout(1400);
const mrr = await p.evaluate(() => [...document.querySelectorAll('.stat')]
  .find(n => /MRR/.test(n.textContent))?.querySelector('.num')?.textContent);
console.log('MRR after an interrupted count-up:', JSON.stringify(mrr));
if (mrr !== '$900') fails.push(`MRR should settle on $900, got ${mrr}`);

await b.close();
console.log(fails.length ? `\nFAILURES:\n${fails.map(f=>'  - '+f).join('\n')}` : '\nInterrupted animations always settle correctly.');
process.exit(fails.length?1:0);
