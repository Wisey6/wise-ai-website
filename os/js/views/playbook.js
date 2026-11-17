// Playbook: how Tyler runs outreach and the business, plus the campaign-maths calculator.
// Static, trusted copy only. Nothing from the database is rendered as HTML.
import { el, icon } from '../ui.js?v=20261118c';

/* ------------------------------------------------------------ calculator */

// Starting assumptions only. They are not benchmarks; the page says so.
export const CALC_DEFAULTS = Object.freeze({
  perDay: 20,      // texts sent per sending day
  days: 20,        // sending days per month
  delivered: 95,   // % of texts delivered
  reply: 8,        // % of delivered texts that get any reply
  positive: 35,    // % of replies that are interested
  booked: 50,      // % of interested replies that book a call
  showed: 75,      // % of booked calls that show up
  closed: 30,      // % of calls held that become a sale
  deal: 3000       // average deal value, $
});

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const pct = (v) => Math.min(100, num(v)) / 100;

/** Forward funnel for one month. Returns fractional counts (display rounds). */
export function funnel(input) {
  const i = { ...CALC_DEFAULTS, ...input };
  const texts = num(i.perDay) * num(i.days);
  const delivered = texts * pct(i.delivered);
  const replies = delivered * pct(i.reply);
  const positive = replies * pct(i.positive);
  const booked = positive * pct(i.booked);
  const showed = booked * pct(i.showed);
  const closed = showed * pct(i.closed);
  const revenue = closed * num(i.deal);
  return { texts, delivered, replies, positive, booked, showed, closed, revenue,
    perText: texts ? revenue / texts : 0 };
}

/**
 * Work backwards from a monthly revenue target. Deals are whole, so the deal
 * count is rounded up first and every earlier stage is what that needs.
 * Returns null when a rate or the deal value is zero (the target is unreachable).
 */
