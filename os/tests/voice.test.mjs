// Voice input (dictation) in the assistant's composer, with a fake SpeechRecognition: the
// browser's real engine needs a microphone and a speech service, so here a stand-in class
// emits interim and final results and errors on cue. The agent function and the chat tables
// are mocked: nothing is sent and no record changes.
//
//   python3 -m http.server 8196 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8196/os/ node os/tests/voice.test.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = (process.env.BASE || 'http://127.0.0.1:8196').replace(/\/os\/?$/, '').replace(/\/$/, '');
const URL = `${ROOT}/os/`;
const PASSWORD = process.env.OS_TEST_PASSWORD;
const EMAIL = process.env.OS_TEST_EMAIL || 'hq@wise-ai.au';
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
const fails = []; const passes = [];
const check = (c, m) => { (c ? passes : fails).push(m); console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const browser = await chromium.launch();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };

/** A stand-in for the browser's speech engine. window.__sr is the live one. */
function fakeSpeech() {
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.started = 0; this.stopped = false; window.__srAll = (window.__srAll || 0) + 1; }
    start() { this.started++; window.__srStarts = (window.__srStarts || 0) + 1; window.__sr = this; this.stopped = false; setTimeout(() => this.onstart?.({}), 5); }
    stop() { this.stopped = true; window.__srStops = (window.__srStops || 0) + 1; setTimeout(() => this.onend?.({}), 5); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  // emit(interim, final): one recognition event, like Chrome's (results from resultIndex on)
  window.__emit = (interim = '', final = '') => {
    const list = [];
    if (final) { const r = [{ transcript: final, confidence: 0.9 }]; r.isFinal = true; list.push(r); }
    if (interim) { const r = [{ transcript: interim, confidence: 0.5 }]; r.isFinal = false; list.push(r); }
    window.__sr?.onresult?.({ resultIndex: 0, results: list });
  };
  window.__fail = (error) => { window.__sr?.onerror?.({ error }); window.__sr?.onend?.({}); };
}
function noSpeech() { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; try { Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true }); } catch { /* ok */ } }

async function session({ speech = true, autosend = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const calls = [];
  await ctx.route('**/functions/v1/agent', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push(body);
    if (body.action === 'status') return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ configured: true, enabled: true, agents: { researcher: true, briefing: true, ask: true, doer: true, chat: true }, spent_usd: 1, cap_usd: 25, runs_today: {}, limits: {} }) });
    if (body.agent === 'chat') return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, chat_id: '00000000-0000-4000-8000-0000000000e1', title: 'Dictated', message: { id: 880001, role: 'assistant', at: new Date().toISOString(), text: 'Noted.', steps: [], links: [] }, changes: [], model: 'claude-sonnet-5-5', cost_usd: 0.01 }) });
    return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true }) });
  });
  for (const t of ['agent_chats', 'agent_changes', 'agent_memory', 'agent_chat_messages', 'mail_drafts', 'calendar_proposals']) {
    await ctx.route(`**/rest/v1/${t}*`, (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill({ status: 200, headers: CORS, body: '[]' })));
  }
  await ctx.addInitScript(speech ? fakeSpeech : noSpeech);
  if (autosend) await ctx.addInitScript(() => { try { localStorage.setItem('wiseos.voice.autosend', '1'); } catch { /* */ } });
  await ctx.addInitScript(() => { window.__mod = (p) => import(document.querySelector('script[type=module]').src.replace('app.js', p)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.calls = calls;
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ email, password }) => { const { sb } = await window.__mod('api.js'); await sb.auth.signInWithPassword({ email, password }); }, { email: EMAIL, password: PASSWORD });
  await page.waitForSelector('#view .page:not([aria-busy])', { timeout: 25000 });
  await page.evaluate(async () => { const m = await window.__mod('api.js'); for (let i = 0; i < 100 && !(m.state.loaded && m.state.me && m.state.agents); i++) await new Promise((r) => setTimeout(r, 100)); });
  await page.waitForSelector('.agd-launch', { timeout: 10000 });
  await page.evaluate(() => { location.hash = '#leads'; });
  await page.waitForTimeout(500);
  return { ctx, page };
}
const openBar = async (page) => { await page.keyboard.press('Control+j'); await page.waitForSelector('.agd-dock[data-agd-state=open] .cx-input'); await page.waitForTimeout(450); };
const pressed = (page) => page.evaluate(() => document.querySelector('.agd-dock .cx-mic')?.getAttribute('aria-pressed'));

