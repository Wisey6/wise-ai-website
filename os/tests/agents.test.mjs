// Wise AI OS: the four agents (Researcher, Morning briefing, Ask the hub, Doer), the
// approvals they wait on, the run log, their switches and budget, the briefing on
// Today, the research card in the lead drawer, the palette hand-offs and the area dock.
//
// The `agent` edge function is NEVER called for real from here (it costs money):
// every request to **/functions/v1/agent is answered by a route mock that follows the
// contract in AGENTS-SPEC (status, each agent's response, and the errors).
//
// Approvals need real agent_actions rows, which the operator session cannot insert (by
// design). Load the fixture first with the service role (Supabase MCP execute_sql on the
// project), run the test, then run the cleanup SQL. Print both with:
//   node os/tests/agents.test.mjs --sql        (fixture)
//   node os/tests/agents.test.mjs --cleanup    (cleanup; also verifies)
// Every row is named "ZZAGUI …" or is an agent_runs row whose input is {"test":"ZZAGUI"}
// (actions cascade from their run).
//
//   python3 -m http.server 8185 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8185 node os/tests/agents.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_SQL = String.raw`
with
l as (
  insert into leads (business, contact_name, website, suburb, industry, status, source, hook)
  values ('ZZAGUI Alpha Plumbing', 'Amy', 'https://example.com', 'Ashgrove', 'Plumbing', 'new', 'manual', null),
         ('ZZAGUI Bravo Electrical', 'Ben', 'https://example.org', 'Bardon', 'Electrical', 'contacted', 'manual', 'old line'),
         ('ZZAGUI Charlie Dental', 'Cat', 'https://example.net', 'Coorparoo', 'Dental', 'replied', 'manual', null),
         ('ZZAGUI Delta Opted', 'Dee', 'https://example.edu', 'Doolandella', 'Cleaning', 'new', 'manual', 'existing hook')
  returning id, business),
c as (insert into clients (name, suburb) values ('ZZAGUI Client Co', 'Paddington') returning id),
d as (insert into deals (title, lead_id, stage, value) select 'ZZAGUI Deal', id, 'qualified', 4000 from l where business = 'ZZAGUI Bravo Electrical' returning id),
r1 as (insert into agent_runs (agent, status, input, output, model, input_tokens, output_tokens, cost_usd, duration_ms, at)
  values ('doer', 'ok', '{"test":"ZZAGUI"}', '{"note":"ZZAGUI note: sending is yours to do.","actions":[]}', 'claude-sonnet-5-5', 5120, 830, 0.0213, 8200, now() - interval '20 minutes') returning id),
r2 as (insert into agent_runs (agent, status, lead_id, input, output, sources, model, input_tokens, output_tokens, searches, cost_usd, duration_ms, at)
  select 'researcher', 'ok', id, '{"test":"ZZAGUI"}',
   '{"observations":[{"text":"ZZAGUI They answer the phone 7am to 3pm only <img src=x onerror=\"window.__xss=1\">","source_url":"https://example.com/contact"}],"hooks":["saw your contact page says calls after 3pm go to voicemail"],"pain":"Calls after 3pm are missed","opted_out":false,"opted_out_evidence":"","number_published":"yes","number_evidence_url":"https://example.com/contact","could_not_read":""}',
   '["https://example.com/contact","javascript:alert(1)"]', 'claude-sonnet-5-5', 9100, 640, 1, 0.0412, 31000, now() - interval '2 hours'
  from l where business = 'ZZAGUI Alpha Plumbing' returning id),
r3 as (insert into agent_runs (agent, status, input, output, model, cost_usd, duration_ms, at)
  values ('doer', 'ok', '{"test":"ZZAGUI","batch":"all"}', '{"note":"ZZAGUI batch"}', 'claude-sonnet-5-5', 0.0101, 5000, now() - interval '30 minutes') returning id),
r4 as (insert into agent_runs (agent, status, input, output, error, model, cost_usd, duration_ms, at)
  values ('ask', 'capped', '{"test":"ZZAGUI"}', '{}', 'ZZAGUI monthly budget reached', null, 0, 40, now() - interval '3 hours') returning id),
ids as (select
  (select id from l where business='ZZAGUI Alpha Plumbing') a, (select id from l where business='ZZAGUI Bravo Electrical') b,
  (select id from l where business='ZZAGUI Charlie Dental') ch, (select id from l where business='ZZAGUI Delta Opted') dl,
  (select id from c) cl, (select id from d) dd, (select id from r1) run1, (select id from r3) run3)