export function needed(target, input) {
  const i = { ...CALC_DEFAULTS, ...input };
  const rates = [i.delivered, i.reply, i.positive, i.booked, i.showed, i.closed].map(pct);
  if (!num(i.deal) || rates.some((r) => r === 0)) return null;
  const deals = Math.ceil(num(target) / num(i.deal));
  const showed = deals / pct(i.closed);
  const booked = showed / pct(i.showed);
  const positive = booked / pct(i.booked);
  const replies = positive / pct(i.positive);
  const delivered = replies / pct(i.reply);
  const texts = delivered / pct(i.delivered);
  const perDay = num(i.days) ? texts / num(i.days) : Infinity;
  return { deals, showed, booked, positive, replies, delivered, texts, perDay };
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const N1 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const N0 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
export const fmtCount = (n) => (n >= 10 ? N0.format(Math.round(n)) : N1.format(Math.round(n * 10) / 10));
export const fmtMoney = (n) => AUD.format(Math.round(n || 0));

const CALC_KEY = 'wiseos.calc';
function loadCalc() {
  try { return JSON.parse(localStorage.getItem(CALC_KEY) || 'null'); } catch { return null; }
}
function saveCalc(v) {
  try { localStorage.setItem(CALC_KEY, JSON.stringify(v)); } catch { /* private mode: fine */ }
}

function calculator(state) {
  const settings = state?.settings || {};
  const stored = loadCalc() || {};
  const vals = { ...CALC_DEFAULTS, ...stored };
  if (!stored.deal && Number(settings.avg_deal_value) > 0) vals.deal = Number(settings.avg_deal_value);
  if (!stored.target) vals.target = 15000;
  const cap = Number(settings.daily_cap) || null;

  const inputs = {};
  const numberInput = (key, label, { suffix = '', step = 1, max } = {}) => {
    const inp = el('input', {
      class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: String(step),
      max: max != null ? String(max) : null, value: String(vals[key]), id: `play-calc-${key}`,
      'aria-label': label
    });
    inp.addEventListener('input', update);
    inputs[key] = inp;
    return el('label', { class: 'play-calc-in', for: `play-calc-${key}` },
      el('span', { class: 'play-calc-label' }, label),
      el('span', { class: 'play-calc-ctl' }, inp, suffix ? el('span', { class: 'play-calc-suffix' }, suffix) : null));
  };

  const stages = [
    ['texts', 'Texts sent'], ['delivered', 'Delivered'], ['replies', 'Replies'],
    ['positive', 'Interested'], ['booked', 'Calls booked'], ['showed', 'Calls held'],
    ['closed', 'Sales']
  ];
  const bars = {};
  const funnelList = el('ol', { class: 'play-funnel', 'aria-live': 'polite' },
    stages.map(([k, label]) => {
      const fill = el('span', { class: 'play-funnel-fill' });
      const value = el('span', { class: 'play-funnel-num' });
      bars[k] = { fill, value };
      return el('li', { class: 'play-funnel-row' },
        el('span', { class: 'play-funnel-label' }, label),
        el('span', { class: 'play-funnel-bar' }, fill),
        value);
    }));
  const revenueOut = el('div', { class: 'kpi-value' });
  const perTextOut = el('div', { class: 'kpi-sub' });

  const needOut = el('div', { class: 'play-need' });

  function read() {
    const out = {};
    for (const [k, inp] of Object.entries(inputs)) out[k] = inp.value === '' ? 0 : Number(inp.value);
    return out;
  }

  function update() {
    const v = read();
    saveCalc(v);
    const f = funnel(v);
    const max = f.texts || 1;
    for (const [k] of stages) {
      bars[k].value.textContent = fmtCount(f[k]);
      bars[k].fill.style.width = `${Math.max(f[k] > 0 ? 1.5 : 0, (f[k] / max) * 100)}%`;
    }
    revenueOut.textContent = fmtMoney(f.revenue);
    if (!f.texts) {
      perTextOut.textContent = 'Enter how many texts you send a day';
    } else {
      const each = f.perText >= 1 || f.perText === 0
        ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 2 }).format(f.perText)
        : `${N1.format(f.perText * 100)}c`;
      perTextOut.textContent = `${each} per text sent · ${fmtCount(f.closed)} sales a month`;
    }

    const n = needed(v.target, v);
    needOut.replaceChildren();
    if (!n) {
      needOut.append(el('p', { class: 'muted' }, 'Every rate and the deal value need to be above zero to work backwards.'));
      return;
    }
    const perDay = Math.ceil(n.perDay);
    const overCap = cap && perDay > cap;
    needOut.append(
      el('p', { class: 'play-need-lead' },
        'To make ', el('strong', {}, fmtMoney(v.target)), ' a month you need ',
        el('strong', {}, `${N0.format(n.deals)} sale${n.deals === 1 ? '' : 's'}`), '. Working back:'),
      el('ul', { class: 'play-need-list' },
        el('li', {}, el('span', {}, 'Calls held'), el('strong', {}, N0.format(Math.ceil(n.showed)))),
        el('li', {}, el('span', {}, 'Calls booked'), el('strong', {}, N0.format(Math.ceil(n.booked)))),
        el('li', {}, el('span', {}, 'Interested replies'), el('strong', {}, N0.format(Math.ceil(n.positive)))),
        el('li', {}, el('span', {}, 'Replies'), el('strong', {}, N0.format(Math.ceil(n.replies)))),
        el('li', {}, el('span', {}, 'Texts a month'), el('strong', {}, N0.format(Math.ceil(n.texts)))),
        el('li', { class: overCap ? 'is-over' : '' }, el('span', {}, 'Texts per sending day'),
          el('strong', {}, Number.isFinite(perDay) ? N0.format(perDay) : '—'))),
      overCap
        ? el('p', { class: 'play-need-warn' }, icon('alert', 14),
          ` That is above your daily cap of ${cap}. Lift a rate (better personal lines, faster replies, a stronger call) before you lift volume.`)
        : el('p', { class: 'muted' }, cap ? `Within your daily cap of ${cap}.` : '')
    );
  }

  const card = el('section', { class: 'play-sec play-calc', id: 'play-maths', 'aria-labelledby': 'play-maths-h' },
    el('header', { class: 'play-sec-head' },
      el('div', { class: 'eyebrow' }, 'Campaign maths'),
      el('h2', { class: 'h2 play-h2', id: 'play-maths-h' }, 'What your texting is worth')),
    el('p', { class: 'play-note' },
      'The starting rates are placeholders, not benchmarks. Replace them with your own numbers once you have sent a couple of hundred texts. Changes are kept on this device.'),
    el('div', { class: 'play-calc-grid' },
      el('div', { class: 'play-calc-inputs' },
        el('fieldset', { class: 'play-fs' },
          el('legend', { class: 'eyebrow' }, 'Volume'),
          numberInput('perDay', 'Texts per day'),
          numberInput('days', 'Sending days per month', { max: 31 })),
        el('fieldset', { class: 'play-fs' },
          el('legend', { class: 'eyebrow' }, 'Rates'),
          numberInput('delivered', 'Delivered', { suffix: '%', step: 0.5, max: 100 }),
          numberInput('reply', 'Reply rate', { suffix: '%', step: 0.5, max: 100 }),
          numberInput('positive', 'Replies that are interested', { suffix: '%', step: 1, max: 100 }),
          numberInput('booked', 'Interested who book', { suffix: '%', step: 1, max: 100 }),
          numberInput('showed', 'Booked who show', { suffix: '%', step: 1, max: 100 }),
          numberInput('closed', 'Calls that close', { suffix: '%', step: 1, max: 100 })),
        el('fieldset', { class: 'play-fs' },
          el('legend', { class: 'eyebrow' }, 'Money'),
          numberInput('deal', 'Average deal value', { suffix: '$', step: 100 }),
          numberInput('target', 'Monthly revenue target', { suffix: '$', step: 500 }))),
      el('div', { class: 'play-calc-out' },
        el('div', { class: 'kpi play-rev' }, el('div', { class: 'kpi-label' }, 'Revenue a month'), revenueOut, perTextOut),
        funnelList,
        el('div', { class: 'play-need-wrap' },
          el('div', { class: 'eyebrow' }, 'Working back from your target'),
          needOut)))
  );
  update();
  return card;
}

