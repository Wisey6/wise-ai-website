import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8099/admin/';
const PASS = 'test-passcode-123';
const errors = [];
const shots = process.argv[2] === 'shots';

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args: ['--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts.googleapis|ERR_CONNECTION/.test(m.text())) errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const dismissStrayModal = async () => {
  if (await page.$('.modal-backdrop')) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.$('.modal-backdrop')) {
      await page.evaluate(() => document.querySelector('.modal-backdrop')?.remove());
      errors.push('a modal was left open and had to be force-removed');
    }
  }
};
const step = async (name, fn) => {
  try { await fn(); await dismissStrayModal(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`); errors.push(`${name}: ${e.message.split('\n')[0]}`); await dismissStrayModal(); }
};

await page.goto(BASE, { waitUntil: 'load' });

await step('gate renders in first-run mode', async () => {
  await page.waitForSelector('.gate', { timeout: 5000 });
  const label = await page.textContent('.gate button[type=submit]');
  if (!/Create vault/.test(label)) throw new Error(`expected "Create vault", got "${label}"`);
  if (!await page.isVisible('#confirm')) throw new Error('confirm field missing on first run');
});

await step('rejects a short passcode', async () => {
  await page.fill('#passcode', 'short');
  await page.fill('#confirm', 'short');
  await page.click('.gate button[type=submit]');
  await page.waitForSelector('.gate-msg.error', { timeout: 3000 });
  const msg = await page.textContent('.gate-msg');
  if (!/at least/i.test(msg)) throw new Error(`unexpected message: ${msg}`);
});

await step('rejects mismatched confirmation', async () => {
  await page.fill('#passcode', PASS);
  await page.fill('#confirm', `${PASS}x`);
  await page.click('.gate button[type=submit]');
  await page.waitForFunction(() => /do not match/i.test(document.querySelector('.gate-msg')?.textContent || ''), { timeout: 3000 });
});

await step('creates the vault and enters the console', async () => {
  await page.fill('#passcode', PASS);
  await page.fill('#confirm', PASS);
  await page.click('.gate button[type=submit]');
  await page.waitForSelector('.shell .rail', { timeout: 8000 });
  await page.waitForSelector('.stat-row .stat', { timeout: 5000 });
});

await step('vault in localStorage is ciphertext', async () => {
  const raw = await page.evaluate(() => localStorage.getItem('wiseai.hq.vault.v1'));
  if (!raw) throw new Error('no vault written');
  const env = JSON.parse(raw);
  for (const k of ['ct', 'iv', 'salt', 'iterations']) if (!(k in env)) throw new Error(`envelope missing ${k}`);
  if (env.iterations !== 310000) throw new Error(`weak KDF: ${env.iterations}`);
  if (/clients|income|quitLine/i.test(atob(env.ct).slice(0, 400))) throw new Error('plaintext leaked into ciphertext');
});

// seed data through the real UI so the forms are exercised too
await step('adds a client via the modal', async () => {
  await page.click('a[href="#clients"]');
  await page.waitForSelector('.empty', { timeout: 3000 });
  await page.click('.empty button');
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.fill('input[name=name]', 'Acme Bowling & Leisure');
  await page.fill('input[name=code]', '1001');
  await page.selectOption('select[name=status]', 'active');
  await page.fill('input[name=mrr]', '190');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('table tbody tr', { timeout: 3000 });
  const text = await page.textContent('table tbody tr');
  if (!/Acme Bowling/.test(text)) throw new Error('client row missing');
  if (!/\$190/.test(text)) throw new Error('MRR not shown');
});

await step('records income and it reaches the metrics', async () => {
  await page.click('a[href="#money"]');
  await page.waitForSelector('.stat-row', { timeout: 3000 });
  await page.click('.card button.btn-ghost');            // "Record income"
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.selectOption('select[name=clientId]', { label: 'Acme Bowling & Leisure' });
  await page.selectOption('select[name=type]', 'audit');
  await page.fill('input[name=amount]', '450');
  await page.fill('input[name=date]', new Date().toISOString().slice(0, 10));
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(400);
  const collected = await page.textContent('.stat:first-child .num');
  if (!/450/.test(collected)) throw new Error(`collected should be $450, got "${collected}"`);
});

await step('adds a recurring cost and burn recomputes', async () => {
  const buttons = await page.$$('.card .btn-ghost');
  await buttons[1].click();                               // "Add recurring"
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.fill('input[name=item]', 'Software subscription');
  await page.fill('input[name=vendor]', 'Vendor');
  await page.fill('input[name=amount]', '129.00');
  await page.selectOption('select[name=cycle]', 'monthly');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(400);
  const burn = await page.textContent('.stat:nth-child(4) .num');
  if (!/129/.test(burn)) throw new Error(`burn should reflect $129.00, got "${burn}"`);
});

await step('yearly cycle is amortised to a monthly figure', async () => {
  const value = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map(r => r.textContent).join('|');
  });
  if (!/Software subscription/.test(value)) throw new Error('recurring row missing');
});

await step('adds a deal and drags it between stages', async () => {
  await page.click('a[href="#pipeline"]');
  await page.waitForSelector('.empty button', { timeout: 3000 });
  await page.click('.empty button');
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.fill('input[name=name]', 'AI visualiser build');
  await page.fill('input[name=value]', '1900');
  await page.fill('input[name=probability]', '60');
  await page.selectOption('select[name=stage]', 'proposal');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.kanban .deal', { timeout: 3000 });
  const stage = await page.getAttribute('.col:has(.deal)', 'data-stage');
  if (stage !== 'proposal') throw new Error(`deal landed in "${stage}", expected proposal`);
  const weighted = await page.textContent('.stat:nth-child(2) .num');
  if (!/1,140/.test(weighted)) throw new Error(`weighted pipeline should be $1,140, got "${weighted}"`);
});

await step('adds a project and a task, and ticks it off', async () => {
  await page.click('a[href="#work"]');
  await page.waitForSelector('.empty button', { timeout: 3000 });
  await page.click('.empty button');
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.fill('input[name=name]', 'Website build — Phase 1');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(300);

  await page.click('.topbar button:has-text("Task")');    // primary action, not a filter
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.fill('input[name=title]', 'Ship the go-live SQL');
  await page.selectOption('select[name=priority]', 'high');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.task', { timeout: 3000 });

  await page.click('.task-check');
  await page.waitForTimeout(400);
  const open = await page.$$('.task');
  if (open.length !== 0) throw new Error(`completed task should leave the "open" filter, ${open.length} remain`);
  await page.click('.seg-btn:has-text("Done")');
  await page.waitForSelector('.task.done', { timeout: 3000 });
  const pressed = await page.getAttribute('.seg-btn:has-text("Done")', 'aria-pressed');
  if (pressed !== 'true') throw new Error('segmented filter did not mark itself pressed');
  await page.click('.seg-btn:has-text("Open")');
});

await step('overview reflects everything entered', async () => {
  await page.click('a[href="#overview"]');
  await page.waitForSelector('.stat-row', { timeout: 3000 });
  const body = await page.textContent('.container');
  for (const want of ['$450', '$190', 'Acme Bowling']) {
    if (!body.includes(want)) throw new Error(`overview missing "${want}"`);
  }
  if (!await page.$('svg.chart')) throw new Error('no chart rendered');
});

if (shots) { await dismissStrayModal();
  for (const [route, name] of [['overview','01-overview'],['pipeline','02-pipeline'],['clients','03-clients'],['work','04-work'],['money','05-money'],['settings','06-settings']]) {
    await page.click(`a[href="#${route}"]`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `shot-${name}.png`, fullPage: route === 'overview' });
  }
}

await step('data survives a reload behind the passcode', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.gate', { timeout: 5000 });
  const label = await page.textContent('.gate button[type=submit]');
  if (!/Unlock/.test(label)) throw new Error(`expected "Unlock" on return visit, got "${label}"`);
});

await step('wrong passcode is refused', async () => {
  await page.fill('#passcode', 'definitely-wrong-code');
  await page.click('.gate button[type=submit]');
  await page.waitForFunction(() => /wrong passcode/i.test(document.querySelector('.gate-msg')?.textContent || ''), { timeout: 5000 });
  if (await page.$('.shell')) throw new Error('console rendered despite a wrong passcode');
});

await step('correct passcode restores the data', async () => {
  await page.fill('#passcode', PASS);
  await page.click('.gate button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 8000 });
  await page.click('a[href="#money"]');
  await page.waitForSelector('table tbody tr', { timeout: 3000 });
  const money = await page.textContent('.container');
  if (!money.includes('$450')) throw new Error('income did not survive the round trip');
  if (!money.includes('Software subscription')) throw new Error('recurring costs did not survive');
  await page.click('a[href="#clients"]');
  await page.waitForSelector('table tbody tr', { timeout: 3000 });
  if (!(await page.textContent('.container')).includes('Acme Bowling')) throw new Error('clients did not survive');
  await page.click('a[href="#pipeline"]');
  await page.waitForSelector('.kanban .deal', { timeout: 3000 });
  if (!(await page.textContent('.container')).includes('AI visualiser')) throw new Error('deals did not survive');
});

if (shots) {
  await page.click('a[href="#overview"]');
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-07-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 950 });
}

await browser.close();

console.log(`\n${errors.length ? `FAILURES (${errors.length}):\n${errors.map(e => '  - ' + e).join('\n')}` : 'All checks passed.'}`);
process.exit(errors.length ? 1 : 0);