try {
  /* ---- not supported: no microphone, nothing else changes */
  {
    const { ctx, page } = await session({ speech: false });
    await openBar(page);
    check(await page.locator('.cx-mic').count() === 0, 'no speech engine (Firefox): no microphone button');
    check(await page.locator('.agd-dock .cx-send').count() === 1, 'the bar is otherwise the same');
    await ctx.close();
  }

  /* ---- the bar */
  {
    const { ctx, page } = await session();
    await openBar(page);
    check(await page.locator('.agd-dock .cx-mic').count() === 1, 'a microphone sits in the bar');
    const tip = await page.getAttribute('.agd-dock .cx-mic', 'title');
    check(/Shift Space/.test(tip) && /browser’s speech service/.test(tip), `its tooltip gives the shortcut and the privacy line (${tip})`);

    // start / stop
    await page.click('.agd-dock .cx-mic');
    await page.waitForTimeout(60);
    const st = await page.evaluate(() => ({ lang: window.__sr?.lang, cont: window.__sr?.continuous, interim: window.__sr?.interimResults, presence: document.querySelector('.agd-dock').dataset.presence, live: [...document.querySelectorAll('.agd-dock [aria-live]')].map((n) => n.textContent).join('|') }));
    check(await pressed(page) === 'true' && st.lang === 'en-AU' && st.cont && st.interim, `click starts listening, en-AU, continuous, interim results (${JSON.stringify(st)})`);
    check(st.presence === 'dictating' && /Listening/.test(st.live), 'the owl shows it is listening and "Listening" is announced');
    await page.click('.agd-dock .cx-mic');
    await page.waitForTimeout(60);
    check(await pressed(page) === 'false' && await page.evaluate(() => window.__sr.stopped), 'a second click stops it');

    // interim then final, at the cursor, keeping what was typed
    await page.fill('.agd-dock .cx-input', 'Hello there. Thanks');
    await page.evaluate(() => { const b = document.querySelector('.agd-dock .cx-input'); b.focus(); b.setSelectionRange(12, 12); });
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__emit('add a'));
    const mid = await page.evaluate(() => ({ v: document.querySelector('.agd-dock .cx-input').value, ghost: document.querySelector('.agd-dock .cx-ghost-interim')?.textContent || '', shown: !document.querySelector('.agd-dock .cx-ghost').hidden }));
    check(mid.v === 'Hello there. Add a Thanks' || mid.v === 'Hello there. add a Thanks', `interim words go in at the cursor (${JSON.stringify(mid.v)})`);
    check(mid.shown && mid.ghost === 'add a', 'the words still being worked out show in a muted tone');
    await page.evaluate(() => window.__emit('', 'add a lead'));
    const fin = await page.evaluate(() => ({ v: document.querySelector('.agd-dock .cx-input').value, ghost: document.querySelector('.agd-dock .cx-ghost').hidden }));
    check(fin.v === 'Hello there. Add a lead Thanks' && fin.ghost, `final words firm up and the typed text is kept (${JSON.stringify(fin.v)})`);
    await page.click('.agd-dock .cx-mic');

    // "send it" sends without the phrase
    await page.fill('.agd-dock .cx-input', '');
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__emit('', 'what is unpaid this month send it'));
    await page.waitForFunction(() => document.querySelector('.agd-dock .cx-msg.is-you'), null, { timeout: 4000 });
    const sent = page.calls.filter((c) => c.agent === 'chat').pop();
    check(sent && sent.message === 'What is unpaid this month' && await pressed(page) === 'false', `"send it" sends the message without those words (${sent?.message})`);

    // silence stops listening and leaves the text to check
    await page.waitForTimeout(400);
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__emit('', 'call Sam on Thursday'));
    const n0 = page.calls.filter((c) => c.agent === 'chat').length;
    await page.waitForTimeout(2900);
    const after = await page.evaluate(() => ({ v: document.querySelector('.agd-dock .cx-input').value, live: [...document.querySelectorAll('.agd-dock [aria-live]')].map((n) => n.textContent).join('|') }));
    check(await pressed(page) === 'false' && after.v === 'Call Sam on Thursday' && page.calls.filter((c) => c.agent === 'chat').length === n0 && /Stopped/.test(after.live), `after 2.5 s of quiet it stops and leaves the text in the bar (${after.v})`);

    // blocked microphone: one calm line, no restart
    const starts = await page.evaluate(() => window.__srStarts);
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__fail('not-allowed'));
    await page.waitForTimeout(1500);
    const note = await page.evaluate(() => { const n = document.querySelector('.agd-dock .cx-voice-note'); return n && !n.hidden ? n.textContent : ''; });
    check(/Microphone is blocked for this site\. Allow it in the browser’s address bar\./.test(note) && await pressed(page) === 'false', 'blocked: one calm line, and it stops');
    check(await page.evaluate(() => window.__srStarts) === starts + 1, 'after an error it does not restart by itself');
    await page.evaluate(() => window.__fail('no-speech'));
    check(await page.locator('.agd-dock .cx-voice-note:not([hidden])').count() <= 1, 'errors do not stack up');

    // Chrome ending a session by itself mid-way: it carries on
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(1300);
    const s1 = await page.evaluate(() => window.__srStarts);
    await page.evaluate(() => window.__sr.onend({}));
    await page.waitForTimeout(50);
    check(await page.evaluate(() => window.__srStarts) === s1 + 1 && await pressed(page) === 'true', 'when the engine ends a session by itself, it carries on listening');

    // closing the bar stops it
    await page.mouse.click(820, 70);
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__sr.stopped) && await page.evaluate(() => document.querySelector('.cx-mic').getAttribute('aria-pressed')) === 'false', 'closing the bar stops listening');

    // hold to talk opens the bar and listens
    await page.waitForTimeout(500);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.down('Space');
    await page.waitForTimeout(600);
    const held = await page.evaluate(() => ({ open: document.querySelector('.agd-dock').dataset.agdState, on: document.querySelector('.agd-dock .cx-mic').getAttribute('aria-pressed') }));
    await page.keyboard.up('Space'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await page.waitForTimeout(60);
    check(held.open === 'open' && held.on === 'true' && await pressed(page) === 'false', `Ctrl+Shift+Space held: opens the bar, listens, and stops on release (${JSON.stringify(held)})`);

    // the options: Send when I stop talking, off by default, kept on this device
    await page.click('.agd-dock .cx-mic', { button: 'right' });
    const optOff = await page.isChecked('.agd-dock [data-act=voice-autosend]');
    await page.check('.agd-dock [data-act=voice-autosend]');
    const stored = await page.evaluate(() => localStorage.getItem('wiseos.voice.autosend'));
    await page.keyboard.press('Escape');
    check(!optOff && stored === '1', 'right-click: "Send when I stop talking", off by default, saved on this device');
    await page.fill('.agd-dock .cx-input', '');
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__emit('', 'remind me tomorrow'));
    const n1 = page.calls.filter((c) => c.agent === 'chat').length;
    await page.waitForTimeout(3000);
    check(page.calls.filter((c) => c.agent === 'chat').length === n1 + 1 && page.calls.filter((c) => c.agent === 'chat').pop().message === 'Remind me tomorrow', 'with it on, it sends after the quiet');

    // the Agents page composer has it too
    await page.evaluate(() => { location.hash = '#agents'; });
    await page.waitForSelector('.cx.is-page .cx-input', { timeout: 8000 });
    check(await page.locator('.cx.is-page .cx-mic').count() === 1, 'the Agents page composer has a microphone too');
    await page.click('.cx.is-page .cx-mic'); await page.waitForTimeout(30);
    await page.evaluate(() => window.__emit('', 'hello from the page'));
    check((await page.inputValue('.cx.is-page .cx-input')).includes('Hello from the page'), 'dictation works there as well');
    await page.click('.cx.is-page .cx-mic');
    check(page.errors.length === 0, `no page errors ${page.errors.join(' | ')}`);
    await ctx.close();
  }

  /* ---- reduced motion: no pulse, a static filled microphone */
  {
    const { ctx, page } = await session({ reducedMotion: 'reduce' });
    await openBar(page);
    await page.click('.agd-dock .cx-mic'); await page.waitForTimeout(60);
    const rm = await page.evaluate(() => { const m = document.querySelector('.agd-dock .cx-mic'); return { pulse: getComputedStyle(m, '::after').animationName, fill: getComputedStyle(m.querySelector('.cx-mic-body')).fill, bg: getComputedStyle(m).backgroundColor }; });
    check(rm.pulse === 'none' && rm.fill !== 'transparent' && rm.fill !== 'rgba(0, 0, 0, 0)' && rm.bg !== 'rgba(0, 0, 0, 0)', `reduced motion: listening shows as a filled microphone, no pulse (${JSON.stringify(rm)})`);
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