/* -------------------------------------------------------------- content */

const p = (...c) => el('p', {}, ...c);
const li = (...c) => el('li', {}, ...c);
const b = (t) => el('strong', {}, t);
const ul = (...items) => el('ul', { class: 'play-list' }, ...items);
const ol = (...items) => el('ol', { class: 'play-steps' }, ...items);

function section(id, eyebrow, title, ...body) {
  return el('section', { class: 'play-sec', id: `play-${id}`, 'aria-labelledby': `play-${id}-h` },
    el('header', { class: 'play-sec-head' },
      el('div', { class: 'eyebrow' }, eyebrow), el('h2', { class: 'h2 play-h2', id: `play-${id}-h` }, title)),
    el('div', { class: 'play-body' }, ...body));
}

function script(label, text, note) {
  return el('div', { class: 'play-script' },
    el('div', { class: 'play-script-label' }, label),
    el('blockquote', { class: 'play-script-text' }, text),
    note ? el('p', { class: 'play-script-note muted' }, note) : null);
}

function check(text, detail) {
  return el('li', { class: 'play-check' },
    el('span', { class: 'play-check-mark', 'aria-hidden': 'true' }, icon('check', 14)),
    el('div', {}, b(text), detail ? el('div', { class: 'play-check-detail' }, detail) : null));
}

const TOC = [
  ['system', 'The system'], ['care', 'Why they should care'], ['maths', 'Campaign maths'],
  ['compliance', 'Compliance'], ['replies', 'Reply scripts'], ['rhythm', 'Weekly rhythm'],
  ['clients', 'Looking after clients'], ['company', 'Running the company']
];