insert into agent_actions (run_id, kind, payload, summary, reason, created_at)
select run1, 'lead.set_status', jsonb_build_object('lead_id', a, 'status', 'interested'), 'ZZAGUI Move Alpha Plumbing to Interested', 'They asked for a price', now() - interval '19 minutes' from ids
union all select run1, 'lead.set_followup', jsonb_build_object('lead_id', b, 'date', to_char(current_date + 3, 'YYYY-MM-DD')), 'ZZAGUI Follow up Bravo Electrical', 'Quiet for a week', now() - interval '19 minutes' from ids
union all select run1, 'task.create', jsonb_build_object('title', 'ZZAGUI Call the accountant', 'client_id', cl, 'due_on', to_char(current_date + 2, 'YYYY-MM-DD'), 'priority', 'high'), 'ZZAGUI Add a task to call the accountant', null, now() - interval '19 minutes' from ids
union all select run1, 'deal.update', jsonb_build_object('deal_id', dd, 'stage', 'proposal', 'next_step', 'ZZAGUI Send the proposal'), 'ZZAGUI Move the deal to Proposal', 'They agreed to a quote', now() - interval '19 minutes' from ids
union all select run1, 'message.draft', jsonb_build_object('lead_id', ch, 'body', 'ZZAGUI Hi Cat, Thursday at 10 works for a quick call. Does that suit?'), 'ZZAGUI Draft a reply to Charlie Dental', 'They asked when you are free', now() - interval '19 minutes' from ids
union all select run1, 'invoice.draft', jsonb_build_object('client_id', cl, 'description', 'ZZAGUI Setup fee', 'amount', 1500, 'kind', 'one_off'), 'ZZAGUI Draft the setup invoice', null, now() - interval '19 minutes' from ids
union all select run1, 'note.add', jsonb_build_object('lead_id', a, 'text', 'ZZAGUI reject me'), 'ZZAGUI Add a note to Alpha', null, now() - interval '19 minutes' from ids
union all select run1, 'lead.set_status', jsonb_build_object('lead_id', b, 'status', 'dnc'), 'ZZAGUI Mark Bravo do not contact', 'Not allowed', now() - interval '19 minutes' from ids
union all select run1, 'lead.set_hook', jsonb_build_object('lead_id', ch, 'hook', 'ZZAGUI line'), 'ZZAGUI <img src=x onerror="window.__xss=1"> hook for Charlie', '<b>bold?</b>', now() - interval '19 minutes' from ids
union all select run3, 'lead.set_hook', jsonb_build_object('lead_id', dl, 'hook', 'ZZAGUI batch line'), 'ZZAGUI Batch: personal line for Delta', null, now() - interval '29 minutes' from ids
union all select run3, 'note.add', jsonb_build_object('client_id', cl, 'text', 'ZZAGUI batch note'), 'ZZAGUI Batch: note for the client', null, now() - interval '29 minutes' from ids
returning id;`;

export const CLEANUP_SQL = String.raw`
delete from agent_runs where input->>'test' = 'ZZAGUI';
delete from income where description like 'ZZAGUI%';
delete from tasks where title like 'ZZAGUI%';
delete from deals where title like 'ZZAGUI%';
delete from clients where name like 'ZZAGUI%';
delete from events where summary like '%ZZAGUI%';
delete from leads where business like 'ZZAGUI%';
select (select count(*) from agent_runs where input->>'test'='ZZAGUI') runs,
  (select count(*) from leads where business like 'ZZAGUI%') leads, (select count(*) from clients where name like 'ZZAGUI%') clients,
  (select count(*) from deals where title like 'ZZAGUI%') deals, (select count(*) from tasks where title like 'ZZAGUI%') tasks,
  (select count(*) from income where description like 'ZZAGUI%') income;`;

if (process.argv.includes('--sql')) { console.log(FIXTURE_SQL); process.exit(0); }
if (process.argv.includes('--cleanup')) { console.log(CLEANUP_SQL); process.exit(0); }

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://127.0.0.1:8185').replace(/\/os\/?$/, '');
const URL = `${BASE}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
const SHOTS = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const API = "document.querySelector('script[type=module]').src.replace('app.js', 'api.js')";

/* ------------------------------------------------------------ the mock */
const STATUS = () => ({
  configured: true, enabled: true, agents: { researcher: true, briefing: true, ask: true, doer: true },
  spent_usd: 3.4172, cap_usd: 25, runs_today: { researcher: 3, briefing: 1, ask: 7, doer: 2 },
  limits: { researcher: 40, briefing: 4, ask: 150, doer: 30 }
});
const mock = { status: STATUS(), research: {}, briefMode: 'ok', doerRun: null, doerActions: [], calls: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const XSS = '<img src=x onerror="window.__xss=1">';

async function mockAgent(ctx) {
  await ctx.route('**/functions/v1/agent', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* */ }
    mock.calls.push(body);
    const run = { run_id: null, model: 'mock', cost_usd: 0.0123, spent_usd: mock.status.spent_usd, cap_usd: mock.status.cap_usd };
    if (body.action === 'status') return json(route, 200, mock.status);
    if (body.agent === 'researcher') {
      const r = mock.research[body.lead_id];
      if (!r) return json(route, 429, { error: 'daily_limit' });
      return json(route, 200, { ok: true, ...run, ...r, sources: r.sources || ['https://example.com/'] });
    }
    if (body.agent === 'briefing') {
      if (mock.briefMode === 'empty') return json(route, 200, { ok: false, error: 'empty' });
      return json(route, 200, {
        ok: true, ...run, cached: false,
        headline: body.refresh ? 'ZZAGUI refreshed headline' : 'ZZAGUI One overdue invoice and two warm leads: chase the money first.',
        do_first: [{ text: 'Chase the invoice', hash: '#income' }, { text: 'Reply to the dentist', hash: '#inbox' }],
        watch: [{ text: `Bad link ${XSS}`, hash: 'javascript:window.__xss=1' }],
        numbers: 'ZZAGUI $0 in this month against a $10,000 target.'
      });
    }
    if (body.agent === 'ask') {
      const q = String(body.question || '');
      if (q.includes('CAP')) return json(route, 402, { error: 'cap_reached' });
      if (q.includes('unknown')) return json(route, 200, { ok: true, ...run, answer: 'The hub does not record that.', links: [], cannot_answer: true });
      return json(route, 200, { ok: true, ...run, answer: `ZZAGUI answer ${XSS}`, links: [{ label: 'Income', hash: '#income' }, { label: 'bad', hash: 'javascript:alert(1)' }], cannot_answer: false });
    }
    if (body.agent === 'doer') {
      if (String(body.instruction).includes('DISABLED')) return json(route, 403, { error: 'disabled' });
      return json(route, 200, { ok: true, ...run, run_id: mock.doerRun, note: `ZZAGUI Sending is yours to do. ${XSS}`, dropped: 1, actions: mock.doerActions });
    }
    return json(route, 400, { error: 'bad_request' });
  });
}

/* --------------------------------------------------------------- helpers */
async function signIn(p) {
  const res = await p.evaluate(async ({ email, password, api }) => {
    const { sb } = await import(eval(api));
    const { error } = await sb.auth.signInWithPassword({ email, password });
    return error ? error.message : 'ok';
  }, { email: EMAIL, password: PASSWORD, api: API });
  if (res !== 'ok') throw new Error(`sign-in failed: ${res}`);
}
async function open(p, hash, wait = 900) {
  await p.evaluate((h) => { location.hash = h; }, hash);
  await p.waitForTimeout(wait);
}
/** Run a supabase query in the page with the operator session: q is a function body using `sb`. */
const db = (p, q, arg) => p.evaluate(async ({ q, arg, api }) => {
  const { sb } = await import(eval(api));
  // eslint-disable-next-line no-new-func
  return new Function('sb', 'arg', `return (async () => { ${q} })()`)(sb, arg);
}, { q, arg, api: API });
const lastToast = (p) => p.locator('.toast').last().textContent().catch(() => '');
const shot = async (p, name, full = false) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full }); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
await mockAgent(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource|net::ERR_FAILED|functions\/v1\//.test(t)) return; // mocked 4xx responses and other functions
  errors.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.dismiss());

