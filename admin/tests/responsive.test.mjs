import { chromium } from 'playwright';
const PASS = 'test-passcode-123';
const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args:['--no-sandbox','--disable-dev-shm-usage'] });
const fails = [];

for (const [w, h, name] of [[375,812,'iphone-se'],[390,844,'iphone'],[768,1024,'tablet'],[1024,768,'laptop'],[1440,950,'desktop']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto('http://127.0.0.1:8099/admin/', { waitUntil: 'load' });
  await p.fill('#passcode', PASS); await p.fill('#confirm', PASS);
  await p.click('.gate button[type=submit]');
  await p.waitForSelector('.shell', { timeout: 8000 });

  // seed one client so tables have content at every width
  await p.evaluate(() => { location.hash = '#clients'; });
  await p.waitForTimeout(300);

  for (const route of ['overview','pipeline','clients','work','money','settings']) {
    await p.evaluate((r) => { location.hash = '#' + r; }, route);
    await p.waitForTimeout(350);
    const m = await p.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      mainW: document.querySelector('.main')?.getBoundingClientRect().width || 0,
      railBottom: document.querySelector('.rail')?.getBoundingClientRect().bottom || 0,
      mainTop: document.querySelector('.main')?.getBoundingClientRect().top || 0
    }));
    if (m.docW > m.winW + 1) fails.push(`${name} #${route}: page scrolls horizontally (${m.docW} > ${m.winW})`);
    if (m.mainW < m.winW * 0.4) fails.push(`${name} #${route}: main is only ${Math.round(m.mainW)}px of ${m.winW}px`);
  }
  if (w <= 820) {
    await p.evaluate(() => { location.hash = '#overview'; });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `resp-${name}.png`, fullPage: false });
  }
  await p.close();
  console.log(`  ${name} (${w}x${h}) checked`);
}
await b.close();
console.log(fails.length ? `\nFAILURES:\n${fails.map(f=>'  - '+f).join('\n')}` : '\nNo layout failures at any breakpoint.');
process.exit(fails.length ? 1 : 0);