export default function playbook(ctx = {}) {
  const state = ctx.state || {};
  const go = (id) => {
    const target = document.getElementById(`play-${id}`);
    if (!target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  const system = section('system', 'Section 1', 'The SMS system in seven steps',
    p('One text to one business owner who would plausibly want to hear from you. Then follow up twice, answer fast, and get them on a call.'),
    ol(
      li(b('Source leads. '), 'Pick one niche and one area. Find businesses by hand: their own website, Google Business Profile, a trade directory listing they control. No bought lists, no scraping tools.'),
      li(b('Verify the mobile and record where it is published. '), 'Only an Australian mobile (04…) that the business shows publicly for enquiries. Paste the page link into "Number source". If the page says they do not want sales calls or messages, skip them.'),
      li(b('Import, then write the personal line. '), 'Import the CSV in Leads, then add a hook for each one: one thing you actually noticed. A lead without a hook does not get a first text.'),
      li(b('First touch. '), 'Campaigns → Send batch. Read every message before it goes and adjust it for that business. Send inside business hours, inside your daily cap.'),
      li(b('Follow up. '), 'Two follow-ups at most, a few days apart, each adding something new. If they have not replied after that, stop.'),
      li(b('Handle replies. '), 'Inbox, within minutes if you can. Answer the question they asked, then offer a short call. Mark the status as you go.'),
      li(b('Book, show, close. '), 'Send the booking link. Confirm the day before. On the call, talk about their numbers, then propose one clear offer with a price.')
    ));

  const care = section('care', 'Section 2', 'Why they should care',
    p('Owners get generic cold texts every day. Ours should read like one local person who looked at their business and has something useful to say. Lead with what is in it for them, never with what we sell.'),
    el('h3', { class: 'play-h3' }, 'A first text that does not read like spam'),
    ul(
      li(b('One specific observation. '), 'Something true about their business: a review that mentions missed calls, a quote form that goes nowhere, hours that end at 3pm.'),
      li(b('One outcome in their numbers. '), 'Jobs won back, hours saved, dollars a month. Use their likely numbers, not ours.'),
      li(b('One easy question. '), 'Something they can answer in a word: "Worth a quick chat?" or "Is that a problem for you?"'),
      li(b('Plain words, short. '), 'No jargon, no "AI-powered", no exclamation marks. Under 300 characters is a good aim.'),
      li(b('No links in the first text. '), 'Links look like spam and get filtered. Send the booking link once they reply.'),
      li(b('Sound like a local. '), 'Say where you are. Write as you would speak to a tradie at the counter.'),
      li(b('Never fake familiarity. '), 'No "Hey mate, great chatting the other day" to a stranger. No pretending to be a customer.')
    ),
    script('Example first touch',
      'Hi Sam, Tyler here from Wise AI in Brisbane. Saw a few of your Google reviews mention it is hard to get through on the phone. We set up an answering system so missed calls get a text back and a booking in minutes, which for a plumber can be a couple of extra jobs a week. Worth a 15 min chat? Reply STOP to opt out',
      'Every part is replaceable for the next business. The hook is the part that has to be true and specific.'),
    el('h3', { class: 'play-h3' }, 'Frame the value as their money'),
    ul(
      li(b('Missed calls → lost jobs → dollars a month. '), 'Missed enquiries a week × share you would have won × average job value × 4.3 weeks. Use the ROI estimator on each lead to write it down.'),
      li(b('Admin hours → wage cost. '), 'Hours a week on quoting, chasing or rostering × what that hour costs them (their own time or a staff wage).'),
      li(b('Be conservative. '), 'Round down. If the honest number is small, pick a different angle or a different business.')
    ));

  const compliance = section('compliance', 'Section 3', 'Australian compliance checklist',
    el('p', { class: 'callout is-warn play-callout' }, icon('alert', 15),
      el('span', {}, 'A plain summary of the Spam Act 2003 as it applies to these texts. It is not legal advice. If anything is unclear for a specific case, get advice or read the ACMA guidance.')),
    el('ul', { class: 'play-checks' },
      check('Have consent before you send.',
        'Consent can be express or inferred. Here we rely on inferred consent from conspicuous publication: the business publishes the number for enquiries, there is no statement with it saying they do not want commercial messages, and the message is relevant to their business or role. A personal mobile someone has not published for business is out.'),
      check('Identify yourself in every message.',
        'Say who is sending (your name and Wise AI) and how to reach you. The system adds the sender name if a cold text leaves it out.'),
      check('Include a working unsubscribe.',
        'Every cold text carries "Reply STOP to opt out". STOP replies are suppressed automatically. Opt-outs must be honoured within 5 business days; we do it immediately.'),
      check('Treat any "stop" as a stop.',
        'If someone writes "please don’t text me" in their own words, mark them Do not contact yourself. The keyword filter will not catch it.'),
      check('No harvested lists, no harvesting software.',
        'Using address-harvesting software, or a list made with it, is prohibited. Build lists by hand from pages the business controls.'),
      check('Keep the evidence.',
        'If consent is ever questioned, it is up to you to show it. Record where each number was published (the "Number source" link) and when you found it. Keep message history.'),
      check('Know who enforces it.',
        'The Australian Communications and Media Authority (ACMA) enforces the Spam Act and can issue warnings, infringement notices and take court action.'),
      check('Phone calls have their own rules.',
        'Cold calling falls under the Do Not Call Register Act and the telemarketing standard, which are separate from the Spam Act. Check them before calling numbers you did not get a reply from.')
    ));

  const replies = section('replies', 'Section 4', 'Reply-handling scripts',
    p('Answer within minutes when you can. Match their tone and length. One question back, then the next step.'),
    el('div', { class: 'play-scripts' },
      script('Interested',
        'Great to hear, thanks Sam. Easiest is a 15 minute call so I can see how enquiries come in now and tell you honestly whether this is worth it for you. Here is my calendar: {booking_url}',
        'Send the link straight away. Mark the lead Interested.'),
      script('“How much is it?”',
        'Fair question. It depends on how many calls you get and what it needs to plug into, but most setups for a business your size are a one-off build plus a small monthly fee. I would rather give you a real number than a guess, so a 15 minute call is the quickest way. Does this week suit?',
        'Give a range if you have a productised offer with a set price. Never dodge twice.'),
      script('“Who is this?”',
        'Sorry, should have been clearer. Tyler from Wise AI, a small automation business in Brisbane. I found your number on your website and texted because of the reviews about missed calls. Happy to leave it there if it is not useful.',
        'Say where you got the number. Offer an easy exit. Most people relax once they know.'),
      script('“Not now”',
        'No worries at all, thanks for letting me know. Would it be OK if I checked back in a couple of months?',
        'If they say yes, set a reminder and note it. If they say no, mark them Lost and leave it.'),
      script('STOP or “don’t text me”',
        'Understood, I have taken you off the list. Sorry for the bother.',
        'One reply at most, then mark Do not contact. A STOP keyword is suppressed automatically; for plain-English requests do it yourself.')
    ));

  const rhythm = section('rhythm', 'Section 5', 'The weekly rhythm',
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'play-rhythm' },
        el('div', { class: 'eyebrow' }, 'Every day · about 20 minutes'),
        ul(
          li('Inbox first. Clear every reply, send booking links, set statuses.'),
          li('Send today’s follow-ups.'),
          li('Write personal lines for tomorrow’s batch, then send today’s batch inside the window.'),
          li('Check calls booked for today and tomorrow.'))),
      el('div', { class: 'play-rhythm' },
        el('div', { class: 'eyebrow' }, 'Every week · 30 minutes'),
        ul(
          li('Review the four numbers (below) against last week.'),
          li('Compare templates: keep the one with the best reply rate, rewrite or retire the rest. Change one thing at a time.'),
          li('Update the calculator rates with your real numbers.'),
          li('Source and verify next week’s leads.'))))
  );

  const clients = section('clients', 'Section 6', 'Looking after clients',
    ul(
      li(b('Reply fast. '), 'Same business day at the latest. Speed is most of what people remember.'),
      li(b('Do what you said, when you said. '), 'If a date slips, tell them before it does.'),
      li(b('Send a monthly ROI report. '), 'One page: calls answered, jobs booked, hours saved, what it is worth in dollars, and what you will improve next month.'),
      li(b('Ask for the referral after a win. '), 'When they tell you it is working, ask who else they know who would want the same. Make it easy: a sentence they can forward.')
    ));

  const company = section('company', 'Section 7', 'Running the company',
    ul(
      li(b('One niche, one offer. '), 'Pick a trade or industry and one problem you fix for it. Saying no to everything else is what makes the outreach specific.'),
      li(b('Productise. '), 'Fixed scope, fixed price, a set timeline. It is easier to sell, deliver and hand over.'),
      li(b('Speed to lead under five minutes. '), 'Practise what you sell. A reply or website enquiry should hear back within minutes in business hours.'),
      li(b('Track four numbers weekly. '), 'Conversations started, calls booked, deals closed, cash collected. If one stalls, you know where to work.'),
      li(b('Case studies and referrals. '), 'Every happy client becomes a short written result with their permission. It does more than any cold text.'),
      li(b('Retainers before headcount. '), 'Build recurring revenue before you hire. Monthly support and improvement keeps clients and smooths cash flow.'),
      li(b('Document delivery. '), 'Write each build as a checklist so an agent or contractor can run it. That is how you scale past your own hours.')
    ));

  const nav = el('nav', { class: 'play-toc', 'aria-label': 'Playbook sections' },
    el('div', { class: 'eyebrow play-toc-title' }, 'Contents'),
    TOC.map(([id, label], i) => el('button', { class: 'play-toc-btn', type: 'button', onClick: () => go(id) },
      el('span', { class: 'play-toc-n', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')), el('span', {}, label))));

  return el('div', { class: 'page play' },
    el('header', { class: 'play-head' },
      el('div', { class: 'eyebrow' }, 'Playbook'),
      el('h1', { class: 'h1' }, 'How we win work'),
      el('p', { class: 'play-lede' },
        'Personal, useful texts to businesses that publish their number, fast replies, and a short call. Read it once properly, then use it as a checklist.')),
    el('div', { class: 'play-layout' },
      nav,
      el('div', { class: 'play-doc' },
        system,
        care,
        calculator(state),
        compliance,
        replies,
        rhythm,
        clients,
        company))
  );
}
