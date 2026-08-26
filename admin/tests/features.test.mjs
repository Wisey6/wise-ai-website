import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PASS='feature-test-passcode';
const b = await chromium.launch({ executablePath: CHROME, args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1440,height:1000} });
const fails=[];
p.on('pageerror', e => fails.push('PAGEERROR: '+e.message));
p.on('console', m => { if(m.type()==='error' && !/fonts.googleapis|Failed to load resource|ERR_CONNECTION|jsdelivr/.test(m.text())) fails.push('CONSOLE: '+m.text()); });
const step = async (n,f) => { try { await f(); console.log('  PASS  '+n); } catch(e){ console.log('  FAIL  '+n+'\n        '+e.message.split('\n')[0]); fails.push(n+': '+e.message.split('\n')[0]); } };

await p.goto(`${BASE}/admin/`, { waitUntil:'load' });
await p.fill('#passcode',PASS); await p.fill('#confirm',PASS);
await p.click('.gate button[type=submit]');
await p.waitForSelector('.shell');

await step('rail carries Outputs and Library', async () => {
  for (const r of ['outputs','library']) {
    if (!await p.$(`a[href="#${r}"]`)) throw new Error(`no rail link for ${r}`);
  }
});

await step('add an output through the modal', async () => {
  await p.click('a[href="#outputs"]'); await p.waitForTimeout(500);
  await p.click('.topbar .btn-primary');
  await p.waitForSelector('.modal');
  await p.fill('input[name=title]', 'Visualiser proposal v1');
  await p.selectOption('select[name=kind]', 'proposal');
  await p.selectOption('select[name=status]', 'draft');
  await p.fill('input[name=path]', 'documents/proposals/example.md');
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('table tbody tr', { timeout:3000 });
  const t = await p.textContent('table tbody tr');
  if (!/Visualiser proposal v1/.test(t)) throw new Error('output row missing');
  if (!/Proposal/.test(t)) throw new Error('kind not shown');
});

await step('draft outputs are called out as not sent', async () => {
  const body = await p.textContent('.container');
  if (!/not out the door/.test(body)) throw new Error('draft callout missing');
});

await step('archive an output, then restore it', async () => {
  await p.click('button[aria-label^="Archive Visualiser"]');
  await p.waitForTimeout(500);
  if ((await p.$$('table tbody tr')).length !== 0) throw new Error('archived row still in the live list');
  await p.click('button:has-text("Archive (1)")');
  await p.waitForTimeout(500);
  if (!/Archived outputs/.test(await p.textContent('.card-head'))) throw new Error('archive view did not open');
  if ((await p.$$('table tbody tr')).length !== 1) throw new Error('archived row not in the archive');
  await p.click('button[aria-label^="Restore Visualiser"]');
  await p.waitForTimeout(500);
  await p.click('button:has-text("Viewing archive")');
  await p.waitForTimeout(500);
  if ((await p.$$('table tbody tr')).length !== 1) throw new Error('restore did not bring it back');
});

await step('add a library entry and search it', async () => {
  await p.click('a[href="#library"]'); await p.waitForTimeout(500);
  await p.click('.topbar .btn-primary');
  await p.waitForSelector('.modal');
  await p.fill('input[name=title]', 'Engineering standards');
  await p.selectOption('select[name=kind]', 'standard');
  await p.fill('input[name=path]', 'company/standards/Engineering-Standards.md');
  await p.fill('input[name=tags]', 'code, review, quality');
  await p.fill('textarea[name=notes]', 'The bar every repo is held to.');
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('.lib-card', { timeout:3000 });
  if ((await p.$$('.tag')).length !== 3) throw new Error('tags not split');

  await p.fill('input[type=search]', 'zzznomatch');
  await p.waitForTimeout(500);
  if (await p.$('.lib-card')) throw new Error('search did not filter it out');
  await p.fill('input[type=search]', 'quality');
  await p.waitForTimeout(500);
  if (!await p.$('.lib-card')) throw new Error('search on a tag found nothing');
});

await step('archiving a client removes it from MRR', async () => {
  await p.click('a[href="#clients"]'); await p.waitForTimeout(400);
  await p.click('.empty button');
  await p.waitForSelector('.modal');
  await p.fill('input[name=name]', 'Testco');
  await p.selectOption('select[name=status]', 'active');
  await p.fill('input[name=mrr]', '500');
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('table tbody tr');

  await p.click('a[href="#overview"]'); await p.waitForTimeout(700);
  const before = await p.$$eval('.stat', ns => ns.map(n=>n.textContent).join('|'));
  if (!/\$500/.test(before)) throw new Error('MRR did not pick the client up');

  await p.click('a[href="#clients"]'); await p.waitForTimeout(400);
  await p.click('button[aria-label^="Archive Testco"]');
  await p.waitForTimeout(500);
  await p.click('a[href="#overview"]'); await p.waitForTimeout(700);
  const after = await p.$$eval('.stat', ns => ns.map(n=>n.textContent).join('|'));
  if (/\$500/.test(after)) throw new Error('archived client still counted in MRR');
});

await step('archived task leaves the board but survives in the archive filter', async () => {
  await p.click('a[href="#work"]'); await p.waitForTimeout(400);
  await p.click('.empty button');
  await p.waitForSelector('.modal');
  await p.fill('input[name=name]', 'Test project');
  await p.click('.modal button[type=submit]');
  await p.waitForTimeout(400);
  await p.click('.topbar button:has-text("Task")');
  await p.waitForSelector('.modal');
  await p.fill('input[name=title]', 'Archivable task');
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('.task');

  await p.click('button[aria-label^="Archive Archivable"]');
  await p.waitForTimeout(600);
  if ((await p.$$('.task')).length !== 0) throw new Error('archived task still on the open board');
  await p.click('.seg-btn:has-text("Archived")');
  await p.waitForTimeout(600);
  if ((await p.$$('.task')).length !== 1) throw new Error('archived task not in the Archived filter');
});

await step('everything survives lock and unlock', async () => {
  await p.reload({ waitUntil:'load' });
  await p.waitForSelector('.gate');
  await p.fill('#passcode', PASS);
  await p.click('.gate button[type=submit]');
  await p.waitForSelector('.shell', { timeout: 8000 });
  await p.click('a[href="#library"]'); await p.waitForTimeout(600);
  if (!await p.$('.lib-card')) throw new Error('library entry did not survive');
  await p.click('a[href="#outputs"]'); await p.waitForTimeout(600);
  if (!(await p.textContent('.container')).includes('Visualiser proposal v1')) throw new Error('output did not survive');
});

await p.click('a[href="#library"]'); await p.waitForTimeout(700);
await p.screenshot({ path:'feat-library.png', fullPage:true });
await p.click('a[href="#outputs"]'); await p.waitForTimeout(700);
await p.screenshot({ path:'feat-outputs.png', fullPage:true });

await b.close();
console.log(fails.length ? `\nFAILURES:\n${fails.map(f=>'  - '+f).join('\n')}` : '\nAll feature checks passed.');
process.exit(fails.length?1:0);
