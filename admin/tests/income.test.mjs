// Income: gross figure, the all-time / by-month split, and receivable due dates.
// Everything is entered through the real modals — no seeded storage, no hooks.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PASS = 'income-test-passcode';

// Relative to today, so an "overdue" assertion never rots into a false pass.
const iso = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const fails = [];
p.on('pageerror', e => fails.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error' && !/fonts.googleapis|Failed to load resource|ERR_CONNECTION|jsdelivr/.test(m.text())) fails.push('CONSOLE: ' + m.text()); });
const step = async (n, f) => { try { await f(); console.log('  PASS  ' + n); } catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message.split('\n')[0]); fails.push(n); } };

await p.goto(`${BASE}/admin/`, { waitUntil: 'load' });
await p.fill('#passcode', PASS); await p.fill('#confirm', PASS);
await p.click('.gate button[type=submit]');
await p.waitForSelector('.shell');
await p.click('a[href="#money"]'); await p.waitForTimeout(400);

// Scope to the Income panel — the Money page carries three tables.
const inc = p.locator('section.card').filter({ has: p.locator('h2', { hasText: 'Income' }) });

async function record({ amount, date, status, due, invoice }) {
  await p.click('button:has-text("Record income")');
  await p.waitForSelector('.modal');
  await p.fill('input[name=amount]', String(amount));
  await p.selectOption('select[name=status]', status);
  await p.fill('input[name=date]', date);            // '' clears it — undated is legal
  if (due !== undefined) await p.fill('input[name=due]', due);
  if (invoice) await p.fill('input[name=invoice]', invoice);
  await p.click('.modal button[type=submit]');
  await p.waitForTimeout(250);
}

// Three paid rows across two months, three receivables in a third, one undated.
await record({ amount: 450, date: '2026-06-10', status: 'paid' });
await record({ amount: 190, date: '2026-06-20', status: 'paid' });
await record({ amount: 190, date: '2026-07-10', status: 'paid' });
await record({ amount: 300, date: '2026-07-15', status: 'invoiced', due: iso(20), invoice: 'INV-A' });
await record({ amount: 500, date: '2026-07-16', status: 'invoiced', due: iso(-10), invoice: 'INV-B' });
await record({ amount: 250, date: '2026-07-17', status: 'invoiced', invoice: 'INV-C' });
await record({ amount: 1000, date: '', status: 'unbilled' });

await step('gross income counts paid rows only', async () => {
  const row = await p.textContent('.stat-row');
  if (!/Gross income/.test(row)) throw new Error('no Gross income stat');
  if (!/\$830/.test(row)) throw new Error('gross should be $830 (paid only): ' + row.replace(/\s+/g, ' ').slice(0, 160));
});

await step('owed-to-us calls out the overdue invoice', async () => {
  const row = await p.textContent('.stat-row');
  if (!/\$1,050/.test(row)) throw new Error('outstanding should be $1,050');
  if (!/1 overdue/.test(row) || !/\$500/.test(row)) throw new Error('overdue not surfaced: ' + row.replace(/\s+/g, ' ').slice(0, 200));
});

await step('due dates read correctly per status', async () => {
  const body = await inc.locator('table tbody').textContent();
  if (!/10d overdue/.test(body)) throw new Error('overdue invoice not flagged');
  if (!/No terms/.test(body)) throw new Error('invoice with no due date not called out');
  const paidRow = await inc.locator('table tbody tr', { hasText: '$450' }).textContent();
  if (/overdue|No terms/.test(paidRow)) throw new Error('a paid row should carry no due state');
});

await step('defaults to All time, flat, every row listed', async () => {
  const active = await inc.locator('.seg .seg-btn[aria-pressed="true"]').textContent();
  if (active.trim() !== 'All time') throw new Error('default not All time: ' + active);
  if (await inc.locator('table tbody tr.group-row').count()) throw new Error('group rows in all-time mode');
  const rows = await inc.locator('table tbody tr').count();
  if (rows !== 7) throw new Error('expected 7 rows, got ' + rows);
});