let prior = null;
try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await signIn(page);
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
  await page.waitForTimeout(1500);

  prior = await db(page, `const { data } = await sb.from('settings').select('agents_enabled,agent_monthly_cap_usd,agent_researcher,agent_briefing,agent_ask,agent_doer').eq('id', 1).single(); return data;`);
  check(Boolean(prior), `read the agent settings to restore later (${JSON.stringify(prior)})`);
  await db(page, `await sb.from('settings').update({ agents_enabled: true, agent_researcher: true, agent_briefing: true, agent_ask: true, agent_doer: true }).eq('id', 1); return true;`);

  // Put the fixture back to its starting state (the operator may update these rows,
  // including an action's decision), so the test can run again without re-inserting.
  await db(page, `
    const base = { pain: null, number_source_url: null, notes: null, next_followup_at: null };
    await sb.from('leads').update({ ...base, status: 'new', hook: null }).eq('business', 'ZZAGUI Alpha Plumbing');
    await sb.from('leads').update({ ...base, status: 'contacted', hook: 'old line' }).eq('business', 'ZZAGUI Bravo Electrical');
    await sb.from('leads').update({ ...base, status: 'replied', hook: null }).eq('business', 'ZZAGUI Charlie Dental');
    await sb.from('leads').update({ ...base, status: 'new', hook: 'existing hook' }).eq('business', 'ZZAGUI Delta Opted');
    await sb.from('deals').update({ stage: 'qualified', next_step: null, value: 4000, probability: 30 }).eq('title', 'ZZAGUI Deal');
    await sb.from('clients').update({ notes: null }).eq('name', 'ZZAGUI Client Co');
    await sb.from('tasks').delete().like('title', 'ZZAGUI%');
    await sb.from('income').delete().like('description', 'ZZAGUI%');
    await sb.from('events').delete().like('summary', '%ZZAGUI%');
    await sb.from('agent_actions').update({ status: 'proposed', decided_at: null, result: null }).like('summary', 'ZZAGUI%');
    return true;`);
  const fx = await db(page, `
    const leads = (await sb.from('leads').select('id,business').like('business', 'ZZAGUI%')).data || [];
    const runs = (await sb.from('agent_runs').select('id,agent,input').eq('input->>test', 'ZZAGUI')).data || [];
    const acts = (await sb.from('agent_actions').select('id,summary,run_id,status').like('summary', 'ZZAGUI%')).data || [];
    const client = (await sb.from('clients').select('id').eq('name', 'ZZAGUI Client Co').maybeSingle()).data;
    const deal = (await sb.from('deals').select('id').eq('title', 'ZZAGUI Deal').maybeSingle()).data;
    return { leads, runs, acts, client, deal };`);
  const lead = (n) => fx.leads.find((l) => l.business.includes(n))?.id;
  const act = (s) => fx.acts.find((a) => a.summary.includes(s))?.id;
  const L = { a: lead('Alpha'), b: lead('Bravo'), c: lead('Charlie'), d: lead('Delta') };
  const run2 = fx.runs.find((r) => r.agent === 'researcher')?.id;
  const run3 = fx.runs.find((r) => r.input?.batch === 'all')?.id;
  check(fx.leads.length === 4 && fx.acts.length === 11 && fx.client && fx.deal && run2 && run3,
    `fixture loaded (${fx.leads.length} leads, ${fx.acts.length} actions). If not, run: node os/tests/agents.test.mjs --sql`);
  if (!run3) throw new Error('fixture missing');
  mock.doerRun = run3;
  mock.doerActions = await db(page, `return (await sb.from('agent_actions').select('*').eq('run_id', arg)).data;`, run3);
  await page.reload({ waitUntil: 'networkidle' });
  await signIn(page);
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ---------------------------------------------------- page + header */
  await open(page, '#agents', 1200);
  check(await page.locator('.ag [data-agent-section]').count() === 4, 'Agents page shows the four agents as sections');
  check(await page.locator('.ag-never').count() === 4, 'each agent says what it can never do');
  check(await page.locator('[data-agents-state="on"]').count() === 1, 'header says connected and on');
  check((await page.locator('[data-spend]').textContent()) === 'US$3.42 of US$25.00', `spend reads in US dollars against the cap (${await page.locator('[data-spend]').textContent()})`);
  const meterW = await page.locator('.ag-statusbar .ag-meter i').evaluate((n) => n.style.width);
  check(meterW === '14%', `budget meter is 3.42/25 = 14% (${meterW})`);
  const waiting = Number(await page.locator('.ag-waiting').getAttribute('data-waiting'));
  check(waiting >= 11, `"Waiting for you" counts the proposed actions (${waiting})`);
  check((await page.locator('[data-agent-section="researcher"] .ag-usage').textContent()).includes('3 of 40 runs today'), 'researcher shows runs today against its daily limit');
  check(await page.locator('[data-rules] li').count() === 7, 'the rules panel lists the seven guarantees');
  const rulesText = await page.locator('[data-rules]').textContent();
  check(/never send/i.test(rulesText) && /Phone numbers and email addresses are never sent/.test(rulesText) && /nine kinds/i.test(rulesText) && /logged/i.test(rulesText), 'the rules say: never sends, nine changes only, no contact details, everything logged');
  await shot(page, 'agents-overview-1440', true);

  // A tiny spend reads "under 1 cent".
  mock.status = { ...STATUS(), spent_usd: 0.0012 };
  await page.evaluate(async (api) => { (await import(eval(api))).agentStatus(); }, API);
  await page.waitForTimeout(600);
  check((await page.locator('[data-spend]').textContent()) === 'under 1 cent of US$25.00', 'a tiny spend reads "under 1 cent"');
  mock.status = STATUS();

  /* ----------------------------------------------------------- switches */
  await page.locator('[data-agent-section="doer"] .ag-switch').click();
  await page.waitForTimeout(1500);
  let s = await db(page, `return (await sb.from('settings').select('agent_doer').eq('id', 1).single()).data;`);
  check(s.agent_doer === false, 'the Doer switch saves agent_doer = false');
  check(await page.locator('[data-agent-section="doer"] .ag-ctrl').isHidden() && await page.locator('[data-agent-section="doer"] .ag-off').isVisible(), 'a switched-off agent hides its control and says how to turn it on');
  await page.locator('[data-agent-section="doer"] .ag-switch').click();
  await page.waitForTimeout(1500);
  s = await db(page, `return (await sb.from('settings').select('agent_doer').eq('id', 1).single()).data;`);
  check(s.agent_doer === true && await page.locator('[data-agent-section="doer"] .ag-ctrl').isVisible(), 'switching it back on restores agent_doer and the control');

  /* ----------------------------------------------------------- researcher */
  mock.research[L.a] = {
    observations: [{ text: `ZZAGUI Their contact page lists a mobile ${XSS}`, source_url: 'https://example.com/contact' }, { text: 'Bad source', source_url: 'javascript:alert(1)' }],
    hooks: ['saw your contact page says you are on the tools till 3'], pain: 'Missed calls while on the tools',
    opted_out: false, opted_out_evidence: '', number_published: 'yes', number_evidence_url: 'https://example.com/contact', could_not_read: ''
  };
  await page.fill('[name="research-q"]', 'ZZAGUI Alpha');
  await page.waitForTimeout(300);
  await page.locator(`.ag-pick-btn[data-lead="${L.a}"]`).click();
  await page.waitForTimeout(500);
  check(await page.locator('.ag-chosen .ag-rc').count() === 1 && /Research again/.test(await page.locator('.ag-chosen [data-act=research]').textContent()), 'a lead with an earlier run shows that research and offers "Research again"');
  await page.locator('.ag-chosen [data-act=research]').click();
  await page.waitForFunction(() => /tools till 3/.test(document.querySelector('.ag-chosen .ag-rc')?.textContent || ''), null, { timeout: 8000 });
  const rc = page.locator('.ag-chosen .ag-rc');
  check(mock.calls.some((c) => c.agent === 'researcher' && c.lead_id === L.a), 'Research runs agentRun("researcher", {lead_id})');
  check(await rc.locator('.ag-obs li').count() === 2 && await rc.locator('.ag-obs a[href="https://example.com/contact"][target=_blank][rel~=noopener]').count() === 1, 'observations show with their source links (new tab, noopener)');
  check(await rc.locator('a[href^="javascript"]').count() === 0, 'a javascript: source is never a link');
  await rc.locator('[data-act=use-line]').first().click();
  await page.waitForTimeout(1500);
  let row = await db(page, `return (await sb.from('leads').select('hook,pain,number_source_url,status').eq('id', arg).single()).data;`, L.a);
  check(row.hook === 'saw your contact page says you are on the tools till 3', `"Use this line" sets the lead's hook (no existing hook, no confirm) (${row.hook})`);
  await page.locator('.ag-chosen [data-act=save-pain]').click();
  await page.waitForTimeout(1200);
  await page.locator('.ag-chosen [data-act=save-source]').click();
  await page.waitForTimeout(1500);
  row = await db(page, `return (await sb.from('leads').select('hook,pain,number_source_url,status').eq('id', arg).single()).data;`, L.a);
  check(row.pain === 'Missed calls while on the tools', '"Save the problem" sets pain');
  check(row.number_source_url === 'https://example.com/contact', '"Save this as the number source" sets number_source_url');
  check(row.status === 'new', 'the research itself changes nothing else on the lead');
  check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#view img[src="x"]')), 'a mocked <img onerror> in the research renders as text');
  await shot(page, 'agents-research-1440');

  // Existing hook → confirm before replacing.
  mock.research[L.b] = { observations: [{ text: 'ZZAGUI Bravo does solar', source_url: 'https://example.org/solar' }], hooks: ['saw you added solar installs this year'], pain: '', opted_out: false, opted_out_evidence: '', number_published: 'unknown', number_evidence_url: '', could_not_read: 'The services page timed out.' };
  await page.fill('[name="research-q"]', 'ZZAGUI Bravo');
  await page.waitForTimeout(300);
  await page.locator(`.ag-pick-btn[data-lead="${L.b}"]`).click();
  await page.locator('.ag-chosen [data-act=research]').click();
  await page.waitForSelector('.ag-chosen .ag-unread', { timeout: 8000 });
  check((await page.locator('.ag-chosen .ag-unread').textContent()).includes('timed out'), 'could_not_read is shown plainly');
  check(await page.locator('.ag-chosen [data-number="unknown"]').count() === 1 && await page.locator('.ag-chosen [data-act=save-source]').count() === 0, 'number check reads Unknown and offers no source to save');
  await page.locator('.ag-chosen [data-act=use-line]').click();
  await page.waitForSelector('.modal');
  check((await page.locator('.modal').textContent()).includes('old line'), 'replacing an existing hook asks first, quoting it');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(1500);
  row = await db(page, `return (await sb.from('leads').select('hook').eq('id', arg).single()).data;`, L.b);
  check(row.hook === 'saw you added solar installs this year', 'confirmed: the hook is replaced');

  // Opted out → the warning, no lines to use, one-click do not contact.
  mock.research[L.d] = { observations: [{ text: 'Footer: no sales calls or marketing please', source_url: 'https://example.edu/' }], hooks: ['saw your footer'], pain: '', opted_out: true, opted_out_evidence: 'No sales calls or marketing please', number_published: 'no', number_evidence_url: '', could_not_read: '' };
  await page.fill('[name="research-q"]', 'ZZAGUI Delta');
  await page.waitForTimeout(300);
  await page.locator(`.ag-pick-btn[data-lead="${L.d}"]`).click();
  await page.locator('.ag-chosen [data-act=research]').click();
  await page.waitForSelector('.ag-chosen [data-optout]', { timeout: 8000 });
  check((await page.locator('.ag-chosen [data-optout]').textContent()).includes('Their site says they do not want sales contact. Do not text them.'), 'opted-out warning shows the exact words');
  check(await page.locator('.ag-chosen [data-act=use-line]').count() === 0, 'no "Use this line" for someone who opted out');
  await shot(page, 'agents-research-optout-1440');
  await page.locator('.ag-chosen [data-act=mark-dnc]').click();
  await page.waitForSelector('.modal');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(1500);
  row = await db(page, `return (await sb.from('leads').select('status').eq('id', arg).single()).data;`, L.d);
  check(row.status === 'dnc', '"Mark do not contact" uses the existing do-not-contact path');

  // Daily limit → a plain message, nothing changes.
  await page.fill('[name="research-q"]', 'ZZAGUI Charlie');
  await page.waitForTimeout(300);
  await page.locator(`.ag-pick-btn[data-lead="${L.c}"]`).click();
  await page.locator('.ag-chosen [data-act=research]').click();
  await page.waitForTimeout(1200);
  check(/limit for today/.test(await lastToast(page)), 'daily_limit shows a plain message');

  /* ------------------------------------------------- lead drawer research */
  mock.research[L.c] = { observations: [{ text: 'ZZAGUI A one-page site with a phone number', source_url: 'https://example.net/' }], hooks: [], pain: '', opted_out: false, opted_out_evidence: '', number_published: 'no', number_evidence_url: '', could_not_read: '' };
  await open(page, `#leads/${L.c}`, 1200);
  await page.waitForSelector('.drawer [data-ld-research]');
  check(/Research this business/.test(await page.locator('.drawer [data-ld-research] [data-act=research]').textContent()), 'the lead drawer offers "Research this business"');
  check(await page.locator('.drawer .ld-ai, .drawer .ld-personal').count() >= 1, 'the drawer keeps the personal line section (and its AI suggest feature)');
  await page.locator('.drawer [data-ld-research] [data-act=research]').click();
  await page.waitForSelector('.drawer [data-ld-research] [data-nolines]', { timeout: 8000 });
  check((await page.locator('.drawer [data-nolines]').textContent()).includes('has not made one up'), 'with no lines it says honestly that it will not make one up');
  check(/Research again/.test(await page.locator('.drawer [data-ld-research] [data-act=research]').textContent()), 'after a run the drawer offers "Research again"');
  await shot(page, 'drawer-research-1440');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await open(page, `#leads/${L.a}`, 1200);
  check((await page.locator('.drawer [data-ld-research] .ag-rc-meta').textContent()).includes('Researched'), 'a lead with a research run shows it, with its date, instead of re-running');
  check((await page.locator('.drawer textarea[name=hook]').inputValue()).includes('tools till 3'), 'the drawer hook field shows the line chosen from research');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ---------------------------------------------------------- briefing */
  // Another session may have written a real briefing today: hide those runs in this page
  // only (in memory), so the "not written yet" state can be tested.
  await page.evaluate(async (api) => {
    const m = await import(eval(api));
    m.state.agent_runs = m.state.agent_runs.filter((r) => r.agent !== 'briefing');
    m.notify();
  }, API);
  await open(page, '#home', 1200);
  check(await page.locator('[data-today-brief="none"] [data-act=brief-write]').count() === 1, 'Today offers one quiet "Write today’s briefing" control');
  check(!mock.calls.some((c) => c.agent === 'briefing'), 'Today never runs the briefing by itself');
  check(await page.locator('.do-item[data-key="agent-approvals"]').count() === 1 && (await page.locator('.do-item[data-key="agent-approvals"] a.do-link').getAttribute('href')) === '#agents/approvals', 'Do next shows the suggestions waiting for approval');
  mock.briefMode = 'empty';
  await page.locator('[data-act=brief-write]').click();
  await page.waitForTimeout(1200);
  check(/nothing in the hub/i.test(await lastToast(page)), 'an empty hub reads plainly (error "empty")');
  mock.briefMode = 'ok';
  await page.locator('[data-act=brief-write]').click();
  await page.waitForSelector('[data-today-brief] .ag-brief-head', { timeout: 8000 });
  check((await page.locator('[data-today-brief] .ag-brief-head').textContent()).includes('One overdue invoice'), 'the briefing shows its headline on Today');
  check(await page.locator('[data-today-brief] .ag-brief-do a[href="#income"]').count() === 1, '"Do first" items are hub links');
  check(await page.locator('[data-today-brief] a[href^="javascript"]').count() === 0 && await page.evaluate(() => window.__xss === undefined), 'an unknown hash is plain text; nothing renders as HTML');
  check(/Written at/.test(await page.locator('[data-today-brief] .ag-brief-meta').textContent()), 'a quiet "written at … · refresh" line');
  await shot(page, 'today-briefing-1440');
  await page.locator('[data-today-brief] [data-act=brief-refresh]').click();
  await page.waitForFunction(() => /refreshed headline/.test(document.querySelector('[data-today-brief] .ag-brief-head')?.textContent || ''), null, { timeout: 8000 });
  check(mock.calls.some((c) => c.agent === 'briefing' && c.refresh === true), 'Refresh sends {refresh:true}');

  /* --------------------------------------------------------------- ask */
  await open(page, '#agents/ask', 1000);
  await page.fill('.ag-ask-input', 'Who has not been invoiced this month?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-turn.is-a .ag-a', { timeout: 8000 });
  check((await page.locator('.ag-turn.is-a .ag-a').first().textContent()).startsWith('ZZAGUI answer <img'), 'the answer shows as text');
  check(await page.locator('.ag-turn.is-a a.ag-link[href="#income"]').count() === 1 && await page.locator('.ag-ask a[href^="javascript"]').count() === 0, 'answer links are hub links only');
  await page.fill('.ag-ask-input', 'And which of those is unknown?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-turn.is-cannot', { timeout: 8000 });
  const lastAsk = mock.calls.filter((c) => c.agent === 'ask').pop();
  check(Array.isArray(lastAsk.history) && lastAsk.history.length === 2 && lastAsk.history[0].role === 'user', `the conversation is sent as history (${lastAsk.history?.length})`);
  check((await page.locator('.ag-turn.is-cannot .ag-cannot').textContent()).includes('cannot answer that from your data'), '"cannot answer from your data" is shown plainly');
  await page.fill('.ag-ask-input', 'half typed question');
  await page.evaluate(async (api) => { (await import(eval(api))).notify(); }, API);
  await page.waitForTimeout(500);
  check((await page.inputValue('.ag-ask-input')) === 'half typed question', 'typed text survives a live update');
  await page.fill('.ag-ask-input', 'CAP test?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(/budget is used up/.test(await lastToast(page)), 'cap_reached reads plainly');
  await shot(page, 'agents-ask-1440');
  await page.locator('[data-act=ask-new]').click();
  check(await page.locator('.ag-turn.is-q').count() === 0, '"New conversation" clears it');

  /* ------------------------------------------------------------- doer */
  await open(page, '#agents/doer', 1000);
  check(await page.locator('.ag-chips .chip').count() === 3, 'the Doer offers three example chips');
  await page.locator('.ag-chips .chip').first().click();
  check((await page.inputValue('.ag-doer-input')).length > 10, 'an example fills the instruction box');
  await page.fill('.ag-doer-input', 'DISABLED please');
  await page.click('[data-act=doer]');
  await page.waitForTimeout(1200);
  check(/switched off/.test(await lastToast(page)), 'disabled reads plainly');
  await page.fill('.ag-doer-input', 'Give Delta a line and note the client');
  await page.click('[data-act=doer]');
  await page.waitForSelector('[data-doer-note]', { timeout: 8000 });
  check(mock.calls.some((c) => c.agent === 'doer' && c.instruction === 'Give Delta a line and note the client'), 'Doer sends {instruction}');
  check((await page.locator('[data-doer-note]').textContent()).includes('<img'), 'its note shows as text');
  check(await page.locator('[data-dropped="1"]').count() === 1, 'it says how many suggestions were dropped');
  check(await page.locator('.ag-doer .ag-action').count() === 2, 'its proposals show as cards');
  await shot(page, 'agents-doer-1440');
  await page.locator('.ag-doer [data-act=approve-all]').click();
  await page.waitForSelector('.modal');
  const confirmText = await page.locator('.modal').textContent();
  check(/1 personal line/.test(confirmText) && /1 note/.test(confirmText), `"Approve all" lists the count by kind first (${confirmText.match(/1 [^.]+\./)?.[0]})`);
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(3000);
  const batch = await db(page, `
    const d = (await sb.from('leads').select('hook').eq('id', arg.d).single()).data;
    const c = (await sb.from('clients').select('notes').eq('name', 'ZZAGUI Client Co').single()).data;
    const a = (await sb.from('agent_actions').select('status').eq('run_id', arg.run3)).data;
    return { hook: d.hook, notes: c.notes, statuses: a.map((x) => x.status) };`, { d: L.d, run3 });
  check(batch.hook === 'ZZAGUI batch line' && /ZZAGUI batch note/.test(batch.notes || '') && batch.statuses.every((x) => x === 'applied'), `Approve all applies the batch (${batch.statuses.join(',')})`);

  /* --------------------------------------------------------- approvals */
  await open(page, '#agents/approvals', 1200);
  const card = (id) => page.locator(`.ag-action[data-action="${id}"]`);
  check(await card(act('Move Alpha')).count() === 1, 'approvals list the proposed actions as cards');
  check(await page.locator('.ag-group[data-run] [data-act=approve-all]').count() >= 1, '"Approve all" is offered per Doer run batch');
  check((await card(act('Draft a reply')).textContent()).includes('This puts a draft in your inbox reply box. It does not send.'), 'message.draft shows the full draft and says it does not send');
  check((await card(act('Draft a reply')).locator('.ag-draft').textContent()).includes('Thursday at 10 works'), 'the full draft text is shown');
  check((await card(act('setup invoice')).textContent()).includes('Creates a draft invoice. Nothing is sent.'), 'invoice.draft says nothing is sent');
  check((await card(act('Move Alpha')).textContent()).includes('ZZAGUI Alpha Plumbing'), 'ids resolve to names');
  check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#view img[src="x"]')), 'a summary with <img onerror> renders as text');
  check((await card(act('hook for Charlie')).textContent()).includes('<b>bold?</b>'), 'a reason with markup renders as text');
  await shot(page, 'agents-approvals-1440', true);

  const approveIt = async (summary) => { await card(act(summary)).locator('[data-act=approve]').click(); await page.waitForTimeout(1800); };
  const before = await db(page, `
    const a = (await sb.from('leads').select('*').eq('id', arg.a).single()).data;
    const b = (await sb.from('leads').select('*').eq('id', arg.b).single()).data;
    const dl = (await sb.from('deals').select('*').eq('title', 'ZZAGUI Deal').single()).data;
    return { a, b, dl };`, L);

  await approveIt('Move Alpha');
  let after = (await db(page, `return (await sb.from('leads').select('*').eq('id', arg).single()).data;`, L.a));
  const diff = (x, y) => Object.keys(y).filter((k) => !['updated_at'].includes(k) && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  check(after.status === 'interested' && diff(before.a, after).join() === 'status', `lead.set_status changes the status and nothing else (${diff(before.a, after).join()})`);

  await approveIt('Follow up Bravo');
  after = (await db(page, `return (await sb.from('leads').select('*').eq('id', arg).single()).data;`, L.b));
  check(Boolean(after.next_followup_at) && diff(before.b, after).join() === 'next_followup_at', `lead.set_followup sets only next_followup_at (${diff(before.b, after).join()})`);

  await approveIt('call the accountant');
  const tasks = await db(page, `return (await sb.from('tasks').select('*').eq('title', 'ZZAGUI Call the accountant')).data;`);
  check(tasks.length === 1 && tasks[0].client_id === fx.client.id && tasks[0].priority === 'high' && Boolean(tasks[0].due_on), 'task.create creates exactly the described task');

  await approveIt('Move the deal');
  const dealAfter = await db(page, `return (await sb.from('deals').select('*').eq('title', 'ZZAGUI Deal').single()).data;`);
  check(dealAfter.stage === 'proposal' && dealAfter.next_step === 'ZZAGUI Send the proposal' && diff(before.dl, dealAfter).sort().join() === 'next_step,stage', `deal.update changes stage and next step only (${diff(before.dl, dealAfter).join()})`);

  const msgsBefore = await db(page, `return (await sb.from('messages').select('id', { count: 'exact', head: true }).eq('lead_id', arg)).count;`, L.c);
  await approveIt('Draft a reply');
  const msgsAfter = await db(page, `return (await sb.from('messages').select('id', { count: 'exact', head: true }).eq('lead_id', arg)).count;`, L.c);
  const draft = await page.evaluate((id) => sessionStorage.getItem(`wiseos.draft.${id}`), L.c);
  check(msgsAfter === msgsBefore, `message.draft creates NO messages row (${msgsBefore} → ${msgsAfter})`);
  check(draft === 'ZZAGUI Hi Cat, Thursday at 10 works for a quick call. Does that suit?', 'message.draft puts the draft in sessionStorage for the inbox composer');
  await page.locator('.ag-decided-wrap summary').click();
  check(await page.locator(`.ag-decided[data-action="${act('Draft a reply')}"] a.ag-open[href="#inbox/${L.c}"]`).count() === 1, 'an applied draft offers "Open" to the inbox');

  await approveIt('setup invoice');
  const inc = await db(page, `return (await sb.from('income').select('*').eq('description', 'ZZAGUI Setup fee')).data;`);
  check(inc.length === 1 && inc[0].status === 'draft' && Number(inc[0].amount) === 1500 && inc[0].client_id === fx.client.id, `invoice.draft creates a draft invoice (${inc[0]?.status})`);

  const alphaNotes = (await db(page, `return (await sb.from('leads').select('notes').eq('id', arg).single()).data;`, L.a)).notes;
  await card(act('note to Alpha')).locator('[data-act=reject]').click();
  await page.waitForTimeout(1500);
  const rej = await db(page, `
    const a = (await sb.from('agent_actions').select('status').eq('id', arg.id).single()).data;
    const l = (await sb.from('leads').select('notes').eq('id', arg.lead).single()).data;
    return { status: a.status, notes: l.notes };`, { id: act('note to Alpha'), lead: L.a });
  check(rej.status === 'rejected' && rej.notes === alphaNotes, 'Reject records the decision and changes nothing');

  check(await card(act('Mark Bravo')).locator('[data-act=approve]').isDisabled() && await card(act('Mark Bravo')).locator('[data-broken]').count() === 1, 'a proposal outside the rules (status dnc) cannot be approved: Approve is disabled and it says why');
  await page.evaluate(async ({ api, id }) => {
    const { applyAgentAction, state } = await import(eval(api));
    return applyAgentAction(state.agent_actions.find((a) => a.id === id));
  }, { api: API, id: act('Mark Bravo') });
  await page.waitForTimeout(800);
  const dnc = await db(page, `
    const a = (await sb.from('agent_actions').select('status,result').eq('id', arg.id).single()).data;
    const l = (await sb.from('leads').select('status').eq('id', arg.lead).single()).data;
    return { a, status: l.status };`, { id: act('Mark Bravo'), lead: L.b });
  check(dnc.status === 'contacted' && dnc.a.status === 'failed', `even applied directly, the allowlist refuses it and nothing changes (${dnc.a.status}: ${dnc.a.result})`);

  const outside = await page.evaluate(async (api) => {
    const { applyAgentAction } = await import(eval(api));
    return applyAgentAction({ id: '00000000-0000-0000-0000-000000000000', status: 'proposed', kind: 'lead.delete', payload: { lead_id: 'x' } });
  }, API);
  check(outside.ok === false && /not allowed/.test(outside.message), 'an action of a kind outside the allowlist cannot be applied');
  check(await page.locator('.ag-decided[data-status="applied"]').count() >= 6, 'decided actions drop into the Decided list with their outcome');
  await shot(page, 'agents-approvals-decided-1440', true);

  /* --------------------------------------------------------------- runs */
  await open(page, '#agents/runs', 1000);
  check(await page.locator(`.ag-runs tr[data-run="${run2}"]`).count() === 1, 'the run log lists the runs');
  check(await page.locator('.ag-runs [data-run-status="capped"]').count() >= 1, 'capped runs are logged too');
  await page.locator('.ag-run-chips [data-filter="researcher"]').click();
  const agentsShown = await page.$$eval('.ag-runs tbody tr td:nth-child(2)', (ns) => [...new Set(ns.map((n) => n.textContent))]);
  check(agentsShown.length === 1 && agentsShown[0] === 'Researcher', `filter by agent (${agentsShown.join(',')})`);
  await shot(page, 'agents-runs-1440');
  await page.locator(`.ag-runs tr[data-run="${run2}"] td`).nth(3).click();
  await page.waitForSelector('.ag-run-cells');
  check((await page.evaluate(() => location.hash)) === `#agents/runs/${run2}`, 'opening a run deep-links to it');
  const runText = await page.locator('.ag-run').textContent();
  check(/9,100/.test(runText) && /US\$0\.04/.test(runText) && /31\.0 s/.test(runText), 'run detail shows tokens, cost and duration');
  const srcs = await page.$$eval('.ag-run-sources a', (ns) => ns.map((n) => ({ href: n.getAttribute('href'), t: n.target, rel: n.rel })));
  check(srcs.length === 1 && srcs[0].href === 'https://example.com/contact' && srcs[0].t === '_blank' && /noopener/.test(srcs[0].rel), 'pages read are plain https links in a new tab (javascript: dropped)');
  check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#view img[src="x"]')), 'run output never renders as HTML');
  await shot(page, 'agents-run-detail-1440', true);

  /* ----------------------------------------------------------- palette */
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal-input');
  const labels = await page.locator('.pal-opt .pal-label').allTextContents();
  check(['Ask the hub', 'Tell the agent to do something', 'Approvals', 'Research a lead'].every((l) => labels.includes(l)), 'palette offers the agent actions');
  await page.keyboard.type('who owes me money?');
  await page.waitForTimeout(200);
  check((await page.locator('.pal-opt.is-sel .pal-label').textContent()) === 'Ask the hub: who owes me money?', 'a question ending in "?" offers "Ask the hub: …"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check((await page.evaluate(() => location.hash)) === '#agents/ask' && (await page.inputValue('.ag-ask-input')) === 'who owes me money?', 'it opens Ask with the question prefilled (not in the URL)');

  /* ----------------------------------------------------------- settings */
  await open(page, '#settings', 1200);
  check(await page.locator('[data-set-agents]').count() === 1, 'Settings has an Agents group');
  check((await page.locator('[data-set-agents]').textContent()).includes('Separate from AI drafting'), 'it says how the two budgets differ');
  await page.fill('[name=agent_monthly_cap_usd]', '30');
  await page.click('[data-act=save-agent-cap]');
  await page.waitForTimeout(1500);
  s = await db(page, `return (await sb.from('settings').select('agent_monthly_cap_usd').eq('id', 1).single()).data;`);
  check(Number(s.agent_monthly_cap_usd) === 30, 'the budget saves agent_monthly_cap_usd');
  await page.fill('[name=agent_monthly_cap_usd]', '150');
  await page.click('[data-act=save-agent-cap]');
  await page.waitForTimeout(800);
  check(/US\$0 to US\$100/.test(await lastToast(page)), 'a budget over US$100 is refused');
  await page.locator('[data-sw="agents_enabled"] .ag-switch').click();
  await page.waitForTimeout(1500);
  s = await db(page, `return (await sb.from('settings').select('agents_enabled').eq('id', 1).single()).data;`);
  check(s.agents_enabled === false, 'the master switch saves agents_enabled');
  await open(page, '#agents', 1000);
  check(await page.locator('[data-gate="off"]').isVisible() && await page.locator('.ag-research').isHidden(), 'switched off: one calm explanation, no dead controls');
  await shot(page, 'agents-off-1440');
  await page.click('[data-act=agents-on]');
  await page.waitForTimeout(1500);
  s = await db(page, `return (await sb.from('settings').select('agents_enabled').eq('id', 1).single()).data;`);
  check(s.agents_enabled === true && await page.locator('.ag-research').isVisible(), '"Turn agents on" turns them back on');

  // Not connected.
  mock.status = { ...STATUS(), configured: false };
  await page.evaluate(async (api) => { await (await import(eval(api))).agentStatus(); }, API);
  await page.waitForTimeout(600);
  check(await page.locator('[data-gate="not-connected"]').isVisible() && await page.locator('.ag-ctrl:visible').count() === 0, 'not connected: one explanation and the way to connect, no controls');
  await shot(page, 'agents-not-connected-1440');
  await open(page, '#home', 800);
  check(await page.locator('[data-today-brief]').count() === 0, 'Today hides the briefing when the agents are not connected');
  mock.status = STATUS();
  await page.evaluate(async (api) => { await (await import(eval(api))).agentStatus(); }, API);

  /* --------------------------------------------------------------- dock */
  for (const [w, h] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await open(page, '#leads', 800);
    await page.mouse.move(w - 100, h / 2);
    await page.waitForTimeout(600);
    const dock = await page.evaluate(() => {
      const list = document.querySelector('.dock-list');
      const items = [...document.querySelectorAll('.rail-dock .dock-item, .rail-dock .conn')];
      return {
        areas: list.querySelectorAll('.dock-item').length,
        clipped: list.scrollHeight > list.clientHeight + 1,
        bottom: Math.max(...items.map((n) => n.getBoundingClientRect().bottom)),
        grow: document.querySelector('.dock-area[data-area="Grow"]')?.classList.contains('is-active'),
        foot: document.querySelectorAll('.dock-foot .dock-item').length
      };
    });
    check(dock.areas === 7 && dock.foot === 2, `dock shows one icon per area (7) plus Settings and Lock at the foot (${w}x${h})`);
    check(!dock.clipped && dock.bottom <= h, `nothing is cut off in the dock at ${w}x${h} (bottom ${Math.round(dock.bottom)})`);
    check(dock.grow === true, `the Grow area is lit on #leads (${w}x${h})`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `dock-${w}x${h}.png`), clip: { x: 0, y: 0, width: 320, height: h } });
    await page.mouse.move(30, h / 2);
    await page.waitForTimeout(600);
    const map = await page.evaluate(() => { const n = document.querySelector('.rail-full .nav'); const f = document.querySelector('.rail-full .rail-foot'); return { foot: f.getBoundingClientRect().bottom }; });
    check(map.foot <= h + 1, `the expanded map fits (scrolls inside itself) at ${w}x${h}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `dock-open-${w}x${h}.png`), clip: { x: 0, y: 0, width: 320, height: h } });
    await page.mouse.move(w - 100, h / 2);
    await page.waitForTimeout(500);
  }
  const badge = await page.evaluate(() => {
    const c = document.querySelector('.dock-item[data-route="agents"] .dock-count');
    return c && !c.hidden ? Number(c.textContent) : 0;
  });
  const pendingNow = await db(page, `return (await sb.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'proposed')).count;`);
  check(badge > 0 && badge === Math.min(pendingNow, 200), `the Agents dock icon carries the approvals count (${badge})`);

  /* -------------------------------------------------------------- 390px */
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ['#agents', '#agents/approvals', '#agents/runs', `#agents/runs/${run2}`, '#agents/ask', '#agents/doer']) {
    await open(page, h, 800);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `${h} has no horizontal scroll at 390px (${over})`);
  }
  if (SHOTS) {
    const p390 = await ctx.newPage();
    await p390.setViewportSize({ width: 390, height: 844 });
    await p390.goto(URL, { waitUntil: 'networkidle' });
    await signIn(p390);
    await p390.waitForSelector('#view .page:not([aria-busy])', { timeout: 20000 });
    await p390.waitForTimeout(1200);
    for (const h of ['#agents', '#agents/approvals', `#agents/runs/${run2}`, '#agents/ask', '#home']) {
      await open(p390, h, 1200);
      await p390.screenshot({ path: join(SHOTS, `agents-390-${h.replace(/[#/]/g, '_').slice(0, 30)}.png`), fullPage: true });
    }
    await open(p390, `#leads/${L.a}`, 1500);
    await p390.screenshot({ path: join(SHOTS, 'drawer-research-390.png') });
    await p390.close();
  }
} catch (e) {
  fails.push(`exception: ${e.message}`);
  console.log('FAIL exception', e);
  await shot(page, 'agents-failure').catch(() => {});
} finally {
  if (prior) {
    try {
      await page.evaluate(async ({ api, prior }) => {
        const { sb } = await import(eval(api));
        await sb.from('settings').update(prior).eq('id', 1);
      }, { api: API, prior });
      const now = await db(page, `return (await sb.from('settings').select('agents_enabled,agent_monthly_cap_usd,agent_researcher,agent_briefing,agent_ask,agent_doer').eq('id', 1).single()).data;`);
      check(JSON.stringify(now) === JSON.stringify(prior), 'agent settings restored to their exact prior values');
    } catch (e) { fails.push(`restore failed: ${e.message}`); }
  }
  await browser.close();
}

console.log(`${mock.calls.length} calls to the agent function, all answered by the mock`);
check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);
console.log('Now remove the fixture: node os/tests/agents.test.mjs --cleanup (run it with the service role).');
process.exit(fails.length ? 1 : 0);
