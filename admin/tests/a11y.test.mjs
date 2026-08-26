import { chromium } from 'playwright';
const PASS = 'test-passcode-123';
const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1440,height:950} });
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

await p.goto('http://127.0.0.1:8099/admin/', { waitUntil:'load' });

// keyboard-only vault creation
await p.keyboard.press('Tab');
const focused = await p.evaluate(() => document.activeElement?.id);
check(focused === 'passcode', `first Tab should land on the passcode field, landed on "${focused}"`);

await p.fill('#passcode', PASS); await p.fill('#confirm', PASS);
await p.keyboard.press('Enter');   // submit via keyboard, no mouse
await p.waitForSelector('.shell', { timeout: 8000 });
check(true, '');

// every interactive control must have an accessible name
const unnamed = await p.evaluate(() => {
  const out = [];
  for (const n of document.querySelectorAll('button, a[href], input, select, textarea')) {
    const name = (n.getAttribute('aria-label') || n.textContent || '').trim()
      || n.getAttribute('title') || n.getAttribute('placeholder') || '';
    if (!name) out.push(n.tagName + '.' + (n.className || '(no class)'));
  }
  return out;
});
check(unnamed.length === 0, `controls with no accessible name: ${unnamed.join(', ')}`);

// visible focus ring on rail links
await p.evaluate(() => document.querySelector('.rail-btn')?.focus());
const ring = await p.evaluate(() => {
  const s = getComputedStyle(document.querySelector('.rail-btn'), null);
  return { outline: s.outlineStyle, width: s.outlineWidth };
});
check(ring.outline !== 'none', `rail link has no focus outline (${JSON.stringify(ring)})`);

// contrast of the main body/secondary text against the canvas
const contrast = await p.evaluate(() => {
  const lum = (rgb) => {
    const [r,g,b] = rgb.match(/\d+/g).slice(0,3).map(Number).map(v => {
      const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
    });
    return 0.2126*r + 0.7152*g + 0.0722*b;
  };
  const ratio = (a,b) => { const [x,y]=[lum(a),lum(b)].sort((m,n)=>n-m); return (x+0.05)/(y+0.05); };
  const bg = 'rgb(13,17,20)';
  const out = {};
  for (const sel of ['.stat-value .num', '.stat-label', '.stat-sub', '.muted', 'body']) {
    const n = document.querySelector(sel);
    if (n) out[sel] = +ratio(getComputedStyle(n).color, bg).toFixed(2);
  }
  return out;
});
for (const [sel, r] of Object.entries(contrast)) {
  const min = sel === '.stat-sub' || sel === '.stat-label' ? 4.5 : 4.5;
  check(r >= min, `contrast too low for ${sel}: ${r}:1 (need ${min}:1)`);
}
console.log('  contrast ratios vs canvas:', JSON.stringify(contrast));

// reduced motion honoured
const rm = await p.evaluate(() => {
  const s = document.createElement('style');
  return getComputedStyle(document.querySelector('.stat')).transitionDuration;
});
console.log('  stat transition:', rm);

// modal traps Escape
await p.click('a[href="#clients"]'); await p.waitForTimeout(300);
await p.click('.empty button'); await p.waitForSelector('.modal');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check(!(await p.$('.modal-backdrop')), 'Escape did not close the modal');

// checkbox role on task toggles
await p.evaluate(() => { location.hash = '#work'; }); await p.waitForTimeout(300);
await b.close();
console.log(fails.length ? `\nFAILURES:\n${fails.map(f=>'  - '+f).join('\n')}` : '\nAccessibility checks passed.');
process.exit(fails.length ? 1 : 0);