await step('all-time table foots the gross', async () => {
  const foot = await inc.locator('table tfoot').textContent();
  if (!/Gross income/i.test(foot) || !/\$830/.test(foot)) throw new Error('tfoot wrong: ' + foot.replace(/\s+/g, ' '));
});

await step('by month groups newest first, undated last', async () => {
  await inc.locator('.seg .seg-btn', { hasText: 'By month' }).click();
  await p.waitForTimeout(300);
  const groups = (await inc.locator('table tbody tr.group-row').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
  if (groups.length !== 3) throw new Error('expected 3 groups, got ' + groups.length + ': ' + JSON.stringify(groups));
  if (!/July 2026/.test(groups[0])) throw new Error('newest month not first: ' + groups[0]);
  if (!/Undated/.test(groups[2])) throw new Error('undated not last: ' + groups[2]);
});

await step('each month totals its own gross, paid only', async () => {
  const groups = (await inc.locator('table tbody tr.group-row').allTextContents()).map(t => t.replace(/\s+/g, ' '));
  const june = groups.find(g => /June 2026/.test(g));
  if (!/\$640/.test(june)) throw new Error('June gross should be $640: ' + june);
  const july = groups.find(g => /July 2026/.test(g));
  if (!/\$190/.test(july)) throw new Error('July gross should be $190 — the three invoiced rows are not income yet: ' + july);
  const undated = groups.find(g => /Undated/.test(g));
  if (!/\$0/.test(undated)) throw new Error('Undated gross should be $0, the row is unbilled: ' + undated);
});

await step('grouping loses no row', async () => {
  const rows = await inc.locator('table tbody tr:not(.group-row)').count();
  if (rows !== 7) throw new Error('expected 7 rows under the groups, got ' + rows);
});

await step('month grosses sum to the all-time gross', async () => {
  const cells = await inc.locator('table tbody tr.group-row td').allTextContents();
  const sum = cells.map(c => Number(String(c).replace(/[^0-9.]/g, '')) || 0).reduce((a, c) => a + c, 0);
  if (Math.abs(sum - 830) > 0.01) throw new Error('month grosses sum to ' + sum + ', not 830');
});

await step('the period is announced and survives navigation', async () => {
  if (await inc.locator('.seg').getAttribute('aria-label') !== 'Income period') throw new Error('seg group unlabelled');
  await p.click('a[href="#overview"]'); await p.waitForTimeout(250);
  await p.click('a[href="#money"]'); await p.waitForTimeout(350);
  const active = await inc.locator('.seg .seg-btn[aria-pressed="true"]').textContent();
  if (active.trim() !== 'By month') throw new Error('period not retained: ' + active);
});

await step('due dates survive lock and unlock', async () => {
  await p.click('a[href="#settings"]'); await p.waitForTimeout(300);
  await p.click('button:has-text("Lock")');
  await p.waitForSelector('.gate');
  await p.fill('#passcode', PASS);
  await p.click('.gate button[type=submit]');
  await p.waitForSelector('.shell');
  await p.click('a[href="#money"]'); await p.waitForTimeout(400);
  const body = await inc.locator('table tbody').textContent();
  if (!/10d overdue/.test(body)) throw new Error('due date lost through the vault round trip');
});

await step('back to All time restores the flat table', async () => {
  await inc.locator('.seg .seg-btn', { hasText: 'All time' }).click();
  await p.waitForTimeout(300);
  if (await inc.locator('table tbody tr.group-row').count()) throw new Error('group rows still present');
  if (await inc.locator('table tbody tr').count() !== 7) throw new Error('row count changed');
});

await step('no horizontal page scroll at 390px with groups on', async () => {
  await p.setViewportSize({ width: 390, height: 900 });
  await inc.locator('.seg .seg-btn', { hasText: 'By month' }).click();
  await p.waitForTimeout(350);
  const over = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (over) throw new Error('page scrolls horizontally on mobile');
});

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nAll income checks passed.');
await b.close();
process.exit(fails.length ? 1 : 0);
